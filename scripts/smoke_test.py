#!/usr/bin/env python3
"""
Smoke test for the hourly refresh: runs the whole job on a throwaway copy of
the site with every store simulated (no network), then checks the output.

  python3 scripts/smoke_test.py      # exit code 0 = OK

Simulated Newegg search answers from the products already in data/deals.json
and data/build-parts.json; brand websites and photo checks are stubbed. Checks:
the job finishes; deals / builds / value / parts-catalog / price-history files
are valid; there are enough deals; every auto-added deal is in the tab the
classifier says it belongs to; app.js has no syntax errors (when node exists).
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

RUNNER = r'''
import json, re, sys, types
from pathlib import Path
root = Path(sys.argv[1]); sys.path.insert(0, str(root / "scripts"))
import requests
class _Resp:
    status_code = 404; text = ""; headers = {}
    def json(self): return {}
    def iter_content(self, n): return iter([b""])
    def __enter__(self): return self
    def __exit__(self, *a): return False
requests.get = lambda *a, **k: _Resp()
requests.Session.get = lambda self, *a, **k: _Resp()
import time; time.sleep = lambda s: None
import daily_refresh as dr, check_images
check_images.image_ok = lambda url: True

products = []
for f in ("deals.json", "build-parts.json"):
    try:
        data = json.loads((root / "data" / f).read_text())
    except OSError:
        continue
    for d in data.get("deals") or data.get("parts") or []:
        sku = str(d.get("sku") or "")
        if d.get("merchant") != "Newegg" or not sku or not d.get("price"):
            continue
        item = sku[7:] if sku.startswith("N82E168") else sku
        was = d.get("previousPrice")
        products.append({"ItemNumber": item, "WebDescription": d["name"], "ImageName": item + ".jpg",
                         "Price": {"FinalPrice": d["price"],
                                   "InstantRebateAmount": round(was - d["price"], 2) if was and was > d["price"] else 0,
                                   "RatingOneDecimal": d.get("rating") or 4.5, "HumanRating": d.get("ratingCount") or 10},
                         "LimitQuantity": 5})
def words(s): return set(re.findall(r"[a-z0-9]+", s.lower()))
def fake_search(self, query, order=8, page=1):
    self.calls += 1; self.ok_calls += 1
    q = words(query)
    hits = [p for p in products if len(q & words(p["WebDescription"])) >= min(2, len(q))]
    return hits[(page - 1) * 30: page * 30]
dr.Newegg.search = fake_search
sys.argv = ["daily_refresh.py"]
code = dr.main()
print("EXIT", code)
'''


def fail(msg: str) -> None:
    print("SMOKE TEST FAILED:", msg)
    sys.exit(1)


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "site"
        shutil.copytree(ROOT, work, ignore=shutil.ignore_patterns(".git", "node_modules", "__pycache__"))
        # force the brand-site step to run (simulated: every store unreachable)
        bs = work / "data" / "brand-sales.json"
        if bs.is_file():
            state = json.loads(bs.read_text())
            state.pop("fetchedAt", None)
            bs.write_text(json.dumps(state))
        (work / "runner.py").write_text(RUNNER)
        r = subprocess.run([sys.executable, "-I", str(work / "runner.py"), str(work)],
                           capture_output=True, text=True, timeout=600)
        out = r.stdout + r.stderr
        if r.returncode != 0 or "EXIT 0" not in r.stdout:
            print(out[-4000:])
            fail("the refresh job did not finish cleanly")

        def load(rel: str):
            try:
                return json.loads((work / rel).read_text())
            except (OSError, ValueError) as e:
                fail(f"{rel} unreadable: {e}")

        deals = load("data/deals.json")["deals"]
        builds = load("data/builds.json")
        value = load("data/value.json")
        catalog = load("data/parts-catalog.json")
        history = load("data/price-history.json")
        if len(deals) < 40:
            fail(f"only {len(deals)} deals")
        for d in deals:
            if not str(d.get("url", "")).startswith("http") or not (isinstance(d.get("price"), (int, float)) and d["price"] > 0):
                fail(f"bad deal {d.get('id')}")
        sys.path.insert(0, str(work / "scripts"))
        import categorize  # noqa: E402  (the copy's classifier)
        wrong = [(d["category"], d["name"][:60]) for d in deals
                 if d.get("autoSeeded") and not d.get("startsAt")
                 and categorize.product_type(d["name"], "", d["price"]) != d["category"]]
        if wrong:
            fail(f"{len(wrong)} auto-added deals in the wrong tab, e.g. {wrong[:3]}")
        if not builds.get("builds"):
            fail("no PC builds produced")
        for b in builds["builds"]:
            if b["total"] > b["budget"] + 0.01:
                fail(f"build over budget: {b['title']} {b['total']}")
        if not value.get("gpu", {}).get("rows"):
            fail("no Best Value GPU rankings")
        if not catalog.get("slots", {}).get("cpu"):
            fail("parts catalog empty")
        if not history.get("items"):
            fail("price history empty")
        if not any(k in d for d in deals for k in ("typical30",)):
            fail("price history stats missing from deals")
        node = shutil.which("node")
        if node:
            js = subprocess.run([node, "--check", str(work / "app.js")], capture_output=True, text=True)
            if js.returncode != 0:
                fail("app.js syntax error: " + js.stderr[-500:])
        summary = re.search(r'"after": (\d+)', out)
        print(f"Smoke test OK: {len(deals)} deals, {len(builds['builds'])} builds, "
              f"{len(value['gpu']['rows'])} GPU value rows, {len(history['items'])} products in history"
              + (f" (job reported {summary.group(1)} deals)" if summary else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
