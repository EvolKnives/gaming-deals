#!/usr/bin/env python3
"""
What kind of product is this? — one classifier for every tab.

Used by the hourly refresh to place new deals, to re-check every existing deal
each run (moving misfiled ones), and by the brand-site sales.

  1. Complete systems first. A title that lists several system specs
     (processor, graphics card, memory, storage) is a prebuilt desktop or a
     laptop, never the SSD or RAM it mentions.
  2. Compatibility text is ignored ("Supports ATX motherboards", "for
     laptop", "compatible with PS5"), so a case isn't read as a motherboard.
  3. Of the tabs whose product word appears, the one named earliest in the
     title wins: products name themselves before listing specs
     ("BRIO 505 Webcam … Microphone … Monitor" is a webcam).
Each tab's must-not words (data/category-rules.json) still apply.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
RULES = {r["category"]: r for r in json.loads(
    (ROOT / "data" / "category-rules.json").read_text(encoding="utf-8"))["seeds"]}

CPU_SPEC = re.compile(r"\b(core (ultra )?[3579]\b|i[3579][- ]?\d{4,5}\w*|ryzen (ai )?[3579]\b|ryzen \d{4}\w*|"
                      r"snapdragon|apple m[1-5]\b|celeron|pentium|athlon|intel n\d{3}\b)", re.I)
GPU_SPEC = re.compile(r"\b(rtx|gtx|geforce|radeon|arc [ab]\d{3})\b", re.I)
RAM_SPEC = re.compile(r"\b\d{1,3} ?gb\b[^,;()]{0,15}\b(lp)?(ddr\d|ram|memory)|"
                      r"\b(lp)?ddr\d\w*\b[^,;()]{0,25}\b\d{1,3} ?gb\b", re.I)
STORAGE_SPEC = re.compile(r"\b\d+(\.\d+)? ?(tb|gb)\b[^,;()]{0,25}\b(ssd|nvme|hdd|m\.2|storage|emmc)\b", re.I)
SCREEN_SIZE = re.compile(r"\b1[0-8](\.\d)?(\"|”|''|[- ]?inch\b|-in\b)", re.I)
LAPTOP_WORD = re.compile(r"\b(laptop|notebook|chromebook|macbook)\b", re.I)
LAPTOP_ACCESSORY = re.compile(r"\b(for|fits) (laptops?|notebooks?|macbooks?)\b|"
                              r"\b(laptop|notebook) (stand|bag|sleeve|backpack|cooling|cooler|charger|"
                              r"adapter|lock|dock|case|skin|riser|tray|table)\b", re.I)
DESKTOP_WORD = re.compile(r"\b(desktop|gaming pc|\bpc\b|tower|computer|workstation|pre-?built|all-in-one)\b", re.I)
STRONG_DESKTOP = re.compile(r"\b(pre-?built|gaming (pc|desktop|computer)|desktop (pc|computer))\b", re.I)

# Product words per tab, used for the "named earliest" rule. Where a tab's
# search rule is too loose for this (e.g. "phone" matches "headphones"), a
# stricter word list is given here.
NOUNS: dict[str, str] = {
    "GPUs": r"graphics card|video card|\b(geforce|radeon|arc)\b[^,]{0,40}?\b\d{1,2} ?gb\b|"
            r"\b(rtx|rx) ?\d{4}( ?(ti|xtx|xt|gre|super))?\b[^,]{0,25}\b\d{1,2} ?gb\b",
    "CPUs": r"\bprocessor\b|\bcpu\b(?! cooler| air cooler| liquid)",
    "Motherboards": r"motherboard|mainboard",
    "RAM": r"desktop memory|pc ram|memory kit|\bram\b|\b\d+ ?gb ?\(\d ?x ?\d+ ?gb\)",
    "SSDs": r"\bssd\b|solid state",
    "PSUs": r"power supply|\bpsu\b(?![^,]{0,8}(mount|shroud|cover|bracket|support))|\b\d{3,4} ?w\b[^,]{0,40}\b80 ?(plus|\+)",
    "Monitors": r"\bmonitor\b(?! (webcam|light|lamp|arm|stand|mount|speakers?|riser))|"
                r"\bdisplay\b(?=[^,]{0,30}\b\d{2,3} ?hz)|"
                r"\b\d{2}(\.\d)?[ -]?(inch|in\b|\"|”)[^,]{0,80}?\b(1[0-9]{2}|[2-5]\d{2}) ?hz\b",
    "Cases": r"\b(pc|computer|gaming|atx|itx|tower) case\b|\bchassis\b|\b(mid|full|mini)[- ]tower\b(?! (cpu )?cooler)|"
             r"\bcase\b(?! fan| fans| (for|compatible))",
    "Networking": r"\brouter\b|mesh (wi-?fi|system|router|network|node)|access point|network switch|"
                  r"ethernet switch|gigabit switch|wi-?fi\b[^,]{0,25}?\b(adapter|card|extender|dongle)|"
                  r"wireless (adapter|card)|range extender|\bwifi card\b",
    "TVs": r"\btv\b|television",
    "Phones": r"smartphone|\bphone\b(?!s? (case|mount|holder|stand))|\biphone \d+|galaxy [sza]\d+|"
              r"pixel \d+[a-z]?\b|\bunlocked\b",
    "Tablets": r"\btablet\b|\bipad\b|galaxy tab",
    "Art Tablets": r"drawing tablet|graphics tablet|graphic tablet|pen display|pen tablet|creative tablet",
    "Earbuds": r"earbuds?|true wireless|\btws\b|in-ear|earphones?",
    "Gaming Headsets": r"headset",
    "Headphones": r"headphones?",
    "Coolers": r"cpu cooler|air cooler|liquid cooler|\baio\b|tower cooler|cpu air cooler|water cooler",
}

# Compatibility clauses removed before matching product words
COMPAT = re.compile(
    r"\b(supports?|supporting|compatible with|compatibility|works with|for use with|fits|designed for|"
    r"for (pc|ps[45]|xbox|switch|mac|laptops?|notebooks?|desktops?|iphone|android|gaming pc)|"
    r"up to \d+ ?(gb|mm)|includes?|including|bundled? with|w/)\b[^,;()\-–—]*", re.I)


COMPONENT_WORD = re.compile(r"\b(desktop|pc|computer|gaming|tower|atx) (motherboard|mainboard|case|chassis|"
                            r"memory|ram|processor|power supply)\b", re.I)


def system_type(title: str) -> str | None:
    comp, cpu = COMPONENT_WORD.search(title), CPU_SPEC.search(title)
    if comp and (not cpu or comp.start() < cpu.start()):
        return None  # a part *for* a system ("Gaming Desktop Motherboard"), named before any spec
    specs = sum(bool(p.search(title)) for p in (CPU_SPEC, GPU_SPEC, RAM_SPEC, STORAGE_SPEC))
    if LAPTOP_WORD.search(title) and specs >= 2 and not LAPTOP_ACCESSORY.search(title):
        return "Laptops"
    if (specs >= 3 and SCREEN_SIZE.search(title) and not DESKTOP_WORD.search(title)
            and not LAPTOP_ACCESSORY.search(title)):
        return "Laptops"  # e.g. 'HP OMEN MAX 16" … Core Ultra 7 … 16GB DDR5 1TB SSD … RTX 5070'
    need = 2 if STRONG_DESKTOP.search(title) else 3
    if DESKTOP_WORD.search(title) and specs >= need and not LAPTOP_WORD.search(title):
        # the site lists gaming desktops: a graphics card must be named
        return "Prebuilts" if GPU_SPEC.search(title) else "_desktop"
    return None


def product_type(title: str, hint: str = "", price: float | None = None) -> str | None:
    """Tab for a product title, or None if it fits no tab."""
    if not title:
        return None
    sysd = system_type(title)
    if sysd:
        return None if sysd.startswith("_") else sysd
    core = COMPAT.sub(" ", title)
    best: tuple[int, int, str] | None = None
    order = list(RULES)
    for cat in order:
        rule = RULES[cat]
        if cat in ("Prebuilts", "Laptops"):
            continue  # systems were handled above
        mustnot = rule.get("titleMustNot")
        if mustnot and re.search(mustnot, title, re.I):
            continue
        if price is not None and price < float(rule.get("minPrice", 0)) * 0.5:
            continue
        noun = NOUNS.get(cat, rule["titleMust"])
        m = re.search(noun, core, re.I)
        if not m and hint:
            m2 = re.search(noun, hint, re.I)
            pos = 10_000 if m2 else None  # hint only counts when the title names nothing
        else:
            pos = m.start() if m else None
        if pos is None:
            continue
        key = (pos, order.index(cat), cat)
        if best is None or key < best:
            best = key
    return best[2] if best else None


def audit(deals: list[dict[str, Any]]) -> list[tuple[str, str, str | None]]:
    """Check every live deal's tab. Misfiled deals are moved to the tab they
    belong in; auto-added ones that fit no tab are marked for removal
    ("_misfit"). Hand-added deals with no clear type are left alone.
    Returns (name, old tab, new tab or None) for each change."""
    changes = []
    for d in deals:
        if d.get("startsAt") or d.get("category") in (None, "Other"):
            continue
        if d.get("source") == "brand-site":
            continue  # sorted when found, using the brand store's own section as a hint
        t = product_type(str(d.get("name") or ""), "", d.get("price"))
        if t == d["category"]:
            continue
        if t:
            changes.append((d["name"], d["category"], t))
            d["category"] = t
        elif d.get("autoSeeded"):
            changes.append((d["name"], d["category"], None))
            d["_misfit"] = True
    return changes
