#!/usr/bin/env python3
"""
Daily automated refresh for What's A Good Deal?  (runs in GitHub Actions)

What it does, without a human:
  1. Re-verifies every Newegg deal against Newegg's public product-search
     JSON API (the same API the live Search Worker uses). Price, was-price,
     rating and stock come straight from Newegg — never invented.
  2. Re-verifies Denon deals from the product page's schema.org JSON-LD.
  3. Prunes anything that could not be verified within STALE_DAYS (retailers
     that block automated checks, discontinued / out-of-stock listings),
     and clears sale end dates that have already passed.
  4. Tops every category back up with fresh, discounted, in-stock Newegg
     listings so the catalogue keeps rotating.
  5. Stamps updatedAt / weekLabel / lastRefresh and deletes orphaned photos.

Safety: if the Newegg API is unreachable (0 verified), it exits non-zero and
writes nothing, so a bad run can never wipe the site.

Usage:
  python3 scripts/daily_refresh.py
  python3 scripts/daily_refresh.py --dry-run
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from refresh import apply_verified_price, week_label_now  # noqa: E402

DEALS_PATH = ROOT / "data" / "deals.json"
IMAGES_DIR = ROOT / "images"
MCP_URL = "https://apis.newegg.com/ex-mcp/endpoint/product-search"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
STALE_DAYS = 3          # drop deals not re-verified for this long
TARGET_PER_CAT = 10     # top categories up to this many deals
MAX_PER_CAT = 16        # trim weakest (no discount) beyond this
MIN_RATING = 3.5        # skip poorly rated seeds (unrated allowed)

BAD_TITLE = re.compile(
    r"\b(refurbished|renewed|open[- ]box|used|pre-owned|for parts|bundle with gift card)\b",
    re.I,
)

# category -> (queries, title must match, title must NOT match, price floor)
SEEDS: dict[str, tuple[list[str], str, str | None, float]] = {
    "GPUs": (["geforce rtx 5070 graphics card", "radeon rx 9070 graphics card",
              "geforce rtx 5060 ti graphics card", "geforce rtx 5080 graphics card"],
             r"graphics card|video card", r"desktop|laptop|gaming pc|bracket|riser|cable", 200),
    "CPUs": (["amd ryzen 7 desktop processor", "amd ryzen 9 desktop processor",
              "intel core ultra desktop processor"],
             r"processor|\bcpu\b",
             r"gaming desktop|desktop (pc|computer)|gaming pc|laptop|cooler|bundle|combo|motherboard|\b\d+ ?GB\b|alienware", 90),
    "Monitors": (["27 inch gaming monitor", "oled gaming monitor", "1440p 165hz monitor"],
                 r"monitor", r"\barm\b|mount|stand only|cable", 120),
    "TVs": (["4k smart tv", "oled tv", "qled tv", "samsung 4k tv", "sony bravia tv", "tcl qled tv", "hisense 4k tv"],
            r"\btv\b|television", r"mount|\bstand\b|remote|antenna|stanbyme|battery|monitor", 250),
    "Home Theater": (["soundbar", "av receiver", "home theater speaker system"],
                     r"sound ?bar|receiver|speaker|subwoofer|home theater", r"mount|cable|bracket|car ", 80),
    "Art Tablets": (["pen display drawing tablet", "xp-pen drawing tablet", "wacom tablet", "huion drawing tablet"],
                    r"drawing|graphics? tablet|pen display|pen tablet|creative tablet",
                    r"ipad|android|surface|windows|snapdragon|\bssd\b|case|cover|glove|film|protector|stand", 40),
    "PSUs": (["850w atx power supply", "1000w atx 3.1 power supply", "750w modular power supply"],
             r"power supply|\bpsu\b", r"ups|battery|cable|extension", 50),
    "Cases": (["mid tower computer case", "atx pc case tempered glass"],
              r"\b(case|chassis|tower)\b", r"fan only|laptop|phone|ssd|enclosure|carrying", 35),
    "Motherboards": (["AM5 B650 motherboard", "AM5 X870 motherboard", "intel Z890 motherboard"],
                     r"motherboard", r"bundle|combo|cpu", 70),
    "RAM": (["DDR5 32GB desktop memory kit", "DDR5 64GB desktop memory"],
            r"\bDDR[45]\b", r"so-?dimm|laptop|server|ecc", 45),
    "SSDs": (["NVMe M.2 SSD 2TB", "NVMe M.2 SSD 1TB", "NVMe M.2 SSD 4TB"],
             r"\b(SSD|solid state)\b", r"enclosure|adapter|external|portable|heatsink only", 35),
    "Phones": (["unlocked smartphone", "samsung galaxy unlocked", "google pixel unlocked", "iphone unlocked"],
               r"phone|galaxy|pixel|iphone", r"case|protector|charger|cable|mount|holder|tablet|watch|earbuds", 150),
    "Laptops": (["gaming laptop rtx", "msi gaming laptop", "asus rog laptop", "lenovo legion laptop"],
                r"(laptop|notebook).*(gaming|rtx|rog|legion|omen|predator|alienware|tuf|nitro|katana|cyborg|raider|vector|stealth|strix|zephyrus)"
                r"|(gaming|rtx|rog|legion|omen|predator|alienware|tuf|nitro|katana|cyborg|raider|vector|stealth|strix|zephyrus).*(laptop|notebook)",
                r"bag|sleeve|stand|cooling pad|charger|adapter|skin|thinkpad", 400),
    "Mice": (["wireless gaming mouse", "gaming mouse"], r"\bmouse\b|\bmice\b", r"pad|mat|bungee|feet|grip tape", 20),
    "Keyboards": (["mechanical gaming keyboard", "wireless mechanical keyboard"],
                  r"keyboard", r"bundle|combo|keycaps? only|wrist rest|switches only|piano|tablet case|mouse", 30),
}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s: Any) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


# ---------------------------------------------------------------- Newegg API
class Newegg:
    def __init__(self) -> None:
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": UA, "Accept": "application/json",
            "Origin": "https://www.newegg.com", "Referer": "https://www.newegg.com/",
        })
        self.calls = 0
        self.ok_calls = 0

    def search(self, query: str, order: int = 8, page: int = 1) -> list[dict[str, Any]]:
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": "newegg product search",
                           "arguments": {"query": query, "page": page, "order": order}}}
        for attempt in range(3):
            self.calls += 1
            try:
                r = self.s.post(MCP_URL, json=body, timeout=30)
                if r.status_code == 200:
                    rpc = r.json()
                    text = (((rpc.get("result") or {}).get("content") or [{}])[0]).get("text")
                    if text:
                        self.ok_calls += 1
                        return list(json.loads(text).get("products") or [])
            except (requests.RequestException, ValueError, KeyError, IndexError):
                pass
            time.sleep(1.5 * (attempt + 1))
        return []


def item_to_sku(item_number: str) -> str:
    cleaned = str(item_number).replace("-", "")
    return ("N82E168" + cleaned).upper() if re.fullmatch(r"\d{8,}", cleaned) else str(item_number).upper()


def sku_from_url(url: str) -> str | None:
    m = re.search(r"/p/((?:N82E168)?[0-9A-Z-]{8,})", url or "", re.I)
    return m.group(1).upper() if m else None


def product_url(item_number: str) -> str:
    return "https://www.newegg.com/p/" + item_to_sku(item_number)


def image_url(p: dict[str, Any]) -> str | None:
    name = str(p.get("ImageName") or "").lstrip("/")
    if not name:
        return None
    if name.startswith("http"):
        return name
    return "https://c1.neweggimages.com/ProductImageCompressAll1280/" + name


def offer(p: dict[str, Any]) -> dict[str, Any] | None:
    """Price/was/rating from an API product, or None when not purchasable."""
    pr = p.get("Price") or {}
    try:
        price = float(pr.get("FinalPrice"))
    except (TypeError, ValueError):
        return None
    if price <= 0 or p.get("LimitQuantity") == 0 or p.get("IsRefurbished"):
        return None
    was = None
    rebate = pr.get("InstantRebateAmount") or 0
    pct = pr.get("PriceSavePercent") or 0
    if rebate and float(rebate) > 0:
        was = round(price + float(rebate), 2)
    elif pct and 0 < float(pct) < 90:
        was = round(price / (1 - float(pct) / 100), 2)
    if was is not None and was <= price:
        was = None
    rating = pr.get("RatingOneDecimal")
    count = pr.get("HumanRating")
    return {
        "price": round(price, 2), "was": was,
        "rating": round(float(rating), 1) if rating else None,
        "count": int(count) if count else None,
    }


def short_query(name: str, words: int) -> str:
    toks = re.sub(r"[^\w.+\-\" ]", " ", name).split()
    return " ".join(toks[:words])


def verify_newegg(api: Newegg, deal: dict[str, Any]) -> dict[str, Any] | None:
    sku = (deal.get("sku") or sku_from_url(deal.get("url", "")) or "").upper()
    if not sku:
        return None
    for q in (deal.get("name", ""), short_query(deal.get("name", ""), 7), short_query(deal.get("name", ""), 4)):
        if not q.strip():
            continue
        for p in api.search(q):
            if item_to_sku(p.get("ItemNumber", "")) == sku or str(p.get("ItemNumber", "")).upper() == sku:
                return {"product": p, "offer": offer(p)}
        time.sleep(0.3)
    return None


# ---------------------------------------------------------------- Denon
def verify_jsonld_price(url: str) -> float | None:
    try:
        r = requests.get(url, headers={"User-Agent": UA, "Accept-Language": "en-US"}, timeout=25)
    except requests.RequestException:
        return None
    if r.status_code != 200:
        return None
    prices: list[float] = []
    for block in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', r.text, re.S):
        try:
            data = json.loads(block)
        except ValueError:
            continue
        stack = [data]
        while stack:
            o = stack.pop()
            if isinstance(o, list):
                stack.extend(o)
            elif isinstance(o, dict):
                if o.get("@type") in ("Offer", "AggregateOffer"):
                    avail = str(o.get("availability", ""))
                    if "OutOfStock" in avail or "Discontinued" in avail:
                        return None
                    try:
                        v = float(str(o.get("price") or o.get("lowPrice")).replace(",", ""))
                        if v > 0:
                            prices.append(v)
                    except ValueError:
                        pass
                stack.extend(o.values())
    return min(prices) if len(set(prices)) == 1 else None


# ---------------------------------------------------------------- helpers
def why_line(price: float, was: float | None) -> str:
    s = f"Newegg price ${price:,.2f}"
    if was:
        s += f", down from ${was:,.2f} (save ${was - price:,.2f})."
    else:
        s += "."
    return s + " Verified by the daily refresh — confirm the cart total before buying."


def slugify(title: str, sku: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:48].strip("-")
    return f"{base}-{sku[-6:].lower()}"


def savings_pct(d: dict[str, Any]) -> float:
    try:
        p, w = float(d["price"]), float(d.get("previousPrice") or 0)
    except (TypeError, ValueError, KeyError):
        return 0.0
    return (w - p) / w if w > p else 0.0


def apply_offer(deal: dict[str, Any], prod: dict[str, Any], off: dict[str, Any], stamp: str) -> None:
    apply_verified_price(deal, off["price"])
    deal["previousPrice"] = off["was"]
    deal["verifiedAt"] = stamp
    deal["updatedAt"] = stamp
    if off["rating"]:
        deal["rating"] = off["rating"]
        deal["ratingSource"] = "newegg-api"
        if off["count"]:
            deal["ratingCount"] = off["count"]
    if not deal.get("image"):
        img = image_url(prod)
        if img:
            deal["image"] = img
            deal["imageSource"] = "newegg-api"
    if deal.get("merchant") == "Newegg":
        deal["why"] = why_line(off["price"], off["was"])


def fits_category(d: dict[str, Any]) -> bool:
    spec = SEEDS.get(str(d.get("category")))
    if not spec:
        return True
    _, must, mustnot, floor = spec
    title = str(d.get("name") or "")
    if not re.search(must, title, re.I) or BAD_TITLE.search(title):
        return False
    if mustnot and re.search(mustnot, title, re.I):
        return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-seed", action="store_true")
    args = ap.parse_args()

    data = json.loads(DEALS_PATH.read_text(encoding="utf-8"))
    deals: list[dict[str, Any]] = list(data.get("deals") or [])
    before = len(deals)
    now = now_utc()
    stamp = iso(now)
    api = Newegg()
    stats: Counter = Counter()
    removed: list[str] = []

    # 1-2. re-verify
    for d in deals:
        merchant = d.get("merchant")
        if merchant == "Newegg":
            res = verify_newegg(api, d)
            if res is None:
                stats["newegg_not_found"] += 1
            elif res["offer"] is None:
                d["_unavailable"] = True
                stats["newegg_unavailable"] += 1
            else:
                apply_offer(d, res["product"], res["offer"], stamp)
                stats["newegg_verified"] += 1
        elif merchant == "Denon":
            price = verify_jsonld_price(d.get("url", ""))
            if price:
                apply_verified_price(d, price)
                if d.get("previousPrice") and float(d["previousPrice"]) <= price:
                    d["previousPrice"] = None
                d["verifiedAt"] = d["updatedAt"] = stamp
                stats["denon_verified"] += 1
        time.sleep(0.2)

    if api.ok_calls == 0:
        print("Newegg API unreachable — aborting without writing.", file=sys.stderr)
        return 2

    # 3. prune
    cutoff = now - timedelta(days=STALE_DAYS)
    kept = []
    for d in deals:
        last = parse_iso(d.get("verifiedAt"))
        if d.pop("_unavailable", False):
            removed.append(f"{d.get('id')} (out of stock)")
            continue
        if last is None or last < cutoff:
            removed.append(f"{d.get('id')} (unverified since {d.get('verifiedAt') or 'before automation'})")
            continue
        if d.get("autoSeeded") and not fits_category(d):
            removed.append(f"{d.get('id')} (no longer matches {d.get('category')} filters)")
            continue
        ends = parse_iso(d.get("endsAt"))
        if ends and ends < now:
            d.pop("endsAt", None)
            st = parse_iso(d.get("startsAt"))
            if st and st < now:
                d.pop("startsAt", None)
            stats["expired_dates_cleared"] += 1
        kept.append(d)
    deals = kept

    # 4. seed
    added = 0
    if not args.no_seed:
        have = {(d.get("sku") or "").upper() for d in deals} | {
            (sku_from_url(d.get("url", "")) or "") for d in deals}
        names = {re.sub(r"\W+", "", d.get("name", "").lower())[:60] for d in deals}
        counts = Counter(d.get("category") for d in deals)
        ids = {d.get("id") for d in deals}
        for cat, (queries, must, mustnot, floor) in SEEDS.items():
            need = TARGET_PER_CAT - counts[cat]
            if need <= 0:
                continue
            must_re = re.compile(must, re.I)
            not_re = re.compile(mustnot, re.I) if mustnot else None
            cands = []
            for q in queries:
                for p in api.search(q):
                    title = str(p.get("WebDescription") or "").strip()
                    off = offer(p)
                    if not title or off is None or off["price"] < floor:
                        continue
                    if not must_re.search(title) or (not_re and not_re.search(title)) or BAD_TITLE.search(title):
                        continue
                    if off["rating"] is not None and off["rating"] < MIN_RATING:
                        continue
                    sku = item_to_sku(p.get("ItemNumber", ""))
                    key = re.sub(r"\W+", "", title.lower())[:60]
                    if not sku or sku in have or key in names:
                        continue
                    if not image_url(p):
                        continue
                    cands.append((p, off, sku, title, key))
                time.sleep(0.3)
            # discounted first, then classic Newegg SKUs, then ratings
            cands.sort(key=lambda c: (
                -(((c[1]["was"] or c[1]["price"]) - c[1]["price"]) / (c[1]["was"] or c[1]["price"])),
                0 if c[2].startswith("N82E168") else 1,
                -(c[1]["rating"] or 0) * (min(c[1]["count"] or 0, 200) / 200),
            ))
            for p, off, sku, title, key in cands:
                if need <= 0:
                    break
                if sku in have or key in names:
                    continue
                did = slugify(title, sku)
                n = 2
                while did in ids:
                    did = f"{slugify(title, sku)}-{n}"
                    n += 1
                deal = {
                    "id": did, "name": title[:140], "category": cat,
                    "price": off["price"], "previousPrice": off["was"],
                    "lastPrice": None, "priceDropped": False, "currency": "USD",
                    "why": why_line(off["price"], off["was"]), "merchant": "Newegg",
                    "url": product_url(p["ItemNumber"]), "urlKind": "product", "sku": sku,
                    "image": image_url(p), "imageSource": "newegg-api",
                    "verifiedAt": stamp, "updatedAt": stamp, "autoSeeded": True,
                }
                if off["rating"]:
                    deal["rating"] = off["rating"]
                    deal["ratingSource"] = "newegg-api"
                    if off["count"]:
                        deal["ratingCount"] = off["count"]
                deals.append(deal)
                have.add(sku)
                names.add(key)
                ids.add(did)
                counts[cat] += 1
                need -= 1
                added += 1
                print(f"  + [{cat}] ${off['price']:,.2f} {title[:70]}")

    # trim oversized categories: drop weakest (smallest discount) beyond MAX
    by_cat: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for d in deals:
        by_cat[str(d.get("category"))].append(d)
    trimmed = []
    for cat, lst in by_cat.items():
        lst.sort(key=savings_pct, reverse=True)
        trimmed.extend(lst[:MAX_PER_CAT])
        for d in lst[MAX_PER_CAT:]:
            removed.append(f"{d.get('id')} (category trim)")
    deals = trimmed

    data["deals"] = deals
    data["updatedAt"] = stamp
    data["weekLabel"] = week_label_now(now)
    data["catalogueRevision"] = int(data.get("catalogueRevision", 0)) + 1
    data["lastRefresh"] = {
        "at": stamp, "source": "daily_refresh", "before": before, "after": len(deals),
        "added": added, "removed": len(removed), **dict(stats),
        "apiCalls": api.calls,
    }

    print(json.dumps(data["lastRefresh"], indent=2))
    for r in removed:
        print("  -", r)
    print("Per category:", dict(Counter(d["category"] for d in deals)))
    if args.dry_run:
        return 0

    DEALS_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    # delete photos no deal references any more
    used = {d.get("image") for d in deals}
    gone = 0
    for f in IMAGES_DIR.glob("*"):
        if f.is_file() and f"images/{f.name}" not in used:
            f.unlink()
            gone += 1
    print(f"Wrote {DEALS_PATH} ({len(deals)} deals); removed {gone} orphaned photos")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
