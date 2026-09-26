#!/usr/bin/env python3
"""
Refresh helper for What's A Good Deal?

This script does NOT invent prices or product photos. It:
  1) Loads data/deals.json
  2) Optionally lists each deal URL so a human (or a future fetch
     pipeline) can re-verify currentPrice / previousPrice
  3) Bumps updatedAt and weekLabel
  4) Writes the file back, preserving deal["image"] fields

Prefer repo-relative paths under images/ for deal photos so GitHub
Pages serves them reliably. Do not clear image fields on refresh.

For fully automated price scraping, wire in retailer APIs or a
trusted deal feed — never guess a number. If a price cannot be
verified, remove that deal rather than fabricating one.

Usage:
  python3 scripts/refresh.py            # stamp updatedAt only
  python3 scripts/refresh.py --check    # print URLs to re-verify
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "deals.json"


def week_label_now(dt: datetime) -> str:
    """Monday-based week label, e.g. 'Week of Sep 22'."""
    d = dt.date()
    monday = d.fromordinal(d.toordinal() - d.weekday())
    day = str(monday.day)  # no leading zero
    return f"Week of {monday.strftime('%b')} {day}"


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
            print(f"{i:2}. [{d.get('category','?')}] {d.get('name')}")
            print(f"    {d.get('price')} (was {d.get('previousPrice')}) @ {d.get('merchant')}")
            print(f"    image: {img}")
            print(f"    {d.get('url')}\n")
        print(
            "Re-check each retailer page. If a price cannot be verified, "
            "remove the deal from data/deals.json — never invent prices."
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

    OUT.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Updated {OUT}")
    print(f"  updatedAt: {data['updatedAt']}")
    print(f"  weekLabel: {data['weekLabel']}")
    print(f"  deals:     {len(deals)}")
    with_img = sum(1 for d in deals if d.get("image"))
    print(f"  images:    {with_img}/{len(deals)}")
    if missing_images:
        print("  missing images:")
        for mid in missing_images:
            print(f"    - {mid}")
    print("Remember: re-verify live retailer prices before publishing.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
