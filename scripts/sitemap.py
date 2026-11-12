#!/usr/bin/env python3
"""Write sitemap.xml: the home page, About / Privacy, and a ?tab= page for
each category and feature tab, so search engines can find category pages.
Run by the hourly job (categories come from data/category-rules.json).
Submit https://<site>/sitemap.xml in Google Search Console once."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
SITE = "https://evolknives.github.io/gaming-deals/"  # change if the site moves to its own domain
FIXED_TABS = ["Best Value", "Builds", "Future"]


def main() -> int:
    cats = [r["category"] for r in json.loads((ROOT / "data" / "category-rules.json").read_text())["seeds"]]
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    urls = [(SITE, "hourly"), (SITE + "about.html", "monthly"), (SITE + "privacy.html", "yearly")]
    urls += [(SITE + "?tab=" + quote(t), "hourly") for t in FIXED_TABS + sorted(cats, key=str.lower)]
    body = "".join(
        f"  <url><loc>{escape(u)}</loc><lastmod>{today}</lastmod><changefreq>{f}</changefreq></url>\n"
        for u, f in urls)
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + body + "</urlset>\n")
    path = ROOT / "sitemap.xml"
    if not path.is_file() or path.read_text() != xml:
        path.write_text(xml)
    print(f"sitemap.xml: {len(urls)} pages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
