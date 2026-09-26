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
2. Edit `data/deals.json` — set `price`, `previousPrice` (or `null` if unknown), `why`, `merchant`, and `url`.
3. **Never invent prices.** If you cannot verify a listing, remove that deal.
4. Stamp the file:

```bash
python3 scripts/refresh.py
python3 scripts/refresh.py --check   # print URLs to re-verify
```

5. Commit and push to `main`. Pages will pick up `data/deals.json` within a minute or two.

### Deal object shape

```json
{
  "id": "slug",
  "name": "Product name",
  "category": "GPU",
  "price": 1179.99,
  "previousPrice": 1250.99,
  "currency": "USD",
  "why": "1–3 sentences on why it’s a good deal right now.",
  "merchant": "Newegg",
  "url": "https://…",
  "image": null
}
```

Categories used in the UI: `GPU`, `CPU`, `Monitor`, `TV`, `Power Supply`, `Mouse`, `Keyboard` (add more freely).

## Design notes

- System fonts, soft rounded cards, sticky header with week/updated label + Share
- Soft dark mode via `prefers-color-scheme`
- Mobile-first / Safari-friendly; Web Share API with clipboard fallback
- Optional product images open in a lightbox

## License

Content and code for personal use by Luc / EvolKnives. Retailer trademarks belong to their owners. Deal links go to freely reachable product pages.
