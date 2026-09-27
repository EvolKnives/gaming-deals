#!/usr/bin/env python3
"""
Search-then-fetch ingest for What's A Good Deal?

Static GitHub Pages cannot scrape Amazon/Newegg from the browser (CORS/ToS).
When Search returns 0 hits for something like "computer cases", run this
script on a machine that can fetch retailer HTML. It finds verified Newegg
product deals for the query, merges them into data/deals.json (deduped),
and leaves ratings/images blank unless heal/ratings scripts are run after.

Never invents prices. Drops OOS/dead listings. Dedupes by SKU/URL.

Usage:
  python3 scripts/search_ingest.py "computer cases"
  python3 scripts/search_ingest.py "ddr5 32gb" --category RAM --limit 10
  python3 scripts/search_ingest.py "b650 motherboard" --category Motherboards
  python3 scripts/search_ingest.py "pc case" --dry-run

Then:
  python3 scripts/heal_images.py
  python3 scripts/fetch_ratings.py   # optional
  git add data/deals.json images && git commit && git push

The live Search tab only filters the updated deals.json pool.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from catalogue_refresh import (  # noqa: E402
    CATEGORY_FLOORS,
    build_deal,
    deal_keys,
    dedupe_deals,
    week_label_now,
)
from newegg_util import (  # noqa: E402
    classify_listing,
    fetch_html,
    parse_newegg_listing_price,
    search_newegg,
    session,
    sleep_polite,
)

DEALS_PATH = ROOT / "data" / "deals.json"

QUERY_CATEGORY_HINTS: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"\b(cases?|chassis|tower)\b", re.I), "Cases", r"\b(case|chassis|tower)\b"),
    (re.compile(r"\b(ram|memory|ddr[45])\b", re.I), "RAM", r"\b(DDR[45]|memory|RAM)\b"),
    (re.compile(r"\b(ssd|nvme|solid.?state)\b", re.I), "SSDs", r"\b(SSD|NVMe)\b"),
    (
        re.compile(r"\b(mobo|motherboard|b650|x670|b850|z790)\b", re.I),
        "Motherboards",
        r"\b(motherboard|B650|X670|B850|X870|Z790|B760)\b",
    ),
    (
        re.compile(r"\b(iphone|phone|pixel|galaxy|smartphone)\b", re.I),
        "Phones",
        r"\b(iPhone|Pixel|Galaxy|phone)\b",
    ),
    (
        re.compile(r"\b(macbook|laptop|notebook|chromebook)\b", re.I),
        "Laptops",
        r"\b(MacBook|laptop|notebook|Chromebook)\b",
    ),
]


def infer_category(query: str, override: str | None) -> tuple[str, re.Pattern[str]]:
    if override:
        for _pat, cat, title_pat in QUERY_CATEGORY_HINTS:
            if cat.lower() == override.lower():
                return cat, re.compile(title_pat, re.I)
        return override, re.compile(r".+", re.I)
    for pat, cat, title_pat in QUERY_CATEGORY_HINTS:
        if pat.search(query):
            return cat, re.compile(title_pat, re.I)
    # Generic: accept titles containing any query token longer than 2 chars
    tokens = [t for t in re.split(r"\s+", query.strip().lower()) if len(t) > 2]
    if tokens:
        return "All", re.compile("|".join(re.escape(t) for t in tokens), re.I)
    return "All", re.compile(r".+", re.I)


def main() -> int:
    ap = argparse.ArgumentParser(description="Search-then-fetch verified deals into deals.json")
    ap.add_argument("query", help="Search query, e.g. 'computer cases'")
    ap.add_argument("--category", default=None, help="Force category label (Cases, RAM, …)")
    ap.add_argument("--limit", type=int, default=12, help="Max new deals to add")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    query = args.query.strip()
    if not query:
        print("Empty query", file=sys.stderr)
        return 1

    cat, title_re = infer_category(query, args.category)
    floor = CATEGORY_FLOORS.get(cat, 20.0)
    print(f"Query={query!r} category={cat} floor=${floor}")

    data = json.loads(DEALS_PATH.read_text(encoding="utf-8"))
    deals: list[dict[str, Any]] = list(data.get("deals") or [])
    before = len(deals)
    existing: set[str] = set()
    for d in deals:
        existing |= deal_keys(d)

    s = session()
    # Broaden query slightly for Cases so "computer cases" hits mid-tower listings.
    searches = [query]
    if cat == "Cases" and "tower" not in query.lower():
        searches.append(query + " mid tower")
    if cat == "Phones":
        ql = query.lower()
        if "iphone" in ql and "unlocked" not in ql:
            searches.append(query + " unlocked")
        if "iphone" not in ql and "phone" not in ql:
            searches.append(query + " phone")
    if cat == "Laptops":
        ql = query.lower()
        if "laptop" not in ql and "macbook" not in ql:
            searches.append(query + " laptop")
        if "gaming" in ql and "rtx" not in ql:
            searches.append(query + " RTX")

    candidates: list[dict[str, Any]] = []
    for q in searches:
        candidates.extend(
            search_newegg(s, q, title_re if cat != "All" else None, min_price=floor, max_n=30)
        )
        sleep_polite(0.5)

    # Prefer discounted
    candidates.sort(
        key=lambda x: (
            0 if x.get("previousPrice") else 1,
            -((x.get("previousPrice") or x["price"]) - x["price"]),
        )
    )
    seen_sku: set[str] = set()
    uniq = []
    for c in candidates:
        if c["sku"] in seen_sku:
            continue
        seen_sku.add(c["sku"])
        uniq.append(c)

    added_deals: list[dict[str, Any]] = []
    for item in uniq:
        if len(added_deals) >= args.limit:
            break
        if f"sku:{item['sku']}" in existing:
            continue
        sleep_polite(0.4)
        html, status, _ = fetch_html(s, item["url"])
        if not html or status >= 400:
            print(f"  skip {item['sku']} fetch-fail")
            continue
        if classify_listing(item["url"], html, status) != "keep":
            print(f"  skip {item['sku']} not-keep")
            continue
        info = parse_newegg_listing_price(html)
        if not info.get("ok") or info.get("price") is None:
            print(f"  skip {item['sku']} no-price")
            continue
        if info["price"] < floor:
            print(f"  skip {item['sku']} below-floor ${info['price']}")
            continue
        if not info.get("previousPrice") and item.get("previousPrice"):
            info["previousPrice"] = item["previousPrice"]
        # If category still All, skip — require a real plural category.
        use_cat = cat if cat != "All" else None
        if not use_cat:
            print(f"  skip {item['sku']} unresolved category — pass --category")
            continue
        deal = build_deal(use_cat, item, info)
        ids = {d.get("id") for d in deals} | {d.get("id") for d in added_deals}
        base = deal["id"]
        n = 2
        while deal["id"] in ids:
            deal["id"] = f"{base}-{n}"
            n += 1
        added_deals.append(deal)
        existing |= deal_keys(deal)
        print(f"  + [{use_cat}] ${deal['price']} {deal['name'][:70]}")

    if not added_deals:
        print("No new verified deals to merge.")
        return 0

    deals.extend(added_deals)
    deals, dup_removed = dedupe_deals(deals)

    now = datetime.now(timezone.utc)
    data["deals"] = deals
    data["updatedAt"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    data["weekLabel"] = week_label_now(now)
    data["catalogueRevision"] = int(data.get("catalogueRevision") or 0) + 1
    data["lastRefresh"] = {
        "at": data["updatedAt"],
        "source": "search_ingest",
        "query": query,
        "before": before,
        "after": len(deals),
        "added": len(added_deals),
        "deduped": dup_removed,
    }

    if args.dry_run:
        print("Dry run — not writing")
        print(json.dumps(data["lastRefresh"], indent=2))
        return 0

    DEALS_PATH.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"Wrote {DEALS_PATH} ({before} → {len(deals)}; +{len(added_deals)})")
    print("Heal photos: python3 scripts/heal_images.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
