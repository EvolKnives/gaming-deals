/**
 * Live Search Worker — Newegg search → deal-shaped JSON.
 * Never invents prices/ratings/dates. Only values from Newegg responses.
 *
 * Primary: Newegg public MCP product-search JSON API (works from CF IPs).
 * Fallback: HTML search page scrape (works from residential / wrangler dev).
 */

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
const RESULT_LIMIT = 16;
const MIN_PRICE = 15;
const CACHE_TTL_SECONDS = 90;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_IP = 30;

const rateBuckets = new Map();

const CATEGORY_HINTS = [
  { re: /\b(rtx|gtx|radeon|gpu|graphics\s*card|geforce)\b/i, cat: "GPUs" },
  { re: /\b(ryzen|core\s*i[3579]|cpu|processor|threadripper)\b/i, cat: "CPUs" },
  { re: /\b(monitor|ultrawide|gaming\s*display)\b/i, cat: "Monitors" },
  { re: /\b(\d{2,3}["']?\s*(inch\s*)?tv|oled\s*tv|qled|television)\b/i, cat: "TVs" },
  { re: /\b(soundbar|receiver|speaker|klipsch|home\s*theater|subwoofer)\b/i, cat: "Home Theater" },
  { re: /\b(wacom|drawing\s*tablet|pen\s*display|art\s*tablet)\b/i, cat: "Art Tablets" },
  { re: /\b(psu|power\s*supply|modular\s*psu)\b/i, cat: "PSUs" },
  { re: /\b(case|chassis|tower|mid.?tower)\b/i, cat: "Cases" },
  { re: /\b(motherboard|mobo|b650|x670|b850|z790|b760|x870)\b/i, cat: "Motherboards" },
  { re: /\b(ddr[45]|memory|ram\b|dimm)\b/i, cat: "RAM" },
  { re: /\b(ssd|nvme|solid.?state)\b/i, cat: "SSDs" },
  { re: /\b(iphone|pixel|galaxy|smartphone|phone)\b/i, cat: "Phones" },
  { re: /\b(macbook|laptop|notebook|chromebook)\b/i, cat: "Laptops" },
  { re: /\b(mouse|mice|g502|deathadder)\b/i, cat: "Mice" },
  { re: /\b(keyboard|keychron|mechanical\s*key)\b/i, cat: "Keyboards" },
];

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
      `https://gaming-deals-search.cache/v2/search?q=${encodeURIComponent(q.toLowerCase())}`,
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
      const { deals, via } = await searchNewegg(q);
      const payload = {
        ok: true,
        query: q,
        source: "live",
        via,
        merchant: "Newegg",
        count: deals.length,
        deals,
      };
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
};

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

async function searchNewegg(query) {
  const errors = [];
  // API first — usually works from Cloudflare egress (HTML search is often 403).
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

  throw new Error(errors.join(" | ") || "no results");
}

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
  const queryCat = inferCategory(query, query);
  const seen = new Set();
  const out = [];

  for (const p of products) {
    if (!p || typeof p !== "object") continue;
    const title = String(p.WebDescription || "").trim();
    if (!title || title.length < 4) continue;

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
    const category = queryCat || inferCategory(title, "") || "Other";
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
      why: whyLine(price, previousPrice),
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
  return out.slice(0, RESULT_LIMIT);
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

  const queryCat = inferCategory(query, query);
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
    const category = queryCat || inferCategory(title, "") || "Other";
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
      why: whyLine(price, previousPrice),
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

  parsed.sort((a, b) => {
    const aNewegg = /^N82E168/i.test(a.sku) ? 1 : 0;
    const bNewegg = /^N82E168/i.test(b.sku) ? 1 : 0;
    return bNewegg - aNewegg;
  });
  return parsed.slice(0, RESULT_LIMIT);
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

function inferCategory(text, query) {
  const hay = `${query || ""} ${text || ""}`;
  for (const h of CATEGORY_HINTS) {
    if (h.re.test(hay)) return h.cat;
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

function whyLine(price, previousPrice) {
  if (previousPrice != null && previousPrice > price) {
    return (
      "Live Newegg listing at $" +
      formatMoney(price) +
      " (was $" +
      formatMoney(previousPrice) +
      "). Confirm the cart total before buying."
    );
  }
  return (
    "Live Newegg listing at $" +
    formatMoney(price) +
    ". Confirm the cart total before buying."
  );
}
