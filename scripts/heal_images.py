#!/usr/bin/env python3
"""
Heal / audit product photos for What's A Good Deal?

For every deal in data/deals.json:
  1) Audit image path — missing/null, missing file, unreadable, or too-small
     (< MIN_PX on the short side, or < MIN_BYTES) counts as broken.
  2) Re-download a real product photo into images/<deal-id>.jpg and set
     deal["image"] = "images/<deal-id>.jpg".
  3) Prefer official retailer/manufacturer shots (Newegg product/search,
     Micro Center og:image, Amazon ASIN media when reachable). Never invent
     a product — search by the deal's exact name.
  4) Category placeholder (clearly labeled) only as last resort.
  5) Exit non-zero if any deal still has a broken image after healing.

Primary image source is the deal's product URL (og:image / main product
CDN). Name-based merchant search is a fallback only when there is no
product URL. Optional deal["imageSource"] records product-page | search
| placeholder for auditing.

Usage:
  python3 scripts/heal_images.py              # audit + heal all broken
  python3 scripts/heal_images.py --audit-only # report only, no downloads
  python3 scripts/heal_images.py --force      # re-download even healthy ones
  python3 scripts/heal_images.py --force-from-url  # re-pull from product URL
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus, urlparse

ROOT = Path(__file__).resolve().parents[1]
DEALS_PATH = ROOT / "data" / "deals.json"
IMAGES_DIR = ROOT / "images"

MIN_PX = 200          # short side below this → broken
MIN_BYTES = 4_000     # tiny files (icons/logos) → broken
TARGET_MAX = 1200     # longest side after compress
TARGET_MIN = 800      # prefer at least this on long side when source is large
JPEG_QUALITY = 85

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

# Reject obvious non-product assets from CDNs / OG tags.
REJECT_URL_SUBSTR = (
    "logo",
    "icon",
    "sprite",
    "favicon",
    "Themes/Nest",
    "WebResource",
    "placeholder",
    "no-image",
    "noimage",
    "default_image",
    "share-default",
    "lg5-common",
    "share/share",
)

NEWEGG_ITEM_RE = re.compile(r"(N82E168[0-9]{8,})", re.I)
OG_IMAGE_RES = (
    re.compile(r'property=["\']og:image["\']\s+content=["\']([^"\']+)["\']', re.I),
    re.compile(r'content=["\']([^"\']+)["\']\s+property=["\']og:image["\']', re.I),
    re.compile(r'og:image["\']?\s+content=["\']([^"\']+)["\']', re.I),
)

AMAZON_ASIN_RE = re.compile(r"/(?:dp|gp/product)/([A-Z0-9]{10})", re.I)
SEARCH_URL_MARKERS = (
    "/p/pl?",
    "searchpage",
    "/s?",
    "search_results",
    "/search?",
    "site/search",
)


def is_search_url(url: str) -> bool:
    u = (url or "").lower()
    return any(tok in u for tok in SEARCH_URL_MARKERS)


def is_product_url(url: str) -> bool:
    if not url or is_search_url(url):
        return False
    host = urlparse(url).netloc.lower()
    u = url.lower()
    if "amazon." in host and AMAZON_ASIN_RE.search(url):
        return True
    if "newegg." in host and NEWEGG_ITEM_RE.search(url) and "/p/pl" not in u:
        return True
    if "bestbuy." in host and (re.search(r"/\d+\.p", u) or "/sku/" in u or "/product/" in u):
        return True
    if "microcenter." in host and "/product/" in u:
        return True
    if any(
        h in host
        for h in (
            "dell.com",
            "lg.com",
            "asus.com",
            "samsung.com",
            "sony.com",
            "corsair.com",
            "logitech.com",
            "razer.com",
            "amd.com",
            "msi.com",
            "gigabyte.com",
        )
    ):
        if "/apd/" in u or re.search(r"/[a-z0-9-]*\d[a-z0-9-]+", urlparse(url).path, re.I):
            return True
    return False



def _session():
    try:
        import requests
    except ImportError as e:
        raise SystemExit("heal_images.py needs requests (pip install requests)") from e
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
    return s


def _pil():
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as e:
        raise SystemExit("heal_images.py needs Pillow (pip install Pillow)") from e
    return Image, ImageDraw, ImageFont


def load_deals() -> dict[str, Any]:
    with DEALS_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def save_deals(data: dict[str, Any]) -> None:
    with DEALS_PATH.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def image_path_for(deal: dict) -> Path:
    return IMAGES_DIR / f"{deal['id']}.jpg"


def relative_image(deal: dict) -> str:
    return f"images/{deal['id']}.jpg"


def audit_one(deal: dict) -> tuple[bool, str]:
    """Return (ok, reason). ok=False means broken/missing."""
    Image, _, _ = _pil()
    rel = deal.get("image")
    if not rel or not str(rel).strip():
        return False, "null/missing image field"
    # Normalize to repo-relative images/<id>.jpg expectation, but still
    # accept any existing relative path under the repo for audit.
    path = ROOT / str(rel).lstrip("/")
    if not path.is_file():
        return False, f"file missing: {rel}"
    try:
        size = path.stat().st_size
    except OSError as e:
        return False, f"unreadable stat: {e}"
    if size < MIN_BYTES:
        return False, f"too small ({size} bytes)"
    try:
        with Image.open(path) as im:
            im.verify()
        with Image.open(path) as im:
            w, h = im.size
            if min(w, h) < MIN_PX:
                return False, f"too small dims {w}x{h}"
    except Exception as e:  # noqa: BLE001 — any decode failure is broken
        return False, f"unreadable: {e}"
    return True, "ok"


def _reject_url(url: str) -> bool:
    low = url.lower()
    return any(s.lower() in low for s in REJECT_URL_SUBSTR)


def _extract_og_image(html: str) -> str | None:
    for rx in OG_IMAGE_RES:
        m = rx.search(html)
        if m:
            url = m.group(1).strip()
            if url and not _reject_url(url):
                return url
    return None


def _fetch_html(session, url: str, timeout: int = 25) -> str | None:
    try:
        r = session.get(url, timeout=timeout, allow_redirects=True)
        if r.status_code >= 400:
            return None
        return r.text
    except Exception:
        return None


def candidate_from_deal_url(session, deal: dict) -> str | None:
    """Try the deal's own retailer/manufacturer product URL for og:image."""
    url = (deal.get("url") or "").strip()
    if not url or is_search_url(url):
        return None
    host = urlparse(url).netloc.lower()

    # Newegg item id → canonical item page (cleanest OG).
    m = NEWEGG_ITEM_RE.search(url)
    if "newegg.com" in host and m:
        item_url = f"https://www.newegg.com/p/{m.group(1).upper()}"
        html = _fetch_html(session, item_url)
        if html:
            img = _extract_og_image(html)
            if img:
                return img

    product_hosts = (
        "newegg.com",
        "microcenter.com",
        "amazon.com",
        "dell.com",
        "lg.com",
        "bestbuy.com",
        "samsung.com",
        "sony.com",
        "asus.com",
        "corsair.com",
        "logitech.com",
        "razer.com",
        "msi.com",
        "gigabyte.com",
        "amd.com",
    )
    if not any(x in host for x in product_hosts):
        return None

    html = _fetch_html(session, url, timeout=20)
    if not html or len(html) < 2000:
        # Amazon often returns a tiny block page — treat as miss.
        return None
    img = _extract_og_image(html)
    if img and "share-default" not in img.lower() and "lg5-common" not in img.lower():
        return img
    # LG.com gallery transforms (og:image is often a site-wide share default)
    if "lg.com" in host:
        gallery = re.findall(
            r"(https://media\.us\.lg\.com/transform/ecomm-PDPGallery-[^\s\"\']+)",
            html,
        )
        hint = (deal.get("name") or "") + " " + url
        keys = re.findall(r"OLED\d{2}[A-Z0-9]+", hint, re.I)
        ranked = []
        for g in gallery:
            score = 0
            for k in keys:
                if k.lower() in g.lower():
                    score += 5
            if "Gallery-01" in g or "gallery-01" in g.lower():
                score += 2
            ranked.append((score, g))
        ranked.sort(reverse=True)
        for score, g in ranked[:8]:
            if score > 0 or not keys:
                return g
    # Amazon media fallback from landing HTML
    if "amazon." in host:
        amz = re.findall(
            r"(https://m\.media-amazon\.com/images/I/[A-Za-z0-9_+.-]+\.jpg)",
            html,
        )
        for a in amz:
            if _reject_url(a):
                continue
            clean = re.sub(r"\._[^.]+_\.", ".", a)
            return clean if not _reject_url(clean) else a
    # Best Buy / generic product image CDN hints
    cdn_pats = [
        r"https://[^\s<>]+bbystatic[^\s<>]+\.(?:jpg|jpeg|png|webp)",
        r"https://[^\s<>]+scene7[^\s<>]+\.(?:jpg|jpeg|png)",
        r"https://productimages\.microcenter\.com/[^\s<>]+\.(?:jpg|jpeg|png)",
        r"https://[^\s<>]+lg\.com/[^\s<>]+\.(?:jpg|jpeg|png)",
        r"https://i\.dell\.com/[^\s<>]+",
    ]
    for pat in cdn_pats:
        for m in re.finditer(pat, html, re.I):
            u = m.group(0)
            if not _reject_url(u) and "logo" not in u.lower():
                return u
    return None


def candidate_from_matched_newegg(session, deal: dict) -> str | None:
    """When Amazon/BB product URL is blocked, pull OG from a name-matched Newegg PDP."""
    name = (deal.get("name") or "").strip()
    if not name:
        return None
    search_url = f"https://www.newegg.com/p/pl?d={quote_plus(name)}"
    html = _fetch_html(session, search_url)
    if not html:
        return None
    ids: list[str] = []
    seen: set[str] = set()
    for m in NEWEGG_ITEM_RE.finditer(html):
        iid = m.group(1).upper()
        if iid.endswith("T") or iid in seen:
            continue
        seen.add(iid)
        ids.append(iid)
    name_l = name.lower()
    must = []
    for tok in re.findall(r"[A-Za-z0-9][A-Za-z0-9+.-]{2,}", name_l):
        if tok in {"the", "and", "with", "for", "oc", "gb", "gaming", "wireless"}:
            continue
        must.append(tok)
    for iid in ids[:6]:
        item_url = f"https://www.newegg.com/p/{iid}"
        page = _fetch_html(session, item_url)
        if not page:
            continue
        tm = re.search(r"<title[^>]*>([^<]+)", page, re.I)
        title = (tm.group(1) if tm else "").lower()
        hit = sum(1 for t in must if t in title) / max(len(must), 1)
        if hit < 0.55:
            time.sleep(0.1)
            continue
        img = _extract_og_image(page)
        if img:
            return img
        time.sleep(0.1)
    return None


def candidate_from_newegg_search(session, deal: dict) -> str | None:
    """Search Newegg by exact product name; take first real product OG image."""
    name = (deal.get("name") or "").strip()
    if not name:
        return None
    search_url = f"https://www.newegg.com/p/pl?d={quote_plus(name)}"
    html = _fetch_html(session, search_url)
    if not html:
        return None
    ids: list[str] = []
    seen: set[str] = set()
    for m in NEWEGG_ITEM_RE.finditer(html):
        iid = m.group(1).upper()
        if iid not in seen:
            seen.add(iid)
            ids.append(iid)
    for iid in ids[:6]:
        item_url = f"https://www.newegg.com/p/{iid}"
        page = _fetch_html(session, item_url)
        if not page:
            continue
        img = _extract_og_image(page)
        if img:
            return img
        time.sleep(0.15)
    return None


def candidate_from_amazon_asin(session, deal: dict) -> str | None:
    """If the deal URL has an Amazon ASIN, try common media CDN patterns."""
    url = (deal.get("url") or "")
    m = re.search(r"/dp/([A-Z0-9]{10})", url, re.I)
    if not m:
        return None
    asin = m.group(1).upper()
    # Hit the DP page once more with a retail UA; if blocked, give up.
    html = _fetch_html(session, f"https://www.amazon.com/dp/{asin}")
    if not html:
        return None
    imgs = re.findall(
        r"(https://m\.media-amazon\.com/images/I/[A-Za-z0-9_+.-]+)\.(jpg|png|jpeg)",
        html,
        flags=re.I,
    )
    for base, ext in imgs:
        full = f"{base}.{ext}"
        if _reject_url(full):
            continue
        # Prefer unsuffixed high-res when possible
        clean = re.sub(r"\._[ACF].*?_\.", ".", full)
        return clean
    return None



def candidate_from_bing(session, deal: dict) -> str | None:
    """Bing image search filtered to retailer/brand CDNs — last real-photo try."""
    name = (deal.get("name") or "").strip()
    if not name:
        return None
    try:
        r = session.get(
            "https://www.bing.com/images/search",
            params={"q": f"{name} product"},
            timeout=25,
        )
        if r.status_code >= 400:
            return None
        html = r.text
    except Exception:
        return None
    urls = re.findall(
        r"murl&quot;:&quot;(https://[^&]+?\.(?:jpg|jpeg|png|webp))", html, flags=re.I
    )
    urls += re.findall(r'"murl":"(https://[^"]+\.(?:jpg|jpeg|png))', html, flags=re.I)
    allow = (
        "neweggimages",
        "media-amazon",
        "bbystatic",
        "microcenter",
        "ssl-images-amazon",
        "scene7",
        "logitech",
        "corsair",
        "razer",
        "steelseries",
        "asus",
        "msi.com",
        "gigabyte",
        "lg.com",
        "samsung",
        "keychron",
        "gloriousgaming",
        "nzxt",
        "amd.com",
        "intel.com",
        "dellcdn",
        "hisense",
        "sony",
        "shopify",
    )
    deny = ("lds", "portrait", "wikipedia", "wikimedia", "pinterest", "pinimg")
    seen: set[str] = set()
    for u in urls:
        u = u.replace("\\u0026", "&")
        low = u.lower()
        if u in seen or _reject_url(u):
            continue
        seen.add(u)
        if any(d in low for d in deny):
            continue
        if any(a in low for a in allow):
            return u
    return None


def prefer_larger_cdn(url: str) -> list[str]:
    """Return URL variants to try, largest first (Newegg 1280 → original)."""
    out = [url]
    if "neweggimages.com" in url and "/ProductImage/" in url and "CompressAll" not in url:
        out.insert(0, url.replace("/ProductImage/", "/ProductImageCompressAll1280/"))
        out.append(url.replace("/ProductImage/", "/ProductImageCompressAll800/"))
    # Amazon: strip size suffixes for fuller asset
    if "media-amazon.com" in url:
        clean = re.sub(r"\._[^.]+_\.", ".", url)
        if clean != url:
            out.insert(0, clean)
    # dedupe preserve order
    seen: set[str] = set()
    uniq: list[str] = []
    for u in out:
        if u not in seen:
            seen.add(u)
            uniq.append(u)
    return uniq


def download_bytes(session, url: str) -> bytes | None:
    try:
        r = session.get(url, timeout=40, allow_redirects=True)
        if r.status_code >= 400:
            return None
        ctype = (r.headers.get("Content-Type") or "").lower()
        if "html" in ctype and len(r.content) < 50_000:
            return None
        if len(r.content) < MIN_BYTES:
            return None
        return r.content
    except Exception:
        return None


def compress_to_jpeg(raw: bytes, dest: Path) -> bool:
    Image, _, _ = _pil()
    try:
        im = Image.open(io.BytesIO(raw))
        im.load()
    except Exception:
        return False
    # Flatten alpha onto white for JPEG
    if im.mode in ("RGBA", "LA", "P"):
        rgba = im.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[-1] if rgba.mode == "RGBA" else None)
        im = bg.convert("RGB")
    elif im.mode != "RGB":
        im = im.convert("RGB")
    w, h = im.size
    if min(w, h) < MIN_PX:
        return False
    long_side = max(w, h)
    if long_side > TARGET_MAX:
        scale = TARGET_MAX / float(long_side)
        im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.Resampling.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp.jpg")
    im.save(tmp, "JPEG", quality=JPEG_QUALITY, optimize=True)
    tmp.replace(dest)
    return True


def make_placeholder(deal: dict, dest: Path) -> bool:
    """Last-resort clearly labeled category placeholder — never a fake product."""
    Image, ImageDraw, ImageFont = _pil()
    cat = (deal.get("category") or "Deal").strip()
    name = (deal.get("name") or deal.get("id") or "Product").strip()
    w = h = 1000
    # Soft dark card matching site vibe
    im = Image.new("RGB", (w, h), (28, 28, 30))
    draw = ImageDraw.Draw(im)
    # Accent bar
    draw.rectangle([0, 0, w, 12], fill=(90, 200, 250))
    try:
        font_lg = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 42
        )
        font_md = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 28
        )
        font_sm = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 22
        )
    except OSError:
        font_lg = font_md = font_sm = ImageFont.load_default()

    draw.text((48, 80), "PHOTO PLACEHOLDER", fill=(90, 200, 250), font=font_sm)
    draw.text((48, 140), cat.upper(), fill=(255, 255, 255), font=font_lg)

    # Word-wrap product name
    max_w = w - 96
    words = name.split()
    lines: list[str] = []
    cur = ""
    for word in words:
        trial = (cur + " " + word).strip()
        bbox = draw.textbbox((0, 0), trial, font=font_md)
        if bbox[2] - bbox[0] <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    y = 240
    for line in lines[:6]:
        draw.text((48, y), line, fill=(200, 200, 205), font=font_md)
        y += 40
    draw.text(
        (48, h - 80),
        "No verified product photo found — replace when available",
        fill=(140, 140, 150),
        font=font_sm,
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp.jpg")
    im.save(tmp, "JPEG", quality=JPEG_QUALITY, optimize=True)
    tmp.replace(dest)
    return True


def find_candidate(session, deal: dict, from_url_only: bool = False) -> tuple[str | None, str]:
    """Return (image_url, source_label).

    Prefer the deal product URL. Search/Bing only when there is no product URL
    (or product-page fetch failed and from_url_only is False).
    """
    url = (deal.get("url") or "").strip()
    product = is_product_url(url)

    primary: list[tuple] = [
        (candidate_from_deal_url, "product-page"),
        (candidate_from_amazon_asin, "product-page"),
    ]
    # Same-SKU Newegg OG when Amazon/BB/manufacturer page blocks scrapers.
    if product:
        primary.append((candidate_from_matched_newegg, "product-page"))

    fallback: list[tuple] = [
        (candidate_from_newegg_search, "search"),
        (candidate_from_bing, "search"),
    ]

    chain = primary if (from_url_only or product) else primary + fallback
    if from_url_only:
        chain = primary
    elif not product:
        chain = fallback

    for fn, label in chain:
        try:
            img = fn(session, deal)
        except Exception as e:  # noqa: BLE001
            print(f"  ! {label} error for {deal['id']}: {e}", file=sys.stderr)
            img = None
        if img:
            return img, label
        time.sleep(0.1)

    # Last chance: if product URL failed and not from_url_only, try search
    if product and not from_url_only:
        for fn, label in fallback:
            try:
                img = fn(session, deal)
            except Exception as e:  # noqa: BLE001
                print(f"  ! {label} error for {deal['id']}: {e}", file=sys.stderr)
                img = None
            if img:
                return img, label
            time.sleep(0.1)
    return None, "none"


def _file_sha1(path: Path) -> str | None:
    import hashlib
    try:
        h = hashlib.sha1()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def _duplicate_of_other(dest: Path, deal_id: str, raw: bytes) -> bool:
    """True if raw bytes (post-compress destination sibling) match another deal image."""
    import hashlib
    digest = hashlib.sha1(raw).hexdigest()
    for p in IMAGES_DIR.glob("*.jpg"):
        if p.name == f"{deal_id}.jpg":
            continue
        other = _file_sha1(p)
        if other and other == digest:
            return True
    return False


def heal_deal(
    session,
    deal: dict,
    force: bool = False,
    from_url_only: bool = False,
    used_digests: set[str] | None = None,
) -> tuple[bool, str]:
    """Ensure deal has a healthy images/<id>.jpg. Returns (ok, note)."""
    dest = image_path_for(deal)
    if not force and not from_url_only:
        if dest.is_file():
            ok2, reason2 = audit_one({**deal, "image": relative_image(deal)})
            if ok2:
                deal["image"] = relative_image(deal)
                return True, "already healthy"
        else:
            ok, reason = audit_one(deal)
            if ok:
                return True, f"healthy ({reason})"

    url, source = find_candidate(session, deal, from_url_only=from_url_only)
    if url:
        last_err = None
        for variant in prefer_larger_cdn(url):
            raw = download_bytes(session, variant)
            if not raw:
                last_err = "download failed"
                continue
            # Uniqueness: avoid reusing identical source bytes across models when possible
            import hashlib
            digest = hashlib.sha1(raw).hexdigest()
            if used_digests is not None and digest in used_digests:
                last_err = "duplicate image bytes of another deal"
                continue
            if compress_to_jpeg(raw, dest):
                deal["image"] = relative_image(deal)
                # Map source label → imageSource audit field
                if source == "product-page":
                    deal["imageSource"] = "product-page"
                elif source in ("search", "newegg-search", "bing-cdn"):
                    deal["imageSource"] = "search"
                else:
                    deal["imageSource"] = source if source != "none" else "search"
                ok, reason = audit_one(deal)
                if ok:
                    if used_digests is not None:
                        used_digests.add(digest)
                    return True, f"healed via {source}: {variant}"
                dest.unlink(missing_ok=True)
                last_err = reason
            else:
                last_err = "download/compress failed"
        if from_url_only:
            return False, f"product-url image failed ({last_err}) from {url}"
        return False, f"downloaded but still broken ({last_err}) from {url}"

    if from_url_only:
        return False, "no image on product URL"

    # Last resort: labeled placeholder
    if make_placeholder(deal, dest):
        deal["image"] = relative_image(deal)
        deal["imageSource"] = "placeholder"
        ok, reason = audit_one(deal)
        if ok:
            return True, "placeholder (no verified product photo)"
    return False, "failed to write image"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit-only", action="store_true", help="Report only")
    parser.add_argument("--force", action="store_true", help="Re-download even healthy")
    parser.add_argument(
        "--force-from-url",
        action="store_true",
        help="Re-pull images from product URLs (skip search fallback first pass)",
    )
    parser.add_argument(
        "--ids",
        nargs="*",
        help="Optional deal id subset to heal",
    )
    args = parser.parse_args(argv)

    data = load_deals()
    deals: list[dict] = data.get("deals") or []
    if args.ids:
        want = set(args.ids)
        deals = [d for d in deals if d.get("id") in want]

    IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    force_any = args.force  # --force-from-url only re-pulls product-URL deals
    broken: list[dict] = []
    healthy = 0
    for d in deals:
        ok, reason = audit_one(d)
        if args.force_from_url and is_product_url(d.get("url") or ""):
            broken.append(d)
            print(f"REPULL  {d.get('id')}: force-from-url")
        elif ok and not force_any:
            healthy += 1
        else:
            broken.append(d)
            print(f"BROKEN  {d.get('id')}: {reason if not force_any else 'forced'}")

    print(f"Audit: {healthy} healthy, {len(broken)} broken / forced (of {len(deals)})")

    if args.audit_only:
        return 1 if broken else 0

    if not broken:
        # Still normalize image fields to images/<id>.jpg when file exists
        changed = False
        for d in deals:
            dest = image_path_for(d)
            if dest.is_file() and d.get("image") != relative_image(d):
                d["image"] = relative_image(d)
                changed = True
        if changed:
            save_deals(data)
            print("Normalized image paths in deals.json")
        return 0

    session = _session()
    unfixed: list[str] = []
    placeholders = 0
    healed = 0
    used_digests: set[str] = set()
    # Seed with existing images we are not rewriting
    broken_ids = {d.get("id") for d in broken}
    for p in IMAGES_DIR.glob("*.jpg"):
        deal_id = p.stem
        if deal_id in broken_ids:
            continue
        digest = _file_sha1(p)
        if digest:
            used_digests.add(digest)

    for d in broken:
        print(f"HEAL    {d.get('id')} — {d.get('name', '')[:70]}")
        ok, note = heal_deal(
            session,
            d,
            force=force_any,
            from_url_only=bool(args.force_from_url and is_product_url(d.get("url") or "")),
            used_digests=used_digests,
        )
        # If force-from-url failed, fall back to full chain once
        if not ok and args.force_from_url:
            print("        ↳ falling back to search/cdn …")
            ok, note = heal_deal(
                session,
                d,
                force=True,
                from_url_only=False,
                used_digests=used_digests,
            )
        print(f"        → {note}")
        if not ok:
            unfixed.append(d.get("id") or "?")
        else:
            healed += 1
            if "placeholder" in note:
                placeholders += 1
        time.sleep(0.2)

    # Ensure ALL deals in the full file point at images/<id>.jpg when present
    full = load_deals() if args.ids else data
    if args.ids:
        # Merge healed fields back into full file
        by_id = {d["id"]: d for d in data["deals"]}
        for d in full["deals"]:
            if d["id"] in by_id:
                d["image"] = by_id[d["id"]].get("image")
        data = full

    for d in data["deals"]:
        dest = image_path_for(d)
        if dest.is_file():
            d["image"] = relative_image(d)

    save_deals(data)

    # Final audit on the deals we touched / all
    final_broken = []
    for d in data["deals"] if not args.ids else [x for x in data["deals"] if x["id"] in set(args.ids or [])]:
        ok, reason = audit_one(d)
        if not ok:
            final_broken.append((d.get("id"), reason))

    print(
        f"Done: healed={healed}, placeholders={placeholders}, "
        f"still_broken={len(final_broken)}"
    )
    if final_broken:
        for i, r in final_broken:
            print(f"UNFIXED {i}: {r}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
