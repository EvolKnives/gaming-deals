#!/usr/bin/env python3
"""Point index.html at the current app.js / styles.css.

Phones cache app.js and styles.css. index.html loads them as
"styles.css?v=<tag>"; when the file changes, the tag must change too or
visitors keep the old copy. This sets each tag to a short hash of the file's
contents, so it changes exactly when the file does. Run by the hourly
GitHub Actions job; safe to run by hand (no change → no write).
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"
PAGES = [ROOT / "index.html", ROOT / "about.html", ROOT / "privacy.html"]
ASSETS = ("app.js", "styles.css")


def main() -> int:
    changed = []
    for page in PAGES:
        if not page.is_file():
            continue
        html = page.read_text(encoding="utf-8")
        new = html
        for name in ASSETS:
            digest = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()[:10]
            new = re.sub(
                rf'({re.escape(name)})(\?v=[^"\']*)?(["\'])',
                rf"\g<1>?v={digest}\g<3>",
                new,
            )
        if new != html:
            page.write_text(new, encoding="utf-8")
            changed.append(page.name)
    print(("asset versions updated: " + ", ".join(changed)) if changed else "asset versions already current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
