#!/usr/bin/env python3
"""
Product cut-outs for What's A Good Deal?

Most product photos are shot on plain white. Inside the hourly refresh this
downloads those photos, makes the white background transparent and saves a
small transparent WebP in images/cut/, so the site can show the product on its
own themed background instead of a white tile.

Only white that touches the photo's edges is removed (a flood fill from the
border), so white parts *inside* a product outline stay. Photos whose edges
are not mostly white (lifestyle shots, photos already transparent or on
colour) are left as they are. The original photo is still used for the
zoomed view.

data/cutouts.json maps each original photo URL to its cut-out path, or to
"skip" when the photo isn't suitable. Cut-outs no deal uses are deleted.
"""

from __future__ import annotations

import hashlib
import io
import json
from collections import deque
from pathlib import Path
from typing import Any

import numpy as np
import requests
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
CUT_DIR = ROOT / "images" / "cut"
MAP_PATH = ROOT / "data" / "cutouts.json"
PER_RUN = 250          # new photos processed per hourly run
SIZE = 480             # longest side of the saved cut-out
WHITE = 236            # a pixel is background when R, G and B are all above this
EDGE_WHITE_SHARE = 0.85  # edges must be at least this white to cut
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def _source_url(url: str) -> str:
    if url.startswith("http"):
        return url
    return "https://evolknives.github.io/gaming-deals/" + url.lstrip("/")


def load_image(url: str) -> Image.Image | None:
    local = ROOT / url if not url.startswith("http") else None
    try:
        if local and local.is_file():
            return Image.open(local).convert("RGBA")
        r = requests.get(_source_url(url), headers={"User-Agent": UA}, timeout=25)
        if r.status_code != 200:
            return None
        return Image.open(io.BytesIO(r.content)).convert("RGBA")
    except Exception:  # noqa: BLE001 — unreadable image: just skip it
        return None


def cut(img: Image.Image) -> Image.Image | None:
    """Transparent-background version, or None if the photo isn't on white."""
    img.thumbnail((SIZE, SIZE))
    a = np.asarray(img).copy()
    h, w = a.shape[:2]
    if h < 40 or w < 40:
        return None
    if (a[:, :, 3] < 250).mean() > 0.02:
        return None  # already has transparency
    white = (a[:, :, 0] > WHITE) & (a[:, :, 1] > WHITE) & (a[:, :, 2] > WHITE)
    border = np.concatenate([white[0, :], white[-1, :], white[:, 0], white[:, -1]])
    if border.mean() < EDGE_WHITE_SHARE:
        return None  # not a plain white backdrop
    # flood fill from every white border pixel through white pixels
    bg = np.zeros((h, w), dtype=bool)
    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            if white[y, x] and not bg[y, x]:
                bg[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if white[y, x] and not bg[y, x]:
                bg[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and white[ny, nx] and not bg[ny, nx]:
                bg[ny, nx] = True
                q.append((ny, nx))
    share = bg.mean()
    if share < 0.15 or share > 0.97:
        return None  # nothing (or nearly everything) would be removed
    # soft 1px edge so the outline isn't jagged
    alpha = Image.fromarray(np.where(bg, 0, 255).astype("uint8")).filter(ImageFilter.GaussianBlur(0.8))
    out = Image.fromarray(a)
    out.putalpha(alpha)
    bbox = out.getbbox()
    return out.crop(bbox) if bbox else None


def update(deals: list[dict[str, Any]]) -> dict[str, int]:
    """Make cut-outs for new photos and set deal["cutout"]."""
    try:
        mapping: dict[str, str] = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        mapping = {}
    CUT_DIR.mkdir(parents=True, exist_ok=True)
    todo = sorted({d["image"] for d in deals if d.get("image") and d["image"] not in mapping})
    made = skipped = 0
    for url in todo[:PER_RUN]:
        img = load_image(url)
        if img is None:
            continue  # couldn't download right now: try again next run
        res = cut(img)
        if res is None:
            mapping[url] = "skip"
            skipped += 1
            continue
        name = hashlib.sha1(url.encode()).hexdigest()[:16] + ".webp"
        res.save(CUT_DIR / name, "WEBP", quality=82, method=6)
        mapping[url] = f"images/cut/{name}"
        made += 1
    live = {d["image"] for d in deals if d.get("image")}
    mapping = {u: v for u, v in mapping.items() if u in live}
    for d in deals:
        v = mapping.get(d.get("image") or "")
        if v and v != "skip":
            d["cutout"] = v
        else:
            d.pop("cutout", None)
    used = {v for v in mapping.values() if v != "skip"}
    for f in CUT_DIR.glob("*.webp"):
        if f"images/cut/{f.name}" not in used:
            f.unlink()
    MAP_PATH.write_text(json.dumps(mapping, separators=(",", ":")) + "\n", encoding="utf-8")
    return {"cutouts_made": made, "cutouts_skipped": skipped, "cutouts_pending": max(0, len(todo) - PER_RUN)}
