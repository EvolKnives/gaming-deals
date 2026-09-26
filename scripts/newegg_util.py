#!/usr/bin/env python3
"""Shared Newegg fetch helpers for catalogue refresh / search ingest.

Never invents prices. Prefer Sold-by-Newegg in-stock FinalPrice when present.
Rejects clearly dead / OOS / not-found listings.
"""

from __future__ import annotations

import html as htmllib
import json
import re
import time
from typing import Any
from urllib.parse import quote_plus

import requests

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

NEWEGG_ITEM_RE = re.compile(r"(N82E168[0-9]{8,})", re.I)


def session() -> requests.Session:
    s = requests.Session()
    s.headers.update(
        {
            "User-Agent": UA,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml",
        }
    )
    return s


def fetch_html(s: requests.Session, url: str, timeout: int = 25) -> tuple[str | None, int, str]:
    try:
        r = s.get(url, timeout=timeout, allow_redirects=True)
    except requests.RequestException:
        return None, 0, url
    return r.text, r.status_code, str(r.url)


def _plausible_price(candidates: list[float], floor: float = 15.0) -> float | None:
    prices = sorted({round(p, 2) for p in candidates if p is not None and p >= floor})
    if not prices:
        return None
    if len(prices) == 1:
        return prices[0]
    hi = prices[-1]
    # Drop junk teaser prices (e.g. $19.99) sitting next to a real $159 offer.
    plausible = [p for p in prices if p >= hi * 0.35]
    if not plausible:
        return None
    # Best (lowest) among plausible.
    return min(plausible)


def parse_newegg_listing_price(html: str) -> dict[str, Any]:
    """Extract a verified price + stock signal from a Newegg product HTML page."""
    out: dict[str, Any] = {
        "ok": False,
        "reason": None,
        "price": None,
        "previousPrice": None,
        "og": None,
        "instock": None,
    }
    if not html:
        out["reason"] = "empty"
        return out
    if re.search(r"Page Not Found|does not exist", html, re.I):
        out["reason"] = "not-found"
        return out

    for pat in (
        r'property=["\']og:image["\']\s+content=["\']([^"\']+)["\']',
        r'content=["\']([^"\']+)["\']\s+property=["\']og:image["\']',
    ):
        m = re.search(pat, html, re.I)
        if m:
            out["og"] = m.group(1)
            break

    offers: list[dict[str, Any]] = []
    for m in re.finditer(
        r"\{[^{}]{0,900}\"FinalPrice\"\s*:\s*([0-9.]+)[^{}]{0,900}\}", html
    ):
        chunk = m.group(0)
        try:
            fp = float(m.group(1))
        except ValueError:
            continue
        sold = re.search(r'"SoldByNewegg"\s*:\s*(true|false)', chunk, re.I)
        inst = re.search(r'"Instock"\s*:\s*(true|false)', chunk, re.I)
        offers.append(
            {
                "price": fp,
                "sold_by_newegg": (sold.group(1).lower() == "true") if sold else None,
                "instock": (inst.group(1).lower() == "true") if inst else None,
            }
        )

    instock_flags = re.findall(r'"Instock"\s*:\s*(true|false)', html, re.I)
    instock_any = any(x.lower() == "true" for x in instock_flags) if instock_flags else None
    out["instock"] = instock_any

    if instock_any is False:
        out["reason"] = "oos"
        return out

    preferred = [
        o["price"]
        for o in offers
        if o.get("sold_by_newegg") and o.get("instock") is not False
    ]
    all_fps = [float(x) for x in re.findall(r'"FinalPrice"\s*:\s*([0-9.]+)', html)]
    price = _plausible_price(preferred or all_fps)

    if price is None:
        m = re.search(
            r"price-current[^>]*>.*?<strong>([0-9,]+)</strong>\s*<sup>\.?([0-9]+)</sup>",
            html,
            re.I | re.S,
        )
        if m:
            price = float(m.group(1).replace(",", "") + "." + m.group(2))

    if price is None:
        out["reason"] = "no-price"
        return out

    was = None
    m = re.search(
        r"price-was[^>]*>.*?\$[\s]*([0-9,]+(?:\.[0-9]+)?)", html, re.I | re.S
    )
    if m:
        try:
            was = float(m.group(1).replace(",", ""))
        except ValueError:
            was = None
    if was is not None and was <= price:
        was = None

    out["ok"] = True
    out["price"] = round(price, 2)
    out["previousPrice"] = round(was, 2) if was else None
    out["reason"] = "ok"
    return out


def classify_listing(url: str, html: str | None, status: int) -> str:
    """Return keep | dead | oos | broken for prune decisions."""
    if status == 0 or status >= 500:
        return "broken"
    if status == 404:
        return "dead"
    if status >= 400:
        return "broken"
    if not html:
        return "broken"
    if re.search(r"Page Not Found|does not exist", html, re.I):
        return "dead"
    info = parse_newegg_listing_price(html)
    if info["reason"] == "not-found":
        return "dead"
    if info["reason"] == "oos":
        return "oos"
    if info["ok"]:
        return "keep"
    # Non-Newegg or blocked: keep unless clearly dead.
    if re.search(r">\s*OUT OF STOCK\s*<", html, re.I) and "ChangeToOutOfStock" not in html:
        return "oos"
    return "keep"


def search_newegg(
    s: requests.Session,
    query: str,
    title_re: re.Pattern[str] | None = None,
    min_price: float = 20.0,
    max_n: int = 30,
) -> list[dict[str, Any]]:
    url = "https://www.newegg.com/p/pl?d=" + quote_plus(query)
    html, status, _ = fetch_html(s, url, timeout=30)
    if not html or status >= 400:
        return []
    containers = re.findall(
        r'class="item-container[^"]*"(.*?)(?=class="item-container|</html>)',
        html,
        re.S | re.I,
    )
    parsed: list[dict[str, Any]] = []
    seen: set[str] = set()
    for cell in containers:
        href = re.search(
            r'href="(https://www\.newegg\.com/[^"]+/p/(N82E168[0-9]+))"', cell, re.I
        )
        if not href:
            continue
        sku = href.group(2).upper()
        if sku in seen:
            continue
        title = None
        img = re.search(r'<img[^>]+(?:title|alt)="([^"]+)"', cell, re.I)
        if img:
            title = htmllib.unescape(img.group(1)).strip()
        if not title:
            tm = re.search(r'class="item-title"[^>]*>(.*?)</a>', cell, re.I | re.S)
            if tm:
                title = htmllib.unescape(re.sub(r"<[^>]+>", "", tm.group(1))).strip()
        price = None
        m = re.search(
            r"price-current[^>]*>.*?<strong>([0-9,]+)</strong>\s*<sup>\.?([0-9]+)</sup>",
            cell,
            re.I | re.S,
        )
        if m:
            price = float(m.group(1).replace(",", "") + "." + m.group(2))
        else:
            m = re.search(
                r"price-current[^>]*>.*?\$[\s]*([0-9,]+(?:\.[0-9]+)?)",
                cell,
                re.I | re.S,
            )
            if m:
                price = float(m.group(1).replace(",", ""))
        was = None
        m = re.search(
            r"price-was[^>]*>.*?\$[\s]*([0-9,]+(?:\.[0-9]+)?)", cell, re.I | re.S
        )
        if m:
            was = float(m.group(1).replace(",", ""))
        if not title or price is None or price < min_price:
            continue
        if title_re and not title_re.search(title):
            continue
        seen.add(sku)
        parsed.append(
            {
                "sku": sku,
                "url": href.group(1),
                "title": title,
                "price": price,
                "previousPrice": was if was and was > price else None,
            }
        )
        if len(parsed) >= max_n:
            break
    return parsed


def slugify(title: str, sku: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", title.lower())
    base = re.sub(r"-{2,}", "-", base).strip("-")[:48].strip("-")
    short = sku[-6:].lower()
    return f"{base}-{short}" if base else f"item-{short}"


def sleep_polite(sec: float = 0.4) -> None:
    time.sleep(sec)
