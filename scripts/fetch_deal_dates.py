#!/usr/bin/env python3
"""
Fetch sale start/end dates for What's A Good Deal?

Reads data/deals.json, fetches product pages when practical, and sets:
  - endsAt   — ISO UTC when a sale/promo end is confidently known
  - startsAt — ISO UTC when a scheduled promo start is confidently known

Never invents dates. Omits fields when unknown / blocked / sentinel.
Skips 403/503/timeouts and schema.org priceValidUntil alone (too often a
rolling feed default, not a real sale end).

Confidence sources (today):
  - Newegg product JSON: PromotionScheduleActiveDate /
    PromotionScheduleExpirationLocal (reject year-1900 sentinels)
  - Dell (and similar) visible "Offer ends M/D/YYYY h:mm AM/PM" text
    interpreted in America/Los_Angeles when no timezone is given

Future refreshes should re-run this so endsAt/startsAt stay filled.

Usage:
  python3 scripts/fetch_deal_dates.py
  python3 scripts/fetch_deal_dates.py --dry-run
  python3 scripts/fetch_deal_dates.py --limit 20
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DEALS_PATH = ROOT / "data" / "deals.json"
PT = ZoneInfo("America/Los_Angeles")

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/122.0.0.0 Safari/537.36"
)

# Merchants we attempt to scrape for schedule fields / offer text.
FETCH_MERCHANTS = {
    "Newegg",
    "Dell",
    "Micro Center",
    "Crutchfield",
    "XPPen",
    "LG",
    # Amazon/Best Buy often block datacenter IPs — still try briefly.
    "Amazon",
    "Best Buy",
}

OFFER_ENDS_RE = re.compile(
    r"Offer ends\s+(\d{1,2}/\d{1,2}/\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)",
    re.I,
)
SALE_ENDS_RE = re.compile(
    r"(?:Sale|Deal|Promo(?:tion)?)\s+ends?\s+(\d{1,2}/\d{1,2}/\d{4}"
    r"(?:\s+\d{1,2}:\d{2}\s*[AP]M)?)",
    re.I,
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


def parse_ne_dt(value: str | None) -> datetime | None:
    """Parse Newegg schedule strings like '2026-10-05 06:59:59.000+00:00'."""
    if not value or value in ("null", "None"):
        return None
    v = value.strip().strip('"').replace(" ", "T", 1)
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def is_sentinel(dt: datetime | None) -> bool:
    """Newegg uses 1900-01-01 placeholders for 'no schedule'."""
    if dt is None:
        return True
    return dt.year < 2000


def to_iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_offer_ends_local(raw: str) -> datetime | None:
    """Parse '9/28/2026 11:59 PM' as Pacific wall time → UTC."""
    raw = raw.strip()
    for fmt in ("%m/%d/%Y %I:%M %p", "%m/%d/%Y"):
        try:
            local = datetime.strptime(raw, fmt)
            if fmt == "%m/%d/%Y":
                local = local.replace(hour=23, minute=59, second=59)
            return local.replace(tzinfo=PT).astimezone(timezone.utc)
        except ValueError:
            continue
    return None


def extract_newegg_schedule(html: str) -> tuple[datetime | None, datetime | None]:
    starts = [
        parse_ne_dt(m.group(1))
        for m in re.finditer(
            r'"PromotionScheduleActiveDate"\s*:\s*"([^"]+)"', html
        )
    ]
    ends = [
        parse_ne_dt(m.group(1))
        for m in re.finditer(
            r'"PromotionScheduleExpirationLocal"\s*:\s*"([^"]+)"', html
        )
    ]
    if not ends:
        ends = [
            parse_ne_dt(m.group(1))
            for m in re.finditer(
                r'"PromotionScheduleExpiration"\s*:\s*"([^"]+)"', html
            )
        ]
    start = next((d for d in starts if d and not is_sentinel(d)), None)
    end = next((d for d in ends if d and not is_sentinel(d)), None)
    return start, end


def extract_offer_text_end(html: str) -> datetime | None:
    for rx in (OFFER_ENDS_RE, SALE_ENDS_RE):
        m = rx.search(html)
        if m:
            dt = parse_offer_ends_local(m.group(1))
            if dt and not is_sentinel(dt):
                return dt
    return None


def fetch_html(session, url: str, merchant: str) -> str | None:
    timeout = 28 if merchant == "Dell" else (12 if merchant in ("Best Buy", "Amazon") else 20)
    try:
        r = session.get(url, timeout=timeout, allow_redirects=True)
    except Exception:
        return None
    if r.status_code in (403, 503, 429) or r.status_code >= 400:
        return None
    if len(r.text) < 3000:
        # Amazon/BB captcha shells
        return None
    return r.text


def detect_dates(
    html: str, merchant: str
) -> tuple[datetime | None, datetime | None, str]:
    """Return (startsAt, endsAt, source_note)."""
    start = end = None
    note = ""

    if merchant == "Newegg" or "newegg.com" in html[:500].lower():
        start, end = extract_newegg_schedule(html)
        if start or end:
            note = "newegg-PromotionSchedule"

    if end is None:
        text_end = extract_offer_text_end(html)
        if text_end:
            end = text_end
            note = (note + "+" if note else "") + "offer-ends-text"

    return start, end, note


def apply_dates(
    deal: dict[str, Any],
    start: datetime | None,
    end: datetime | None,
    now: datetime,
) -> dict[str, str]:
    """Mutate deal endsAt/startsAt. Returns change summary."""
    changes: dict[str, str] = {}

    # endsAt: only keep if still in the future (don't publish stale ends).
    if end and end > now:
        iso = to_iso_z(end)
        if deal.get("endsAt") != iso:
            changes["endsAt"] = iso
        deal["endsAt"] = iso
    else:
        if "endsAt" in deal:
            changes["endsAt"] = "(cleared)"
        deal.pop("endsAt", None)

    # startsAt: keep when in the future (upcoming promo). Past starts → omit.
    if start and start > now:
        iso = to_iso_z(start)
        if deal.get("startsAt") != iso:
            changes["startsAt"] = iso
        deal["startsAt"] = iso
    else:
        if "startsAt" in deal:
            changes["startsAt"] = "(cleared)"
        deal.pop("startsAt", None)

    return changes


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch deal endsAt/startsAt")
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
    now = datetime.now(timezone.utc)
    session = _session()

    fetched = 0
    with_ends = 0
    with_starts = 0
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

    print(f"Fetching dates for {len(targets)} product deals (of {len(deals)}) …")

    for deal in targets:
        mid = deal.get("id") or deal.get("name") or "?"
        merchant = deal.get("merchant") or ""
        url = deal["url"]
        html = fetch_html(session, url, merchant)
        fetched += 1
        if html is None:
            blocked += 1
            skipped += 1
            print(f"  skip/blocked  {mid} [{merchant}]")
            time.sleep(args.sleep)
            continue

        start, end, note = detect_dates(html, merchant)
        if is_sentinel(start):
            start = None
        if is_sentinel(end):
            end = None

        if not start and not end:
            unknown += 1
            print(f"  unknown       {mid} [{merchant}]")
            time.sleep(args.sleep)
            continue

        changes = apply_dates(deal, start, end, now)
        if deal.get("endsAt"):
            with_ends += 1
        if deal.get("startsAt"):
            with_starts += 1
        if changes:
            updated_ids.append(str(mid))
            print(
                f"  set           {mid} [{merchant}] "
                f"startsAt={deal.get('startsAt')} endsAt={deal.get('endsAt')} "
                f"({note})"
            )
        else:
            print(f"  unchanged     {mid} [{merchant}] ({note})")
        time.sleep(args.sleep)

    # Recount across full catalog (including deals we didn't re-fetch).
    total_ends = sum(1 for d in deals if d.get("endsAt"))
    total_starts = sum(1 for d in deals if d.get("startsAt"))

    if not args.dry_run:
        DEALS_PATH.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"\nWrote {DEALS_PATH}")
    else:
        print("\nDry run — no write")

    print(f"  fetched:     {fetched}")
    print(f"  blocked:     {blocked}")
    print(f"  unknown:     {unknown}")
    print(f"  with endsAt: {total_ends} (set this pass: {with_ends})")
    print(f"  with startsAt: {total_starts} (set this pass: {with_starts})")
    if updated_ids:
        print("  updated ids:")
        for i in updated_ids:
            print(f"    - {i}")
    print(
        "Remember: never invent endsAt/startsAt. Re-run on refresh to refill."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
