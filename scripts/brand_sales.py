#!/usr/bin/env python3
"""
Sales on manufacturers' own websites (Logitech, Razer, Keychron and other
Shopify-based brand stores), for What's A Good Deal?

Every FETCH_EVERY_HOURS the hourly refresh calls refresh(); it reads the stores
listed in data/brand-stores.json and keeps only products that are on sale on
the brand's site right now (sale price below the brand's own regular price),
linked to the brand's product page. Results go to data/brand-sales.json and
are merged into the deals by daily_refresh.py.

Only pages each site's robots.txt allows are read (product pages, store
listings, Shopify's public products.json feed) — never carts, accounts,
search or APIs — with a pause between requests.

Store types:
  shopify   {base}/products.json — price + compare_at_price per variant
  logitech  server-rendered store listings: sale price + struck-through
            regular price per tile; the product page supplies the photo
  razer     product pages from the sitemap, a rotating batch per refresh;
            each embeds the regular price and the markdown (sale) price
"""

from __future__ import annotations

import html as htmlmod
import json
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import requests

ROOT = Path(__file__).resolve().parents[1]
STORES_PATH = ROOT / "data" / "brand-stores.json"
SALES_PATH = ROOT / "data" / "brand-sales.json"
FETCH_EVERY_HOURS = 6
MIN_DISCOUNT = 0.05      # at least 5% off the brand's own regular price
PAUSE = 1.0              # seconds between requests to the same site
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
SKIP_TYPES = re.compile(r"keycap|switch|spare|part|accessor|cable organiser|sticker|gift card|"
                        r"apparel|shirt|hoodie|cap\b|merch|warranty|service|z-others|deskmat|mouse ?pad",
                        re.I)


# accessories for a product rather than the product itself (allowed only in
# tabs where they are the product)
ACCESSORY = re.compile(r"\b(carrying case|case|cover|bag|sleeve|stand|wrist ?rest|keycaps?|switch(es)?|"
                       r"dongle|receiver|skins?|grip tape|feet|skates|mouse ?pad|desk ?mat|replacement|ear ?pads|"
                       r"cushions?|dock|cable)\b", re.I)
ACCESSORY_TABS = {"Cases", "Cables", "Charging", "Storage", "Networking", "AV Receivers"}
RAZER_PRICE = re.compile(
    r'"razerProductMarketingData":\{"cheapestPrice":"([^"]+)".{0,400}?"markDownPrice":\{"price":\{[^}]*"value":([\d.]+)',
    re.S)


# several products sold together: hard to file under one tab, so skipped
MULTI = re.compile(r"\bbundle\b|gift set|\bcombo\b|\bkit\b[^,]{0,40}\+|\s\+\s[^,]{0,40}\+", re.I)


def _sort_into_tab(classify: Callable, name: str, hint: str, price: float) -> str | None:
    if MULTI.search(name):
        return None
    cat = classify(name, hint, price)
    if cat and cat not in ACCESSORY_TABS and ACCESSORY.search(name):
        return None
    return cat


def _get(s: requests.Session, url: str) -> requests.Response | None:
    try:
        r = s.get(url, timeout=30)
    except requests.RequestException:
        return None
    time.sleep(PAUSE)
    return r if r.status_code == 200 else None


def _money(v: Any) -> float | None:
    try:
        n = float(str(v).replace("US$", "").replace("$", "").replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return round(n, 2) if n > 0 else None


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60]


def _deal(brand: str, key: str, name: str, price: float, was: float, url: str,
          image: str | None, category: str, stamp: str, hint: str = "") -> dict[str, Any]:
    return {
        "id": f"brand-{_slug(brand)}-{_slug(key)}",
        "name": name, "category": category, "price": price, "previousPrice": was,
        "lastPrice": None, "priceDropped": False, "currency": "USD",
        "why": f"On sale on {brand}'s own site: ${price:,.2f}, regularly ${was:,.2f}. "
               "Confirm the cart total before buying.",
        "merchant": brand, "url": url, "urlKind": "product",
        "sku": f"{_slug(brand).upper()}-{_slug(key).upper()}",
        "image": image, "imageSource": "brand-site",
        "verifiedAt": stamp, "updatedAt": stamp, "source": "brand-site",
        "brandHint": hint.strip(),  # the brand store's own section, used to re-check the tab
    }


def _on_sale(price: float | None, was: float | None) -> bool:
    return bool(price and was and was > price and (was - price) / was >= MIN_DISCOUNT)


# ---------------------------------------------------------------- shopify
def shopify(store: dict[str, Any], s: requests.Session, classify: Callable, stamp: str,
            log: dict[str, Any]) -> list[dict[str, Any]]:
    base = store["base"].rstrip("/")
    out = []
    for page in range(1, 5):
        r = _get(s, f"{base}/products.json?limit=250&page={page}")
        if r is None:
            if page == 1:
                log["error"] = "products.json not reachable"
            break
        try:
            products = r.json().get("products") or []
        except ValueError:
            log["error"] = "products.json not JSON"
            break
        for p in products:
            ptype = str(p.get("product_type") or "")
            if SKIP_TYPES.search(ptype) or not p.get("images"):
                continue
            sale = [v for v in p.get("variants") or []
                    if v.get("available", True) and _on_sale(_money(v.get("price")), _money(v.get("compare_at_price")))]
            if not sale:
                continue
            v = min(sale, key=lambda v: _money(v["price"]) or 1e9)
            price, was = _money(v["price"]), _money(v["compare_at_price"])
            name = p.get("title") or ""
            if store["brand"].lower() not in name.lower():
                name = f"{store['brand']} {name}"
            cat = _sort_into_tab(classify, name, f"{ptype} {store.get('hint', '')}", price)
            if not cat:
                continue
            out.append(_deal(store["brand"], str(p.get("handle") or p.get("id")), name, price, was,
                             f"{base}/products/{p.get('handle')}", p["images"][0].get("src"), cat, stamp,
                             f"{ptype} {store.get('hint', '')}"))
        if len(products) < 250:
            break
    return out


# ---------------------------------------------------------------- logitech
TILE = re.compile(
    r'<a href="(/[a-z-]+/shop/p/[^"]+)"[^>]*card-link[^>]*>\s*<h2[^>]*>(.*?)</h2>\s*(?:<p[^>]*>(.*?)</p>)?',
    re.S)
PRICES = re.compile(r'<span>\$([\d,]+\.\d\d)</span>\s*<span class="line-through[^"]*">\$([\d,]+\.\d\d)</span>')


def _jsonld_product(html: str) -> dict[str, Any]:
    for block in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.S):
        try:
            data = json.loads(block)
        except ValueError:
            continue
        for d in data if isinstance(data, list) else [data]:
            if isinstance(d, dict) and d.get("@type") == "Product":
                return d
    return {}


def _image_of(ld: dict[str, Any]) -> str | None:
    img = ld.get("image")
    if isinstance(img, list):
        img = img[0] if img else None
    if isinstance(img, dict):
        img = img.get("url")
    return img if isinstance(img, str) and img.startswith("http") else None


def logitech(store: dict[str, Any], s: requests.Session, classify: Callable, stamp: str,
             log: dict[str, Any]) -> list[dict[str, Any]]:
    base = store["base"].rstrip("/")
    out, seen = [], set()
    for path, hint in store["paths"].items():
        r = _get(s, base + path)
        if r is None:
            log.setdefault("missing", []).append(path)
            continue
        page = re.sub(r"<!--.*?-->", "", r.text)
        tiles = list(TILE.finditer(page))
        for i, m in enumerate(tiles):
            href, name = m.group(1), htmlmod.unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip()
            end = tiles[i + 1].start() if i + 1 < len(tiles) else len(page)
            pm = PRICES.search(page, m.end(), end)
            if not pm or href in seen:
                continue
            price, was = _money(pm.group(1)), _money(pm.group(2))
            if not _on_sale(price, was):
                continue
            seen.add(href)
            full = f"{store['brand']} {name}" if store["brand"].lower() not in name.lower() else name
            cat = _sort_into_tab(classify, full, hint, price)
            if not cat:
                continue
            pr = _get(s, base + href)  # product page: photo (and confirms it exists)
            if pr is None:
                continue
            img = _image_of(_jsonld_product(pr.text))
            if not img:
                continue
            out.append(_deal(store["brand"], href.rsplit("/", 1)[-1], full, price, was,
                             base + href, img, cat, stamp, hint))
    return out


# ---------------------------------------------------------------- razer
def razer(store: dict[str, Any], s: requests.Session, classify: Callable, stamp: str,
          log: dict[str, Any], state: dict[str, Any]) -> list[dict[str, Any]]:
    base = store["base"].rstrip("/")
    urls = state.get("razerUrls") or []
    if not urls or state.get("razerUrlsAt", "") < (datetime.now(timezone.utc) - timedelta(days=7)).isoformat():
        sections = "|".join(re.escape(k) for k in store["sections"])
        found: list[str] = []
        queue = [store["sitemap"]] + store.get("extraSitemaps", [])
        visited = 0
        while queue and visited < 12:
            sm = queue.pop(0)
            visited += 1
            r = _get(s, sm)
            if r is None:
                continue
            if "<sitemapindex" in r.text:  # an index: follow its child sitemaps
                queue.extend(htmlmod.unescape(x).strip() for x in re.findall(r"<loc>([^<]+)</loc>", r.text))
                continue
            for loc in re.findall(r"<loc>([^<]+)</loc>", r.text):
                if re.search(rf"razer\.com/({sections})/[^/?#]+/?$", loc) and "/buy" not in loc:
                    found.append(loc.strip())
        urls = sorted(set(found))
        state["razerUrls"], state["razerUrlsAt"] = urls, datetime.now(timezone.utc).isoformat()
    if not urls:
        log["error"] = "no product URLs in sitemap"
        return []
    # a rotating batch each refresh; sales found earlier stay until re-checked
    per = int(store.get("perRun", 30))
    cursor = int(state.get("razerCursor", 0)) % len(urls)
    batch = (urls + urls)[cursor:cursor + per]
    state["razerCursor"] = (cursor + per) % len(urls)
    prev = {d["url"]: d for d in state.get("razerSales", [])}
    for url in batch:
        prev.pop(url, None)
        r = _get(s, url)
        if r is None:
            continue
        page = r.text
        mk = RAZER_PRICE.search(page)
        if not mk:
            continue
        was, price = _money(mk.group(1)), _money(mk.group(2))
        if not _on_sale(price, was):
            continue
        ld = _jsonld_product(page)
        name, img = str(ld.get("name") or ""), _image_of(ld)
        section = re.search(r"razer\.com/([^/]+)/", url)
        hint = store["sections"].get(section.group(1), "") if section else ""
        cat = _sort_into_tab(classify, name, hint, price) if name else None
        if cat and img:
            prev[url] = _deal(store["brand"], url.rstrip("/").rsplit("/", 1)[-1], name, price, was,
                              url, img, cat, stamp, hint)
    state["razerSales"] = list(prev.values())
    log["checked"] = len(batch)
    return state["razerSales"]


# ---------------------------------------------------------------- main
def refresh(classify: Callable[[str, str, float], str | None], now: datetime) -> list[dict[str, Any]]:
    """Return current brand-site sales, re-reading the stores when due."""
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        state = json.loads(SALES_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    fetched = state.get("fetchedAt")
    if fetched and datetime.fromisoformat(fetched.replace("Z", "+00:00")) > now - timedelta(hours=FETCH_EVERY_HOURS):
        # cached sales are re-sorted every run, so rule fixes apply right away
        out = []
        for d in state.get("deals") or []:
            cat = _sort_into_tab(classify, d.get("name", ""), d.get("brandHint", ""), float(d.get("price") or 0))
            if cat:
                d["category"] = cat
                out.append(d)
        return out
    stores = json.loads(STORES_PATH.read_text(encoding="utf-8"))["stores"]
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
    deals: list[dict[str, Any]] = []
    logs: dict[str, Any] = {}
    for store in stores:
        log: dict[str, Any] = {}
        try:
            if store["type"] == "shopify":
                found = shopify(store, s, classify, stamp, log)
            elif store["type"] == "logitech":
                found = logitech(store, s, classify, stamp, log)
            elif store["type"] == "razer":
                found = razer(store, s, classify, stamp, log, state)
            else:
                continue
        except Exception as e:  # noqa: BLE001 — one store failing never stops the rest
            log["error"] = f"{type(e).__name__}: {e}"[:200]
            found = []
        log["onSale"] = len(found)
        logs[store["brand"]] = log
        deals.extend(found)
        print(f"  brand sales: {store['brand']}: {log}")
    state.update({"fetchedAt": stamp, "deals": deals, "log": logs})
    SALES_PATH.write_text(json.dumps(state, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return deals
