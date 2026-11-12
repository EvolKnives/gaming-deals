#!/usr/bin/env python3
"""
Hourly automated refresh for What's A Good Deal?  (runs in GitHub Actions)

What it does, without a human:
  1. Re-verifies every current Newegg deal against Newegg's public product-search
     JSON API (the same API the live Search Worker uses). Price, was-price,
     rating and stock come straight from Newegg — never invented.
  2. Re-verifies Denon deals from the product page's schema.org JSON-LD.
  3. Prunes anything that could not be verified within STALE_DAYS calendar
     days (not job runs — still 3 days even when this job is hourly). Upcoming
     Future deals (startsAt still in the future) are kept without a Newegg
     price check. Once the sale starts they are moved to the live catalogue
     if verifiable, or kept until endsAt and then dropped.
  4. Tops every category back up with fresh, discounted, in-stock Newegg
     listings so the catalogue keeps rotating.
  5. Stamps updatedAt / weekLabel / lastRefresh and deletes orphaned photos
     only when deal data meaningfully changed (prices, membership, dates) —
     timestamp-only bumps are not written, so hourly runs do not spam commits.

Safety: if the Newegg API is unreachable, or returns 403/429, the script
exits non-zero and writes nothing, so a bad or throttled run can never wipe
the site.

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
STALE_DAYS = 3          # drop unverifiable deals after this many calendar days (not runs)
TARGET_PER_CAT = 20     # top categories up to this many deals (per-category "target" overrides)
MAX_PER_CAT = 24        # trim weakest (no discount) beyond this
VERIFY_EVERY_HOURS = 3  # each deal is re-checked on a rotation, about a third per hourly run
MIN_RATING = 3.5        # skip poorly rated seeds (unrated allowed)

BAD_TITLE = re.compile(
    r"\b(refurbished|renewed|open[- ]box|used|pre-owned|for parts|bundle with gift card)\b",
    re.I,
)

# category -> (queries, title must match, title must NOT match, price floor).
# Rules live in data/category-rules.json, shared with the Search Worker.
RULES_PATH = ROOT / "data" / "category-rules.json"
_RULES = json.loads(RULES_PATH.read_text(encoding="utf-8"))["seeds"]
SEEDS: dict[str, tuple[list[str], str, str | None, float]] = {
    r["category"]: (r["queries"], r["titleMust"], r.get("titleMustNot"), float(r["minPrice"]))
    for r in _RULES
}
TARGETS: dict[str, int] = {r["category"]: int(r.get("target", TARGET_PER_CAT)) for r in _RULES}


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


def is_upcoming(d: dict[str, Any], now: datetime) -> bool:
    """True when startsAt is still in the future (Future-tab deals)."""
    st = parse_iso(d.get("startsAt"))
    return st is not None and st > now


def catalogue_fingerprint(data: dict[str, Any]) -> str:
    """Stable snapshot of deal contents, ignoring check-time stamps."""
    rows = []
    for d in data.get("deals") or []:
        rows.append({
            k: d.get(k)
            for k in (
                "id", "name", "category", "price", "previousPrice", "lastPrice",
                "priceDropped", "url", "sku", "merchant", "startsAt", "endsAt",
                "promoCode", "image", "sourceUrl",
            )
        })
    rows.sort(key=lambda r: str(r.get("id") or ""))
    return json.dumps(rows, sort_keys=True, default=str)


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
        self.rate_limited = None  # HTTP 403/429, if the API asked us to back off

    def search(self, query: str, order: int = 8, page: int = 1) -> list[dict[str, Any]]:
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": "newegg product search",
                           "arguments": {"query": query, "page": page, "order": order}}}
        for attempt in range(3):
            self.calls += 1
            try:
                r = self.s.post(MCP_URL, json=body, timeout=30)
                if r.status_code in (403, 429):
                    self.rate_limited = r.status_code
                    return []
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


# Words that describe a category rather than a specific product; ignored when
# matching an upcoming deal's name to a Newegg listing for its photo.
GENERIC_WORDS = {
    "gaming", "monitor", "class", "with", "and", "the", "for", "inch", "smart",
    "wireless", "speaker", "bundle", "desktop", "curved", "ultrawide", "ultra",
    "channel", "soundbar", "pack", "month", "pass", "plus", "intel", "core",
    "amd", "ryzen", "geforce", "rtx", "black", "white", "uhd", "ips", "fhd",
}


def _name_tokens(name: str) -> list[str]:
    name = re.split(r"\s[\u2014\u2013-]\s", name)[0]  # drop " — spec tail"
    toks = re.sub(r"[^\w. ]", " ", name.lower()).split()
    return [t.strip(".") for t in toks if len(t.strip(".")) > 1 and t.strip(".") not in GENERIC_WORDS]


def find_photo(api: Newegg, deal: dict[str, Any]) -> str | None:
    """Photo for an upcoming (Future-tab) deal from a Newegg listing of the
    same product. Image only — the Future price still comes from the source.
    Needs the brand plus most of the name's distinctive words in the title."""
    toks = _name_tokens(deal.get("name", ""))
    if len(toks) < 2:
        return None
    brand = toks[0]
    for q in (short_query(deal.get("name", ""), 6), short_query(deal.get("name", ""), 4)):
        best, best_score = None, 0.0
        for p in api.search(q):
            img = image_url(p)
            title = str(p.get("WebDescription") or "").lower()
            if not img or brand not in title:
                continue
            words = set(_name_tokens(title)) | {brand} if brand in title else set()
            # the product line name (e.g. "UltraFine" vs "UltraGear") must match,
            # not just brand + size numbers
            if not any(t in words for t in toks[1:] if t.isalpha()):
                continue
            score = sum(1 for t in toks if t in words) / len(toks)
            if score > best_score:
                best, best_score = img, score
        if best and best_score >= 0.6:
            return best
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
    apply_verified_price(deal, off["price"], parse_iso(stamp))
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


# ---------------------------------------------------------------- build parts
# Regular-price parts for the Builds tab (data/build-parts.json), so builds can
# reach lower budgets and both AMD and Intel even when few parts are on sale.
# Looked up every POOL_MAX_AGE_HOURS, not every hour, to save API calls.
POOL_PATH = ROOT / "data" / "build-parts.json"
POOL_MAX_AGE_HOURS = 6
POOL_QUERIES: dict[str, list[str]] = {
    "CPUs": ["amd ryzen 5 5600 processor", "amd ryzen 7 5700x3d processor",
             "amd ryzen 5 7600 processor", "amd ryzen 7 7700 processor",
             "amd ryzen 7 9700x processor", "intel core i5-12400f processor",
             "intel core i5-14400f processor", "intel core i5-14600kf processor",
             "intel core ultra 5 225 processor", "intel core ultra 5 245k processor",
             "intel core ultra 7 265k processor"],
    "Motherboards": ["B550 motherboard", "B650 motherboard", "A620 motherboard",
                     "B760M DDR4 motherboard", "B760 DDR5 motherboard", "B860 motherboard",
                     "Z790 DDR5 motherboard"],
    "RAM": ["DDR4 16GB 3200 desktop memory kit", "DDR4 32GB 3200 desktop memory kit",
            "DDR5 16GB 6000 desktop memory kit", "DDR5 32GB 6000 desktop memory kit"],
    "GPUs": ["geforce rtx 5060 graphics card", "geforce rtx 5060 ti 16gb graphics card",
             "radeon rx 9060 xt graphics card", "intel arc b580 graphics card",
             "geforce rtx 5070 graphics card", "radeon rx 9070 graphics card"],
    "SSDs": ["1TB NVMe M.2 SSD", "2TB NVMe M.2 SSD"],
    "PSUs": ["650w power supply", "750w 80 plus gold power supply", "850w modular power supply"],
    "Cases": ["micro atx case", "atx mid tower case airflow"],
    "Coolers": ["cpu air cooler"],
}


def refresh_build_parts(api: Newegg, now: datetime, stamp: str) -> None:
    try:
        old = json.loads(POOL_PATH.read_text(encoding="utf-8"))
        fetched = parse_iso(old.get("fetchedAt"))
        if fetched and now - fetched < timedelta(hours=POOL_MAX_AGE_HOURS) and old.get("parts"):
            print(f"Build parts: {len(old['parts'])} cached from {old['fetchedAt']}")
            return
    except (OSError, ValueError):
        pass
    parts: dict[str, dict[str, Any]] = {}
    for cat, queries in POOL_QUERIES.items():
        _, must, mustnot, _floor = SEEDS[cat]
        must_re = re.compile(must, re.I)
        not_re = re.compile(mustnot, re.I) if mustnot else None
        for q in queries:
            if throttled_flag(api):
                print("Build parts: Newegg throttled — keeping the previous list")
                return
            for p in api.search(q):
                title = str(p.get("WebDescription") or "").strip()
                off = offer(p)
                if not title or off is None or off["price"] < 15 or not image_url(p):
                    continue
                if not must_re.search(title) or (not_re and not_re.search(title)) or BAD_TITLE.search(title):
                    continue
                if off["rating"] is not None and off["rating"] < MIN_RATING:
                    continue
                sku = item_to_sku(p.get("ItemNumber", ""))
                if not sku or sku in parts:
                    continue
                parts[sku] = {
                    "id": "part-" + slugify(title, sku), "name": title, "category": cat,
                    "price": off["price"], "previousPrice": off["was"], "currency": "USD",
                    "merchant": "Newegg", "url": product_url(p["ItemNumber"]), "sku": sku,
                    "image": image_url(p), "verifiedAt": stamp,
                }
            time.sleep(0.3)
    if not parts:
        print("Build parts: nothing found — keeping the previous list")
        return
    POOL_PATH.write_text(json.dumps({"fetchedAt": stamp, "parts": list(parts.values())},
                                    indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Build parts: {len(parts)} regular-price parts saved")


def throttled_flag(api: Newegg) -> bool:
    return bool(api.rate_limited)


COLOR_WORDS = re.compile(
    r"\b(black|white|red|blue|green|pink|purple|orange|yellow|grey|gray|silver|gold|"
    r"graphite|midnight|starlight|navy|teal|cyan|beige|cream|lilac|lavender|mint|"
    r"deep|pulse|robot|carbon|velocity|shock|dark|light|matte|bright)\b",
    re.I,
)


def product_key(title: str) -> str:
    """Same product in a different colour → same key (dedupes colour variants)."""
    t = re.sub(r"\([^)]{0,40}\)", " ", str(title).lower())
    t = COLOR_WORDS.sub(" ", t)
    return re.sub(r"\W+", "", t)[:50]


def fits_category(d: dict[str, Any]) -> bool:
    spec = SEEDS.get(str(d.get("category")))
    if not spec:
        return True
    _, must, mustnot, floor = spec
    title = str(d.get("name") or "")
    # names saved before Nov 2026 were cut at 140 chars, so the keyword may be missing
    if len(title) < 140 and not re.search(must, title, re.I):
        return False
    if BAD_TITLE.search(title):
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
    before_fp = catalogue_fingerprint(data)
    now = now_utc()
    stamp = iso(now)
    api = Newegg()
    stats: Counter = Counter()
    removed: list[str] = []

    def throttled() -> bool:
        """True once Newegg asks us to back off. The run then stops making
        requests but still saves what it already verified this hour."""
        if api.rate_limited and not stats["throttled"]:
            stats["throttled"] = 1
            print(
                f"Newegg returned HTTP {api.rate_limited} — stopping checks; "
                "saving what was verified so far.",
                file=sys.stderr,
            )
        return bool(api.rate_limited)

    # 1-2. re-verify current listings only (upcoming Future deals are not Newegg-checked)
    for d in deals:
        if is_upcoming(d, now):
            stats["upcoming_kept"] += 1
            if not d.get("image"):
                img = None if throttled() else find_photo(api, d)
                if img:
                    d["image"] = img
                    d["imageSource"] = "newegg-api-match"
                    stats["upcoming_photo_added"] += 1
            continue
        merchant = d.get("merchant")
        if merchant == "Newegg":
            if throttled():
                continue  # keeps its last verifiedAt; pruned only after STALE_DAYS
            last = parse_iso(d.get("verifiedAt"))
            if last and now - last < timedelta(hours=VERIFY_EVERY_HOURS - 0.5):
                stats["newegg_checked_recently"] += 1
                continue  # rotation: checked within the last few hours
            res = verify_newegg(api, d)
            if throttled():
                continue
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
                apply_verified_price(d, price, now)
                if d.get("previousPrice") and float(d["previousPrice"]) <= price:
                    d["previousPrice"] = None
                d["verifiedAt"] = d["updatedAt"] = stamp
                stats["denon_verified"] += 1
        time.sleep(0.2)

    if api.ok_calls == 0:
        print("Newegg API unreachable — aborting without writing.", file=sys.stderr)
        return 2

    # 3. prune
    # STALE_DAYS is calendar days, not hourly runs — a deal must stay unverifiable
    # for 3 days before it is dropped.
    cutoff = now - timedelta(days=STALE_DAYS)
    kept = []
    for d in deals:
        last = parse_iso(d.get("verifiedAt"))
        starts = parse_iso(d.get("startsAt"))
        ends = parse_iso(d.get("endsAt"))
        upcoming = starts is not None and starts > now
        started = starts is not None and starts <= now
        unavailable = d.pop("_unavailable", False)

        if upcoming:
            kept.append(d)
            continue

        # Sale started but still cannot be verified: keep until endsAt (or
        # STALE_DAYS after the start if no end date), then drop.
        unverifiable = unavailable or last is None or last < cutoff
        if unverifiable and started:
            if ends and ends > now:
                kept.append(d)
                continue
            if ends and ends <= now:
                removed.append(f"{d.get('id')} (sale ended, unverifiable)")
                continue
            if now < starts + timedelta(days=STALE_DAYS):
                kept.append(d)
                continue
            removed.append(f"{d.get('id')} (unverified after sale start)")
            continue

        if unavailable:
            removed.append(f"{d.get('id')} (out of stock)")
            continue
        if last is None or last < cutoff:
            removed.append(f"{d.get('id')} (unverified since {d.get('verifiedAt') or 'before automation'})")
            continue
        if d.get("autoSeeded") and not fits_category(d):
            removed.append(f"{d.get('id')} (no longer matches {d.get('category')} filters)")
            continue
        if started:
            # Now a live, verifiable deal — leave the Future tab.
            d.pop("startsAt", None)
            stats["promoted_from_future"] += 1
        if ends and ends < now:
            d.pop("endsAt", None)
            stats["expired_dates_cleared"] += 1
        kept.append(d)
    deals = kept

    # colour variants of one auto-seeded product: keep the best saving only
    best: dict[tuple[str, str], dict[str, Any]] = {}
    for d in deals:
        if not d.get("autoSeeded") or is_upcoming(d, now):
            continue
        k = (str(d.get("category")), product_key(d.get("name", "")))
        if k not in best or savings_pct(d) > savings_pct(best[k]):
            best[k] = d
    keep_ids = {id(v) for v in best.values()}
    deduped = []
    for d in deals:
        if d.get("autoSeeded") and not is_upcoming(d, now) and id(d) not in keep_ids:
            removed.append(f"{d.get('id')} (colour variant)")
            continue
        deduped.append(d)
    deals = deduped

    # 4. seed
    added = 0
    if not args.no_seed and not throttled():
        have = {(d.get("sku") or "").upper() for d in deals} | {
            (sku_from_url(d.get("url", "")) or "") for d in deals}
        names = {product_key(d.get("name", "")) for d in deals}
        counts = Counter(d.get("category") for d in deals if not is_upcoming(d, now))
        ids = {d.get("id") for d in deals}
        for cat, (queries, must, mustnot, floor) in SEEDS.items():
            if throttled():
                break
            target = TARGETS.get(cat, TARGET_PER_CAT)
            need = target - counts[cat]
            if need <= 0:
                continue
            must_re = re.compile(must, re.I)
            not_re = re.compile(mustnot, re.I) if mustnot else None
            cands = []
            why_not: Counter = Counter()
            samples: dict[str, list[str]] = defaultdict(list)

            def reject(reason: str, title: str) -> None:
                why_not[reason] += 1
                if len(samples[reason]) < 3:
                    samples[reason].append(title[:90])

            # first page of every search; a second page only if still short
            pages = [(q, 1) for q in queries] + [(q, 2) for q in queries]
            for q, page in pages:
                if page == 2 and len(cands) >= need * 2:
                    break
                results = api.search(q, page=page)
                if not results:
                    why_not["no search results"] += 1
                for p in results:
                    title = str(p.get("WebDescription") or "").strip()
                    off = offer(p)
                    if not title:
                        reject("no title", title)
                        continue
                    if off is None:
                        reject("not purchasable", title)
                        continue
                    if off["price"] < floor:
                        reject(f"under ${floor:.0f}", title)
                        continue
                    if cat == "Prebuilts" and not off["was"]:
                        reject("no discount", title)
                        continue
                    if not must_re.search(title):
                        reject("missing category keyword", title)
                        continue
                    if (not_re and not_re.search(title)) or BAD_TITLE.search(title):
                        reject("excluded word", title)
                        continue
                    if off["rating"] is not None and off["rating"] < MIN_RATING:
                        reject("low rating", title)
                        continue
                    sku = item_to_sku(p.get("ItemNumber", ""))
                    key = product_key(title)
                    if not sku or sku in have or key in names:
                        reject("already listed", title)
                        continue
                    if not image_url(p):
                        reject("no photo", title)
                        continue
                    cands.append((p, off, sku, title, key))
                if throttled():
                    break
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
                    "id": did, "name": title, "category": cat,
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
            if need > 0:
                print(f"  ! [{cat}] still {need} short of {target}; rejected: {dict(why_not)}")
                for reason, titles in samples.items():
                    for t in titles:
                        print(f"      {reason}: {t}")

    # trim oversized live categories only — upcoming Future deals are kept aside
    upcoming_deals = [d for d in deals if is_upcoming(d, now)]
    live_deals = [d for d in deals if not is_upcoming(d, now)]
    by_cat: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for d in live_deals:
        by_cat[str(d.get("category"))].append(d)
    trimmed = []
    for cat, lst in by_cat.items():
        lst.sort(key=savings_pct, reverse=True)
        cap = max(MAX_PER_CAT, TARGETS.get(cat, TARGET_PER_CAT) + 4)
        trimmed.extend(lst[:cap])
        for d in lst[cap:]:
            removed.append(f"{d.get('id')} (category trim)")
    deals = trimmed + upcoming_deals

    last_refresh = {
        "at": stamp, "source": "hourly_refresh", "before": before, "after": len(deals),
        "added": added, "removed": len(removed), **dict(stats),
        "apiCalls": api.calls,
    }
    print(json.dumps(last_refresh, indent=2))
    for r in removed:
        print("  -", r)
    print("Per category:", dict(Counter(d["category"] for d in deals)))
    print("Upcoming/Future:", sum(1 for d in deals if is_upcoming(d, now)))

    proposed = dict(data)
    proposed["deals"] = deals
    meaningful = catalogue_fingerprint(proposed) != before_fp
    if not meaningful:
        # Still write: the site's "Updated / Checked X ago" labels read these
        # timestamps, so skipping the save made hourly checks look stale.
        print("No meaningful deal changes — saving fresh check timestamps only.")

    data["deals"] = deals
    data["updatedAt"] = stamp
    data["weekLabel"] = week_label_now(now)
    if meaningful:
        data["catalogueRevision"] = int(data.get("catalogueRevision", 0)) + 1
    data["lastRefresh"] = last_refresh

    if args.dry_run:
        return 0

    # regular-price build parts (every few hours), then today's prices into the
    # price history, which also adds 30-day stats and honest-discount flags
    if not throttled():
        refresh_build_parts(api, now, stamp)
    import price_history  # noqa: E402  (scripts/ is on sys.path)
    try:
        pool_parts = json.loads(POOL_PATH.read_text(encoding="utf-8")).get("parts") or []
    except (OSError, ValueError):
        pool_parts = []
    price_history.record(deals, pool_parts, now)
    data["deals"] = deals

    DEALS_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    # delete photos no deal references any more
    used = {d.get("image") for d in deals}
    gone = 0
    for f in IMAGES_DIR.glob("*"):
        if f.is_file() and f"images/{f.name}" not in used:
            f.unlink()
            gone += 1
    print(f"Wrote {DEALS_PATH} ({len(deals)} deals); removed {gone} orphaned photos")
    # rebuild the Builds tab's PCs from the fresh prices
    import build_pcs  # noqa: E402  (scripts/ is on sys.path)
    build_pcs.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
