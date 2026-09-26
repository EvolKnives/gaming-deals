# What's A Good Deal?

A sparse, Apple-inspired static site that surfaces **current** prices on popular gaming-PC gear — GPUs, CPUs, monitors, power supplies, mice, keyboards, TVs, and home theater.

Live: **https://evolknives.github.io/gaming-deals/**

## Stack

- Static HTML / CSS / JS (no build step)
- Deal data in [`data/deals.json`](data/deals.json)
- GitHub Pages from `main` `/`

## Local preview

```bash
cd gaming-deals
python3 -m http.server 8080
# open http://127.0.0.1:8080/
```

Or any static server that serves the repo root.

## Updating deals

1. Re-check each product on the retailer page (Best Buy, Amazon, Newegg, Micro Center, manufacturer store).
2. Edit `data/deals.json` — set `price`, `previousPrice` (list/MSRP, or `null` if unknown), `why`, `merchant`, and `url`.
3. When the verified price is lower than the prior check, set `lastPrice` to the old `price`, `priceDropped: true`, and optional `dropAmount`. If the price rose, stayed flat, or the deal is first seen, set `priceDropped: false` and clear `dropAmount`.
4. **Never invent prices.** If you cannot verify a listing, remove that deal.
5. Stamp the file (and heal photos if any are missing/broken):

```bash
python3 scripts/refresh.py
python3 scripts/refresh.py --check         # print URLs to re-verify
python3 scripts/refresh.py --heal-images   # stamp + audit/heal photos
python3 scripts/heal_images.py             # photos only
```

6. Commit and push to `main`. Pages will pick up `data/deals.json` within a minute or two.

### Hourly deals refresh (intent)

An automated (or agent-driven) hourly refresh should re-verify each deal URL.

Prefer **product-page URLs** for price checks — search result pages are harder to scrape and more often blocked. Run `scripts/fix_product_links.py` when adding deals so CTAs stay on PDPs.

Then:

1. Compare the new verified price to the old `deal.price` (that value becomes `lastPrice`).
2. If new < old → `priceDropped: true`, `dropAmount = old - new`.
3. If new ≥ old or the deal is first seen → `priceDropped: false`, clear `dropAmount`.
4. Keep `previousPrice` as list/MSRP for the “% off” badge — it is not the last-check price.
5. Never invent prices. Prefer `scripts/refresh.apply_verified_price(deal, new_price)` so the fields stay consistent even while scraping remains manual.

Cards show a small green “Dropped” / “↓ $X” pill when the current `price` is below list/MSRP (`previousPrice`) **or** when `priceDropped` is true from the last hourly check. The UI computes this client-side from existing fields so refresh flags and % off stay honest to the numbers on the card — never invent prices. Prefer the hourly `dropAmount` when present; otherwise show dollars below list/MSRP.

### Deal object shape

```json
{
  "id": "slug",
  "name": "Product name",
  "category": "GPUs",
  "price": 1179.99,
  "previousPrice": 1250.99,
  "lastPrice": 1219.99,
  "priceDropped": true,
  "dropAmount": 40,
  "currency": "USD",
  "why": "1–3 sentences on why it’s a good deal right now.",
  "merchant": "Newegg",
  "url": "https://…",
  "urlKind": "product",
  "asin": "B0EXAMPLE1",
  "image": "images/slug.jpg",
  "imageSource": "product-page"
}
```

`urlKind`, `asin`/`sku`, and `imageSource` are optional audit fields — `app.js` ignores unknown keys.

- `previousPrice` — list / MSRP for the “% off · save $X” badge (or `null`).
- `lastPrice` — price at the previous successful refresh (`null` if never checked before).
- `priceDropped` — `true` when current `price` < `lastPrice` from the prior refresh (hourly signal only).
- `dropAmount` — optional dollars fallen since last refresh.
- **Dropped pill (UI)** — shown when `price < previousPrice` (below list/MSRP) **or** `priceDropped` (down since last check). Meaning: below list/MSRP or down since last check.

Categories used in the UI (always plural, never apostrophe plurals — except `Home Theater`): `GPUs`, `CPUs`, `Monitors`, `TVs`, `Home Theater`, `Art Tablets`, `PSUs`, `Mice`, `Keyboards` (plus `All`). Map legacy singular labels (GPU→GPUs, Power Supply→PSUs, Mouse→Mice, etc.) when editing.


### Inspiration UI (client-side)

Cards also show:
- **Sparkline + Near low** — SVG trend from `priceHistory[]` when present; otherwise an honest series from known points (`previousPrice` → `lastPrice` → `price`). Never invents fake lows. “Near low” only when current is within ~5% of the min of available points.
- **Deal heat meter** — static cool → warm → hot → fire from % off + drop size (no voting backend).
- **Promo chip** — if `promoCode` (or `promo` / `couponCode`) is set, shows “Code: X · tap to copy” via the existing toast. Do not invent codes.
- **Budget ladder** — Under $50 / $50–150 / $150–400 / $400+ chips sit under categories and AND with the category filter.
- **Freshness / ends-at** — “Checked …” from deal `updatedAt` or site `updatedAt`; countdown only when `endsAt` is present (never invent end dates). Soft **Ending soon** badge when `endsAt` is within 48h.
- **Future tab** — filter chip listing deals with `startsAt` between 1 day and 1 month ahead. Empty copy: “No upcoming deals found yet.” Never invent start dates.

Optional deal fields for richer UI (all optional; omit when unknown):
- `priceHistory` — array of numbers or `{ price }` objects
- `promoCode` — real stack/coupon code string
- `endsAt` — ISO datetime for limited-time deals (omit when unknown)
- `startsAt` — ISO datetime when a scheduled promo/sale begins (Future tab)
- `updatedAt` — per-deal last check (falls back to site `updatedAt`)

### Sort order

Single-category tabs (GPUs, TVs, Home Theater, Art Tablets, etc.) sort by **biggest savings first**. Savings = `previousPrice - price` when `previousPrice > price`. Deals with no measurable savings sink to the bottom.

On the **All** tab, deals are grouped by category, each group is savings-sorted as above, then **round-robin interleaved** across categories so long same-category runs are avoided. Same category only lands back-to-back when every remaining deal shares that category. The sort runs on every render so it survives refresh and filter changes.


## Product photos & CTA links

Every deal should have a real product photo at `images/<deal-id>.jpg` (JPEG, ~800–1200px on the long side) and `deal.image` set to that repo-relative path so GitHub Pages serves it.

- **CTA `url` should be a product page** (Amazon `/dp/ASIN`, Newegg `/p/N82E…`, Best Buy `….p?skuId=…`, Micro Center `/product/…`, or manufacturer PDP) whenever a matching SKU can be verified. Search URLs (`/s?k=`, `/p/pl?`, Best Buy `searchpage.jsp`) are a last resort when the exact listing is ambiguous.
- Optional audit fields (ignored by `app.js` if absent): `urlKind` (`product`|`search`), `asin` / `sku`, `imageSource` (`product-page`|`search`|`placeholder`).
- Photos are pulled **from the product page** (og:image / primary CDN) first. Name-based merchant search is only a fallback. **Never invent a product.**
- Category placeholders (clearly labeled “PHOTO PLACEHOLDER”) are a last resort only.

### Fix links + self-heal

```bash
# Resolve search → product URLs when a confident same-SKU match exists
python3 scripts/fix_product_links.py
python3 scripts/fix_product_links.py --dry-run

# Audit + re-download any missing / null / too-small / unreadable photos
python3 scripts/heal_images.py

# Re-pull photos from product URLs (replace wrong search-sourced shots)
python3 scripts/heal_images.py --force-from-url

# Report only (exit 1 if anything is broken)
python3 scripts/heal_images.py --audit-only

# Stamp week metadata and heal photos in one pass
python3 scripts/refresh.py --heal-images

# Fill endsAt / startsAt from retailer pages when confidently found
python3 scripts/fetch_deal_dates.py
python3 scripts/refresh.py --fetch-dates
```

`heal_images.py` exits non-zero if any deal is still broken after healing. Needs `Pillow` and `requests` (`python3 -m venv .venv && .venv/bin/pip install Pillow requests`).

**Scraping blockers:** Amazon and Best Buy often block or time out from datacenter IPs (product CTAs still work in a browser). Newegg item pages, Micro Center, and many manufacturer PDPs remain fetchable for og:image. When a product URL is blocked, heal falls back to a name-matched Newegg product image when the title clearly matches.

## Design notes

- System fonts, soft rounded cards, sticky header with week/updated label + Share
- Soft dark mode via `prefers-color-scheme`
- Mobile-first / Safari-friendly; Web Share API with clipboard fallback
- Optional product images open in a lightbox
- Price-drop pill (green, subtle pulse once on reveal; respects `prefers-reduced-motion`)

## License

Content and code for personal use by Luc / EvolKnives. Retailer trademarks belong to their owners. Deal links go to freely reachable product pages.
