#!/usr/bin/env python3
"""
Refresh helper for What's A Good Deal?

This script does NOT invent prices or product photos. It:
  1) Loads data/deals.json
  2) Optionally lists each deal URL so a human (or a future fetch
     pipeline) can re-verify currentPrice / previousPrice
  3) Bumps updatedAt and weekLabel
  4) Writes the file back, preserving deal["image"] fields

Price-drop fields (set when a refresh verifies a new price):
  - lastPrice     — price at the previous successful refresh (number or null)
  - priceDropped  — true when current price < lastPrice from the prior refresh
  - dropAmount    — optional; how much it fell since last refresh (old - new)

On each refresh that verifies a new price, call apply_verified_price():
  1. Compare new price to the old deal.price (that becomes lastPrice).
  2. If new < old → priceDropped true, dropAmount = old - new.
  3. If new >= old or first seen → priceDropped false, clear dropAmount.
  4. Never invent prices.

previousPrice remains list/MSRP for "% off" badges — do not confuse it
with lastPrice (last refresh check).

Prefer repo-relative paths under images/ for deal photos so GitHub
Pages serves them reliably. Do not clear image fields on refresh.
Run scripts/fix_product_links.py to resolve search CTAs to product
pages when a confident SKU match exists, then scripts/heal_images.py
(or refresh.py --heal-images) to audit and re-download photos from
those product pages. Product URLs are preferred for hourly price
verification — search URLs are harder / blocked more often.

Category labels must be plural grammar (never apostrophe plurals):
GPUs, CPUs, Monitors, TVs, Home Theater, Art Tablets, PSUs, Cases, Motherboards, RAM, SSDs, Mice, Keyboards. The UI also sorts
visible deals by biggest list/MSRP savings first (see app.js).

For fully automated price scraping, wire in retailer APIs or a
trusted deal feed — never guess a number. If a price cannot be
verified, remove that deal rather than fabricating one.

Usage:
  python3 scripts/refresh.py                 # stamp updatedAt only
  python3 scripts/refresh.py --check         # print URLs to re-verify
  python3 scripts/refresh.py --heal-images   # stamp + audit/heal product photos
  python3 scripts/refresh.py --fetch-dates  # stamp + fill endsAt/startsAt when known
"""

from __future__ import annotations

import argparse
import subprocess
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "deals.json"


def week_label_now(dt: datetime) -> str:
    """Monday-based week label, e.g. 'Week of Sep 22'."""
    d = dt.date()
    monday = d.fromordinal(d.toordinal() - d.weekday())
    day = str(monday.day)  # no leading zero
    return f"Week of {monday.strftime('%b')} {day}"


def _as_price(value: Any) -> float | None:
    """Return a finite non-negative float, or None if missing/invalid."""
    if value is None:
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n != n or n < 0:  # NaN or negative
        return None
    return n


def apply_verified_price(deal: dict, new_price: Any) -> dict:
    """Apply a verified live price to a deal dict (mutates and returns it).

    Sets lastPrice from the prior deal["price"], then updates priceDropped
    / dropAmount when the new verified price is lower. Never invents
    prices — pass only numbers checked on a retailer page or trusted feed.
    If new_price cannot be parsed, the deal is left unchanged.
    """
    new = _as_price(new_price)
    if new is None:
        return deal

    old = _as_price(deal.get("price"))
    if old is not None:
        deal["lastPrice"] = round(old, 2)
        if new < old:
            deal["priceDropped"] = True
            deal["dropAmount"] = round(old - new, 2)
        else:
            deal["priceDropped"] = False
            deal.pop("dropAmount", None)
    else:
        # First time we have a price for this deal.
        deal["lastPrice"] = None
        deal["priceDropped"] = False
        deal.pop("dropAmount", None)

    deal["price"] = round(new, 2)
    return deal


def clear_price_drop(deal: dict) -> dict:
    """Mark a deal as not dropped (e.g. after first sighting or a rise)."""
    deal["priceDropped"] = False
    deal.pop("dropAmount", None)
    return deal


def main() -> int:
    parser = argparse.ArgumentParser(description="Refresh deals.json metadata")
    parser.add_argument(
        "--check",
        action="store_true",
        help="List deal URLs that should be re-verified manually",
    )
    parser.add_argument(
        "--stamp-only",
        action="store_true",
        default=True,
        help="Only bump updatedAt / weekLabel (default)",
    )
    parser.add_argument(
        "--heal-images",
        action="store_true",
        help="After stamping, run scripts/heal_images.py to audit/fix photos",
    )
    parser.add_argument(
        "--fix-links",
        action="store_true",
        help="After stamping, run scripts/fix_product_links.py",
    )
    parser.add_argument(
        "--fetch-dates",
        action="store_true",
        help="After stamping, run scripts/fetch_deal_dates.py for endsAt/startsAt",
    )
    args = parser.parse_args()

    if not OUT.exists():
        print(f"Missing {OUT}", file=sys.stderr)
        return 1

    data = json.loads(OUT.read_text(encoding="utf-8"))
    deals = data.get("deals") or []
    now = datetime.now(timezone.utc)

    if args.check:
        print(f"{len(deals)} deals to verify:\n")
        for i, d in enumerate(deals, 1):
            img = d.get("image") or "(no image)"
            dropped = d.get("priceDropped")
            last = d.get("lastPrice")
            drop_amt = d.get("dropAmount")
            drop_note = ""
            if dropped:
                drop_note = f"  [DROPPED since last refresh"
                if drop_amt is not None:
                    drop_note += f" by ${drop_amt}"
                drop_note += "]"
            print(f"{i:2}. [{d.get('category','?')}] {d.get('name')}")
            print(
                f"    {d.get('price')} (list/MSRP {d.get('previousPrice')}; "
                f"last refresh {last}) @ {d.get('merchant')}{drop_note}"
            )
            print(f"    image: {img}")
            print(f"    {d.get('url')}\n")
        print(
            "Re-check each retailer page. If a price cannot be verified, "
            "remove the deal from data/deals.json — never invent prices."
        )
        print(
            "When a verified price is lower than the prior deal['price'], "
            "set lastPrice to the old price, priceDropped true, and "
            "dropAmount = old - new (see apply_verified_price)."
        )
        print(
            "Keep deal['image'] as a repo-relative path under images/ "
            "(preferred) or a hotlinkable CDN URL. Do not clear images "
            "when refreshing prices."
        )
        return 0

    data["updatedAt"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    data["weekLabel"] = week_label_now(now)
    data.setdefault("title", "What's A Good Deal?")

    # Preserve existing image fields; never invent product photos here.
    missing_images = [d.get("id") or d.get("name") for d in deals if not d.get("image")]
    dropped_count = sum(1 for d in deals if d.get("priceDropped"))

    OUT.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Updated {OUT}")
    print(f"  updatedAt: {data['updatedAt']}")
    print(f"  weekLabel: {data['weekLabel']}")
    print(f"  deals:     {len(deals)}")
    with_img = sum(1 for d in deals if d.get("image"))
    print(f"  images:    {with_img}/{len(deals)}")
    print(f"  dropped:   {dropped_count}/{len(deals)} (priceDropped)")
    if missing_images:
        print("  missing images:")
        for mid in missing_images:
            print(f"    - {mid}")
    print("Remember: re-verify live retailer prices before publishing.")
    print(
        "Tip: use apply_verified_price(deal, new_price) when a scrape "
        "confirms a new number so lastPrice / priceDropped stay correct."
    )

    if args.fix_links:
        fix = ROOT / "scripts" / "fix_product_links.py"
        print(f"\nRunning {fix.name} …")
        venv_py = ROOT / ".venv" / "bin" / "python"
        py = str(venv_py) if venv_py.is_file() else sys.executable
        rc = subprocess.call([py, str(fix)])
        if rc != 0:
            print("fix_product_links.py failed", file=sys.stderr)
            return rc
        data = json.loads(OUT.read_text(encoding="utf-8"))
        deals = data.get("deals") or []

    if args.fetch_dates:
        fetch_dates = ROOT / "scripts" / "fetch_deal_dates.py"
        print(f"\nRunning {fetch_dates.name} …")
        venv_py = ROOT / ".venv" / "bin" / "python"
        py = str(venv_py) if venv_py.is_file() else sys.executable
        rc = subprocess.call([py, str(fetch_dates)])
        if rc != 0:
            print("fetch_deal_dates.py failed", file=sys.stderr)
            return rc
        data = json.loads(OUT.read_text(encoding="utf-8"))
        deals = data.get("deals") or []
        with_ends = sum(1 for d in deals if d.get("endsAt"))
        with_starts = sum(1 for d in deals if d.get("startsAt"))
        print(f"Post-fetch-dates endsAt: {with_ends}/{len(deals)} startsAt: {with_starts}/{len(deals)}")

    if args.heal_images:
        heal = ROOT / "scripts" / "heal_images.py"
        print(f"\nRunning {heal.name} …")
        # Prefer venv interpreter when present so Pillow/requests resolve.
        venv_py = ROOT / ".venv" / "bin" / "python"
        py = str(venv_py) if venv_py.is_file() else sys.executable
        rc = subprocess.call([py, str(heal)])
        if rc != 0:
            print("heal_images.py failed — photos still broken", file=sys.stderr)
            return rc
        # Re-read counts after heal
        data = json.loads(OUT.read_text(encoding="utf-8"))
        deals = data.get("deals") or []
        with_img = sum(1 for d in deals if d.get("image"))
        print(f"Post-heal images: {with_img}/{len(deals)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
