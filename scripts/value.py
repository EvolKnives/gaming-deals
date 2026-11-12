#!/usr/bin/env python3
"""
Best Value rankings for What's A Good Deal?

Ranks graphics cards and processors by gaming performance per dollar at
today's prices. Runs at the end of every hourly refresh and writes
data/value.json, which the site's Best Value tab shows.

Performance is the approximate relative gaming score used by the PC builder
(scripts/build_pcs.py: fastest current GPU = 100). For every model (e.g. "RTX
5070") the cheapest listing across deals and regular-price parts is used, so
each model appears once at its best price today. Value = performance points
per $100. Also picks the fastest model under a few price limits.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_pcs as bp  # noqa: E402  (score tables)
OUT = ROOT / "data" / "value.json"
TOP = 12
GPU_LIMITS = [500, 800, 1500]
CPU_LIMITS = [150, 250, 400]


def model_name(kind: str, name: str) -> str | None:
    if kind == "gpu":
        m = re.search(r"\b(RTX|RX|Arc) ?([A-Z]?\d{3,4})( ?(Ti|XTX|XT|GRE|SUPER))?\b", name, re.I)
        if not m:
            return None
        brand = {"rtx": "RTX", "rx": "RX", "arc": "Arc"}[m.group(1).lower()]
        suffix = (" " + {"TI": "Ti", "SUPER": "Super"}.get(m.group(4).upper(), m.group(4).upper())) if m.group(4) else ""
        vram = re.search(r"\b(8|10|12|16|20|24|32) ?GB\b", name, re.I)
        # 8GB and 16GB versions of one card are different products
        mem = f" {vram.group(1)}GB" if vram and re.search(r"5060 ?ti|9060 ?xt|4060 ?ti", name, re.I) else ""
        return f"{brand} {m.group(2).upper()}{suffix}{mem}"
    for m in re.finditer(r"Ryzen [3579] \d{4}[A-Z0-9]*|Core Ultra [3579] \d{3}[A-Z]*|Core i[3579]-\d{4,5}[A-Z]*",
                         name, re.I):
        # skip series names ("Ryzen 5 9000 Series"): the real model comes later
        if re.fullmatch(r"(?i)ryzen [3579] \d000", m.group(0)):
            nxt = re.match(r"\s*(\d{4}[A-Z0-9]*)\b", name[m.end():], re.I)
            if nxt:  # "Ryzen 5 9000 9600" → "Ryzen 5 9600"
                return f"Ryzen {m.group(0).split()[1]} {nxt.group(1).upper()}"
            if re.match(r"(?i)\s*series", name[m.end():]):
                continue
        return re.sub(r"\s+", " ", m.group(0)).replace("RYZEN", "Ryzen")
    return None


def rank(kind: str, products: list[dict[str, Any]], table: list[tuple[str, int]],
         limits: list[int]) -> dict[str, Any]:
    best: dict[str, dict[str, Any]] = {}
    for p in products:
        price = p.get("price")
        if not isinstance(price, (int, float)) or price <= 0 or not p.get("url"):
            continue
        score = bp.first_score(table, p.get("name", ""))
        model = model_name(kind, p.get("name", ""))
        if not score or not model:
            continue
        # an "F" chip is the same chip without integrated graphics: one row per pair,
        # showing whichever is cheaper ("Ryzen 5 5500" / "5500F", "245K" / "245KF")
        key = re.sub(r"(\d)F$", r"\1", re.sub(r"KF$", "K", model)) if kind == "cpu" else model
        if key not in best or price < best[key]["price"]:
            was = p.get("previousPrice")
            best[key] = {
                "model": model, "score": score, "price": round(float(price), 2),
                "previousPrice": was if isinstance(was, (int, float)) and was > price else None,
                "name": p.get("name"), "url": p.get("url"), "image": p.get("image"),
                "merchant": p.get("merchant") or "Newegg",
                "value": round(score / float(price) * 100, 2),
                "id": p.get("id"),
            }
    rows = sorted(best.values(), key=lambda r: (-r["value"], r["price"]))
    picks = []
    for limit in limits:
        under = [r for r in rows if r["price"] <= limit]
        if under:
            top = max(under, key=lambda r: (r["score"], -r["price"]))
            picks.append({"limit": limit, "model": top["model"]})
    fastest = max(rows, key=lambda r: (r["score"], -r["price"]))["model"] if rows else None
    return {"rows": rows[:TOP], "picks": picks, "fastest": fastest, "count": len(rows)}


def main() -> int:
    deals = json.loads((ROOT / "data" / "deals.json").read_text(encoding="utf-8")).get("deals") or []
    try:
        pool = json.loads((ROOT / "data" / "build-parts.json").read_text(encoding="utf-8")).get("parts") or []
    except (OSError, ValueError):
        pool = []
    live = [d for d in deals if not d.get("startsAt")]
    gpus = [d for d in live + pool if d.get("category") == "GPUs"]
    cpus = [d for d in live + pool if d.get("category") == "CPUs"]
    out = {
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "gpu": rank("gpu", gpus, bp.GPU_SCORES, GPU_LIMITS),
        "cpu": rank("cpu", cpus, bp.CPU_SCORES, CPU_LIMITS),
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Value: {out['gpu']['count']} GPU models, {out['cpu']['count']} CPU models ranked")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
