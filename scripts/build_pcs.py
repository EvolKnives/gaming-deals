#!/usr/bin/env python3
"""
Auto PC builds for What's A Good Deal?

Reads data/deals.json and, for each budget in BUDGETS, picks the strongest
gaming PC that today's deals can make: CPU, motherboard, memory, graphics
card, SSD, power supply, case and (when the CPU has none in the box) a CPU
cooler. Writes data/builds.json, which the site's Builds tab shows.

Compatibility is read from product titles:
  - CPU socket ↔ motherboard socket (AM4, AM5, LGA1700, LGA1851)
  - memory type (DDR4 / DDR5) ↔ motherboard
  - motherboard size (ATX, Micro-ATX, Mini-ITX, E-ATX) ↔ case
  - power supply wattage ≥ what the graphics card needs
A part whose title doesn't say enough to check is left out rather than
guessed. Budgets no build can meet are skipped; identical builds are shown
once. Run by daily_refresh.py every hour; safe to run by hand.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from itertools import product
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEALS_PATH = ROOT / "data" / "deals.json"
BUILDS_PATH = ROOT / "data" / "builds.json"

BUDGETS = [1000, 1500, 2000, 3000]
COOLER_ESTIMATE = 35.0  # used only when no cooler deal exists today

# ---------------------------------------------------------------- parsing
CPU_SCORES = [  # relative gaming performance; first match wins
    (r"9800x3d", 100), (r"9950x3d", 98), (r"9900x3d", 92), (r"7800x3d", 92),
    (r"7950x3d", 90), (r"\b285k\b", 85), (r"9950x\b", 85), (r"14900k", 85),
    (r"9900x\b", 82), (r"7950x\b", 82), (r"\b270k\b", 81), (r"9700x", 80),
    (r"14700k", 80), (r"13900k", 80), (r"\b265k\b", 78), (r"7900x\b", 78),
    (r"9600x", 76), (r"7700x", 75), (r"14600k", 74), (r"5800x3d", 72),
    (r"7600x", 72), (r"\b245k\b", 70), (r"13600k", 70), (r"7600\b", 70),
    (r"5700x3d", 68), (r"8700g", 62), (r"12600k", 60), (r"14400", 58),
    (r"5800x\b", 58), (r"5700x\b", 55), (r"5600x\b", 52), (r"12400", 50),
    (r"5600\b", 50), (r"5500\b", 42),
    (r"ryzen 9", 80), (r"ryzen 7", 72), (r"ryzen 5", 60), (r"core ultra 9", 85),
    (r"core ultra 7", 78), (r"core ultra 5", 68), (r"\bi9\b", 78), (r"\bi7\b", 70),
    (r"\bi5\b", 58), (r"\bi3\b", 40),
]
GPU_SCORES = [
    (r"5090", 100), (r"4090", 95), (r"5080", 75), (r"4080", 70),
    (r"5070 ?ti", 62), (r"9070 ?xt", 60), (r"7900 ?xtx", 60), (r"4070 ?ti", 55),
    (r"7900 ?xt\b", 55), (r"5070", 52), (r"9070", 50), (r"7800 ?xt", 45),
    (r"4070", 45), (r"5060 ?ti", 40), (r"9060 ?xt", 40), (r"7700 ?xt", 38),
    (r"5060", 33), (r"4060 ?ti", 33), (r"9060", 30), (r"4060", 28),
    (r"\bb580\b", 28), (r"7600 ?xt", 26), (r"7600", 24), (r"\bb570\b", 24),
    (r"3060", 22), (r"\ba750\b", 20),
]
GPU_PSU_WATTS = [  # recommended whole-system PSU
    (r"5090|4090", 1000), (r"5080|4080|7900", 850), (r"5070 ?ti|9070 ?xt|4070 ?ti", 750),
    (r"5070|9070|4070|7800", 650), (r"5060|4060|9060|7700|7600|b580|b570|3060|a750", 550),
]
# CPUs sold with a cooler in the box
BOXED_COOLER = re.compile(
    r"\b(5500|5600|5600x|7600|8600g|8700g)\b(?!x)|wraith|with cooler|cooler included|"
    r"\bi[3579]-1[234]\d{3}f?\b(?!k)",
    re.I,
)


def first_score(table: list[tuple[str, int]], title: str) -> int | None:
    t = title.lower()
    for pat, score in table:
        if re.search(pat, t):
            return score
    return None


def cpu_socket(t: str) -> str | None:
    t = t.lower()
    if re.search(r"\bam5\b", t):
        return "AM5"
    if re.search(r"\bam4\b", t):
        return "AM4"
    if re.search(r"lga ?1851", t):
        return "LGA1851"
    if re.search(r"lga ?1700", t):
        return "LGA1700"
    if re.search(r"ryzen [3579] ?[789]\d{3}", t):
        return "AM5"
    if re.search(r"ryzen [3579] ?[35]\d{3}", t):
        return "AM4"
    if re.search(r"core ultra [3579] ?2\d\d", t):
        return "LGA1851"
    if re.search(r"\bi[3579]-1[234]\d{3}", t):
        return "LGA1700"
    return None


def board_socket(t: str) -> str | None:
    t = t.lower()
    if re.search(r"\bam5\b|lga ?1718|\b(b650|x670|x870|b850|a620)", t):
        return "AM5"
    if re.search(r"\bam4\b|\b(b550|x570|b450|a520)", t):
        return "AM4"
    if re.search(r"lga ?1851|\b(z890|b860|h810)", t):
        return "LGA1851"
    if re.search(r"lga ?1700|\b(z790|b760|h610|z690|b660|h770)", t):
        return "LGA1700"
    return None


def board_memory(t: str, socket: str) -> str | None:
    t = t.lower()
    if "ddr5" in t:
        return "DDR5"
    if "ddr4" in t:
        return "DDR4"
    return {"AM5": "DDR5", "LGA1851": "DDR5", "AM4": "DDR4"}.get(socket)


def board_size(t: str) -> str:
    t = t.lower()
    if re.search(r"mini[- ]?itx|\bitx\b|b650i|b850i|x870i|z890i|b760i", t):
        return "ITX"
    if re.search(r"micro[- ]?atx|m-atx|\bm?atx\b.*\bmicro|\bmatx\b|\buatx\b|\b[abhxz]\d{3}m\b", t):
        return "mATX"
    if re.search(r"e-?atx", t):
        return "EATX"
    return "ATX"


def case_fits(t: str) -> set[str]:
    t = t.lower()
    if re.search(r"e-?atx|full[- ]tower", t):
        return {"EATX", "ATX", "mATX", "ITX"}
    if re.search(r"\batx\b(?! ?power)|mid[- ]?tower", t):
        return {"ATX", "mATX", "ITX"}
    if re.search(r"micro[- ]?atx|m-atx|\bmatx\b", t):
        return {"mATX", "ITX"}
    if re.search(r"mini[- ]?itx|\bitx\b", t):
        return {"ITX"}
    return set()  # unknown size → not used


def ram_info(t: str) -> tuple[str | None, int | None]:
    tl = t.lower()
    kind = "DDR5" if "ddr5" in tl else "DDR4" if "ddr4" in tl else None
    m = re.search(r"(\d{1,3}) ?gb\b", tl)
    return kind, int(m.group(1)) if m else None


def ssd_gb(t: str) -> int | None:
    tl = t.lower()
    if not re.search(r"nvme|m\.2|pcie", tl):
        return None  # builds use M.2 NVMe drives
    m = re.search(r"(\d+(?:\.\d+)?) ?tb\b", tl)
    if m:
        return int(float(m.group(1)) * 1000)
    m = re.search(r"\b(\d{3,4}) ?gb\b", tl)
    return int(m.group(1)) if m else None


def psu_watts(t: str) -> int | None:
    m = re.search(r"\b(\d{3,4}) ?w\b", t.lower())
    return int(m.group(1)) if m else None


def gpu_psu_need(t: str) -> int:
    tl = t.lower()
    for pat, watts in GPU_PSU_WATTS:
        if re.search(pat, tl):
            return watts
    return 650


# ---------------------------------------------------------------- building
def part(d: dict[str, Any], role: str) -> dict[str, Any]:
    keep = ("id", "name", "price", "previousPrice", "url", "merchant", "image")
    return {"role": role, **{k: d.get(k) for k in keep}}


def candidates(deals: list[dict[str, Any]], now: datetime) -> dict[str, list[dict[str, Any]]]:
    def live(d: dict[str, Any]) -> bool:
        st = d.get("startsAt")
        if st:
            try:
                if datetime.fromisoformat(st.replace("Z", "+00:00")) > now:
                    return False
            except ValueError:
                return False
        return isinstance(d.get("price"), (int, float)) and d["price"] > 0 and bool(d.get("url"))

    by: dict[str, list[dict[str, Any]]] = {}
    for d in deals:
        if live(d):
            by.setdefault(str(d.get("category")), []).append(d)
    out: dict[str, list[dict[str, Any]]] = {k: [] for k in
                                            ("cpu", "board", "ram", "gpu", "ssd", "psu", "case", "cooler")}
    for d in by.get("CPUs", []):
        sock, score = cpu_socket(d["name"]), first_score(CPU_SCORES, d["name"])
        if sock and score:
            out["cpu"].append({**d, "_sock": sock, "_score": score,
                               "_boxed": bool(BOXED_COOLER.search(d["name"]))})
    for d in by.get("Motherboards", []):
        sock = board_socket(d["name"])
        mem = board_memory(d["name"], sock or "") if sock else None
        if sock and mem:
            out["board"].append({**d, "_sock": sock, "_mem": mem, "_size": board_size(d["name"])})
    for d in by.get("RAM", []):
        kind, gb = ram_info(d["name"])
        if kind and gb and gb >= 16:
            out["ram"].append({**d, "_mem": kind, "_gb": gb})
    for d in by.get("GPUs", []):
        score = first_score(GPU_SCORES, d["name"])
        if score:
            out["gpu"].append({**d, "_score": score, "_need": gpu_psu_need(d["name"])})
    for d in by.get("SSDs", []):
        gb = ssd_gb(d["name"])
        if gb and gb >= 500:
            out["ssd"].append({**d, "_gb": gb})
    for d in by.get("PSUs", []):
        w = psu_watts(d["name"])
        if w:
            out["psu"].append({**d, "_w": w})
    for d in by.get("Cases", []):
        fits = case_fits(d["name"])
        if fits:
            out["case"].append({**d, "_fits": fits})
    out["cooler"] = list(by.get("Coolers", []))
    return out


def best_build(c: dict[str, list[dict[str, Any]]], budget: float) -> dict[str, Any] | None:
    cooler = min(c["cooler"], key=lambda d: d["price"]) if c["cooler"] else None
    best, best_key = None, None
    for gpu, cpu in product(c["gpu"], c["cpu"]):
        base = gpu["price"] + cpu["price"]
        if base > budget:
            continue
        psu = min((p for p in c["psu"] if p["_w"] >= gpu["_need"]), key=lambda d: d["price"], default=None)
        if not psu:
            continue
        cool_price = 0.0 if cpu["_boxed"] else (cooler["price"] if cooler else COOLER_ESTIMATE)
        fixed = base + psu["price"] + cool_price
        for board in (b for b in c["board"] if b["_sock"] == cpu["_sock"]):
            case = min((k for k in c["case"] if board["_size"] in k["_fits"]),
                       key=lambda d: d["price"], default=None)
            if not case:
                continue
            for ram, ssd in product((r for r in c["ram"] if r["_mem"] == board["_mem"]), c["ssd"]):
                total = fixed + board["price"] + case["price"] + ram["price"] + ssd["price"]
                if total > budget:
                    continue
                # graphics card counts 3x the processor: for games it matters far more
                score = (3 * gpu["_score"] + cpu["_score"]
                         + (4 if ram["_gb"] >= 32 else 0) + (1 if ram["_gb"] >= 64 else 0)
                         + (2 if ssd["_gb"] >= 1000 else 0) + (1 if ssd["_gb"] >= 2000 else 0))
                key = (score, -total)
                if best_key is None or key > best_key:
                    best_key = key
                    best = {"gpu": gpu, "cpu": cpu, "board": board, "ram": ram, "ssd": ssd,
                            "psu": psu, "case": case, "total": total,
                            "cooler": None if cpu["_boxed"] else cooler}
    return best


def render(b: dict[str, Any], budget: int) -> dict[str, Any]:
    roles = [("cpu", "Processor"), ("cooler", "CPU cooler"), ("board", "Motherboard"),
             ("ram", "Memory"), ("gpu", "Graphics card"), ("ssd", "Storage"),
             ("psu", "Power supply"), ("case", "Case")]
    parts, notes = [], []
    for key, label in roles:
        if key == "cooler":
            if b["cpu"]["_boxed"]:
                notes.append("The processor comes with its own cooler.")
                continue
            if not b["cooler"]:
                parts.append({"role": label, "name": "Any CPU cooler (not in today's deals)",
                              "price": COOLER_ESTIMATE, "estimate": True})
                continue
        parts.append(part(b[key], label))
        if key == "cooler":
            notes.append(f"Make sure the cooler lists {b['cpu']['_sock']} support (most current coolers do).")
    total = round(sum(p["price"] for p in parts), 2)
    was = sum((p.get("previousPrice") or p["price"]) for p in parts)
    notes.append("Check that the graphics card fits the case before buying.")
    return {
        "budget": budget,
        "title": f"${budget:,} gaming PC",
        "total": total,
        "savings": round(max(0.0, was - total), 2),
        "summary": f"{short(b['cpu']['name'])} + {short(b['gpu']['name'])}",
        "parts": parts,
        "notes": notes,
    }


def short(name: str) -> str:
    """'GIGABYTE Eagle GeForce RTX 5060 Ti 8GB …' → 'RTX 5060 Ti'."""
    for pat in (r"(RTX|RX|Arc) ?[A-Z]?\d{3,4}(?: ?(?:Ti|XTX|XT|GRE))?",
                r"Ryzen [3579] \d{4}[A-Z0-9]*", r"Core Ultra [3579] \d{3}[A-Z]*",
                r"Core i[3579]-\d{4,5}[A-Z]*"):
        m = re.search(pat, name, re.I)
        if m:
            return m.group(0)
    return name.split(" - ")[0][:40]


def main() -> int:
    deals = json.loads(DEALS_PATH.read_text(encoding="utf-8")).get("deals") or []
    now = datetime.now(timezone.utc)
    c = candidates(deals, now)
    builds, seen = [], set()
    for budget in BUDGETS:
        b = best_build(c, budget)
        if not b:
            continue
        sig = tuple(b[k]["id"] for k in ("cpu", "board", "ram", "gpu", "ssd", "psu", "case"))
        if sig in seen:
            continue
        seen.add(sig)
        builds.append(render(b, budget))
    out = {"updatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "budgets": BUDGETS, "builds": builds}
    BUILDS_PATH.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Builds: {len(builds)} ({', '.join(b['title'] + ' $' + format(b['total'], ',.2f') for b in builds) or 'none'})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
