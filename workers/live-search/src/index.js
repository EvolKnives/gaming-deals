/**
 * Live Search Worker — Newegg search → deal-shaped JSON.
 * Never invents prices/ratings/dates. Only values from Newegg responses.
 *
 * Primary: Newegg's product-search JSON API; fallback: Newegg search HTML.
 */

import categoryRules from "../../../data/category-rules.json";

const ALLOWED_ORIGINS = new Set([
  "https://evolknives.github.io",
  "http://localhost",
  "http://127.0.0.1",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const NEWEGG_MCP_URL = "https://apis.newegg.com/ex-mcp/endpoint/product-search";
const MIN_QUERY_LEN = 2;
const MAX_QUERY_LEN = 80;
const RESULT_LIMIT = 20;
const MIN_DEAL_PCT = 5;
const MIN_DEAL_SAVE = 5;
const MIN_PRICE = 15;
const CACHE_TTL_SECONDS = 180;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_IP = 30;

const rateBuckets = new Map();

// Category rules shared with the hourly refresh script (data/category-rules.json).
// Order matters: the first matching pattern wins.
const CATEGORY_HINTS = categoryRules.liveSearchHints.map((h) => ({
  re: new RegExp(h.pattern, "i"),
  cat: h.category,
}));

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json(
        { ok: true, service: "gaming-deals-search", endpoints: ["/search?q="] },
        200,
        cors
      );
    }

    if (url.pathname !== "/search") {
      return json({ ok: false, error: "not_found" }, 404, cors);
    }

    if (request.method !== "GET" && request.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405, cors);
    }

    let q = (url.searchParams.get("q") || "").trim();
    if (request.method === "POST") {
      try {
        const ct = request.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const body = await request.json();
          if (body && typeof body.q === "string" && body.q.trim()) q = body.q.trim();
          else if (body && typeof body.query === "string" && body.query.trim())
            q = body.query.trim();
        } else if (ct.includes("application/x-www-form-urlencoded")) {
          const form = await request.formData();
          const fq = form.get("q") || form.get("query");
          if (typeof fq === "string" && fq.trim()) q = fq.trim();
        }
      } catch (_) {
        /* ignore */
      }
    }

    q = q.replace(/\s+/g, " ").slice(0, MAX_QUERY_LEN);
    if (q.length < MIN_QUERY_LEN) {
      return json(
        { ok: false, error: "query_too_short", minLength: MIN_QUERY_LEN, deals: [] },
        400,
        cors
      );
    }

    const clientIp =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
      "unknown";
    if (!allowRate(clientIp)) {
      return json({ ok: false, error: "rate_limited", deals: [] }, 429, cors);
    }

    const cacheKey = new Request(
      `https://gaming-deals-search.cache/v11/search?q=${encodeURIComponent(q.toLowerCase())}`,
      { method: "GET" }
    );
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const hit = new Response(cached.body, cached);
      Object.entries(cors).forEach(([k, v]) => hit.headers.set(k, v));
      hit.headers.set("X-Cache", "HIT");
      return hit;
    }

    try {
      const { deals, via, note } = await searchLive(q, env);
      const topMerchant =
        deals[0] && deals[0].merchant ? deals[0].merchant : "live";
      const payload = {
        ok: true,
        query: q,
        source: "live",
        via,
        merchant: topMerchant,
        count: deals.length,
        deals,
      };
      if (note && !deals.length) payload.note = note;
      const response = json(payload, 200, {
        ...cors,
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
        "X-Cache": "MISS",
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      return json(
        {
          ok: false,
          error: "upstream_failed",
          message: String(err && err.message ? err.message : err),
          deals: [],
        },
        502,
        cors
      );
    }
  },

  // Hourly backup for the GitHub Actions deals refresh. GitHub's own cron is
  // known to start late or skip runs, so this asks GitHub to run the workflow
  // at minute 20 — unless a run already started in the last 40 minutes.
  // Needs the GITHUB_DISPATCH_TOKEN secret (see README); without it, no-op.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(triggerDealsRefresh(env));
  },
};

const REFRESH_REPO = "EvolKnives/gaming-deals";
const REFRESH_WORKFLOW = "daily-refresh.yml";
const REFRESH_SKIP_IF_RECENT_MS = 40 * 60 * 1000;

async function triggerDealsRefresh(env) {
  const token = env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    console.log("refresh trigger: GITHUB_DISPATCH_TOKEN not set — skipping");
    return;
  }
  const api = `https://api.github.com/repos/${REFRESH_REPO}/actions/workflows/${REFRESH_WORKFLOW}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "gaming-deals-refresh-trigger",
  };

  try {
    const r = await fetch(`${api}/runs?per_page=1`, { headers });
    if (r.ok) {
      const latest = ((await r.json()).workflow_runs || [])[0];
      const age = latest ? Date.now() - Date.parse(latest.created_at) : Infinity;
      if (age < REFRESH_SKIP_IF_RECENT_MS) {
        console.log(`refresh trigger: run ${latest.id} started ${Math.round(age / 60000)}m ago — skipping`);
        return;
      }
    }
  } catch (err) {
    console.log("refresh trigger: could not list runs, dispatching anyway:", String(err));
  }

  const d = await fetch(`${api}/dispatches`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  });
  console.log(`refresh trigger: dispatch → HTTP ${d.status}`);
}

function corsHeaders(origin) {
  let allow = "https://evolknives.github.io";
  if (origin) {
    try {
      const u = new URL(origin);
      const key = `${u.protocol}//${u.host}`;
      if (
        ALLOWED_ORIGINS.has(key) ||
        ALLOWED_ORIGINS.has(origin) ||
        u.hostname === "localhost" ||
        u.hostname === "127.0.0.1"
      ) {
        allow = origin;
      }
    } catch (_) {
      /* keep default */
    }
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(extraHeaders || {}),
    },
  });
}

function allowRate(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start > RATE_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (now - v.start > RATE_WINDOW_MS) rateBuckets.delete(k);
    }
  }
  return bucket.count <= RATE_MAX_PER_IP;
}

async function searchLive(query, env) {
  const errors = [];
  // Best Buy's official Products API first (needs the BESTBUY_API_KEY secret).
  // Newegg's JSON API and search page follow, though Newegg usually blocks
  // Cloudflare's servers. (An Amazon-page fallback was removed: scraping
  // Amazon breaks their terms and their page layout.)
  if (env && env.BESTBUY_API_KEY) {
    try {
      const deals = await searchViaBestBuy(query, env.BESTBUY_API_KEY);
      if (deals.length) return { deals, via: "bestbuy-api" };
      errors.push("bestbuy:empty");
    } catch (err) {
      errors.push("bestbuy:" + String(err && err.message ? err.message : err));
    }
  } else {
    errors.push("bestbuy:no-key");
  }

  // Prefer HTTP 200 + empty deals over 502 when upstreams are empty/blocked —
  // the frontend then shows filtered catalogue or a clean "no deals" instead of
  // dumping unrelated Cases/PSUs for category queries like "GPU".
  try {
    const deals = await searchViaMcpApi(query);
    if (deals.length) return { deals, via: "newegg-mcp-api" };
    errors.push("mcp:empty");
  } catch (err) {
    errors.push("mcp:" + String(err && err.message ? err.message : err));
  }

  try {
    const deals = await searchViaHtml(query);
    if (deals.length) return { deals, via: "newegg-html" };
    errors.push("html:empty");
  } catch (err) {
    errors.push("html:" + String(err && err.message ? err.message : err));
  }

  return { deals: [], via: "empty", note: errors.join(" | ") || "no results" };
}

// ---------------------------------------------------------------- Best Buy
// https://bestbuyapis.github.io/api-documentation/ — official Products API.
const BESTBUY_API = "https://api.bestbuy.com/v1/products";
const BESTBUY_FIELDS = [
  "sku", "name", "salePrice", "regularPrice", "onSale", "image", "largeImage",
  "url", "customerReviewAverage", "customerReviewCount", "onlineAvailability",
].join(",");

async function searchViaBestBuy(query, apiKey) {
  // Every word must match (Best Buy keyword search, AND-ed); online-buyable only.
  const words = String(query)
    .toLowerCase()
    .split(/[^a-z0-9.+-]+/)
    .filter((w) => w.length > 0)
    .slice(0, 8);
  if (!words.length) return [];
  const filter = words.map((w) => "search=" + encodeURIComponent(w)).join("&") + "&onlineAvailability=true";
  const url =
    `${BESTBUY_API}(${filter})?format=json&pageSize=40` +
    `&show=${BESTBUY_FIELDS}&apiKey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Best Buy HTTP ${res.status}`);
  const page = await res.json();
  return mapBestBuyProducts(Array.isArray(page.products) ? page.products : [], query);
}

function mapBestBuyProducts(products, query) {
  const out = [];
  for (const p of products) {
    if (!p || typeof p !== "object") continue;
    const title = decodeHtml(String(p.name || "")).trim();
    const price = Number(p.salePrice);
    const regular = Number(p.regularPrice);
    if (!title || !Number.isFinite(price) || !p.url || !p.sku) continue;
    const previousPrice = Number.isFinite(regular) && regular > price ? round2(regular) : null;
    const sku = "BBY-" + String(p.sku);
    const deal = {
      id: "live-" + slugify(title, sku),
      name: title,
      price: round2(price),
      previousPrice,
      url: String(p.url),
      urlKind: "product",
      merchant: "Best Buy",
      image: p.largeImage || p.image || null,
      category: inferCategory(title, query) || "Other",
      currency: "USD",
      sku,
      source: "live",
      why: whyLine(price, previousPrice, "Best Buy"),
    };
    const rating = Number(p.customerReviewAverage);
    if (Number.isFinite(rating) && rating > 0) {
      deal.rating = round2(rating);
      deal.ratingSource = "bestbuy-api";
      const reviews = Number(p.customerReviewCount);
      if (Number.isFinite(reviews) && reviews > 0) deal.ratingCount = reviews;
    }
    out.push(deal);
  }
  // same relevance / real-discount filtering and ranking as Newegg results
  return finalizeDealList(out, query);
}

// ---------------------------------------------------------------- Newegg
async function searchViaMcpApi(query) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "newegg product search",
      arguments: {
        query,
        page: 1,
        order: 8, // Featured — closest to site default search
      },
    },
  };

  const res = await fetch(NEWEGG_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
      Origin: "https://www.newegg.com",
      Referer: "https://www.newegg.com/",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Newegg MCP HTTP ${res.status}`);
  const rpc = await res.json();
  if (rpc.error) throw new Error(rpc.error.message || "Newegg MCP error");
  const text = rpc?.result?.content?.[0]?.text;
  if (typeof text !== "string" || !text) throw new Error("Newegg MCP empty");
  const page = JSON.parse(text);
  const products = Array.isArray(page.products) ? page.products : [];
  return mapApiProducts(products, query);
}

function mapApiProducts(products, query) {
  const seen = new Set();
  const out = [];

  for (const p of products) {
    if (!p || typeof p !== "object") continue;
    const title = String(p.WebDescription || "").trim();
    if (!title || title.length < 4) continue;
    if (!titleMatchesQuery(title, query)) continue;

    const itemNumber = String(p.ItemNumber || "").trim();
    if (!itemNumber) continue;

    // Skip clearly unavailable when LimitQuantity is explicitly 0
    if (p.LimitQuantity === 0) continue;

    const priceInfo = p.Price || {};
    const price = Number(priceInfo.FinalPrice);
    if (!Number.isFinite(price) || price < MIN_PRICE) continue;

    const sku = itemNumberToSku(itemNumber);
    if (seen.has(sku)) continue;
    seen.add(sku);

    let previousPrice = null;
    const rebate = Number(priceInfo.InstantRebateAmount);
    if (Number.isFinite(rebate) && rebate > 0) {
      previousPrice = round2(price + rebate);
    } else {
      const savePct = Number(priceInfo.PriceSavePercent);
      if (Number.isFinite(savePct) && savePct > 0 && savePct < 90) {
        previousPrice = round2(price / (1 - savePct / 100));
      }
    }
    if (previousPrice != null && previousPrice <= price) previousPrice = null;

    const image = imageUrlFromName(p.ImageName);
    const category = inferCategory(title, query) || "Other";
    const id = slugify(title, sku);
    const url = productUrlFromItem(itemNumber, sku);

    const deal = {
      id: "live-" + id,
      name: title,
      price: round2(price),
      previousPrice,
      url,
      urlKind: "product",
      merchant: "Newegg",
      image: image || null,
      category,
      currency: priceInfo.CurrencyCode === "USD" || !priceInfo.CurrencyCode ? "USD" : String(priceInfo.CurrencyCode),
      sku,
      source: "live",
      why: whyLine(price, previousPrice, "Newegg"),
    };

    const rating = Number(priceInfo.RatingOneDecimal);
    if (Number.isFinite(rating) && rating > 0) {
      deal.rating = round2(rating);
      deal.ratingSource = "newegg-mcp-api";
      const reviews = Number(priceInfo.HumanRating);
      if (Number.isFinite(reviews) && reviews > 0) deal.ratingCount = reviews;
    }

    out.push(deal);
    if (out.length >= RESULT_LIMIT) break;
  }

  // Prefer classic Newegg catalog SKUs when sorting the limited set
  out.sort((a, b) => {
    const aN = /^N82E168/i.test(a.sku) ? 1 : 0;
    const bN = /^N82E168/i.test(b.sku) ? 1 : 0;
    return bN - aN;
  });
  return finalizeDealList(out, query);
}

function itemNumberToSku(itemNumber) {
  const cleaned = String(itemNumber).replace(/-/g, "");
  if (/^\d{8,}$/.test(cleaned)) return ("N82E168" + cleaned).toUpperCase();
  return String(itemNumber).toUpperCase();
}

function productUrlFromItem(itemNumber, sku) {
  if (/^N82E168/i.test(sku)) {
    return "https://www.newegg.com/p/" + sku;
  }
  return "https://www.newegg.com/p/" + itemNumber;
}

function imageUrlFromName(name) {
  if (!name || typeof name !== "string") return null;
  const clean = name.replace(/^\/+/, "");
  if (!clean) return null;
  if (/^https?:\/\//i.test(clean)) return clean;
  return "https://c1.neweggimages.com/ProductImageCompressAll300/" + clean;
}

async function searchViaHtml(query) {
  const searchUrl = "https://www.newegg.com/p/pl?d=" + encodeURIComponent(query);
  const res = await fetch(searchUrl, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Newegg HTML HTTP ${res.status}`);
  const html = await res.text();
  if (!html || html.length < 500) throw new Error("Empty Newegg HTML");
  return parseSearchHtml(html, query);
}

function parseSearchHtml(html, query) {
  const containers = [];
  const re = /class="item-container[^"]*"([\s\S]*?)(?=class="item-container|<\/html>)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    containers.push(m[1]);
    if (containers.length > 60) break;
  }

  const seen = new Set();
  const parsed = [];

  for (const cell of containers) {
    const product = extractProductUrl(cell);
    if (!product) continue;
    const { url, sku } = product;
    if (seen.has(sku)) continue;
    if (/\bout\s*of\s*stock\b/i.test(cell) && !/add to cart/i.test(cell)) continue;

    const title = extractTitle(cell);
    if (!title || title.length < 4) continue;
    const price = extractPrice(cell);
    if (price == null || price < MIN_PRICE) continue;

    const previousPrice = extractWasPrice(cell, price);
    const image = extractImage(cell);
    const rating = extractRating(cell);
    const category = inferCategory(title, query) || "Other";
    const id = slugify(title, sku);

    const deal = {
      id: "live-" + id,
      name: title,
      price,
      previousPrice: previousPrice != null ? previousPrice : null,
      url,
      urlKind: "product",
      merchant: "Newegg",
      image: image || null,
      category,
      currency: "USD",
      sku,
      source: "live",
      why: whyLine(price, previousPrice, "Newegg"),
    };
    if (rating && Number.isFinite(rating.value) && rating.value > 0) {
      deal.rating = rating.value;
      if (rating.count != null) deal.ratingCount = rating.count;
      deal.ratingSource = "newegg-search-card";
    }

    seen.add(sku);
    parsed.push(deal);
    if (parsed.length >= RESULT_LIMIT) break;
  }

  return finalizeDealList(parsed, query);
}

function extractProductUrl(cell) {
  let m = cell.match(
    /href="(https:\/\/www\.newegg\.com\/[^"]+\/p\/(N82E168[0-9A-Z]+))"/i
  );
  if (m) return { url: m[1].split("?")[0], sku: m[2].toUpperCase() };
  m = cell.match(/href="(https:\/\/www\.newegg\.com\/p\/([A-Z0-9-]+))"/i);
  if (m) {
    const sku = m[2].toUpperCase();
    if (/^(N82E168|9SI|[0-9]{2}[A-Z0-9-]+)/i.test(sku) || sku.length >= 6) {
      return { url: m[1].split("?")[0], sku };
    }
  }
  m = cell.match(
    /href="(https:\/\/www\.newegg\.com\/[^"#?]+\/p\/([A-Z0-9-]{6,}))"/i
  );
  if (m) return { url: m[1].split("?")[0], sku: m[2].toUpperCase() };
  return null;
}

function extractTitle(cell) {
  let m = cell.match(/<img[^>]+(?:title|alt)="([^"]+)"/i);
  if (m) return decodeHtml(m[1]).trim();
  m = cell.match(/class="item-title"[^>]*>([\s\S]*?)<\/a>/i);
  if (m) return decodeHtml(m[1].replace(/<[^>]+>/g, "")).trim();
  return null;
}

function extractPrice(cell) {
  let m = cell.match(
    /price-current[^>]*>[\s\S]*?<strong>([0-9,]+)<\/strong>\s*<sup>\.?([0-9]+)<\/sup>/i
  );
  if (m) {
    const n = parseFloat(m[1].replace(/,/g, "") + "." + m[2]);
    return Number.isFinite(n) ? round2(n) : null;
  }
  m = cell.match(/price-current[^>]*>[\s\S]*?\$[\s]*([0-9,]+(?:\.[0-9]+)?)/i);
  if (m) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    return Number.isFinite(n) ? round2(n) : null;
  }
  return null;
}

function extractWasPrice(cell, current) {
  const m = cell.match(/price-was[^>]*>[\s\S]*?\$[\s]*([0-9,]+(?:\.[0-9]+)?)/i);
  if (!m) return null;
  const was = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(was) || was <= current) return null;
  return round2(was);
}

function extractImage(cell) {
  const m = cell.match(
    /<img[^>]+src="(https:\/\/(?:c\d+\.)?neweggimages\.com\/[^"]+)"/i
  );
  if (m) return m[1].replace(/&amp;/g, "&");
  const m2 = cell.match(
    /<img[^>]+src="(https:\/\/[^"]+newegg[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i
  );
  if (m2) return m2[1].replace(/&amp;/g, "&");
  return null;
}

function extractRating(cell) {
  let value = null;
  let m = cell.match(/aria-label="rated\s+([0-9.]+)\s+out\s+of\s+5"/i);
  if (m) value = parseFloat(m[1]);
  if (value == null) {
    m = cell.match(/class="rating\s+rating-([0-9]+)"/i);
    if (m) value = parseFloat(m[1]);
  }
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  let count = null;
  m = cell.match(/class="item-rating-num"[^>]*>\(?\s*([0-9,]+)\s*\)?</i);
  if (m) {
    const c = parseInt(m[1].replace(/,/g, ""), 10);
    if (Number.isFinite(c)) count = c;
  }
  return { value: round2(value), count };
}



/** Query tokens + brand/product aliases so "Samsung" matches Galaxy titles. */
const QUERY_ALIASES = {
  samsung: ["samsung", "galaxy", "odyssey"],
  microsoft: ["microsoft", "surface", "xbox"],
  apple: ["apple", "iphone", "ipad", "macbook", "imac", "airpods"],
  iphone: ["iphone", "apple"],
  ipad: ["ipad", "apple"],
  google: ["google", "pixel"],
  sony: ["sony", "playstation", "ps5", "wh-1000"],
  logitech: ["logitech", "logi"],
  nvidia: ["nvidia", "geforce", "rtx", "gtx"],
  amd: ["amd", "radeon", "ryzen"],
  intel: ["intel", "core ultra", "core i"],
  lg: ["lg", "gram"],
  asus: ["asus", "rog", "tuf", "zenbook"],
  acer: ["acer", "predator", "nitro"],
  dell: ["dell", "alienware", "xps"],
  hp: ["hp", "omen", "hyperx"],
  lenovo: ["lenovo", "thinkpad", "legion", "yoga"],
  corsair: ["corsair"],
  razer: ["razer"],
  wacom: ["wacom"],
  klipsch: ["klipsch"],
  svs: ["svs"],
  // Category / product-type shorthand — titles rarely say "GPU" literally.
  gpu: ["gpu", "graphics card", "geforce", "radeon", "rtx", "gtx", "intel arc"],
  gpus: ["gpu", "graphics card", "geforce", "radeon", "rtx", "gtx", "intel arc"],
  graphics: ["graphics card", "geforce", "radeon", "rtx", "gtx"],
  card: ["graphics card", "geforce", "radeon"],
  cpu: ["cpu", "processor", "ryzen", "core i", "core ultra", "threadripper"],
  cpus: ["cpu", "processor", "ryzen", "core i", "core ultra", "threadripper"],
  processor: ["processor", "cpu", "ryzen", "core i", "core ultra"],
  ram: ["ram", "ddr4", "ddr5", "ddr", "dimm", "desktop memory"],
  memory: ["ddr4", "ddr5", "desktop memory", "system memory", "dimm"],
  ssd: ["ssd", "nvme", "solid state"],
  ssds: ["ssd", "nvme", "solid state"],
  nvme: ["nvme", "ssd"],
  headset: ["headset", "headphones", "headphone"],
  headphones: ["headphones", "headset", "headphone"],
  headphone: ["headphone", "headphones", "headset"],
  mouse: ["mouse", "mice"],
  mice: ["mice", "mouse"],
  keyboard: ["keyboard", "keyboards"],
  keyboards: ["keyboards", "keyboard"],
  laptop: ["laptop", "notebook", "macbook", "chromebook"],
  laptops: ["laptop", "notebook", "macbook", "chromebook"],
  notebook: ["notebook", "laptop"],
  xbox: ["xbox"],
  playstation: ["playstation", "ps5", "ps4"],
  ps5: ["ps5", "playstation"],
  console: ["console", "xbox", "playstation", "switch"],
  psu: ["psu", "power supply"],
  psus: ["psu", "power supply"],
  monitor: ["monitor", "ultrawide"],
  monitors: ["monitor", "ultrawide"],
};

function tokenizeQuery(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function expandQueryTokens(query) {
  const tokens = tokenizeQuery(query);
  const out = new Set();
  for (const t of tokens) {
    out.add(t);
    const aliases = QUERY_ALIASES[t];
    if (aliases) aliases.forEach((a) => out.add(a));
  }
  return [...out];
}

function getQueryIntent(query) {
  const q = String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();
  if (!q) return null;
  if (/^(gpu|gpus)$/.test(q) || /^graphics\s+cards?$/.test(q)) return "gpus";
  if (/^(cpu|cpus|processor|processors)$/.test(q)) return "cpus";
  if (/^(ram|ddr4|ddr5|ddr)$/.test(q) || /^desktop\s+memory$/.test(q)) return "ram";
  if (/^(ssd|ssds|nvme)$/.test(q) || /^solid\s+state/.test(q)) return "ssds";
  if (/^(laptop|laptops|notebook|notebooks|macbook|chromebook)$/.test(q)) return "laptops";
  if (/^(prebuilt|prebuilts)$/.test(q) || /^pre\s*built/.test(q) || /^(gaming\s+)?desktops?$/.test(q) || /^gaming\s+pcs?$/.test(q)) return "prebuilts";
  if (/^(mouse|mice)$/.test(q)) return "mice";
  if (/^(keyboard|keyboards)$/.test(q)) return "keyboards";
  if (/^(headset|headsets|headphone|headphones)$/.test(q)) return "headset";
  if (/^(psu|psus)$/.test(q) || /^power\s+supply/.test(q)) return "psus";
  if (/^(case|cases|chassis)$/.test(q) || /^pc\s+case/.test(q)) return "cases";
  if (/^(monitor|monitors|ultrawide)$/.test(q)) return "monitors";
  if (/^(motherboard|motherboards|mobo|mobos)$/.test(q)) return "motherboards";
  if (/^(phone|phones|iphone|smartphone)$/.test(q)) return "phones";
  if (/^(tv|tvs|television)$/.test(q)) return "tvs";
  if (/^(xbox|playstation|ps5|ps4|console|consoles|switch|controller|controllers|gamepad)$/.test(q))
    return "console";
  return null;
}

function titleLooksLikeIntent(title, intent) {
  const hay = String(title || "").toLowerCase().replace(/\s+/g, " ");
  if (!hay || !intent) return false;
  if (intent === "gpus") {
    // Exclude laptops / cases / brackets that merely mention a GPU.
    if (/\b(laptop|notebook|chromebook|macbook|headset|headphones|mouse\b|keyboard|prebuilt|desktop\s*(pc|computer)|gaming\s*pc\b|anti-?sag|pc\s*case|mid-?tower|computer\s*case|gpu\s*bracket|gpu\s*support|gpu\s*riser)\b/i.test(hay))
      return false;
    if (/\b(geforce|radeon|rtx\s*\d|gtx\s*\d|graphics\s*card|intel\s*arc|arc\s*a\d{3})\b/i.test(hay))
      return true;
    // Bare "gpu" only when it looks like a card, not an accessory.
    return /\bgpu\b/i.test(hay) && !/\b(arm|bracket|support|holder|riser|cable|adapter)\b/i.test(hay);
  }
  if (intent === "cpus") {
    if (!/\b(ryzen|core\s*ultra|core\s*i[3579]|threadripper|\bcpu\b|processor)\b/i.test(hay)) return false;
    if (/\b(laptop|notebook|motherboard|graphics\s*card|gpu)\b/i.test(hay)) return false;
    return true;
  }
  if (intent === "ram") {
    if (!/\b(ddr[45]|sodimm|udimm|\bdimm\b|desktop\s*memory|pc\s*ram|system\s*memory|288-?pin)\b/i.test(hay))
      return false;
    if (/\b(laptop|notebook|chromebook|headset|headphones|memory\s*foam|ssd|console|controller|motherboard|\bmobo\b)\b/i.test(hay))
      return false;
    return true;
  }
  if (intent === "ssds") {
    if (!/\b(ssd|nvme|solid\s*state)\b/i.test(hay)) return false;
    // Whole laptops that list an SSD capacity are not SSD products.
    if (/\b(laptop|notebook|chromebook|macbook)\b/i.test(hay)) return false;
    if (/\b(xbox|playstation|console)\b/i.test(hay) && !/\b(external|portable)\s*ssd\b/i.test(hay))
      return false;
    return true;
  }
  if (intent === "laptops") {
    return /\b(laptop|notebook|macbook|chromebook)\b/i.test(hay);
  }
  if (intent === "prebuilts") {
    if (/\b(laptop|notebook|chromebook|macbook|motherboard|pc\s*case|computer\s*case)\b/i.test(hay)) return false;
    return /\b(pre-?built|(gaming|gamer)\s+(desktop|pc|computer)|gaming\s+desktop|desktop\s+(pc|computer)|gaming\s+tower)\b/i.test(hay);
  }
  if (intent === "mice") {
    if (!/\b(mouse|mice)\b/i.test(hay)) return false;
    if (/\b(mouse\s*pad|mousepad|keyboard\s*and\s*mouse\s*combo)\b/i.test(hay) && !/\bmouse\b/i.test(hay))
      return false;
    return true;
  }
  if (intent === "keyboards") {
    return /\b(keyboard|keychron|keycaps)\b/i.test(hay);
  }
  if (intent === "headset") {
    return /\b(headset|headphones?|earbuds?|earphones?)\b/i.test(hay);
  }
  if (intent === "psus") {
    return /\b(psu|power\s*supply)\b/i.test(hay);
  }
  if (intent === "cases") {
    return /\b((mid|full|mini)[\s-]?tower|pc\s*case|computer\s*case|atx\s*case|gaming\s*case|chassis)\b/i.test(hay);
  }
  if (intent === "monitors") {
    return /\b(monitor|ultrawide|gaming\s*display)\b/i.test(hay) && !/\blaptop\b/i.test(hay);
  }
  if (intent === "motherboards") {
    return /\b(motherboard|mobo|b650|x670|b850|z790|b760|x870)\b/i.test(hay);
  }
  if (intent === "phones") {
    return /\b(iphone|pixel|galaxy|smartphone|\bphone\b)\b/i.test(hay) && !/\b(headphone|microphone|phone\s*case)\b/i.test(hay);
  }
  if (intent === "tvs") {
    return /\b(\d{2,3}["']?\s*(inch\s*)?tv|oled\s*tv|qled|television)\b/i.test(hay);
  }
  if (intent === "console") {
    // Avoid bare "console" (TVs say "PC/console living rooms") and accessories
    // (Xbox-compatible headsets/skins should not count as console hits).
    if (/\b(headset|headphones?|earbuds?|earphones?|stand|mount|holder|skin|cover|charger|charging\s*dock|cable)\b/i.test(hay)) {
      return false;
    }
    return /\b(xbox|playstation|\bps[45]\b|nintendo\s*switch|(?:gaming|game|video\s*game)\s*console|wireless\s*controller|game\s*controller|gamepad)\b/i.test(hay);
  }
  return false;
}

function titleMatchesQuery(title, query) {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return false;
  const hay = String(title || "").toLowerCase().replace(/\s+/g, " ");
  if (!hay) return false;
  const intent = getQueryIntent(query);

  // Category-ish queries: product must BE that thing, not merely mention a token.
  if (intent) {
    return titleLooksLikeIntent(hay, intent);
  }

  const hayCompact = hay.replace(/[^a-z0-9]+/g, "");
  // Every original token must match either itself or one of its aliases in the title.
  for (const t of tokens) {
    const opts = QUERY_ALIASES[t] || [t];
    const hit = opts.some((opt) => {
      const escaped = opt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp("(^|[^a-z0-9])" + escaped, "i").test(hay)) return true;
      // Compact match: "rtx4070" in "rtx 4070" / "rtx-4070"
      const compact = opt.replace(/[^a-z0-9]+/g, "");
      return compact.length >= 2 && hayCompact.includes(compact);
    });
    if (!hit) return false;
  }
  // Keep model families tight: "4070" should not rank "4070 Ti / Super" first unless asked.
  const qLow = String(query || "").toLowerCase();
  const hayLow = hay;
  const modelNums = tokens.filter((t) => /^\d{3,4}$/.test(t));
  for (const num of modelNums) {
    const askedTi = /\bti\b/.test(qLow) || qLow.includes(num + "ti");
    const askedSuper = /\bsuper\b/.test(qLow);
    const titleHasTi = new RegExp(num + "\\s*ti\\b|" + num + "ti", "i").test(hayLow);
    const titleHasSuper = new RegExp(num + "[\\s-]*super\\b", "i").test(hayLow);
    if (titleHasTi && !askedTi) return false;
    if (titleHasSuper && !askedSuper && !askedTi) return false;
  }
  return true;
}

function relevanceScore(title, query) {
  const hay = String(title || "").toLowerCase();
  const tokens = tokenizeQuery(query);
  if (!tokens.length || !hay) return 0;
  let score = 0;
  const intent = getQueryIntent(query);
  if (intent && titleLooksLikeIntent(hay, intent)) score += 30;
  for (const t of tokens) {
    const opts = QUERY_ALIASES[t] || [t];
    let best = 0;
    for (const opt of opts) {
      if (hay.includes(opt)) {
        best = Math.max(best, opt === t ? 12 : 8);
        if (hay.startsWith(opt) || new RegExp("(^|\\s)" + opt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(hay)) {
          best += 4;
        }
      }
    }
    score += best;
  }
  return score;
}

function isRealDeal(price, previousPrice) {
  if (!Number.isFinite(price) || price < MIN_PRICE) return false;
  if (!Number.isFinite(previousPrice) || previousPrice <= price) return false;
  const save = previousPrice - price;
  const pct = (save / previousPrice) * 100;
  return save >= MIN_DEAL_SAVE && pct >= MIN_DEAL_PCT;
}

function normalizeTitleStem(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/sponsored\s*ad\s*-?\s*/g, " ")
    .replace(/\([^)]{0,40}\)/g, " ")
    .replace(
      /\b(black|white|red|blue|green|pink|purple|orange|yellow|grey|gray|silver|gold|space\s*gray|graphite|midnight|starlight|obsidian)\b/g,
      " "
    )
    .replace(/\b(wired|wireless|bluetooth|rgb|edition|series|gaming|new|renewed)\b/g, " ")
    .replace(/[^a-z0-9+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
}

function pricesNear(a, b) {
  const pa = Number(a);
  const pb = Number(b);
  if (!Number.isFinite(pa) || !Number.isFinite(pb)) return false;
  const diff = Math.abs(pa - pb);
  const base = Math.max(pa, pb);
  return diff <= 8 || (base > 0 && diff / base <= 0.08);
}

function finalizeDealList(deals, query) {
  const seenIds = new Set();
  const kept = [];
  const scored = [];
  for (const deal of deals || []) {
    if (!deal || !deal.name || !deal.url) continue;
    if (!titleMatchesQuery(deal.name, query)) continue;
    const price = Number(deal.price);
    const prev = Number(deal.previousPrice);
    if (!isRealDeal(price, prev)) continue;
    const idKey = String(deal.sku || deal.url || deal.id).toLowerCase();
    if (seenIds.has(idKey)) continue;
    seenIds.add(idKey);

    const stem = normalizeTitleStem(deal.name);
    const dup = kept.find(
      (k) => k.stem === stem && pricesNear(k.deal.price, price)
    );
    if (dup) {
      // Keep the stronger discount / longer name.
      const dupSave = Number(dup.deal.previousPrice) - Number(dup.deal.price);
      const save = prev - price;
      if (save > dupSave || (save === dupSave && deal.name.length > dup.deal.name.length)) {
        dup.deal = deal;
        dup.stem = stem;
        dup.rel = relevanceScore(deal.name, query);
        dup.savePct = (save / prev) * 100;
        dup.save = save;
      }
      continue;
    }

    const rel = relevanceScore(deal.name, query);
    const savePct = ((prev - price) / prev) * 100;
    const row = { deal, rel, savePct, save: prev - price, stem };
    kept.push(row);
    scored.push(row);
  }
  scored.sort((a, b) => {
    if (b.rel !== a.rel) return b.rel - a.rel;
    if (b.savePct !== a.savePct) return b.savePct - a.savePct;
    return b.save - a.save;
  });
  return scored.slice(0, RESULT_LIMIT).map((x) => x.deal);
}


function inferCategory(text, query) {
  // Prefer classifying the product title; fall back to the query intent.
  const title = String(text || "");
  const q = String(query || "");
  for (const h of CATEGORY_HINTS) {
    if (h.re.test(title)) return h.cat;
  }
  const intent = getQueryIntent(q || title);
  const intentToCat = {
    gpus: "GPUs",
    cpus: "CPUs",
    ram: "RAM",
    ssds: "SSDs",
    laptops: "Laptops",
    prebuilts: "Prebuilts",
    mice: "Mice",
    keyboards: "Keyboards",
    headset: "Home Theater",
    psus: "PSUs",
    cases: "Cases",
    monitors: "Monitors",
    motherboards: "Motherboards",
    phones: "Phones",
    tvs: "TVs",
    console: "Other",
  };
  if (intent && intentToCat[intent]) return intentToCat[intent];
  for (const h of CATEGORY_HINTS) {
    if (h.re.test(q)) return h.cat;
  }
  return null;
}

function slugify(title, sku) {
  const base = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .replace(/-$/g, "");
  const short = String(sku || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(-8);
  return (base || "item") + (short ? "-" + short : "");
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function formatMoney(n) {
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function whyLine(price, previousPrice, merchant) {
  const who = merchant || "retailer";
  if (previousPrice != null && previousPrice > price) {
    return (
      "Live " +
      who +
      " listing at $" +
      formatMoney(price) +
      " (was $" +
      formatMoney(previousPrice) +
      "). Confirm the cart total before buying."
    );
  }
  return (
    "Live " +
    who +
    " listing at $" +
    formatMoney(price) +
    ". Confirm the cart total before buying."
  );
}
