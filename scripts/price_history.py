#!/usr/bin/env python3
"""
Price history for What's A Good Deal?

data/price-history.json stores only price *changes*:

  {"items": {SKU: [[hour, price], ...]},   # a price holds until the next entry
   "seen":  {SKU: hour}}                   # last hour the product was checked

A price of null marks a gap: the product went unchecked for more than
GAP_HOURS, so nothing is assumed about its price until the next entry.

"hour" is whole hours since 1970-01-01 UTC. An hourly check that finds the
same price as last time writes nothing new, only bumps "seen". Changes older
than KEEP_DAYS are dropped, except the last one before the cutoff, which is
the price that was in effect when the window starts.

From the history it also works out, per deal:
  low30 / high30 / typical30  lowest, highest and usual price over the last
                              30 days ("usual" = the price held longest)
  historyDays                 days since tracking started
  lowest30                    today's price is the lowest of the last 30 days
  wasUnseen                   the store's "was" price is above anything it
                              charged in the last 30 days (a likely inflated
                              markdown)
The two flags need MIN_DAYS_FOR_FLAGS days of tracking inside the 30-day
window, so a new product never gets a misleading label.

Usage:
  python3 scripts/price_history.py --backfill   # rebuild from git history of data/deals.json
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
HISTORY_PATH = ROOT / "data" / "price-history.json"
KEEP_DAYS = 90
WINDOW_DAYS = 30
MIN_DAYS_FOR_FLAGS = 14
STALE_HOURS = 48  # a product not seen for this long gets no flags
GAP_HOURS = 48    # unchecked longer than this → gap marker, not an assumed price


def hour_index(when: datetime) -> int:
    return int(when.timestamp() // 3600)


def load() -> dict[str, Any]:
    try:
        data = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
        if isinstance(data.get("items"), dict) and data.get("format") == "changes":
            data.setdefault("seen", {})
            return data
    except (OSError, ValueError):
        pass
    return {"items": {}, "seen": {}}


def save(data: dict[str, Any], now: datetime) -> None:
    data["updatedAt"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    data["format"] = "changes"
    data["keepDays"] = KEEP_DAYS
    HISTORY_PATH.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n",
                            encoding="utf-8")


def sku_of(d: dict[str, Any]) -> str | None:
    if d.get("sku"):
        return str(d["sku"]).upper()
    m = re.search(r"/p/((?:N82E168)?[0-9A-Z-]{8,})", str(d.get("url") or ""), re.I)
    return m.group(1).upper() if m else None  # older snapshots: SKU from the link


def prices_of(products: Iterable[dict[str, Any]]) -> Iterable[tuple[str, float]]:
    for d in products:
        sku, price = sku_of(d), d.get("price")
        if sku and isinstance(price, (int, float)) and price > 0 and not d.get("upcoming"):
            yield sku, round(float(price), 2)


def observe(data: dict[str, Any], sku: str, hour: int, price: float) -> None:
    """Record a price check. Only a change of price adds an entry."""
    series = data["items"].setdefault(sku, [])
    last_seen = data["seen"].get(sku)
    data["seen"][sku] = max(hour, last_seen if last_seen is not None else hour)
    if not series or hour > series[-1][0]:
        if series and last_seen is not None and hour - last_seen > GAP_HOURS and series[-1][1] is not None:
            series.append([last_seen + 1, None])  # unchecked stretch: don't assume a price
        if not series or series[-1][1] != price:
            series.append([hour, price])
        return
    # an older check (backfill out of order): insert in time order, drop repeats
    series.append([hour, price])
    series.sort(key=lambda p: p[0])
    deduped: list[list[float]] = []
    for h, p in series:
        if deduped and deduped[-1][0] == h:
            deduped[-1][1] = p
        elif not deduped or deduped[-1][1] != p:
            deduped.append([h, p])
    data["items"][sku] = deduped


def prune(data: dict[str, Any], now_hour: int) -> None:
    cutoff = now_hour - KEEP_DAYS * 24
    for sku in list(data["items"]):
        if data["seen"].get(sku, 0) <= cutoff:  # not seen in 90 days: forget it
            del data["items"][sku]
            data["seen"].pop(sku, None)
            continue
        s = data["items"][sku]
        older = [p for p in s if p[0] <= cutoff]
        data["items"][sku] = ([older[-1]] if older else []) + [p for p in s if p[0] > cutoff]


def window_stats(series: list[list[float]], seen: int, now_hour: int) -> dict[str, Any]:
    """Prices in effect during the last 30 days, weighted by how long each held."""
    start = now_hour - WINDOW_DAYS * 24
    end = min(seen, now_hour) + 1
    held: dict[float, int] = {}
    for i, (h, p) in enumerate(series):
        nxt = series[i + 1][0] if i + 1 < len(series) else end
        a, b = max(h, start), min(nxt, end)
        if b > a and p is not None:
            held[p] = held.get(p, 0) + (b - a)
    if not held:
        return {}
    return {
        "low30": min(held),
        "high30": max(held),
        "typical30": max(held, key=lambda p: (held[p], -p)),  # price held longest
        "historyDays": (now_hour - series[0][0]) // 24 + 1,
        "_trackedDays30": sum(held.values()) / 24,  # observed time only, gaps excluded
    }


def annotate(deal: dict[str, Any], series: list[list[float]] | None, seen: int | None,
             now_hour: int) -> None:
    """Add 30-day stats and honest-discount flags to a deal (in place)."""
    for k in ("low30", "high30", "typical30", "historyDays", "trackedDays30", "lowest30", "wasUnseen"):
        deal.pop(k, None)
    if not series or seen is None:
        return
    s = window_stats(series, seen, now_hour)
    deal.update({k: v for k, v in s.items() if not k.startswith("_")})
    deal["trackedDays30"] = round(s.get("_trackedDays30", 0), 1)  # observed days in the window
    if s.get("_trackedDays30", 0) < MIN_DAYS_FOR_FLAGS or now_hour - seen > STALE_HOURS:
        return  # too little recent history to judge fairly
    price = float(deal.get("price") or 0)
    if price and price <= s["low30"] and s["high30"] > s["low30"]:
        deal["lowest30"] = True  # cheapest in 30 days, and the price has moved
    was = deal.get("previousPrice")
    if isinstance(was, (int, float)) and was > s["high30"] * 1.01:
        deal["wasUnseen"] = True


def record(deals: list[dict[str, Any]], parts: list[dict[str, Any]], now: datetime) -> None:
    """Log this hour's prices, then annotate the deals with stats and flags."""
    data = load()
    hour = hour_index(now)
    for sku, price in prices_of(list(deals) + list(parts)):
        observe(data, sku, hour, price)
    prune(data, hour)
    for d in deals:
        sku = sku_of(d)
        if sku:
            annotate(d, data["items"].get(sku), data["seen"].get(sku), hour)
    save(data, now)


def backfill() -> int:
    """Rebuild the history from every committed version of data/deals.json."""
    log = subprocess.run(
        ["git", "log", "--reverse", "--format=%H %cI", "--", "data/deals.json"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.split("\n")
    data: dict[str, Any] = {"items": {}, "seen": {}}
    snapshots = 0
    for line in log:
        if not line.strip():
            continue
        commit, when = line.split(" ", 1)
        try:
            blob = subprocess.run(["git", "show", f"{commit}:data/deals.json"], cwd=ROOT,
                                  capture_output=True, text=True, check=True).stdout
            deals = json.loads(blob).get("deals") or []
        except (subprocess.CalledProcessError, ValueError):
            continue
        hour = hour_index(datetime.fromisoformat(when).astimezone(timezone.utc))
        for sku, price in prices_of(deals):
            observe(data, sku, hour, price)
        snapshots += 1
    now = datetime.now(timezone.utc)
    prune(data, hour_index(now))
    save(data, now)
    changes = sum(len(s) for s in data["items"].values())
    print(f"Backfilled {snapshots} snapshots → {len(data['items'])} products, {changes} price entries")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", action="store_true")
    args = ap.parse_args()
    raise SystemExit(backfill() if args.backfill else 0)
