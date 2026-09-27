# Live Search Worker

Cloudflare Worker that powers the Search tab on
[What's A Good Deal?](https://evolknives.github.io/gaming-deals/).

Fetches **real** Newegg prices via Newegg's public MCP product-search JSON API
(HTML scrape is a fallback for local `wrangler dev`; Newegg often returns 403
to Cloudflare egress IPs). Never invents prices, ratings, or dates.

## Endpoint

`GET /search?q=iphone` → JSON

```json
{ "ok": true, "query": "iphone", "source": "live", "via": "newegg-mcp-api", "deals": [ /* deal cards */ ] }
```

Also accepts `POST /search` with `{ "q": "…" }`.

CORS allows `https://evolknives.github.io` and localhost origins.
Responses are cached ~90s per query; empty/short queries (`< 2` chars) are rejected;
in-isolate rate limit ~30 req/min/IP.

## Current temporary deploy

A preview deploy may be live at:

`https://gaming-deals-search.different-cartoon.workers.dev`

Temporary preview accounts **expire unless claimed**. To keep it:

1. Open the claim URL printed by `wrangler deploy --temporary` (check agent notes), **or**
2. Prefer a permanent account (recommended):

```bash
cd workers/live-search
npx wrangler login          # one-time browser sign-in as Luc
npx wrangler deploy         # → gaming-deals-search.<your-subdomain>.workers.dev
```

Then set `LIVE_SEARCH_URL` at the top of `/app.js` to that URL, commit, and push
so GitHub Pages picks it up.

## Local

```bash
npx wrangler dev
curl 'http://127.0.0.1:8787/search?q=laptop'
```
