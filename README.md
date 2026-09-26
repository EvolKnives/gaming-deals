# What's A Good Deal?

A sparse, Apple-inspired static site that surfaces **current** prices on popular gaming-PC gear — GPUs, CPUs, monitors, power supplies, mice, keyboards, and TVs.

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
5. Stamp the file:

```bash
python3 scripts/refresh.py
python3 scripts/refresh.py --check   # print URLs to re-verify
```

6. Commit and push to `main`. Pages will pick up `data/deals.json` within a minute or two.

### Hourly deals refresh (intent)

An automated (or agent-driven) hourly refresh should re-verify each deal URL, then:

1. Compare the new verified price to the old `deal.price` (that value becomes `lastPrice`).
2. If new < old → `priceDropped: true`, `dropAmount = old - new`.
3. If new ≥ old or the deal is first seen → `priceDropped: false`, clear `dropAmount`.
4. Keep `previousPrice` as list/MSRP for the “% off” badge — it is not the last-check price.
5. Never invent prices. Prefer `scripts/refresh.apply_verified_price(deal, new_price)` so the fields stay consistent even while scraping remains manual.

Cards with `priceDropped: true` show a small green “Dropped” / “↓ $X” pill on the product image.

### Deal object shape

```json
{
  "id": "slug",
  "name": "Product name",
  "category": "GPU",
  "price": 1179.99,
  "previousPrice": 1250.99,
  "lastPrice": 1219.99,
  "priceDropped": true,
  "dropAmount": 40,
  "currency": "USD",
  "why": "1–3 sentences on why it’s a good deal right now.",
  "merchant": "Newegg",
  "url": "https://…",
  "image": "images/slug.jpg"
}
```

- `previousPrice` — list / MSRP for the “% off · save $X” badge (or `null`).
- `lastPrice` — price at the previous successful refresh (`null` if never checked before).
- `priceDropped` — `true` when current `price` < `lastPrice` from the prior refresh.
- `dropAmount` — optional dollars fallen since last refresh.

Categories used in the UI: `GPU`, `CPU`, `Monitor`, `TV`, `Power Supply`, `Mouse`, `Keyboard` (add more freely).

## Design notes

- System fonts, soft rounded cards, sticky header with week/updated label + Share
- Soft dark mode via `prefers-color-scheme`
- Mobile-first / Safari-friendly; Web Share API with clipboard fallback
- Optional product images open in a lightbox
- Price-drop pill (green, subtle pulse once on reveal; respects `prefers-reduced-motion`)

## License

Content and code for personal use by Luc / EvolKnives. Retailer trademarks belong to their owners. Deal links go to freely reachable product pages.
