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
Responses are cached ~3 min per query; empty/short queries (`< 2` chars) are rejected;
in-isolate rate limit ~30 req/min/IP.

## Current temporary deploy

A preview deploy may be live at:

`https://gaming-deals-search.evolknives.workers.dev`

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

## Hourly refresh backup (cron trigger)

GitHub's scheduled workflows often start late or get skipped. The Worker also
runs on a timer (`[triggers] crons` in `wrangler.toml`, minute 20 of every hour)
and asks GitHub to run **Hourly deals refresh** — unless a run already started
in the last 40 minutes, so it never doubles up with GitHub's own schedule.

One-time setup:

1. Create a GitHub **fine-grained personal access token** at
   <https://github.com/settings/personal-access-tokens/new>:
   - Repository access: *Only select repositories* → `EvolKnives/gaming-deals`
   - Permissions → Repository → **Actions: Read and write** (nothing else)
   - Expiration: up to 1 year (set a reminder to renew it)
2. Store it in the Worker and deploy:

   ```bash
   cd workers/live-search
   npx wrangler login                       # if not already signed in
   npx wrangler secret put GITHUB_DISPATCH_TOKEN   # paste the token
   npx wrangler deploy
   ```

Without the secret the timer does nothing. Check it with `npx wrangler tail`
around minute 20 — it logs `refresh trigger: …` each hour.
