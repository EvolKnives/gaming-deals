# What's A Good Deal?

A sparse, Apple-inspired static site that surfaces **current** prices on popular gaming-PC gear — GPUs, CPUs, monitors, cases, motherboards, RAM, SSDs, phones, prebuilt gaming PCs, laptops, power supplies, mice, keyboards, TVs, and home theater — plus upcoming, sourced sale prices on the Future tab.

Live: **https://evolknives.github.io/gaming-deals/**

## Stack

- Static HTML / CSS / JS (no build step)
- Deal data in [`data/deals.json`](data/deals.json)
- GitHub Pages from `main` `/`


## Live Search

The Search chip filters the local catalogue instantly, then (after ~300ms debounce,
query length ≥ 2) calls a Cloudflare Worker for live results (Best Buy's official API, then Newegg). Live hits
render in the **same deal cards**; catalogue matches for the query are merged in
and deduped by SKU/URL. If the Worker is unreachable, Search falls back to
catalogue-only with a calm status line.

- Worker source: [`workers/live-search/`](workers/live-search/)
- Config: `LIVE_SEARCH_URL` near the top of [`app.js`](app.js)
- Deploy: see [`workers/live-search/README.md`](workers/live-search/README.md) (`npx wrangler login` once, then `npx wrangler deploy`)

Pull-to-refresh reloads `data/deals.json?t=…` with `cache: "no-store"` (the same cache-bust runs on a normal page load). After the tab has been hidden for more than 5 minutes, coming back also refetches quietly. The header shows **Updated X ago** from `deals.json` `updatedAt`.

## Builds tab

[`scripts/build_pcs.py`](scripts/build_pcs.py) runs at the end of every hourly
refresh and writes [`data/builds.json`](data/builds.json): for each budget
($1,200, $1,500, $2,000, $3,000) the strongest AMD build and the strongest
Intel build that today's prices allow. Parts come from the deals plus
regular-price Newegg parts that the refresh looks up every 6 hours
([`data/build-parts.json`](data/build-parts.json), queries in `POOL_QUERIES`
in `daily_refresh.py`); each part is marked on sale or regular price.

Compatibility is read from product titles: CPU and motherboard sockets,
memory type, motherboard size vs case, and power supply wattage vs graphics
card. The graphics card is weighted 3x the processor, and builds from $2,000
up use at least 32GB of memory. Budgets no build can meet are skipped.

**Build your own** (a switch at the top of the Builds tab) lets visitors pick
every part from [`data/parts-catalog.json`](data/parts-catalog.json), which
`build_pcs.py` writes each hour: every part whose compatibility facts could be
read. Each list only offers parts that fit the other picks (socket, DDR4 vs
DDR5, board size vs case, PSU wattage vs graphics card). The build is kept in
the visitor's browser and can be shared as a link (`?tab=Builds&build=…`).

On the site, each part has a menu of other compatible options with prices.
Picking a graphics card that needs more power, or a motherboard the case
can't hold, also switches in the cheapest power supply or case that fits.

## Sales on brand websites

[`scripts/brand_sales.py`](scripts/brand_sales.py) checks the stores in
[`data/brand-stores.json`](data/brand-stores.json) every 6 hours and adds
products that are on sale on the brand's own site (at least 5% below the
brand's regular price), linked to the brand's product page:

- **Shopify stores** (Keychron and other accessory brands): the public
  `products.json` feed (`price` vs `compare_at_price`)
- **Logitech**: server-rendered store listings (sale price + struck-through
  regular price); the product page supplies the photo
- **Razer**: product pages from the sitemap, a rotating batch of 30 per
  refresh; each page embeds the regular and markdown prices

Only paths each site's robots.txt allows are read, with a pause between
requests. Products are sorted into tabs with the same category rules as
Newegg deals; accessories (cases, keycaps, docks…) are skipped. Results and a
per-store log are in `data/brand-sales.json`. Add a store by adding a line.

## Photos (automatic)

[`scripts/check_images.py`](scripts/check_images.py) runs inside every hourly
refresh: it re-checks every product photo about once a day (≈150 per run),
removes photos that no longer load, and looks for a photo for every deal that
has none — the product page's og:image / schema.org image (stores that block
automated visits, like Costco, are skipped), then a matching Newegg listing.
A candidate is used only after it is confirmed to load. Deals still without a
photo show a category icon and are listed in the run log (`photos_missing`).

## Right tab for every product

[`scripts/categorize.py`](scripts/categorize.py) decides what kind of product a
title describes: complete systems first (a title listing processor, graphics,
memory and storage is a prebuilt or laptop, never the SSD it mentions),
compatibility text ignored, then the product word named earliest in the title.
New deals must classify as the tab they were searched for; every existing deal
is re-checked each hourly run (misfiled ones move, auto-added ones that fit no
tab are dropped); build parts and brand-site sales use the same check.

## Price history

[`scripts/price_history.py`](scripts/price_history.py) runs inside every hourly
refresh. [`data/price-history.json`](data/price-history.json) stores only price
**changes** per SKU (`[hour, price]`; a price holds until the next entry) and the
last hour each product was seen. A product unchecked for over 48 hours gets a
gap marker (`null` price) instead of an assumed price. Changes are kept 90 days.

From it each deal gets `low30` / `high30` / `typical30` (price held longest) and
two honest-discount flags, set only after 14 days of observed prices in the
30-day window: `lowest30` ("Lowest in 30 days") and `wasUnseen` (the store's
"was" price is above anything charged in 30 days). Cards link to an
Amazon-style step chart (30 / 90 days). `--backfill` rebuilds the file from the
git history of `data/deals.json`.

## Shared category rules

[`data/category-rules.json`](data/category-rules.json) holds the category rules
used by both the hourly refresh (search queries, title must / must-not
patterns, price floor) and the Search Worker (title → category hints). Edit
categories there, then redeploy the Worker for Search to pick up changes.

## Asset versions

`index.html` loads `app.js?v=…` and `styles.css?v=…`. The hourly job runs
[`scripts/stamp_asset_versions.py`](scripts/stamp_asset_versions.py), which
sets each tag to a hash of the file, so phones fetch the new file whenever it
changes. Run it by hand before pushing if you want the change live right away.

## Local preview

```bash
cd gaming-deals
python3 -m http.server 8080
# open http://127.0.0.1:8080/
```

Or any static server that serves the repo root.

## Updating deals

### Automatic hourly refresh (GitHub Actions)

[`.github/workflows/daily-refresh.yml`](.github/workflows/daily-refresh.yml)
(`Hourly deals refresh`) runs [`scripts/daily_refresh.py`](scripts/daily_refresh.py)
**every hour at minute 17** (`17 * * * *`, offset from top-of-hour congestion)
and can be run by hand from the Actions tab (*Run workflow*). It needs no secrets.
GitHub's scheduler often starts runs late or skips them, so the Search Worker
also starts this workflow at minute 20 of every hour unless a run began in the
last 40 minutes (one-time setup: [`workers/live-search/README.md`](workers/live-search/README.md#hourly-refresh-backup-cron-trigger)).
If Newegg throttles a run partway through, it stops checking and saves what it
already verified. Each run:

1. Re-verifies every *current* Newegg deal (price, was-price, rating, stock) through Newegg's
   public product-search JSON API — the same API the live Search Worker uses — and
   Denon deals from the product page's JSON-LD. Upcoming Future deals (`startsAt` still
   in the future) are skipped and kept as announced.
2. Drops anything that can't be verified for **3 calendar days** (not 3 job runs — still
   three days even though the job is hourly). Sale end dates that have passed are cleared
   on live, verifiable deals. After a Future deal's start date, it is promoted to the live
   catalogue if the price can be verified, or kept until `endsAt` and then dropped.
3. Tops each category back up to 10 with fresh, in-stock, best-discount Newegg listings
   (Prebuilts require a real was-price / discount).
4. Writes and commits `data/deals.json` (+ removed photos) **every run**, so the
   site's "Updated X ago" and per-deal "Checked X ago" stay current even in hours when
   no price changed. `catalogueRevision` only bumps on meaningful changes (prices,
   membership, sale dates). Each commit triggers a GitHub Pages rebuild.

If the Newegg API is unreachable, or returns HTTP 403/429, the script exits without
writing, so a throttled or bad run never wipes the site. Pull-to-refresh on the site
picks up the new file after a successful commit.

To add a current deal from a retailer the job can't verify (Amazon, Best Buy, Crutchfield…),
add it by hand — it will be pruned after 3 days unless the job can re-verify it.
Upcoming announced sales should include `startsAt` (and `endsAt` / `sourceUrl` when known)
so the hourly job keeps them until the sale starts.


### Dynamic catalogue refresh

The catalogue still lives in static `data/deals.json` on GitHub Pages. **Search** also calls the live Worker when configured (`LIVE_SEARCH_URL`). To make the catalogue change over time (and so queries like “computer cases” return hits), refresh the JSON on a machine that can fetch retailer pages, then push:

```bash
# Prune dead/OOS Newegg listings + seed/grow Cases, RAM, SSDs, Motherboards
python3 scripts/catalogue_refresh.py

# Search-then-fetch: fill misses for a query (e.g. Search had 0 hits)
python3 scripts/search_ingest.py "computer cases"
python3 scripts/search_ingest.py "ddr5 32gb" --category RAM --limit 10

# Stamp week metadata / heal photos / ratings for new URLs
python3 scripts/refresh.py
python3 scripts/heal_images.py
python3 scripts/fetch_ratings.py   # optional; never invents scores

git add data/deals.json images && git commit -m "Refresh catalogue" && git push
```

`catalogue_refresh.py` **removes** deals when a Newegg product page is verified dead or out of stock. Transient fetch failures keep the deal (no catalogue wipe). Duplicates are collapsed by SKU/ASIN/product URL (never by Amazon/Best Buy search hubs).

Client pull-to-refresh still reloads `deals.json` with cache-bust — do **not** reinstate an hourly client timer that pings.


1. Re-check each product on the retailer page (Best Buy, Amazon, Newegg, Micro Center, manufacturer store).
2. Edit `data/deals.json` — set `price`, `previousPrice` (list/MSRP, or `null` if unknown), `why`, `merchant`, and `url`.
3. When the verified price is lower than the prior check, set `lastPrice` to the old `price`, `priceDropped: true`, `dropAmount` and `droppedAt`. The flag stays on for 24 hours while the price holds, and clears if the price rises (`apply_verified_price` in `scripts/refresh.py`).
4. **Never invent prices.** If you cannot verify a listing, remove that deal.
5. Stamp the file (and heal photos if any are missing/broken):

```bash
python3 scripts/refresh.py
python3 scripts/refresh.py --check         # print URLs to re-verify
python3 scripts/refresh.py --heal-images   # stamp + audit/heal photos
python3 scripts/heal_images.py             # photos only
```

6. Commit and push to `main`. Pages will pick up `data/deals.json` within a minute or two.

### Manual re-verification notes

A manual or agent-driven refresh should re-verify each deal URL.

Prefer **product-page URLs** for price checks — search result pages are harder to scrape and more often blocked. Run `scripts/fix_product_links.py` when adding deals so CTAs stay on PDPs.

Then:

1. Compare the new verified price to the old `deal.price` (that value becomes `lastPrice`).
2. If new < old → `priceDropped: true`, `dropAmount = old - new`, `droppedAt = now`.
3. If new = old → keep the drop flag until 24 hours after `droppedAt`; if new > old or first seen → `priceDropped: false`.
4. Keep `previousPrice` as list/MSRP for the “% off” badge — it is not the last-check price.
5. Never invent prices. Prefer `scripts/refresh.apply_verified_price(deal, new_price)` so the fields stay consistent even while scraping remains manual.

Cards show a small green “↓ $X” badge only for a real recent drop: `priceDropped` from the hourly check, kept for 24 hours. Savings against list/MSRP (`previousPrice`) already appear in the “% off · save $X” pill, so the badge does not repeat them.

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
- `priceDropped` — `true` for 24 hours after an hourly check finds a lower price (`droppedAt` records when).
- `dropAmount` — optional dollars fallen since last refresh.
- **Drop badge (UI)** — shown only when `priceDropped` is true (a real drop in the last 24 hours).

Categories used in the UI (always plural, never apostrophe plurals — except `Home Theater`): `GPUs`, `CPUs`, `Monitors`, `TVs`, `Home Theater`, `Art Tablets`, `PSUs`, `Cases`, `Motherboards`, `RAM`, `SSDs`, `Phones`, `Prebuilts`, `Laptops`, `Mice`, `Keyboards` (plus `All` / `Future` / Search). Map legacy singular labels (GPU→GPUs, Case→Cases, Power Supply→PSUs, Mouse→Mice, Prebuilt→Prebuilts, etc.) when editing.


### Inspiration UI (client-side)

Cards also show:
- **Near low** — only when `priceHistory[]` has 3+ real checks and current is within ~5% of that min, or when `priceDropped` since the last verified refresh. No sparkline (list/MSRP is not a trend).
- **Deal heat meter** — static cool → warm → hot → fire from % off + drop size (no voting backend).
- **Promo chip** — if `promoCode` (or `promo` / `couponCode`) is set, shows “Code: X · tap to copy” via the existing toast. Do not invent codes.
- **Budget ladder** — Under $50 / $50–150 / $150–400 / $400+ chips sit under categories and AND with the category filter.
- **Freshness / ends-at** — “Checked …” from deal `updatedAt` or site `updatedAt`; countdown only when `endsAt` is present (never invent end dates). Soft **Ending soon** badge when `endsAt` is within 48h.
- **Product rating** — compact `★ 4.3` / `★ 4.3 · 1.2k` on the card when `rating` was scraped from the product page (never invent scores; omit when blocked/missing).
- **Future tab** — filter chip listing deals whose `startsAt` is still in the future, up to 30 days ahead. Empty copy: “No upcoming deals found yet.” Never invent start dates or prices; announced Future deals should include `sourceUrl` / `sourceName` when the price comes from an ad or announcement.

Optional deal fields for richer UI (all optional; omit when unknown):
- `priceHistory` — array of numbers or `{ price }` objects
- `promoCode` — real stack/coupon code string
- `endsAt` — ISO datetime for limited-time deals (omit when unknown)
- `startsAt` — ISO datetime when a scheduled promo/sale begins (Future tab)
- `updatedAt` — per-deal last check (falls back to site `updatedAt`)
- `rating` — product score out of 5 (scraped only; omit when unknown)
- `ratingCount` — review/rating count when available
- `ratingSource` — short scrape note e.g. `newegg-RatingOneDecimal`

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
# Fill rating / ratingCount from retailer product pages when found
python3 scripts/fetch_ratings.py
python3 scripts/fetch_ratings.py --dry-run
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
