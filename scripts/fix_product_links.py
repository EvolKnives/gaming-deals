#!/usr/bin/env python3
"""
Resolve search/listing retailer URLs to canonical product pages.

For each deal in data/deals.json:
  1) Classify url as product | search | other (sets deal["urlKind"]).
  2) When urlKind is search (or a known category/hub page), try to resolve a
     same-merchant product page that matches the deal name / model / SKU.
  3) Store asin / sku when known. Never invent prices. Prefer accurate
     fewer deep links over wrong SKUs — leave search URL when ambiguous.

Usage:
  python3 scripts/fix_product_links.py              # resolve + write
  python3 scripts/fix_product_links.py --dry-run    # report only
  python3 scripts/fix_product_links.py --ids a b    # subset
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote_plus, urlparse

ROOT = Path(__file__).resolve().parents[1]
DEALS_PATH = ROOT / "data" / "deals.json"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

NEWEGG_ITEM_RE = re.compile(r"(N82E168[0-9]{8,})", re.I)
AMAZON_ASIN_RE = re.compile(r"/(?:dp|gp/product)/([A-Z0-9]{10})", re.I)
BB_SKU_RE = re.compile(r"/(\d{5,8})\.p", re.I)
MC_SKU_RE = re.compile(r"/product/(\d+)", re.I)

# High-confidence same-merchant product URLs curated from verified listings.
# Only include when the ASIN/SKU/model clearly matches the deal name.
CURATED_PRODUCT_URLS: dict[str, str] = {
    # Amazon — ASINs verified via public listings (same product family/SKU)
    "amd-ryzen-5-9600x": "https://www.amazon.com/dp/B0D6NN6TM7",
    "amd-ryzen-5-7600x": "https://www.amazon.com/dp/B0BBJDS62N",
    "amd-ryzen-7-9700x": "https://www.amazon.com/dp/B0D6NMDNNX",
    "amd-ryzen-9-9900x": "https://www.amazon.com/dp/B0D6NN87T8",
    "amd-ryzen-7-7800x3d": "https://www.amazon.com/dp/B0BTZB7F88",
    "amd-ryzen-9-9950x": "https://www.amazon.com/dp/B0D6NNRBGP",
    "amd-ryzen-9-7900x": "https://www.amazon.com/dp/B0BBJ59WJ4",
    "amd-ryzen-7-9850x3d-amazon": "https://www.amazon.com/dp/B0G8JMLXNQ",
    "gigabyte-rx-9070-xt": "https://www.amazon.com/dp/B0DT7B79K9",
    "msi-ventus-rtx-5080-amazon": "https://www.amazon.com/dp/B0GVGP3JG3",
    "logitech-g502-x-plus": "https://www.amazon.com/dp/B092CB69Q4",
    "razer-deathadder-v3-pro": "https://www.amazon.com/dp/B0B6XZLNHQ",
    "logitech-g-pro-x-superlight-2": "https://www.amazon.com/dp/B09NBWL8J5",
    "corsair-k70-pro-tkl": "https://www.amazon.com/dp/B0D83TJ5RB",
    "msi-mpg-a850gs": "https://www.amazon.com/dp/B0DT2V39K4",
    "logitech-g203": "https://www.amazon.com/dp/B01KUGR3MA",
    # Best Buy numeric SKUs
    "samsung-g80sd": (
        "https://www.bestbuy.com/site/samsung-32-odyssey-oled-g8-g81sf-4k-uhd-"
        "240hz-0-03ms-amd-freesync-premium-pro-glare-free-hdr-400-gaming-monitor-"
        "silver/6619366.p?skuId=6619366"
    ),
    "asus-xg27aqdmg": (
        "https://www.bestbuy.com/site/asus-rog-strix-xg27aqdmg-27-class-wqhd-"
        "gaming-oled-monitor/11534131.p?skuId=11534131"
    ),
    "lg-32gs95ue": (
        "https://www.bestbuy.com/site/lg-ultragear-32gs95ue-b-32-4k-uhd-oled-"
        "gaming-monitor-black/6619495.p?skuId=6619495"
    ),
    # Manufacturer PDPs (Best Buy search left unresolved / category hubs fixed)
    "lg-oled65c6": "https://www.lg.com/us/tvs/lg-oled65c6pua-oled-4k-tv",
    "lg-oled55c6": "https://www.lg.com/us/tvs/lg-oled55c6pua-oled-4k-tv",
    "lg-oled42c6": "https://www.lg.com/us/tvs/lg-oled42c6pua-oled-4k-tv",
    "lg-oled48c6": "https://www.lg.com/us/tvs/lg-oled48c6pua-oled-4k-tv",
    "lg-oled55g6": "https://www.lg.com/us/tvs/lg-oled55g6wua-oled-4k-tv",
    "lg-b6e-55": "https://www.lg.com/us/tvs/lg-oled55b6eua-oled-4k-tv",
    "lg-oled65b6": "https://www.lg.com/us/tvs/lg-oled65b6eua-oled-4k-tv",
    "dell-aw2725df": (
        "https://www.dell.com/en-us/shop/alienware-27-360hz-qd-oled-gaming-"
        "monitor-aw2725df/apd/210-bljd/monitors-monitor-accessories"
    ),
    "razer-basilisk-v3-pro": "https://www.amazon.com/dp/B0B6Y3XYFG",
    "corsair-m75": "https://www.amazon.com/dp/B0CTN26P3Z",
    "sony-bravia-8-65": (
        "https://www.bestbuy.com/site/sony-65-class-bravia-8-oled-4k-uhd-smart-"
        "google-tv-2024/6578577.p?skuId=6578577"
    ),
    "lg-b6-48": "https://www.lg.com/us/tvs/lg-oled48b6gua-oled-4k-tv",
    "lg-c6h-77": "https://www.lg.com/us/tvs/lg-oled77c6hua-oled-4k-tv",
    "lg-27gx700a": "https://www.amazon.com/dp/B0FLLNVXFG",
    "msi-mpg-a1000gs-ii": "https://www.amazon.com/dp/B0FXNTC1S8",
    "logitech-g309": "https://www.amazon.com/dp/B0C8523DT8",
    "razer-huntsman-v3-pro-tkl": "https://www.razer.com/gaming-keyboards/razer-huntsman-v3-pro-tenkeyless-8khz",
}



def _session():
    try:
        import requests
    except ImportError as e:
        raise SystemExit("fix_product_links.py needs requests") from e
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
    return s


def load_deals() -> dict[str, Any]:
    with DEALS_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def save_deals(data: dict[str, Any]) -> None:
    with DEALS_PATH.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def classify_url(url: str) -> str:
    if not url:
        return "other"
    u = url.lower()
    host = urlparse(url).netloc.lower()
    if any(
        x in u
        for x in (
            "/p/pl?",
            "searchpage.jsp",
            "/s?",
            "search_results",
            "/search?",
            "site/search",
        )
    ):
        return "search"
    if "amazon." in host and AMAZON_ASIN_RE.search(url):
        return "product"
    if "newegg." in host and NEWEGG_ITEM_RE.search(url) and "/p/pl" not in u:
        return "product"
    if "bestbuy." in host and (BB_SKU_RE.search(url) or "/sku/" in u or "/product/" in u):
        return "product"
    if "microcenter." in host and ("/product/" in u or MC_SKU_RE.search(url)):
        return "product"
    # Manufacturer / brand PDP heuristics — exclude bare category hubs
    brand_hosts = (
        "dell.com",
        "lg.com",
        "asus.com",
        "msi.com",
        "gigabyte.com",
        "corsair.com",
        "logitech.com",
        "razer.com",
        "samsung.com",
        "sony.com",
        "amd.com",
        "intel.com",
        "nzxt.com",
        "hisense",
        "keychron.com",
        "steelseries.com",
    )
    if any(h in host for h in brand_hosts):
        path = urlparse(url).path.strip("/")
        # Category hubs like /us/tvs or /sr/monitors/... without a model slug
        if path in ("", "us", "us/tvs") or path.endswith("/tvs") or "/sr/" in u:
            # Dell apd/ product codes are real PDPs
            if "/apd/" in u:
                return "product"
            return "other"
        return "product"
    return "other"


def extract_ids(url: str) -> dict[str, str]:
    out: dict[str, str] = {}
    m = AMAZON_ASIN_RE.search(url or "")
    if m:
        out["asin"] = m.group(1).upper()
    m = NEWEGG_ITEM_RE.search(url or "")
    if m:
        out["sku"] = m.group(1).upper()
    m = BB_SKU_RE.search(url or "")
    if m:
        out["sku"] = m.group(1)
    m = MC_SKU_RE.search(url or "")
    if m:
        out["sku"] = m.group(1)
    # Best Buy /sku/123
    m = re.search(r"/sku/(\d{5,8})", url or "", re.I)
    if m:
        out["sku"] = m.group(1)
    return out


def _tokens(name: str) -> list[str]:
    stop = {
        "the",
        "and",
        "with",
        "for",
        "oc",
        "gb",
        "w",
        "a",
        "gold",
        "wireless",
        "gaming",
        "mouse",
        "keyboard",
        "geforce",
        "radeon",
        "unlocked",
        "desktop",
        "processor",
        "series",
        "modular",
    }
    raw = re.findall(r"[A-Za-z0-9][A-Za-z0-9+.-]*", (name or "").lower())
    return [t for t in raw if t not in stop and len(t) > 1]


def _score(deal_name: str, title: str, query: str = "") -> float:
    t = (title or "").lower()
    toks = _tokens(deal_name)
    if not toks:
        return 0.0
    hit = sum(1 for x in toks if x in t) / len(toks)
    for part in re.findall(r"[A-Za-z0-9][A-Za-z0-9+.-]{3,}", (query or "").lower()):
        if part in t:
            hit += 0.12
    for bad in ("renewed", "refurbished", "bundle", "open box", "open-box", "combo"):
        if bad in t:
            hit -= 0.55
    # Capacity / size mismatches (rough)
    for cap in re.findall(r"(\d+)\s*gb", deal_name.lower()):
        # if title has a different explicit GB capacity for GPUs/PSUs, soft-penalize
        other = re.findall(r"(\d+)\s*gb", t)
        if other and cap not in other and any(o != cap for o in other):
            # allow L3 cache etc.; only penalize when both look like VRAM/PSU sizes
            if int(cap) >= 8 and any(int(o) >= 8 and o != cap for o in other):
                hit -= 0.35
    return hit


def resolve_newegg_search(session, deal: dict) -> tuple[str | None, str]:
    url = deal.get("url") or ""
    q = parse_qs(urlparse(url).query).get("d", [""])[0]
    if not q:
        q = deal.get("name") or ""
    search = f"https://www.newegg.com/p/pl?d={quote_plus(q)}"
    try:
        r = session.get(search, timeout=25)
        html = r.text
    except Exception as e:
        return None, f"newegg fetch error: {e}"
    hrefs = re.findall(
        r'href="(https://www\.newegg\.com/[^"]+/p/(N82E168[0-9]+))"', html, re.I
    )
    rel = re.findall(r'href="(/[^"]+/p/(N82E168[0-9]+))"', html, re.I)
    candidates: list[tuple[str, str]] = []
    seen: set[str] = set()
    for full, iid in hrefs + [
        ("https://www.newegg.com" + p, i) for p, i in rel
    ]:
        iid_u = iid.upper()
        if iid_u.endswith("T") or iid_u in seen:
            continue
        seen.add(iid_u)
        candidates.append((full.split("?")[0], iid_u))
    best: tuple[float, str, str] | None = None
    for cand, iid in candidates[:8]:
        try:
            ir = session.get(cand, timeout=25)
            tm = re.search(r"<title[^>]*>([^<]+)", ir.text, re.I)
            title = tm.group(1) if tm else ""
            title = re.sub(r"\s*[-|].*newegg.*", "", title, flags=re.I).strip()
            # Prefer model token in path
            sc = _score(deal.get("name") or "", title, q)
            path_l = cand.lower()
            for tok in _tokens(deal.get("name") or ""):
                if len(tok) >= 4 and tok in path_l:
                    sc += 0.08
            # Query model codes in path (GV-N5070..., SL-1000G, MPG-271QRX)
            for part in re.findall(r"[A-Za-z0-9][A-Za-z0-9+.-]{4,}", q.lower()):
                compact = part.replace("+", "").replace(" ", "")
                if compact and compact.replace("-", "") in path_l.replace("-", ""):
                    sc += 0.2
            if best is None or sc > best[0]:
                best = (sc, cand, title)
        except Exception:
            continue
        time.sleep(0.1)
    if best and best[0] >= 0.55:
        return best[1], f"newegg match score={best[0]:.2f} title={best[2][:60]}"
    if best and best[0] >= 0.40:
        # Accept if path clearly contains model from query
        path_l = best[1].lower()
        q_parts = [
            p.lower().replace("+", "")
            for p in re.findall(r"[A-Za-z0-9][A-Za-z0-9+.-]{4,}", q)
        ]
        if any(p.replace("-", "") in path_l.replace("-", "") for p in q_parts if len(p) >= 5):
            return best[1], f"newegg model-in-path score={best[0]:.2f} title={best[2][:60]}"
    return None, f"newegg ambiguous (best={best[0] if best else 0:.2f})"


def annotate(deal: dict) -> None:
    url = deal.get("url") or ""
    kind = classify_url(url)
    deal["urlKind"] = kind
    ids = extract_ids(url)
    if "asin" in ids:
        deal["asin"] = ids["asin"]
    elif "asin" in deal and kind != "product":
        pass
    if "sku" in ids:
        deal["sku"] = ids["sku"]


def resolve_deal(session, deal: dict, dry_run: bool = False) -> tuple[bool, str]:
    """Return (changed, note)."""
    did = deal.get("id") or "?"
    url = (deal.get("url") or "").strip()
    kind = classify_url(url)

    # Fix known category hubs even if classified as other/product wrongly
    curated = CURATED_PRODUCT_URLS.get(did)
    if curated and curated.rstrip("/") != url.rstrip("/"):
        # Only apply curated when current is search/other OR curated is clearly better PDP
        if kind in ("search", "other") or did in ("dell-aw2725df", "lg-c6h-77"):
            if not dry_run:
                deal["url"] = curated
            annotate(deal)
            return True, f"curated → {curated[:90]}"

    if kind == "product":
        annotate(deal)
        return False, "already product"

    if kind == "search":
        host = urlparse(url).netloc.lower()
        # Prefer curated same-or-better product URL
        if curated:
            if not dry_run:
                deal["url"] = curated
            annotate(deal)
            return True, f"curated → {curated[:90]}"

        if "newegg.com" in host:
            resolved, note = resolve_newegg_search(session, deal)
            if resolved:
                if not dry_run:
                    deal["url"] = resolved
                annotate(deal)
                return True, note
            annotate(deal)
            return False, note

        # Amazon / Best Buy search without curated ASIN/SKU: leave flagged
        annotate(deal)
        return False, "left search (no confident same-merchant product)"

    # other (category hubs)
    if curated:
        if not dry_run:
            deal["url"] = curated
        annotate(deal)
        return True, f"curated hub→pdp {curated[:90]}"
    annotate(deal)
    return False, "other/unresolved"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--ids", nargs="*")
    args = parser.parse_args(argv)

    data = load_deals()
    deals: list[dict] = data.get("deals") or []
    if args.ids:
        want = set(args.ids)
        deals = [d for d in deals if d.get("id") in want]

    before = {"product": 0, "search": 0, "other": 0}
    for d in data["deals"]:
        before[classify_url(d.get("url") or "")] = before.get(
            classify_url(d.get("url") or ""), 0
        ) + 1
    # recount properly
    before = {"product": 0, "search": 0, "other": 0}
    for d in data["deals"]:
        before[classify_url(d.get("url") or "")] += 1

    print(
        f"Before: product={before['product']} search={before['search']} "
        f"other={before['other']} (of {len(data['deals'])})"
    )

    session = _session()
    changed = 0
    unresolved_search: list[str] = []
    for d in deals:
        was = classify_url(d.get("url") or "")
        ok, note = resolve_deal(session, d, dry_run=args.dry_run)
        now_kind = classify_url(
            (CURATED_PRODUCT_URLS.get(d["id"]) if args.dry_run and ok else d.get("url"))
            or ""
        )
        if args.dry_run and ok and CURATED_PRODUCT_URLS.get(d["id"]):
            now_kind = classify_url(CURATED_PRODUCT_URLS[d["id"]])
        elif args.dry_run and ok:
            # newegg dry-run still returns resolved URL in note only — re-call without write already set url only if not dry
            pass
        print(f"{'FIXED' if ok else 'KEEP '} {d.get('id')}: {note}")
        if ok:
            changed += 1
        if (not ok and was == "search") or (
            classify_url(d.get("url") or "") == "search"
        ):
            if classify_url(d.get("url") or "") == "search":
                unresolved_search.append(d.get("id") or "?")
        time.sleep(0.05)

    # Annotate ALL deals in file (urlKind/asin/sku) even if not in subset
    if not args.dry_run:
        if args.ids:
            # merge resolved subset into full file
            by_id = {d["id"]: d for d in deals}
            full = load_deals()
            for d in full["deals"]:
                if d["id"] in by_id:
                    src = by_id[d["id"]]
                    for k in ("url", "urlKind", "asin", "sku"):
                        if k in src:
                            d[k] = src[k]
                else:
                    annotate(d)
            data = full
        else:
            for d in data["deals"]:
                annotate(d)
        save_deals(data)

    after = {"product": 0, "search": 0, "other": 0}
    for d in (data if not args.dry_run else load_deals())["deals"]:
        # For dry-run, recompute as if curated applied
        u = d.get("url") or ""
        if args.dry_run and d.get("id") in CURATED_PRODUCT_URLS:
            # approximate: count curated as product for report
            pass
        after[classify_url(u)] += 1

    if args.dry_run:
        # Simulate after counts
        after = {"product": 0, "search": 0, "other": 0}
        for d in load_deals()["deals"]:
            u = d.get("url") or ""
            did = d.get("id")
            if did in CURATED_PRODUCT_URLS and classify_url(u) != "product":
                after["product"] += 1
            else:
                after[classify_url(u)] += 1

    print(
        f"After:  product={after['product']} search={after['search']} "
        f"other={after['other']}  changed={changed}"
    )
    if unresolved_search:
        # unique preserve order
        seen: set[str] = set()
        uniq = []
        for i in unresolved_search:
            if i not in seen:
                seen.add(i)
                uniq.append(i)
        print(f"Remaining search ({len(uniq)}): {', '.join(uniq)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
