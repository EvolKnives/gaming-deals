#!/usr/bin/env python3
"""
Image audit for What's A Good Deal?

Runs inside every hourly refresh, with no one needing to ask:

1. Audit: a rotating batch of product photos is checked each run (every
   photo about once a day). A photo that no longer loads (missing, error page,
   not an image) is removed, so the card shows its category icon instead of a
   broken image.
2. Fill: every deal without a working photo gets one looked for: the
   og:image / schema.org image on its own product page (for stores that allow
   it), then a matching Newegg listing. A candidate is used only after it is
   checked to load. Deals that still have none are listed in the run log.

Results are cached in data/image-checks.json.
"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
import re
from typing import Any, Callable
from urllib.parse import urlparse

import requests

ROOT = Path(__file__).resolve().parents[1]
CACHE_PATH = ROOT / "data" / "image-checks.json"
RECHECK_HOURS = 24
PER_RUN = 150
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def _abs(url: str) -> str:
    if url.startswith("http"):
        return url
    return "https://evolknives.github.io/gaming-deals/" + url.lstrip("/")


def image_ok(url: str) -> bool:
    try:
        with requests.get(_abs(url), headers={"User-Agent": UA, "Accept": "image/*"},
                          timeout=20, stream=True, allow_redirects=True) as r:
            if r.status_code != 200:
                return False
            ctype = r.headers.get("Content-Type", "")
            first = next(r.iter_content(512), b"")
            return ctype.startswith("image/") and len(first) > 0
    except requests.RequestException:
        return False


def audit(deals: list[dict[str, Any]], now: datetime) -> dict[str, int]:
    hour = int(now.timestamp() // 3600)
    try:
        cache: dict[str, list[int]] = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cache = {}
    urls = sorted({d["image"] for d in deals if d.get("image")})
    due = [u for u in urls if u not in cache or hour - cache[u][0] >= RECHECK_HOURS]
    due.sort(key=lambda u: cache.get(u, [0])[0])  # never-checked and oldest first
    batch = due[:PER_RUN]
    with ThreadPoolExecutor(max_workers=8) as pool:
        for url, ok in zip(batch, pool.map(image_ok, batch)):
            cache[url] = [hour, 1 if ok else 0]
    removed = 0
    for d in deals:
        u = d.get("image")
        if u and u in cache and not cache[u][1]:
            d.pop("image", None)
            d.pop("imageSource", None)
            d["imageBroken"] = u  # kept for the log; a new photo clears it
            removed += 1
        elif u:
            d.pop("imageBroken", None)
    live = set(urls)
    cache = {u: v for u, v in cache.items() if u in live}
    CACHE_PATH.write_text(json.dumps(cache, separators=(",", ":")) + "\n", encoding="utf-8")
    return {"images_checked": len(batch), "images_removed": removed}


# stores whose pages block automated visits: never fetched
NO_FETCH = ("costco.com", "amazon.", "walmart.com", "bestbuy.com")
FILL_PER_RUN = 25


def page_image(url: str) -> str | None:
    """og:image or schema.org Product image from a product page."""
    host = urlparse(url).netloc.lower()
    if not url.startswith("http") or any(b in host for b in NO_FETCH):
        return None
    try:
        r = requests.get(url, headers={"User-Agent": UA, "Accept-Language": "en-US"}, timeout=25)
    except requests.RequestException:
        return None
    if r.status_code != 200:
        return None
    for pat in (r'property=["\']og:image["\']\s+content=["\']([^"\']+)',
                r'content=["\']([^"\']+)["\']\s+property=["\']og:image',
                r'"@type"\s*:\s*"Product".{0,2000}?"image"\s*:\s*\[?\s*"([^"]+)"'):
        m = re.search(pat, r.text, re.S | re.I)
        if m and m.group(1).startswith("http") and not re.search(r"logo|icon|placeholder|default", m.group(1), re.I):
            return m.group(1)
    return None


def fill_missing(deals: list[dict[str, Any]], newegg_match: Callable[[dict[str, Any]], str | None],
                 now: datetime) -> dict[str, Any]:
    """Find photos for deals that have none. Tries each deal at most once a day."""
    hour = int(now.timestamp() // 3600)
    missing = [d for d in deals if not d.get("image")]
    tried = 0
    found = 0
    for d in sorted(missing, key=lambda d: d.get("photoTriedAt", 0)):
        if tried >= FILL_PER_RUN:
            break
        if hour - int(d.get("photoTriedAt", 0)) < RECHECK_HOURS:
            continue
        tried += 1
        d["photoTriedAt"] = hour
        for source, finder in (("product-page", lambda x: page_image(x.get("url", ""))),
                               ("newegg-api-match", newegg_match)):
            try:
                cand = finder(d)
            except Exception:  # noqa: BLE001 — one failed lookup never stops the run
                cand = None
            if cand and cand != d.get("imageBroken") and image_ok(cand):
                d["image"], d["imageSource"] = cand, source
                d.pop("imageBroken", None)
                d.pop("photoTriedAt", None)
                found += 1
                break
    still = [d.get("name", "")[:60] for d in deals if not d.get("image")]
    return {"photos_found": found, "photos_missing": len(still), "photos_missing_names": still[:10]}
