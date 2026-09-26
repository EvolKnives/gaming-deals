#!/usr/bin/env python3
"""
Dynamic catalogue refresh for What's A Good Deal?

Re-checks current deals and **removes** listings that are clearly dead /
unavailable / broken when verification succeeds. Pulls fresh verified
Newegg deals into existing + PC-parts categories (Cases, RAM, SSDs,
Motherboards) so the catalogue churns over time.

Hard rules:
  - Never invent prices, ratings, startsAt/endsAt, or photos.
  - Prefer product deep links; wrong photo worse than missing.
  - Deduplicate aggressively by SKU / ASIN / normalized URL / id.

Usage:
  python3 scripts/catalogue_refresh.py              # prune + seed missing cats
  python3 scripts/catalogue_refresh.py --prune-only
  python3 scripts/catalogue_refresh.py --seed-only
  python3 scripts/catalogue_refresh.py --no-seed
  python3 scripts/catalogue_refresh.py --queries "pc case" "ddr5 32gb"

After a successful refresh, stamp metadata:
  python3 scripts/refresh.py
Optional: heal images / ratings for new URLs:
  python3 scripts/refresh.py --heal-images
  python3 scripts/fetch_ratings.py

Client update path remains pull-to-refresh on deals.json (no hourly ping).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from newegg_util import (  # noqa: E402
    NEWEGG_ITEM_RE,
    classify_listing,
    fetch_html,
    parse_newegg_listing_price,
    search_newegg,
    session,
    sleep_polite,
    slugify,
)

DEALS_PATH = ROOT / "data" / "deals.json"
IMAGES_DIR = ROOT / "images"

# Plural category labels (must match app.js CATEGORY_ORDER / aliases).
SEED_QUERIES: dict[str, list[tuple[str, str]]] = {
    "Cases": [
        ("mid tower computer case", r"\b(case|chassis|tower)\b"),
        ("atx pc case tempered glass", r"\b(case|chassis|tower)\b"),
    ],
    "RAM": [
        ("DDR5 32GB desktop memory kit", r"\bDDR[45]\b"),
        ("DDR5 64GB desktop RAM", r"\bDDR[45]\b"),
    ],
    "SSDs": [
        ("NVMe M.2 SSD 2TB", r"\b(SSD|NVMe)\b"),
        ("NVMe M.2 SSD 1TB", r"\b(SSD|NVMe)\b"),
    ],
    "Motherboards": [
        ("AM5 B650 motherboard", r"\b(motherboard|B650|X670|B850|X870|Z790|B760)\b"),
    ],
}

CATEGORY_FLOORS = {
    "Cases": 35.0,
    "RAM": 45.0,
    "SSDs": 35.0,
    "Motherboards": 70.0,
}

TARGET_PER_SEED_CAT = 12


def week_label_now(dt: datetime) -> str:
    d = dt.date()
    monday = d.fromordinal(d.toordinal() - d.weekday())
    return f"Week of {monday.strftime('%b')} {monday.day}"


def is_search_url(url: str) -> bool:
    u = (url or "").lower()
    if not u:
        return True
    if "searchpage.jsp" in u or "/p/pl?" in u or "search?" in u:
        return True
    if "amazon." in u and re.search(r"/s(\?|/|$)", u):
        return True
    return False


def norm_url(url: str) -> str:
    if not url:
        return ""
    p = urlparse(url.strip())
    path = p.path.rstrip("/")
    host = (p.netloc or "").lower().replace("www.", "")
    return urlunparse(("https", host, path, "", "", "")).lower()


def deal_keys(deal: dict[str, Any]) -> set[str]:
    """Identity keys for dedupe. Never key on retailer search hubs."""
    keys: set[str] = set()
    if deal.get("id"):
        keys.add("id:" + str(deal["id"]).lower())
    sku = deal.get("sku") or deal.get("asin")
    if sku:
        keys.add("sku:" + str(sku).upper())
    url = str(deal.get("url") or "")
    m = NEWEGG_ITEM_RE.search(url)
    if m:
        keys.add("sku:" + m.group(1).upper())
    am = re.search(r"/(?:dp|gp/product)/([A-Z0-9]{10})", url, re.I)
    if am:
        keys.add("asin:" + am.group(1).upper())
    bb = re.search(r"/(\d{5,8})\.p", url, re.I)
    if bb:
        keys.add("bb:" + bb.group(1))
    if url and not is_search_url(url) and (m or am or bb or "/product/" in url.lower()):
        keys.add("url:" + norm_url(url))
    return keys


def savings(deal: dict[str, Any]) -> float:
    try:
        price = float(deal.get("price"))
        prev = float(deal.get("previousPrice"))
    except (TypeError, ValueError):
        return -1.0
    if prev > price:
        return prev - price
    return -1.0


def dedupe_deals(deals: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Keep one best card per product identity (SKU/ASIN/URL/id)."""
    groups: dict[str, list[dict[str, Any]]] = {}
    order: list[str] = []
    unkeyed: list[dict[str, Any]] = []

    for d in deals:
        keys = deal_keys(d)
        if not keys:
            unkeyed.append(d)
            continue
        # Find existing group
        gid = None
        for k in keys:
            if k in groups:
                gid = k
                break
        if gid is None:
            gid = next(iter(keys))
            groups[gid] = []
            order.append(gid)
        groups[gid].append(d)
        for k in keys:
            groups[k] = groups[gid]

    kept: list[dict[str, Any]] = []
    seen_group_ids: set[int] = set()
    for gid in order:
        bucket = groups[gid]
        if id(bucket) in seen_group_ids:
            continue
        seen_group_ids.add(id(bucket))
        # Prefer: has image, has previousPrice savings, product urlKind, lower price
        def score(x: dict[str, Any]) -> tuple:
            return (
                1 if x.get("image") else 0,
                1 if savings(x) > 0 else 0,
                savings(x),
                1 if x.get("urlKind") == "product" else 0,
                -(float(x["price"]) if isinstance(x.get("price"), (int, float)) else 1e18),
            )

        best = sorted(bucket, key=score, reverse=True)[0]
        kept.append(best)

    removed = len(deals) - (len(kept) + len(unkeyed))
    return kept + unkeyed, max(0, removed)


def prune_deals(
    deals: list[dict[str, Any]], s, limit: int | None = None
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Drop dead/OOS/broken when we can verify. Leave alone when blocked/uncertain."""
    kept: list[dict[str, Any]] = []
    removed: list[dict[str, str]] = []
    checked = 0
    for d in deals:
        url = d.get("url") or ""
        if limit is not None and checked >= limit:
            kept.append(d)
            continue
        if not url.startswith("http"):
            removed.append({"id": str(d.get("id")), "reason": "missing-url"})
            continue
        # Only auto-prune Newegg product URLs this pass (reliable Instock flags).
        host = urlparse(url).netloc.lower()
        if "newegg.com" not in host or "/p/" not in url:
            kept.append(d)
            continue
        checked += 1
        sleep_polite(0.35)
        html, status, _ = fetch_html(s, url)
        verdict = classify_listing(url, html, status)
        if verdict in ("dead", "oos"):
            removed.append({"id": str(d.get("id")), "reason": verdict, "url": url})
            continue
        if verdict == "broken":
            # Soft: keep on transient errors so we don't wipe the catalogue.
            kept.append(d)
            continue
        # Optionally refresh verified price when parse succeeds.
        if html and "newegg.com" in host:
            info = parse_newegg_listing_price(html)
            if info.get("ok") and info.get("price") is not None:
                old = d.get("price")
                new = info["price"]
                try:
                    old_f = float(old) if old is not None else None
                except (TypeError, ValueError):
                    old_f = None
                if old_f is not None:
                    d["lastPrice"] = round(old_f, 2)
                    if new < old_f:
                        d["priceDropped"] = True
                        d["dropAmount"] = round(old_f - new, 2)
                    else:
                        d["priceDropped"] = False
                        d.pop("dropAmount", None)
                d["price"] = new
                if info.get("previousPrice"):
                    d["previousPrice"] = info["previousPrice"]
        kept.append(d)
    return kept, removed


def build_deal(cat: str, item: dict[str, Any], verified: dict[str, Any]) -> dict[str, Any]:
    price = verified["price"]
    prev = verified.get("previousPrice") or item.get("previousPrice")
    if prev is not None and prev <= price:
        prev = None
    deal_id = slugify(item["title"], item["sku"])
    if cat == "Cases":
        why = f"Verified Newegg computer case listing at ${price:,.2f}"
    else:
        why = f"Verified Newegg listing at ${price:,.2f}"
    if prev:
        why += f" (was ${prev:,.2f})."
    else:
        why += "."
    why += f" Product deep link {item['sku']}."
    deal: dict[str, Any] = {
        "id": deal_id,
        "name": item["title"][:140],
        "category": cat,
        "price": round(float(price), 2),
        "previousPrice": round(float(prev), 2) if prev else None,
        "lastPrice": None,
        "priceDropped": False,
        "currency": "USD",
        "why": why,
        "merchant": "Newegg",
        "url": item["url"],
        "urlKind": "product",
        "sku": item["sku"],
    }
    # Attach local image if already healed/downloaded under images/<id>.jpg
    img = IMAGES_DIR / f"{deal_id}.jpg"
    if img.is_file() and img.stat().st_size >= 4000:
        deal["image"] = f"images/{deal_id}.jpg"
        deal["imageSource"] = "product-page"
    return deal


def seed_categories(
    deals: list[dict[str, Any]],
    s,
    only: set[str] | None = None,
    extra_queries: list[str] | None = None,
) -> tuple[list[dict[str, Any]], int]:
    existing_keys: set[str] = set()
    for d in deals:
        existing_keys |= deal_keys(d)

    added = 0
    cats = list(SEED_QUERIES.keys())
    if only:
        cats = [c for c in cats if c in only]

    # Count current
    counts = defaultdict(int)
    for d in deals:
        counts[str(d.get("category"))] += 1

    for cat in cats:
        need = max(0, TARGET_PER_SEED_CAT - counts[cat])
        if need <= 0 and not extra_queries:
            continue
        floor = CATEGORY_FLOORS.get(cat, 20.0)
        candidates: list[dict[str, Any]] = []
        for q, pat in SEED_QUERIES[cat]:
            candidates.extend(
                search_newegg(s, q, re.compile(pat, re.I), min_price=floor, max_n=25)
            )
            sleep_polite(0.5)
        if extra_queries and cat == "Cases":
            for q in extra_queries:
                candidates.extend(
                    search_newegg(
                        s,
                        q,
                        re.compile(r"\b(case|chassis|tower)\b", re.I),
                        min_price=floor,
                        max_n=20,
                    )
                )
        # Prefer discounted
        candidates.sort(
            key=lambda x: (
                0 if x.get("previousPrice") else 1,
                -((x.get("previousPrice") or x["price"]) - x["price"]),
            )
        )
        # Dedupe candidates by sku
        seen_sku: set[str] = set()
        uniq = []
        for c in candidates:
            if c["sku"] in seen_sku:
                continue
            seen_sku.add(c["sku"])
            uniq.append(c)

        got = 0
        for item in uniq:
            if got >= max(need, TARGET_PER_SEED_CAT if counts[cat] == 0 else need):
                break
            if any(k in existing_keys for k in (f"sku:{item['sku']}",)):
                continue
            sleep_polite(0.4)
            html, status, final_url = fetch_html(s, item["url"])
            if not html or status >= 400:
                continue
            verdict = classify_listing(item["url"], html, status)
            if verdict != "keep":
                continue
            info = parse_newegg_listing_price(html)
            if not info.get("ok"):
                continue
            price = info["price"]
            if price is None or price < floor:
                continue
            # Merge search previousPrice if page lacked was-price
            if not info.get("previousPrice") and item.get("previousPrice"):
                info["previousPrice"] = item["previousPrice"]
            deal = build_deal(cat, item, info)
            # Ensure unique id
            ids = {d.get("id") for d in deals}
            base = deal["id"]
            n = 2
            while deal["id"] in ids:
                deal["id"] = f"{base}-{n}"
                n += 1
            deals.append(deal)
            existing_keys |= deal_keys(deal)
            counts[cat] += 1
            got += 1
            added += 1
            print(f"  + [{cat}] ${deal['price']} {deal['name'][:70]}")
    return deals, added


def main() -> int:
    ap = argparse.ArgumentParser(description="Dynamic catalogue refresh + prune")
    ap.add_argument("--prune-only", action="store_true")
    ap.add_argument("--seed-only", action="store_true")
    ap.add_argument("--no-seed", action="store_true")
    ap.add_argument("--no-prune", action="store_true")
    ap.add_argument("--prune-limit", type=int, default=None, help="Max Newegg URLs to recheck")
    ap.add_argument(
        "--seed-cats",
        nargs="*",
        default=None,
        help="Subset of Cases RAM SSDs Motherboards",
    )
    ap.add_argument("--queries", nargs="*", default=None, help="Extra search queries (Cases)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not DEALS_PATH.exists():
        print(f"Missing {DEALS_PATH}", file=sys.stderr)
        return 1

    data = json.loads(DEALS_PATH.read_text(encoding="utf-8"))
    deals: list[dict[str, Any]] = list(data.get("deals") or [])
    before = len(deals)
    print(f"Loaded {before} deals")

    s = session()
    removed: list[dict[str, str]] = []

    if not args.seed_only and not args.no_prune:
        print("Pruning dead/OOS Newegg listings…")
        deals, removed = prune_deals(deals, s, limit=args.prune_limit)
        for r in removed:
            print(f"  - remove {r.get('id')} ({r.get('reason')})")

    added = 0
    if not args.prune_only and not args.no_seed:
        print("Seeding / growing catalogue…")
        only = set(args.seed_cats) if args.seed_cats else None
        deals, added = seed_categories(deals, s, only=only, extra_queries=args.queries)

    deals, dup_removed = dedupe_deals(deals)
    if dup_removed:
        print(f"Deduped {dup_removed} duplicate SKU/URL cards")

    now = datetime.now(timezone.utc)
    data["deals"] = deals
    data["updatedAt"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    data["weekLabel"] = week_label_now(now)
    data["catalogueRevision"] = data.get("catalogueRevision", 0) + 1
    data["lastRefresh"] = {
        "at": data["updatedAt"],
        "before": before,
        "after": len(deals),
        "removed": len(removed),
        "added": added,
        "deduped": dup_removed,
    }
    data.setdefault("title", "What's A Good Deal?")

    if args.dry_run:
        print("Dry run — not writing")
        print(json.dumps(data["lastRefresh"], indent=2))
        return 0

    DEALS_PATH.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"Wrote {DEALS_PATH}")
    print(
        f"  {before} → {len(deals)} deals "
        f"(+{added} / -{len(removed)} / dedupe {dup_removed})"
    )
    print(f"  catalogueRevision={data['catalogueRevision']} updatedAt={data['updatedAt']}")
    print("Next: python3 scripts/heal_images.py  # for any new deals missing photos")
    print("      python3 scripts/fetch_ratings.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
