#!/usr/bin/env python3
"""
Fetch product ratings for What's A Good Deal?

Reads data/deals.json, fetches product pages when practical, and sets:
  - rating       — float on a 5-star scale (e.g. 4.3)
  - ratingCount  — integer review/rating count when available
  - ratingSource — short note e.g. "newegg-aggregateRating"

Never invents ratings. Omits fields when blocked / captcha / missing / zero.
Skips search URLs. Prefer out-of-5; if retailer uses 10, convert and keep scale=5.

Usage:
  python3 scripts/fetch_ratings.py
  python3 scripts/fetch_ratings.py --dry-run
  python3 scripts/fetch_ratings.py --limit 20
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEALS_PATH = ROOT / "data" / "deals.json"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/122.0.0.0 Safari/537.36"
)

# Merchants we attempt to scrape for product ratings.
FETCH_MERCHANTS = {
    "Newegg",
    "Amazon",
    "Best Buy",
    "Crutchfield",
    "LG",
    "Denon",
    "Micro Center",
    "Dell",
    "XPPen",
    "Razer",
}

LD_SCRIPT_RE = re.compile(
    r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.I | re.S,
)


def _session():
    import requests

    s = requests.Session()
    s.headers.update(
        {
            "User-Agent": UA,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml",
        }
    )
    return s


def fetch_html(session, url: str, merchant: str) -> str | None:
    timeout = 28 if merchant == "Dell" else (
        14 if merchant in ("Best Buy", "Amazon") else 20
    )
    try:
        r = session.get(url, timeout=timeout, allow_redirects=True)
    except Exception:
        return None
    if r.status_code in (403, 503, 429) or r.status_code >= 400:
        return None
    if len(r.text) < 3000:
        return None
    low = r.text[:4000].lower()
    if "captcha" in low and ("robot" in low or "api-services-support" in low):
        return None
    return r.text


def _to_float(val: Any) -> float | None:
    if val is None or val is False:
        return None
    if isinstance(val, (int, float)):
        f = float(val)
        return f if f == f else None  # NaN guard
    s = str(val).strip().replace(",", "")
    if not s or s.lower() in ("null", "none", "n/a"):
        return None
    try:
        return float(s)
    except ValueError:
        m = re.search(r"([\d.]+)", s)
        return float(m.group(1)) if m else None


def _to_int(val: Any) -> int | None:
    if val is None or val is False:
        return None
    if isinstance(val, bool):
        return None
    if isinstance(val, int):
        return val if val >= 0 else None
    if isinstance(val, float):
        return int(val) if val >= 0 else None
    s = str(val).strip().replace(",", "")
    if not s or s.lower() in ("null", "none", "n/a"):
        return None
    try:
        return int(float(s))
    except ValueError:
        m = re.search(r"(\d+)", s)
        return int(m.group(1)) if m else None


def normalize_to_five(
    value: float, best: float | None = None, worst: float | None = None
) -> float | None:
    """Map a retailer score onto a 1–5 (display) scale. Reject nonsense."""
    if value <= 0:
        return None
    b = best if best and best > 0 else None
    w = worst if worst is not None and worst >= 0 else 0.0

    if b is not None:
        span = b - (w or 0.0)
        if span <= 0:
            return None
        # Already on ~5
        if 4.5 <= b <= 5.5:
            out = value
        elif 9.5 <= b <= 10.5:
            out = value * 5.0 / b
        else:
            out = ((value - (w or 0.0)) / span) * 5.0
    else:
        # Heuristic when bestRating absent
        if value <= 5.0:
            out = value
        elif value <= 10.0:
            out = value / 2.0
        else:
            return None

    if out <= 0 or out > 5.05:
        return None
    # Clamp tiny float noise above 5
    if out > 5.0:
        out = 5.0
    return round(out, 2)


def _walk_json(obj: Any):
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from _walk_json(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk_json(v)


def extract_jsonld_aggregate(html: str) -> tuple[float | None, int | None, str]:
    """Parse Product (or similar) aggregateRating from JSON-LD."""
    best_hit: tuple[float, int | None, str] | None = None

    for block in LD_SCRIPT_RE.findall(html):
        block = block.strip()
        if not block or "aggregateRating" not in block:
            continue
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            # Sometimes multiple objects concatenated — try first object only
            try:
                data = json.loads(block.split("</")[0])
            except Exception:
                continue

        for node in _walk_json(data):
            types = node.get("@type")
            type_list = (
                [types]
                if isinstance(types, str)
                else (types if isinstance(types, list) else [])
            )
            type_l = [str(t).lower() for t in type_list]
            # Prefer Product / IndividualProduct; skip Organization alone
            if type_l and not any(
                t in ("product", "individualproduct", "productgroup", "offer")
                for t in type_l
            ):
                if "aggregaterating" not in type_l and "aggregateRating" not in node:
                    continue

            agg = node.get("aggregateRating")
            if not isinstance(agg, dict):
                continue
            raw = _to_float(agg.get("ratingValue"))
            if raw is None:
                continue
            best = _to_float(agg.get("bestRating"))
            worst = _to_float(agg.get("worstRating"))
            score = normalize_to_five(raw, best, worst)
            if score is None:
                continue
            count = _to_int(agg.get("reviewCount"))
            if count is None:
                count = _to_int(agg.get("ratingCount"))
            if count is not None and count <= 0:
                count = None
            # Prefer hits that look like Product and have a count
            rank = (1 if any("product" in t for t in type_l) else 0, count or 0)
            hit = (score, count, "jsonld-aggregateRating")
            if best_hit is None:
                best_hit = hit
                best_rank = rank
            elif rank > best_rank:
                best_hit = hit
                best_rank = rank

    if best_hit:
        return best_hit[0], best_hit[1], best_hit[2]
    return None, None, ""


def extract_newegg(html: str) -> tuple[float | None, int | None, str]:
    """Newegg product JSON: RatingOneDecimal / AverageRatingFloat + HumanRating."""
    # Prefer decimal rating on the item Review blob
    m = re.search(r'"RatingOneDecimal"\s*:\s*([\d.]+)', html)
    score = None
    source = ""
    if m:
        score = normalize_to_five(_to_float(m.group(1)) or 0)
        if score:
            source = "newegg-RatingOneDecimal"

    if score is None:
        m = re.search(r'"AverageRatingFloat"\s*:\s*([\d.]+)', html)
        if m:
            score = normalize_to_five(_to_float(m.group(1)) or 0)
            if score:
                source = "newegg-AverageRatingFloat"

    if score is None:
        # Integer Rating inside Review — only if > 0
        m = re.search(
            r'"Review"\s*:\s*\{[^}]*?"Rating"\s*:\s*([1-5])(?:\.\d+)?',
            html,
        )
        if m:
            score = normalize_to_five(float(m.group(1)))
            if score:
                source = "newegg-Rating"

    if score is None:
        return None, None, ""

    count = None
    # HumanRating on Newegg is the review count (not a human-readable score)
    m = re.search(
        r'"Review"\s*:\s*\{[^}]*?"HumanRating"\s*:\s*(\d+)',
        html,
    )
    if m:
        c = int(m.group(1))
        if c > 0:
            count = c
    if count is None:
        m = re.search(r'"AllReviewCount"\s*:\s*(\d+)', html)
        if m and int(m.group(1)) > 0:
            count = int(m.group(1))

    return score, count, source


def extract_amazon(html: str) -> tuple[float | None, int | None, str]:
    score = None
    source = ""
    m = re.search(
        r'data-hook="rating-out-of-text"[^>]*>\s*([\d.]+)\s*out of\s*5',
        html,
        re.I,
    )
    if m:
        score = normalize_to_five(_to_float(m.group(1)) or 0)
        source = "amazon-rating-out-of-text"
    if score is None:
        m = re.search(
            r'id="acrPopover"[^>]*title="([\d.]+)\s*out of\s*5',
            html,
            re.I,
        )
        if m:
            score = normalize_to_five(_to_float(m.group(1)) or 0)
            source = "amazon-acrPopover"

    if score is None:
        return None, None, ""

    count = None
    m = re.search(
        r'id="acrCustomerReviewText"[^>]*aria-label="([\d,]+)\s+Reviews?"',
        html,
        re.I,
    )
    if m:
        count = _to_int(m.group(1))
    if count is None:
        m = re.search(
            r'id="acrCustomerReviewText"[^>]*>\s*\(([\d,]+)\)',
            html,
            re.I,
        )
        if m:
            count = _to_int(m.group(1))
    if count is None:
        m = re.search(
            r'data-hook="total-review-count"[^>]*>\s*([\d,]+)\s*(?:global\s+)?ratings?',
            html,
            re.I,
        )
        if m:
            count = _to_int(m.group(1))

    return score, count, source


def extract_bestbuy(html: str) -> tuple[float | None, int | None, str]:
    score = None
    source = ""
    m = re.search(r'"customerAverageRating"\s*:\s*([\d.]+)', html)
    if m:
        score = normalize_to_five(_to_float(m.group(1)) or 0)
        source = "bestbuy-customerAverageRating"
    if score is None:
        m = re.search(
            r'"averageOverallRating"\s*:\s*"?([\d.]+)"?',
            html,
        )
        if m:
            score = normalize_to_five(_to_float(m.group(1)) or 0)
            source = "bestbuy-averageOverallRating"

    if score is None:
        return None, None, ""

    count = None
    for pat in (
        r'"customerReviewCount"\s*:\s*(\d+)',
        r'"totalReviewCount"\s*:\s*(\d+)',
        r'"totalCount"\s*:\s*(\d+)',
    ):
        m = re.search(pat, html)
        if m and int(m.group(1)) > 0:
            count = int(m.group(1))
            break
    return score, count, source


def extract_itemprop(html: str) -> tuple[float | None, int | None, str]:
    m = re.search(
        r'itemprop=["\']ratingValue["\'][^>]*content=["\']([\d.]+)["\']',
        html,
        re.I,
    )
    if not m:
        m = re.search(
            r'content=["\']([\d.]+)["\'][^>]*itemprop=["\']ratingValue["\']',
            html,
            re.I,
        )
    if not m:
        return None, None, ""
    score = normalize_to_five(_to_float(m.group(1)) or 0)
    if score is None:
        return None, None, ""
    count = None
    cm = re.search(
        r'itemprop=["\']reviewCount["\'][^>]*content=["\']([\d,]+)["\']',
        html,
        re.I,
    )
    if not cm:
        cm = re.search(
            r'content=["\']([\d,]+)["\'][^>]*itemprop=["\']reviewCount["\']',
            html,
            re.I,
        )
    if cm:
        count = _to_int(cm.group(1))
    return score, count, "itemprop-ratingValue"


def extract_lg_denonish(html: str) -> tuple[float | None, int | None, str]:
    """Manufacturer PDPs sometimes embed BV / PowerReviews / simple JSON."""
    for pat, src in (
        (
            r'"averageOverallRating"\s*:\s*"?([\d.]+)"?',
            "bv-averageOverallRating",
        ),
        (
            r'"average_rating"\s*:\s*"?([\d.]+)"?',
            "average_rating",
        ),
        (
            r'"avgRating"\s*:\s*"?([\d.]+)"?',
            "avgRating",
        ),
        (
            r'data-rating=["\']([\d.]+)["\']',
            "data-rating",
        ),
    ):
        m = re.search(pat, html, re.I)
        if not m:
            continue
        raw = _to_float(m.group(1))
        if raw is None or raw <= 0:
            continue
        # Guard against non-rating specs like "2.8/5.6MHz"
        if raw > 5 and raw <= 10:
            score = normalize_to_five(raw, best=10.0)
        else:
            score = normalize_to_five(raw)
        if score is None:
            continue
        count = None
        for cpat in (
            r'"totalReviewCount"\s*:\s*"?(\d+)"?',
            r'"review_count"\s*:\s*"?(\d+)"?',
            r'"ratingCount"\s*:\s*"?(\d+)"?',
            r'"numReviews"\s*:\s*"?(\d+)"?',
        ):
            cm = re.search(cpat, html, re.I)
            if cm and int(cm.group(1)) > 0:
                count = int(cm.group(1))
                break
        return score, count, src
    return None, None, ""


def detect_rating(
    html: str, merchant: str
) -> tuple[float | None, int | None, str]:
    """Return (rating_out_of_5, ratingCount, source_note)."""
    # 1) JSON-LD aggregateRating (preferred when honest Product data)
    score, count, note = extract_jsonld_aggregate(html)
    if score is not None:
        return score, count, note

    # 2) Merchant-specific
    mlow = (merchant or "").lower()
    if mlow == "newegg" or "newegg.com" in html[:800].lower():
        score, count, note = extract_newegg(html)
        if score is not None:
            return score, count, note

    if mlow == "amazon" or "amazon.com" in html[:800].lower():
        score, count, note = extract_amazon(html)
        if score is not None:
            return score, count, note

    if mlow == "best buy" or "bestbuy.com" in html[:800].lower():
        score, count, note = extract_bestbuy(html)
        if score is not None:
            return score, count, note

    # 3) itemprop fallback
    score, count, note = extract_itemprop(html)
    if score is not None:
        return score, count, note

    # 4) Manufacturer-ish (LG / Denon / Razer)
    if mlow in ("lg", "denon", "razer") or any(
        h in html[:1200].lower()
        for h in ("lg.com", "denon.com", "razer.com")
    ):
        score, count, note = extract_lg_denonish(html)
        if score is not None:
            return score, count, note

    # Newegg sometimes without early domain hint in truncated checks
    score, count, note = extract_newegg(html)
    if score is not None:
        return score, count, note

    return None, None, ""


def apply_rating(
    deal: dict[str, Any],
    score: float | None,
    count: int | None,
    source: str,
) -> dict[str, str]:
    """Mutate deal rating fields. Returns change summary."""
    changes: dict[str, str] = {}

    if score is None:
        for key in ("rating", "ratingCount", "ratingSource"):
            if key in deal:
                changes[key] = "(cleared)"
            deal.pop(key, None)
        return changes

    rounded = round(float(score), 2)
    if deal.get("rating") != rounded:
        changes["rating"] = str(rounded)
    deal["rating"] = rounded

    if count is not None and count > 0:
        if deal.get("ratingCount") != count:
            changes["ratingCount"] = str(count)
        deal["ratingCount"] = int(count)
    else:
        if "ratingCount" in deal:
            changes["ratingCount"] = "(cleared)"
        deal.pop("ratingCount", None)

    if source:
        if deal.get("ratingSource") != source:
            changes["ratingSource"] = source
        deal["ratingSource"] = source
    else:
        deal.pop("ratingSource", None)

    return changes


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch deal product ratings")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0, help="Max deals to fetch")
    parser.add_argument(
        "--sleep", type=float, default=0.45, help="Delay between requests"
    )
    args = parser.parse_args()

    if not DEALS_PATH.exists():
        print(f"Missing {DEALS_PATH}", file=sys.stderr)
        return 1

    data = json.loads(DEALS_PATH.read_text(encoding="utf-8"))
    deals: list[dict[str, Any]] = data.get("deals") or []
    session = _session()

    fetched = 0
    with_rating = 0
    skipped = 0
    unknown = 0
    blocked = 0
    updated_ids: list[str] = []

    targets = [
        d
        for d in deals
        if (d.get("merchant") in FETCH_MERCHANTS)
        and d.get("url")
        and d.get("urlKind") != "search"
    ]
    if args.limit > 0:
        targets = targets[: args.limit]

    print(f"Fetching ratings for {len(targets)} product deals (of {len(deals)}) …")

    for deal in targets:
        mid = deal.get("id") or deal.get("name") or "?"
        merchant = deal.get("merchant") or ""
        url = deal["url"]
        html = fetch_html(session, url, merchant)
        fetched += 1
        if html is None:
            blocked += 1
            skipped += 1
            # Do not clear an existing honest rating on a transient block
            print(f"  skip/blocked  {mid} [{merchant}]")
            time.sleep(args.sleep)
            continue

        score, count, note = detect_rating(html, merchant)
        if score is None:
            unknown += 1
            # Page loaded but no rating — omit fields (don't keep stale invent)
            changes = apply_rating(deal, None, None, "")
            if changes:
                updated_ids.append(str(mid))
                print(f"  cleared       {mid} [{merchant}] (no rating on page)")
            else:
                print(f"  unknown       {mid} [{merchant}]")
            time.sleep(args.sleep)
            continue

        changes = apply_rating(deal, score, count, note)
        with_rating += 1
        if changes:
            updated_ids.append(str(mid))
            print(
                f"  set           {mid} [{merchant}] "
                f"rating={deal.get('rating')} count={deal.get('ratingCount')} "
                f"({note})"
            )
        else:
            print(
                f"  unchanged     {mid} [{merchant}] "
                f"rating={deal.get('rating')} ({note})"
            )
        time.sleep(args.sleep)

    total_rated = sum(1 for d in deals if isinstance(d.get("rating"), (int, float)))

    if not args.dry_run:
        DEALS_PATH.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"\nWrote {DEALS_PATH}")
    else:
        print("\nDry run — no write")

    print(f"  fetched:      {fetched}")
    print(f"  blocked:      {blocked}")
    print(f"  unknown:      {unknown}")
    print(f"  with rating:  {total_rated} (set this pass: {with_rating})")
    if updated_ids:
        print("  updated ids:")
        for i in updated_ids:
            print(f"    - {i}")
    print("Remember: never invent ratings. Re-run on refresh to refill.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
