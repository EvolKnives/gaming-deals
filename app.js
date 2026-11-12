(function () {
  "use strict";

  var dealsEl = document.getElementById("deals");
  var statusEl = document.getElementById("status");
  var weekLabelEl = document.getElementById("week-label");
  var headerEl = document.getElementById("site-header");
  var filtersEl = document.getElementById("filters");
  var filterButtonsEl = document.getElementById("filter-buttons");
  var searchPanelEl = document.getElementById("search-panel");
  var searchInputEl = document.getElementById("deal-search");
  var searchClearEl = document.getElementById("deal-search-clear");
  var searchRecentEl = document.getElementById("search-recent");
  var toastEl = document.getElementById("toast");
  var lightboxEl = document.getElementById("lightbox");
  var lightboxImg = document.getElementById("lightbox-img");
  var lightboxClose = document.getElementById("lightbox-close");
  var pullRefreshEl = document.getElementById("pull-refresh");
  var pullRefreshLabelEl = document.getElementById("pull-refresh-label");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var toastTimer = null;
  var lightboxOpen = false;
  var allDeals = [];
  var BUILDS_MODE = "Builds"; // tab of complete PCs from data/builds.json
  var VALUE_MODE = "Best Value"; // performance-per-dollar rankings, data/value.json
  var valueData = null;
  var valueKind = "gpu";
  var valueRankById = {}; // deal id → rank in the Best Value top 10 (badge on cards)
  var SAVED_MODE = "Saved"; // deals the visitor saved on this device (localStorage)
  var CARDS_PER_PAGE = 36;
  var dealsRenderSeq = 0;
  var dealsPager = null;
  var allBuilds = null;
  var partsCatalog = null; // data/parts-catalog.json, loaded when "Build your own" opens
  var buildsView = storeGet("buildsView") === "custom" ? "custom" : "recommended";
  var customPick = readCustomPick();
  var activeFilter = "All";
  var activeBudget = "All";
  var activeSort = "savings";
  var SEARCH_MODE = "Search";
  var SEARCH_STORAGE_KEY = "wagd-search-state";
  var MAX_RECENT_SEARCHES = 6;
  var searchQuery = "";
  var recentSearches = [];
  var searchDebounceTimer = null;
  var siteUpdatedAt = null;
  var lastDealsFetchAt = 0;
  var VISIBILITY_REFRESH_MS = 5 * 60 * 1000;
  var loadingDeals = false;
  var pullStartY = 0;
  var pullStartX = 0;
  var pullDistance = 0;
  var pullTracking = false;
  var pullReady = false;
  var SITE_TITLE = "What's A Good Deal?";

  // Live search is off: Newegg blocks the Worker and Best Buy's API needs a
  // business email. Search filters the site's own deals instead. To turn it
  // back on, set this to "https://gaming-deals-search.evolknives.workers.dev"
  // (the Worker still uses Best Buy if a BESTBUY_API_KEY secret is added).
  var LIVE_SEARCH_URL = "";
  var LIVE_SEARCH_MIN_CHARS = 2;
  var LIVE_SEARCH_DEBOUNCE_MS = 300;
  var liveSearchDeals = [];
  var lastSearchShown = { total: 0, live: 0, catalogue: 0 };
  var liveSearchQuery = "";
  var liveSearchLoading = false;
  var liveSearchError = "";
  var liveSearchTimer = null;
  var liveSearchAbort = null;
  var liveSearchSeq = 0;
  var searchLiveStatusEl = null;

  // Canonical plural filter labels (never apostrophe plurals).
  // Fixed tabs first (Search, All, Builds, Future), then product types A–Z.
  var CATEGORY_ORDER = [
    "All",
    "Future",
    "Art Tablets",
    "AV Receivers",
    "Cables",
    "Cases",
    "Charging",
    "Computer Speakers",
    "Controllers",
    "Coolers",
    "CPUs",
    "Earbuds",
    "Gaming Headsets",
    "GPUs",
    "Headphones",
    "Hi-Fi Speakers",
    "Keyboards",
    "Laptops",
    "Mice",
    "Microphones",
    "Monitors",
    "Motherboards",
    "Networking",
    "Phones",
    "Prebuilts",
    "PSUs",
    "RAM",
    "Soundbars",
    "SSDs",
    "Storage",
    "Subwoofers",
    "Tablets",
    "TVs",
    "Webcams",
    "Wireless Speakers"
  ];
  var CATEGORY_ALIASES = {
    GPU: "GPUs",
    GPUs: "GPUs",
    CPU: "CPUs",
    CPUs: "CPUs",
    Monitor: "Monitors",
    Monitors: "Monitors",
    TV: "TVs",
    TVs: "TVs",
    "Power Supply": "PSUs",
    PSU: "PSUs",
    PSUs: "PSUs",
    Mouse: "Mice",
    Mice: "Mice",
    Keyboard: "Keyboards",
    Keyboards: "Keyboards",
    "Home Theater": "Soundbars",
    "Home theatre": "Soundbars",
    "Home theatre equipment": "Soundbars",
    HT: "Soundbars",
    Speakers: "Wireless Speakers",
    "Home Speakers": "Hi-Fi Speakers",
    Receivers: "AV Receivers",
    Cable: "Cables",
    "Art Tablets": "Art Tablets",
    "Art Tablet": "Art Tablets",
    "Drawing Tablets": "Art Tablets",
    "Drawing Tablet": "Art Tablets",
    "Pen Displays": "Art Tablets",
    "Pen Display": "Art Tablets",
    Case: "Cases",
    Cases: "Cases",
    Chassis: "Cases",
    "Computer Cases": "Cases",
    "PC Cases": "Cases",
    Motherboard: "Motherboards",
    Motherboards: "Motherboards",
    Mobo: "Motherboards",
    Mobos: "Motherboards",
    RAM: "RAM",
    Memory: "RAM",
    SSD: "SSDs",
    SSDs: "SSDs",
    "Solid State Drives": "SSDs",
    Phone: "Phones",
    Phones: "Phones",
    iPhone: "Phones",
    iPhones: "Phones",
    Smartphone: "Phones",
    Smartphones: "Phones",
    Laptop: "Laptops",
    Laptops: "Laptops",
    Notebook: "Laptops",
    Notebooks: "Laptops",
    MacBook: "Laptops",
    MacBooks: "Laptops",
    Prebuilt: "Prebuilts",
    Prebuilts: "Prebuilts",
    "Prebuilt PC": "Prebuilts",
    "Prebuilt PCs": "Prebuilts",
    "Gaming PC": "Prebuilts",
    "Gaming PCs": "Prebuilts",
    "Gaming Desktop": "Prebuilts",
    "Gaming Desktops": "Prebuilts",
    Desktop: "Prebuilts",
    Desktops: "Prebuilts",
    Headset: "Gaming Headsets",
    Headsets: "Gaming Headsets",
    Headphone: "Headphones",
    Headphones: "Headphones",
    Earbuds: "Earbuds",
    Earphones: "Earbuds",
    Xbox: "Other",
    PlayStation: "Other",
    Console: "Other",
    Controller: "Controllers",
    Controllers: "Controllers",
    Gamepad: "Controllers"
  };

  var BUDGET_OPTIONS = [
    { id: "All", label: "Any price" },
    { id: "under50", label: "Under $50", min: 0, max: 50 },
    { id: "50-150", label: "$50–150", min: 50, max: 150 },
    { id: "150-400", label: "$150–400", min: 150, max: 400 },
    { id: "400plus", label: "$400+", min: 400, max: Infinity }
  ];

  var SORT_OPTIONS = [
    { id: "savings", label: "Best savings" },
    { id: "rating", label: "Top rated" },
    { id: "price-asc", label: "Low to high" },
    { id: "price-desc", label: "High to low" }
  ];

  function normalizeCategory(cat) {
    if (!cat) return "";
    var key = String(cat).trim();
    if (CATEGORY_ALIASES[key]) return CATEGORY_ALIASES[key];
    return key.replace(/\u2019s$/i, "s").replace(/'s$/i, "s");
  }

  function dealSavings(deal) {
    var price = Number(deal && deal.price);
    var prev = Number(deal && deal.previousPrice);
    if (!Number.isFinite(price) || !Number.isFinite(prev) || prev <= price) {
      return null;
    }
    return prev - price;
  }

  function sortBySavingsDesc(list) {
    return list.slice().sort(function (a, b) {
      var sa = dealSavings(a);
      var sb = dealSavings(b);
      var ha = sa != null;
      var hb = sb != null;
      if (ha && hb) {
        if (sb !== sa) return sb - sa;
      } else if (ha !== hb) {
        return ha ? -1 : 1;
      }
      var pa = Number(a && a.price);
      var pb = Number(b && b.price);
      if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb;
      return String((a && a.name) || "").localeCompare(String((b && b.name) || ""));
    });
  }

  function dealRating(deal) {
    var r = Number(deal && deal.rating);
    return Number.isFinite(r) && r > 0 ? r : null;
  }

  function applySort(list, sortId) {
    var mode = sortId || activeSort || "savings";
    if (mode === "price-asc") {
      return list.slice().sort(function (a, b) {
        var pa = Number(a && a.price);
        var pb = Number(b && b.price);
        var ha = Number.isFinite(pa);
        var hb = Number.isFinite(pb);
        if (ha && hb && pa !== pb) return pa - pb;
        if (ha !== hb) return ha ? -1 : 1;
        return String((a && a.name) || "").localeCompare(String((b && b.name) || ""));
      });
    }
    if (mode === "price-desc") {
      return list.slice().sort(function (a, b) {
        var pa = Number(a && a.price);
        var pb = Number(b && b.price);
        var ha = Number.isFinite(pa);
        var hb = Number.isFinite(pb);
        if (ha && hb && pa !== pb) return pb - pa;
        if (ha !== hb) return ha ? -1 : 1;
        return String((a && a.name) || "").localeCompare(String((b && b.name) || ""));
      });
    }
    if (mode === "rating") {
      return list.slice().sort(function (a, b) {
        var ra = dealRating(a);
        var rb = dealRating(b);
        var ha = ra != null;
        var hb = rb != null;
        if (ha && hb && rb !== ra) return rb - ra;
        if (ha !== hb) return ha ? -1 : 1;
        var ca = Number(a && a.ratingCount);
        var cb = Number(b && b.ratingCount);
        if (Number.isFinite(ca) && Number.isFinite(cb) && cb !== ca) return cb - ca;
        var sa = dealSavings(a);
        var sb = dealSavings(b);
        if (sa != null && sb != null && sb !== sa) return sb - sa;
        return String((a && a.name) || "").localeCompare(String((b && b.name) || ""));
      });
    }
    return sortBySavingsDesc(list);
  }

  // All-tab only: round-robin across categories so cards feel fresh.
  // Within each category, keep biggest list/MSRP savings first.
  function interleaveByCategory(list) {
    var buckets = Object.create(null);
    var catOrder = [];
    var i;
    for (i = 0; i < list.length; i++) {
      var deal = list[i];
      var cat = normalizeCategory(deal && deal.category) || "Other";
      if (!buckets[cat]) {
        buckets[cat] = [];
        catOrder.push(cat);
      }
      buckets[cat].push(deal);
    }

    var ordered = [];
    for (i = 0; i < CATEGORY_ORDER.length; i++) {
      var canon = CATEGORY_ORDER[i];
      if (canon !== "All" && buckets[canon]) ordered.push(canon);
    }
    for (i = 0; i < catOrder.length; i++) {
      if (ordered.indexOf(catOrder[i]) === -1) ordered.push(catOrder[i]);
    }

    for (i = 0; i < ordered.length; i++) {
      buckets[ordered[i]] = sortBySavingsDesc(buckets[ordered[i]]);
    }

    var lastPickAt = Object.create(null);
    for (i = 0; i < ordered.length; i++) lastPickAt[ordered[i]] = -1e9;

    var result = [];
    var lastCat = null;
    var remaining = ordered.filter(function (c) {
      return buckets[c].length > 0;
    });

    while (remaining.length) {
      var candidates = remaining.filter(function (c) {
        return c !== lastCat;
      });
      if (!candidates.length) candidates = remaining.slice();

      candidates.sort(function (a, b) {
        if (lastPickAt[a] !== lastPickAt[b]) return lastPickAt[a] - lastPickAt[b];
        return ordered.indexOf(a) - ordered.indexOf(b);
      });

      var pick = candidates[0];
      result.push(buckets[pick].shift());
      lastPickAt[pick] = result.length - 1;
      lastCat = pick;
      remaining = remaining.filter(function (c) {
        return buckets[c].length > 0;
      });
    }

    return result;
  }

  document.documentElement.classList.add("js");

  function formatMoney(n) {
    var num = Number(n);
    if (!Number.isFinite(num)) return "";
    return num.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: num % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function pctOff(price, previous) {
    if (!previous || previous <= price) return null;
    return Math.round(((previous - price) / previous) * 100);
  }

  function savings(price, previous) {
    if (!previous || previous <= price) return null;
    return previous - price;
  }

  function formatUpdated(iso) {
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "Updated recently";
    var diffMs = Date.now() - d.getTime();
    if (diffMs < 0) diffMs = 0;
    var mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "Updated just now";
    if (mins === 1) return "Updated 1 minute ago";
    if (mins < 60) return "Updated " + mins + " minutes ago";
    var hours = Math.floor(mins / 60);
    if (hours === 1) return "Updated 1 hour ago";
    if (hours < 24) return "Updated " + hours + " hours ago";
    var days = Math.floor(hours / 24);
    if (days === 1) return "Updated 1 day ago";
    if (days < 7) return "Updated " + days + " days ago";
    return (
      "Updated " +
      d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "America/Los_Angeles"
      })
    );
  }

  function formatChecked(iso) {
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    var now = Date.now();
    var diffMs = now - d.getTime();
    if (diffMs < 0) diffMs = 0;
    var mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "Checked just now";
    if (mins < 60) return "Checked " + mins + "m ago";
    var hours = Math.floor(mins / 60);
    if (hours < 24) return "Checked " + hours + "h ago";
    var days = Math.floor(hours / 24);
    if (days < 7) return "Checked " + days + "d ago";
    return (
      "Checked " +
      d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "America/Los_Angeles"
      })
    );
  }

  function formatEndsIn(iso) {
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    var ms = d.getTime() - Date.now();
    if (ms <= 0) return "Ended";
    var mins = Math.ceil(ms / 60000);
    if (mins < 60) return "Ends in " + mins + "m";
    var hours = Math.floor(mins / 60);
    if (hours < 48) {
      var remM = mins % 60;
      return remM ? "Ends in " + hours + "h " + remM + "m" : "Ends in " + hours + "h";
    }
    var days = Math.floor(hours / 24);
    if (days < 7) {
      return (
        "Ends " +
        d.toLocaleDateString("en-US", {
          weekday: "short",
          timeZone: "America/Los_Angeles"
        })
      );
    }
    return (
      "Ends " +
      d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "America/Los_Angeles"
      })
    );
  }

  function formatStartsIn(iso) {
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    var ms = d.getTime() - Date.now();
    if (ms <= 0) return "";
    var mins = Math.ceil(ms / 60000);
    if (mins < 60) return "Starts in " + mins + "m";
    var hours = Math.floor(mins / 60);
    if (hours < 48) {
      var remM = mins % 60;
      return remM
        ? "Starts in " + hours + "h " + remM + "m"
        : "Starts in " + hours + "h";
    }
    var days = Math.floor(hours / 24);
    if (days < 7) {
      return (
        "Starts " +
        d.toLocaleDateString("en-US", {
          weekday: "short",
          timeZone: "America/Los_Angeles"
        })
      );
    }
    return (
      "Starts " +
      d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "America/Los_Angeles"
      })
    );
  }

  /** Upcoming promo: startsAt is still in the future, up to 30 days ahead. */
  function isFutureDeal(deal) {
    if (!deal || !deal.startsAt) return false;
    var t = new Date(deal.startsAt).getTime();
    if (Number.isNaN(t)) return false;
    var now = Date.now();
    var day = 24 * 60 * 60 * 1000;
    return t > now && t <= now + 30 * day;
  }

  function endsWithinMs(deal, ms) {
    if (!deal || !deal.endsAt) return false;
    var t = new Date(deal.endsAt).getTime();
    if (Number.isNaN(t)) return false;
    var delta = t - Date.now();
    return delta > 0 && delta <= ms;
  }

  function slugify(str) {
    return (
      String(str || "deal")
        .toLowerCase()
        .replace(/['']/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 56) || "deal"
    );
  }

  function pageUrl(hash) {
    var base = location.origin + location.pathname + location.search;
    return hash ? base + "#" + hash : base.replace(/#$/, "");
  }

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.hidden = false;
    toastEl.textContent = msg;
    toastEl.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("is-on");
      setTimeout(function () {
        if (!toastEl.classList.contains("is-on")) toastEl.hidden = true;
      }, 280);
    }, 1800);
  }

  function pressFlash(el) {
    if (!el || reduceMotion) return;
    el.classList.remove("is-flash");
    void el.offsetWidth;
    el.classList.add("is-flash");
    setTimeout(function () {
      el.classList.remove("is-flash");
    }, 560);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        if (document.execCommand("copy")) resolve();
        else reject(new Error("copy failed"));
      } catch (e) {
        reject(e);
      }
      document.body.removeChild(ta);
    });
  }

  function canNativeShare() {
    return typeof navigator.share === "function";
  }

  function sharePayload(data) {
    var payload = {
      title: data.title || SITE_TITLE,
      text: data.text || "",
      url: data.url || pageUrl()
    };
    if (canNativeShare()) {
      return navigator
        .share(payload)
        .then(function () {
          showToast("Shared");
        })
        .catch(function (err) {
          if (err && err.name === "AbortError") return;
          return copyText(payload.url).then(function () {
            showToast("Link copied");
          });
        });
    }
    return copyText(payload.url).then(function () {
      showToast("Link copied");
    });
  }

  function openLightbox(src, alt) {
    if (!lightboxEl || !lightboxImg || !src) return;
    lightboxImg.src = src;
    lightboxImg.alt = alt || "";
    lightboxEl.hidden = false;
    lightboxEl.removeAttribute("hidden");
    lightboxEl.setAttribute("aria-hidden", "false");
    lightboxOpen = true;
    document.body.style.overflow = "hidden";
    document.body.classList.add("lightbox-open");
    if (lightboxClose) {
      try {
        lightboxClose.focus({ preventScroll: true });
      } catch (e) {
        lightboxClose.focus();
      }
    }
  }

  function closeLightbox() {
    if (!lightboxEl) return;
    lightboxEl.hidden = true;
    lightboxEl.setAttribute("hidden", "");
    lightboxEl.setAttribute("aria-hidden", "true");
    lightboxOpen = false;
    document.body.style.overflow = "";
    document.body.classList.remove("lightbox-open");
    if (lightboxImg) {
      var img = lightboxImg;
      setTimeout(function () {
        if (lightboxOpen) return;
        img.removeAttribute("src");
        img.alt = "";
      }, reduceMotion ? 0 : 280);
    }
  }

  function observeReveal(nodes) {
    if (reduceMotion || !("IntersectionObserver" in window)) {
      nodes.forEach(function (n) {
        n.classList.add("is-visible");
      });
      return;
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            entry.target.classList.remove("will-reveal");
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );
    nodes.forEach(function (n) {
      n.classList.add("will-reveal");
      io.observe(n);
    });
    setTimeout(function () {
      nodes.forEach(function (n) {
        if (!n.classList.contains("is-visible")) {
          n.classList.add("is-visible");
          n.classList.remove("will-reveal");
        }
      });
    }, 1200);
  }

  /** Real check history only — never treat list/MSRP as a trend. */
  function priceHistorySeries(deal) {
    var pts = [];
    var hist = deal && deal.priceHistory;
    if (!Array.isArray(hist) || !hist.length) return pts;
    hist.forEach(function (item) {
      var v = typeof item === "number" ? item : item && item.price;
      var n = Number(v);
      if (Number.isFinite(n) && n > 0) pts.push(n);
    });
    return pts;
  }

  /** Near low only with a real check history (3+ points), or a verified drop since last refresh. */
  function isNearLow(deal) {
    if (deal && deal.priceDropped) return true;
    var series = priceHistorySeries(deal);
    if (series.length < 3) return false;
    var cur = Number(deal && deal.price);
    if (!Number.isFinite(cur)) return false;
    var min = Math.min.apply(null, series);
    if (!Number.isFinite(min) || min <= 0) return false;
    return cur <= min * 1.05;
  }

  /** Static client-side heat from % off + drop size. No voting. */
  function dealHeat(deal) {
    var price = Number(deal && deal.price);
    var prev = Number(deal && deal.previousPrice);
    var pct = pctOff(price, prev) || 0;
    var drop = savings(price, prev) || 0;
    var score = pct + Math.min(30, drop / 15);
    if (deal && deal.priceDropped) score += 6;
    var level;
    var label;
    if (score >= 42) {
      level = "fire";
      label = "Fire";
    } else if (score >= 26) {
      level = "hot";
      label = "Hot";
    } else if (score >= 12) {
      level = "warm";
      label = "Warm";
    } else {
      level = "cool";
      label = "Cool";
    }
    var fill = Math.max(8, Math.min(100, Math.round(score * 1.6)));
    return { level: level, label: label, fill: fill, score: score };
  }

  function dealPromoCode(deal) {
    if (!deal) return "";
    var raw = deal.promoCode || deal.promo || deal.couponCode || deal.code;
    if (raw == null) return "";
    var code = String(raw).trim();
    return code || "";
  }

  function loadSearchState() {
    try {
      var raw = sessionStorage.getItem(SEARCH_STORAGE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (!data || typeof data !== "object") return;
      if (typeof data.query === "string") searchQuery = data.query;
      if (Array.isArray(data.recent)) {
        recentSearches = data.recent
          .filter(function (q) {
            return typeof q === "string" && q.trim();
          })
          .map(function (q) {
            return q.trim();
          })
          .slice(0, MAX_RECENT_SEARCHES);
      }
    } catch (e) {}
  }

  function saveSearchState() {
    try {
      sessionStorage.setItem(
        SEARCH_STORAGE_KEY,
        JSON.stringify({
          query: searchQuery,
          recent: recentSearches
        })
      );
    } catch (e) {}
  }

  function rememberSearchQuery(query) {
    var q = String(query || "").trim();
    if (!q) return;
    recentSearches = [q].concat(
      recentSearches.filter(function (item) {
        return item.toLowerCase() !== q.toLowerCase();
      })
    ).slice(0, MAX_RECENT_SEARCHES);
    saveSearchState();
  }

  function dealSearchBlob(deal) {
    if (!deal) return "";
    return [
      deal.name,
      deal.title,
      deal.brand,
      deal.category,
      deal.merchant,
      deal.why,
      deal.sku,
      deal.urlKind
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function tokenizeQuery(query) {
    return String(query || "")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  }

  var SEARCH_ALIASES = {
    samsung: ["samsung", "galaxy", "odyssey"],
    microsoft: ["microsoft", "surface", "xbox"],
    apple: ["apple", "iphone", "ipad", "macbook", "imac", "airpods"],
    google: ["google", "pixel"],
    sony: ["sony", "playstation", "ps5"],
    nvidia: ["nvidia", "geforce", "rtx", "gtx"],
    amd: ["amd", "radeon", "ryzen"],
    intel: ["intel"],
    lg: ["lg"],
    asus: ["asus", "rog", "tuf"],
    logitech: ["logitech", "logi"],
    wacom: ["wacom"],
    klipsch: ["klipsch"],
    svs: ["svs"],
    gpu: ["gpu", "graphics card", "geforce", "radeon", "rtx", "gtx"],
    gpus: ["gpu", "graphics card", "geforce", "radeon", "rtx", "gtx"],
    graphics: ["graphics card", "geforce", "radeon", "rtx", "gtx"],
    cpu: ["cpu", "processor", "ryzen", "core"],
    cpus: ["cpu", "processor", "ryzen", "core"],
    ram: ["ram", "ddr4", "ddr5", "ddr", "dimm", "desktop memory"],
    memory: ["ddr4", "ddr5", "desktop memory", "dimm"],
    ssd: ["ssd", "nvme", "solid state"],
    ssds: ["ssd", "nvme", "solid state"],
    headset: ["headset", "headphones", "headphone"],
    headphones: ["headphones", "headset", "headphone"],
    mouse: ["mouse", "mice"],
    mice: ["mice", "mouse"],
    keyboard: ["keyboard", "keyboards"],
    keyboards: ["keyboards", "keyboard"],
    laptop: ["laptop", "notebook", "macbook", "chromebook"],
    laptops: ["laptop", "notebook", "macbook", "chromebook"],
    prebuilt: ["prebuilt", "pre-built", "gaming desktop", "gaming pc", "desktop pc"],
    prebuilts: ["prebuilt", "pre-built", "gaming desktop", "gaming pc", "desktop pc"],
    xbox: ["xbox"],
    playstation: ["playstation", "ps5", "ps4"],
    console: ["console", "xbox", "playstation", "switch"],
    psu: ["psu", "power supply"],
    monitor: ["monitor", "ultrawide"]
  };

  function getSearchIntent(query) {
    var q = String(query || "")
      .toLowerCase()
      .replace(/[^a-z0-9+]+/g, " ")
      .trim();
    if (!q) return null;
    if (/^(gpu|gpus)$/.test(q) || /^graphics\s+cards?$/.test(q)) return "GPUs";
    if (/^(cpu|cpus|processor|processors)$/.test(q)) return "CPUs";
    if (/^(ram|ddr4|ddr5|ddr)$/.test(q) || /^desktop\s+memory$/.test(q)) return "RAM";
    if (/^(ssd|ssds|nvme)$/.test(q) || /^solid\s+state/.test(q)) return "SSDs";
    if (/^(laptop|laptops|notebook|notebooks|macbook|chromebook)$/.test(q)) return "Laptops";
    if (/^(prebuilt|prebuilts)$/.test(q) || /^pre\s*built/.test(q) || /^gaming\s+pcs?$/.test(q) || /^(gaming\s+)?desktops?$/.test(q))
      return "Prebuilts";
    if (/^(mouse|mice)$/.test(q)) return "Mice";
    if (/^(keyboard|keyboards)$/.test(q)) return "Keyboards";
    if (/^(headset|headsets)$/.test(q)) return "Gaming Headsets";
    if (/^(headphone|headphones)$/.test(q)) return "Headphones";
    if (/^(psu|psus)$/.test(q) || /^power\s+supply/.test(q)) return "PSUs";
    if (/^(case|cases|chassis)$/.test(q) || /^pc\s+case/.test(q)) return "Cases";
    if (/^(monitor|monitors|ultrawide)$/.test(q)) return "Monitors";
    if (/^(motherboard|motherboards|mobo|mobos)$/.test(q)) return "Motherboards";
    if (/^(phone|phones|iphone|smartphone)$/.test(q)) return "Phones";
    if (/^(tv|tvs|television)$/.test(q)) return "TVs";
    if (/^(xbox|playstation|ps5|ps4|console|consoles|controller|controllers|gamepad)$/.test(q))
      return "Other";
    return null;
  }

  function titleLooksLikeSearchIntent(title, intent) {
    var hay = String(title || "").toLowerCase();
    if (!hay || !intent) return false;
    if (intent === "GPUs") {
      if (/\b(laptop|notebook|chromebook|macbook|headset|headphones|mouse\b|keyboard|prebuilt|desktop\s*(pc|computer)|anti-?sag|pc\s*case|mid-?tower|computer\s*case|gpu\s*bracket|gpu\s*support|gpu\s*riser)\b/i.test(hay))
        return false;
      if (/\b(geforce|radeon|rtx\s*\d|gtx\s*\d|graphics\s*card|intel\s*arc|arc\s*a\d{3})\b/i.test(hay))
        return true;
      return /\bgpu\b/i.test(hay) && !/\b(arm|bracket|support|holder|riser|cable|adapter)\b/i.test(hay);
    }
    if (intent === "CPUs") {
      if (!/\b(ryzen|core\s*ultra|core\s*i[3579]|threadripper|\bcpu\b|processor)\b/i.test(hay)) return false;
      if (/\b(laptop|notebook|motherboard|graphics\s*card)\b/i.test(hay)) return false;
      return true;
    }
    if (intent === "RAM") {
      if (!/\b(ddr[45]|sodimm|udimm|\bdimm\b|desktop\s*memory|pc\s*ram|system\s*memory|288-?pin)\b/i.test(hay))
        return false;
      if (/\b(laptop|notebook|chromebook|headset|headphones|memory\s*foam|ssd|console|motherboard|\bmobo\b)\b/i.test(hay))
        return false;
      return true;
    }
    if (intent === "SSDs") {
      if (!/\b(ssd|nvme|solid\s*state)\b/i.test(hay)) return false;
      if (/\b(laptop|notebook|chromebook|macbook)\b/i.test(hay)) return false;
      return true;
    }
    if (intent === "Laptops") return /\b(laptop|notebook|macbook|chromebook)\b/i.test(hay);
    if (intent === "Prebuilts") {
      if (/\b(laptop|notebook|chromebook|macbook|motherboard|pc\s*case|computer\s*case)\b/i.test(hay)) return false;
      return /\b(pre-?built|(gaming|gamer)\s+(desktop|pc|computer)|gaming\s+desktop|desktop\s+(pc|computer)|gaming\s+tower)\b/i.test(hay);
    }
    if (intent === "Mice") return /\b(mouse|mice)\b/i.test(hay);
    if (intent === "Keyboards") return /\b(keyboard|keychron)\b/i.test(hay);
    if (intent === "Gaming Headsets") return /\b(headset|gaming headphones?)\b/i.test(hay);
    if (intent === "Headphones") return /\b(headphones?|headset)\b/i.test(hay);
    if (intent === "PSUs") return /\b(psu|power\s*supply)\b/i.test(hay);
    if (intent === "Cases")
      return /\b((mid|full|mini)[\s-]?tower|pc\s*case|computer\s*case|atx\s*case|gaming\s*case|chassis)\b/i.test(hay);
    if (intent === "Monitors")
      return /\b(monitor|ultrawide|gaming\s*display)\b/i.test(hay) && !/\blaptop\b/i.test(hay);
    if (intent === "Motherboards")
      return /\b(motherboard|mobo|b650|x670|b850|z790|b760|x870)\b/i.test(hay);
    if (intent === "Phones")
      return /\b(iphone|pixel|galaxy|smartphone|\bphone\b)\b/i.test(hay);
    if (intent === "TVs")
      return /\b(\d{2,3}["']?\s*(inch\s*)?tv|oled\s*tv|qled|television)\b/i.test(hay);
    if (intent === "Other") {
      if (/\b(headset|headphones?|earbuds?|earphones?|stand|mount|holder|skin|cover|charger|charging\s*dock|cable)\b/i.test(hay)) {
        return false;
      }
      return /\b(xbox|playstation|\bps[45]\b|nintendo\s*switch|(?:gaming|game|video\s*game)\s*console|wireless\s*controller|game\s*controller|gamepad)\b/i.test(hay);
    }
    return false;
  }

  function matchesSearchQuery(deal, query) {
    var tokens = tokenizeQuery(query);
    if (!tokens.length) return false;
    var intent = getSearchIntent(query);
    var cat = normalizeCategory(deal && deal.category) || "";
    var name = String((deal && (deal.name || deal.title)) || "");
    var blob = dealSearchBlob(deal);

    // Category-ish queries: require the product to BE that category/intent.
    // Prefer empty-with-clear message over noisy Cases/PSUs for "GPU".
    if (intent) {
      if (intent === "Other") {
        // Title only — blob often says "PC/console living rooms" on TVs etc.
        return titleLooksLikeSearchIntent(name, intent);
      }
      if ((intent === "Gaming Headsets" || intent === "Headphones") && /^(headset|headsets|headphone|headphones)$/i.test(String(query || "").trim())) {
        return /\b(headset|headphones?|earbuds?|earphones?)\b/i.test(name + " " + blob);
      }
      if (cat === intent) {
        // Category match is strong, but reject obvious cross-type titles
        // (laptop filed as SSD, memory-foam headset filed as RAM, etc.).
        if (intent === "GPUs" || intent === "RAM" || intent === "SSDs" || intent === "CPUs") {
          if (titleLooksLikeSearchIntent(name, intent)) return true;
          // Trust catalogue category only when the title is not clearly another product.
          if (intent === "SSDs" && /\b(laptop|notebook|chromebook|macbook)\b/i.test(name)) return false;
          if (intent === "RAM" && /\b(laptop|notebook|headset|headphones|memory\s*foam)\b/i.test(name)) return false;
          if (intent === "GPUs" && /\b(laptop|notebook|prebuilt|pc\s*case|mid-?tower|anti-?sag)\b/i.test(name)) return false;
          return true;
        }
        return true;
      }
      return titleLooksLikeSearchIntent(name, intent);
    }

    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      var opts = SEARCH_ALIASES[t] || [t];
      var hit = false;
      for (var j = 0; j < opts.length; j++) {
        var escaped = opts[j].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        var re = new RegExp("(^|[^a-z0-9])" + escaped, "i");
        if (re.test(blob) || re.test(name)) {
          hit = true;
          break;
        }
      }
      if (!hit) return false;
    }
    return true;
  }

  function isPricedDeal(deal) {
    var price = Number(deal && deal.price);
    var prev = Number(deal && deal.previousPrice);
    if (!Number.isFinite(price) || price <= 0) return false;
    if (!Number.isFinite(prev) || prev <= price) return false;
    var save = prev - price;
    var pct = (save / prev) * 100;
    return save >= 5 && pct >= 5;
  }

  function renderRecentSearches() {
    if (!searchRecentEl) return;
    searchRecentEl.innerHTML = "";
    if (!recentSearches.length) {
      searchRecentEl.hidden = true;
      return;
    }
    recentSearches.forEach(function (q) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "search-recent__chip";
      chip.textContent = q;
      chip.setAttribute("aria-label", "Search for " + q);
      chip.addEventListener("click", function () {
        applySearchQuery(q, { commit: true, focus: false });
      });
      searchRecentEl.appendChild(chip);
    });
    searchRecentEl.hidden = false;
  }

  function syncSearchClearButton() {
    if (!searchClearEl) return;
    searchClearEl.hidden = !String(searchQuery || "").trim();
  }

  function syncSearchPanel() {
    if (!searchPanelEl) return;
    var on = activeFilter === SEARCH_MODE;
    searchPanelEl.hidden = !on;
    if (searchInputEl && searchInputEl.value !== searchQuery) {
      searchInputEl.value = searchQuery;
    }
    syncSearchClearButton();
    if (on) renderRecentSearches();
  }

  function applySearchQuery(query, opts) {
    opts = opts || {};
    searchQuery = String(query == null ? "" : query);
    if (searchInputEl && searchInputEl.value !== searchQuery) {
      searchInputEl.value = searchQuery;
    }
    syncSearchClearButton();
    saveSearchState();
    if (opts.commit && String(searchQuery).trim()) {
      rememberSearchQuery(searchQuery);
      renderRecentSearches();
    }
    if (activeFilter === SEARCH_MODE) {
      renderDeals(allDeals);
      scheduleLiveSearch(searchQuery, { immediate: !!opts.commit });
    } else {
      clearLiveSearch();
    }
    if (opts.focus && searchInputEl) {
      try {
        searchInputEl.focus();
      } catch (e) {}
    }
  }

  function normalizeDealTitleStem(name) {
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

  function dealIdentityKeys(deal) {
    var keys = [];
    if (deal && deal.sku) keys.push("sku:" + String(deal.sku).toUpperCase());
    if (deal && deal.url) {
      var u = String(deal.url).split("?")[0].replace(/\/$/, "").toLowerCase();
      keys.push("url:" + u);
      var m = u.match(/\/p\/([a-z0-9-]+)/i);
      if (m) keys.push("sku:" + m[1].toUpperCase());
      var asin = u.match(/\/(?:dp|gp\/product)\/([a-z0-9]{10})/i);
      if (asin) keys.push("asin:" + asin[1].toUpperCase());
    }
    if (deal && deal.id) keys.push("id:" + String(deal.id).toLowerCase());
    var stem = normalizeDealTitleStem(deal && (deal.name || deal.title));
    if (stem && stem.length >= 8) {
      var price = Number(deal && deal.price);
      var bucket = Number.isFinite(price) ? Math.round(price / 5) * 5 : "x";
      keys.push("stem:" + stem + "|" + bucket);
    }
    return keys;
  }

  function clearLiveSearch() {
    clearTimeout(liveSearchTimer);
    liveSearchTimer = null;
    if (liveSearchAbort) {
      try {
        liveSearchAbort.abort();
      } catch (e) {}
      liveSearchAbort = null;
    }
    liveSearchDeals = [];
    liveSearchQuery = "";
    liveSearchLoading = false;
    liveSearchError = "";
    syncSearchLiveStatus();
  }

  function ensureSearchLiveStatusEl() {
    if (searchLiveStatusEl && searchLiveStatusEl.isConnected) return searchLiveStatusEl;
    if (!ensureSearchUi() || !searchPanelEl) return null;
    var inner = searchPanelEl.querySelector(".search-panel__inner");
    if (!inner) return null;
    var el = document.getElementById("search-live-status");
    if (!el) {
      el = document.createElement("p");
      el.id = "search-live-status";
      el.className = "search-live-status";
      el.hidden = true;
      el.setAttribute("aria-live", "polite");
      inner.appendChild(el);
    }
    searchLiveStatusEl = el;
    return el;
  }

  function syncSearchLiveStatus() {
    var el = ensureSearchLiveStatusEl();
    if (!el) return;
    if (activeFilter !== SEARCH_MODE) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    var q = String(searchQuery || "").trim();
    if (q.length < LIVE_SEARCH_MIN_CHARS) {
      el.hidden = true;
      el.textContent = "";
      el.classList.remove("is-loading", "is-error");
      return;
    }
    if (!LIVE_SEARCH_URL) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    if (liveSearchLoading) {
      el.hidden = false;
      el.classList.add("is-loading");
      el.classList.remove("is-error");
      el.textContent = "Searching live deals…";
      return;
    }
    var shown = lastSearchShown || { total: 0, live: 0, catalogue: 0 };
    var plural = function (n, one, many) {
      return n + " " + (n === 1 ? one : many);
    };
    if (liveSearchError) {
      el.hidden = false;
      el.classList.remove("is-loading");
      el.classList.add("is-error");
      if (shown.catalogue > 0) {
        el.textContent =
          "Live search unavailable — showing " +
          plural(shown.catalogue, "catalogue deal", "catalogue deals");
      } else {
        el.textContent =
          "Live search unavailable — no strong catalogue matches for “" + q + "”";
      }
      return;
    }
    if (liveSearchQuery === q) {
      el.hidden = false;
      el.classList.remove("is-loading", "is-error");
      if (shown.total <= 0) {
        el.textContent = "No deals found for “" + q + "”";
        return;
      }
      if (shown.live > 0 && shown.catalogue > 0) {
        el.textContent =
          "Showing " +
          shown.live +
          " live + " +
          shown.catalogue +
          " catalogue (" +
          plural(shown.total, "deal", "deals") +
          ")";
        return;
      }
      if (shown.live > 0) {
        el.textContent =
          "Showing " + plural(shown.live, "live deal", "live deals") + " with real price cuts";
        return;
      }
      el.textContent =
        "Showing " + plural(shown.catalogue || shown.total, "catalogue deal", "catalogue deals");
      return;
    }
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("is-loading", "is-error");
  }

  function scheduleLiveSearch(query, opts) {
    opts = opts || {};
    clearTimeout(liveSearchTimer);
    var q = String(query || "").trim();
    if (!LIVE_SEARCH_URL || activeFilter !== SEARCH_MODE) {
      if (liveSearchDeals.length || liveSearchLoading || liveSearchError) {
        liveSearchDeals = [];
        liveSearchQuery = "";
        liveSearchLoading = false;
        liveSearchError = "";
        syncSearchLiveStatus();
      }
      return;
    }
    if (q.length < LIVE_SEARCH_MIN_CHARS) {
      if (liveSearchAbort) {
        try {
          liveSearchAbort.abort();
        } catch (e) {}
        liveSearchAbort = null;
      }
      liveSearchDeals = [];
      liveSearchQuery = "";
      liveSearchLoading = false;
      liveSearchError = "";
      syncSearchLiveStatus();
      return;
    }
    // Already have fresh results for this exact query
    if (!opts.force && liveSearchQuery === q && liveSearchDeals.length && !liveSearchLoading) {
      syncSearchLiveStatus();
      return;
    }
    var run = function () {
      fetchLiveSearch(q);
    };
    if (opts.immediate) run();
    else liveSearchTimer = setTimeout(run, LIVE_SEARCH_DEBOUNCE_MS);
  }

  function fetchLiveSearch(query) {
    var q = String(query || "").trim();
    if (!LIVE_SEARCH_URL || q.length < LIVE_SEARCH_MIN_CHARS) return;
    if (liveSearchAbort) {
      try {
        liveSearchAbort.abort();
      } catch (e) {}
    }
    var seq = ++liveSearchSeq;
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    liveSearchAbort = controller;
    liveSearchLoading = true;
    liveSearchError = "";
    syncSearchLiveStatus();
    if (activeFilter === SEARCH_MODE) {
      dealsEl.setAttribute("aria-busy", "true");
    }

    var endpoint =
      LIVE_SEARCH_URL.replace(/\/$/, "") + "/search?q=" + encodeURIComponent(q);
    var fetchOpts = { method: "GET", credentials: "omit" };
    if (controller) fetchOpts.signal = controller.signal;

    fetch(endpoint, fetchOpts)
      .then(function (res) {
        return res.json().then(function (body) {
          return { res: res, body: body };
        });
      })
      .then(function (pack) {
        if (seq !== liveSearchSeq) return;
        liveSearchLoading = false;
        liveSearchAbort = null;
        var body = pack.body || {};
        if (!pack.res.ok || body.ok === false) {
          liveSearchError = "Live search unavailable — showing catalogue matches";
          liveSearchDeals = [];
          liveSearchQuery = q;
          syncSearchLiveStatus();
          if (activeFilter === SEARCH_MODE && String(searchQuery || "").trim() === q) {
            renderDeals(allDeals);
          }
          return;
        }
        var deals = Array.isArray(body.deals) ? body.deals : [];
        // Trust only objects with a real numeric price + url (never invent)
        liveSearchDeals = deals
          .filter(function (d) {
            return (
              d &&
              typeof d.name === "string" &&
              d.name &&
              typeof d.url === "string" &&
              d.url &&
              Number.isFinite(Number(d.price)) &&
              Number(d.price) > 0 &&
              isPricedDeal(d) &&
              matchesSearchQuery(d, q)
            );
          })
          .map(function (d) {
            return refineLiveDealCategory(d);
          });
        liveSearchQuery = q;
        liveSearchError = "";
        syncSearchLiveStatus();
        if (activeFilter === SEARCH_MODE && String(searchQuery || "").trim() === q) {
          renderDeals(allDeals);
        }
      })
      .catch(function (err) {
        if (seq !== liveSearchSeq) return;
        if (err && err.name === "AbortError") return;
        liveSearchLoading = false;
        liveSearchAbort = null;
        liveSearchDeals = [];
        liveSearchQuery = q;
        liveSearchError = "Live search unavailable — showing catalogue matches";
        syncSearchLiveStatus();
        if (activeFilter === SEARCH_MODE && String(searchQuery || "").trim() === q) {
          renderDeals(allDeals);
        }
      });
  }

  function refineLiveDealCategory(deal) {
    if (!deal) return deal;
    var name = String(deal.name || deal.title || "");
    var cat = normalizeCategory(deal.category) || deal.category || "";
    // Prefer title-derived category when Worker sent Other / empty / clearly wrong.
    var guessed = null;
    if (/\b(earbuds?|earphones?|true wireless)\b/i.test(name)) guessed = "Earbuds";
    else if (/\b(headset)\b/i.test(name)) guessed = "Gaming Headsets";
    else if (/\b(headphones?)\b/i.test(name)) guessed = "Headphones";
    else if (/\b(wireless\s*controller|gamepad|game\s*controller)\b/i.test(name)) guessed = "Controllers";
    else if (/\b(xbox|playstation|\bps[45]\b|nintendo\s*switch)\b/i.test(name)) guessed = "Other";
    else if (/\b(macbook|laptop|notebook|chromebook)\b/i.test(name)) guessed = "Laptops";
    else if (/\b(pre-?built|(gaming|gamer)\s+(desktop|pc|computer)|gaming\s+desktop|desktop\s+(pc|computer))\b/i.test(name) &&
             !/\b(pc\s*case|computer\s*case|motherboard)\b/i.test(name))
      guessed = "Prebuilts";
    else if (/\b(geforce|radeon|rtx\s*\d|gtx\s*\d|graphics\s*card|\bgpu\b)\b/i.test(name) &&
             !/\b(laptop|notebook)\b/i.test(name))
      guessed = "GPUs";
    else if (/\b(ddr[45]|sodimm|desktop\s*memory|288-?pin)\b/i.test(name) &&
             !/\b(laptop|headset|memory\s*foam)\b/i.test(name))
      guessed = "RAM";
    else if (/\b(nvme|solid\s*state|\bssd\b)\b/i.test(name) && !/\b(laptop|notebook|console)\b/i.test(name))
      guessed = "SSDs";
    else if (/\b(mouse|mice)\b/i.test(name)) guessed = "Mice";
    else if (/\b(keyboard)\b/i.test(name)) guessed = "Keyboards";
    else if (/\b(monitor|ultrawide)\b/i.test(name) && !/\blaptop\b/i.test(name)) guessed = "Monitors";

    if (guessed && guessed !== cat) {
      // Title-derived category wins whenever Worker/catalogue tag is missing or wrong
      // (headset→RAM, Xbox→Other/RAM, laptop SSD→SSDs, GPU→Cases, etc.).
      deal.category = guessed;
    } else if (guessed && !cat) {
      deal.category = guessed;
    }
    return deal;
  }

  function mergeSearchResults(catalogueMatches, liveDeals) {
    var seen = Object.create(null);
    var out = [];
    function take(deal) {
      if (!deal) return;
      var keys = dealIdentityKeys(deal);
      for (var i = 0; i < keys.length; i++) {
        if (seen[keys[i]]) return;
      }
      // Extra near-dupe: same title stem within ~8% price, even if stem bucket differs.
      var stem = normalizeDealTitleStem(deal.name || deal.title);
      var price = Number(deal.price);
      if (stem && Number.isFinite(price)) {
        for (var j = 0; j < out.length; j++) {
          var other = out[j];
          var oStem = normalizeDealTitleStem(other.name || other.title);
          var oPrice = Number(other.price);
          if (oStem !== stem || !Number.isFinite(oPrice)) continue;
          var diff = Math.abs(price - oPrice);
          var base = Math.max(price, oPrice);
          if (diff <= 8 || (base > 0 && diff / base <= 0.08)) return;
        }
      }
      keys.forEach(function (k) {
        seen[k] = true;
      });
      out.push(deal);
    }
    // Live hits primary
    (liveDeals || []).forEach(take);
    // Then catalogue matches that also match the query
    (catalogueMatches || []).forEach(take);
    return out;
  }

  function ensureSearchUi() {
    if (searchPanelEl && searchInputEl) return true;
    searchPanelEl = document.getElementById("search-panel");
    searchInputEl = document.getElementById("deal-search");
    searchClearEl = document.getElementById("deal-search-clear");
    searchRecentEl = document.getElementById("search-recent");
    return !!(searchPanelEl && searchInputEl);
  }

  function initSearchUi() {
    if (!ensureSearchUi()) return;
    loadSearchState();
    if (searchInputEl.value !== searchQuery) searchInputEl.value = searchQuery;
    syncSearchClearButton();

    searchInputEl.addEventListener("input", function () {
      var value = searchInputEl.value;
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(function () {
        applySearchQuery(value, { commit: false });
      }, 200);
    });

    searchInputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(searchDebounceTimer);
        applySearchQuery(searchInputEl.value, { commit: true });
      } else if (e.key === "Escape") {
        if (searchInputEl.value) {
          e.preventDefault();
          clearTimeout(searchDebounceTimer);
          applySearchQuery("", { commit: false, focus: true });
        }
      }
    });

    if (searchClearEl) {
      searchClearEl.addEventListener("click", function () {
        clearTimeout(searchDebounceTimer);
        applySearchQuery("", { commit: false, focus: true });
        pressFlash(searchClearEl);
      });
    }

    syncSearchPanel();
  }

  function matchesBudget(deal, budgetId) {
    if (!budgetId || budgetId === "All") return true;
    var opt = null;
    for (var i = 0; i < BUDGET_OPTIONS.length; i++) {
      if (BUDGET_OPTIONS[i].id === budgetId) {
        opt = BUDGET_OPTIONS[i];
        break;
      }
    }
    if (!opt || opt.min == null) return true;
    var price = Number(deal && deal.price);
    if (!Number.isFinite(price)) return false;
    return price >= opt.min && price < opt.max;
  }

  var FUNNEL_SVG =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">' +
    '<path d="M4 5.5h16l-6.2 7.3v5.4l-3.6 1.8v-7.2L4 5.5z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>' +
    "</svg>";
  var SORT_SVG =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">' +
    '<path d="M7 4.5v15M7 19.5l-3-3M7 19.5l3-3M17 19.5v-15M17 4.5l-3 3M17 4.5l3 3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>";
  var CHECK_SVG =
    '<svg class="tool-menu__check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
    '<path d="M3.2 8.4l3 3 6.6-6.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>";
  var openToolMenu = null;

  function closeToolMenu(restoreFocus) {
    if (!openToolMenu) return;
    var m = openToolMenu;
    openToolMenu = null;
    m.menu.hidden = true;
    m.btn.setAttribute("aria-expanded", "false");
    m.btn.classList.remove("is-open");
    if (restoreFocus) {
      try {
        m.btn.focus();
      } catch (e) {}
    }
  }

  function toggleToolMenu(btn, menu) {
    if (openToolMenu && openToolMenu.menu === menu) {
      closeToolMenu(false);
      return;
    }
    closeToolMenu(false);
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    btn.classList.add("is-open");
    openToolMenu = { btn: btn, menu: menu };
    var checked = menu.querySelector('[aria-checked="true"]') || menu.querySelector("button");
    if (checked) {
      try {
        checked.focus({ preventScroll: true });
      } catch (e) {}
    }
  }

  document.addEventListener("pointerdown", function (e) {
    if (!openToolMenu) return;
    var wrap = openToolMenu.btn.parentNode;
    if (wrap && wrap.contains(e.target)) return;
    closeToolMenu(false);
  });
  document.addEventListener("keydown", function (e) {
    if (!openToolMenu) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeToolMenu(true);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      var items = Array.prototype.slice.call(openToolMenu.menu.querySelectorAll("button"));
      var i = items.indexOf(document.activeElement);
      var next = e.key === "ArrowDown" ? i + 1 : i - 1;
      if (next < 0) next = items.length - 1;
      if (next >= items.length) next = 0;
      e.preventDefault();
      items[next].focus();
    }
  });
  window.addEventListener("resize", function () {
    closeToolMenu(false);
  });

  /**
   * Price filter + sort as two compact icon buttons with popover menus.
   * Same option ids / behavior as the old pill rows.
   */
  function renderToolMenu(kind) {
    var isBudget = kind === "budget";
    var btn = document.getElementById(isBudget ? "budget-toggle" : "sort-toggle");
    var menu = document.getElementById(isBudget ? "budget-menu" : "sort-menu");
    if (!btn || !menu) return;
    var options = isBudget ? BUDGET_OPTIONS : SORT_OPTIONS;
    var current = isBudget ? activeBudget : activeSort;
    var defaultId = isBudget ? "All" : "savings";
    var currentLabel = "";
    options.forEach(function (o) {
      if (o.id === current) currentLabel = o.label;
    });

    if (!btn.dataset.ready) {
      btn.dataset.ready = "1";
      btn.innerHTML = (isBudget ? FUNNEL_SVG : SORT_SVG) + '<span class="tool-btn__dot" aria-hidden="true"></span>';
      btn.addEventListener("click", function () {
        pressFlash(btn);
        toggleToolMenu(btn, menu);
      });
    }
    var nonDefault = current !== defaultId;
    btn.classList.toggle("is-active", nonDefault);
    btn.setAttribute(
      "aria-label",
      (isBudget ? "Price filter: " : "Sort: ") + currentLabel
    );
    btn.title = (isBudget ? "Price: " : "Sort: ") + currentLabel;

    menu.innerHTML =
      '<p class="tool-menu__title">' + (isBudget ? "Price" : "Sort by") + "</p>";
    options.forEach(function (opt) {
      var item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitemradio");
      var on = opt.id === current;
      item.setAttribute("aria-checked", on ? "true" : "false");
      item.className = "tool-menu__item" + (on ? " is-on" : "");
      item.innerHTML = '<span class="tool-menu__label">' + escapeHtml(opt.label) + "</span>" + CHECK_SVG;
      item.addEventListener("click", function () {
        if (isBudget) {
          if (opt.id !== activeBudget) {
            activeBudget = opt.id;
            renderDeals(allDeals);
          }
        } else if (opt.id !== activeSort) {
          activeSort = opt.id;
          renderDeals(allDeals);
        }
        closeToolMenu(true);
        renderToolMenu(kind);
      });
      menu.appendChild(item);
    });
  }

  function renderBudgetFilters() {
    renderToolMenu("budget");
  }

  function renderSortFilters() {
    renderToolMenu("sort");
  }

  function renderFilters(deals) {
    if (!filtersEl || !filterButtonsEl) return;
    var present = {};
    deals.forEach(function (d) {
      var c = normalizeCategory(d.category);
      if (c) present[c] = true;
    });
    var cats = [SEARCH_MODE, "All", VALUE_MODE, BUILDS_MODE, "Future"];
    if (savedCount() > 0 || activeFilter === SAVED_MODE) cats.push(SAVED_MODE);
    CATEGORY_ORDER.forEach(function (cat) {
      if (cat !== "All" && cat !== "Future" && present[cat]) cats.push(cat);
    });
    Object.keys(present).forEach(function (cat) {
      if (cats.indexOf(cat) === -1) cats.push(cat);
    });
    // Mode chip — not a deal.category; keep first so Search is easy to hit.
    if (cats.indexOf(SEARCH_MODE) === -1) cats.unshift(SEARCH_MODE);
    else if (cats[0] !== SEARCH_MODE) {
      cats = [SEARCH_MODE].concat(cats.filter(function (c) { return c !== SEARCH_MODE; }));
    }
    filterButtonsEl.innerHTML = "";
    cats.forEach(function (cat) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "filter-btn" + (cat === activeFilter ? " is-on" : "");
      btn.dataset.filter = cat; // the tab's name (a chip's text can include a count)
      btn.setAttribute("aria-pressed", cat === activeFilter ? "true" : "false");
      if (cat === SEARCH_MODE) {
        btn.className += " filter-btn--search";
        btn.setAttribute("aria-label", "Search deals");
        btn.dataset.filter = SEARCH_MODE;
        btn.innerHTML =
          '<svg class="filter-btn__icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
          '<circle cx="10.5" cy="10.5" r="6.25" fill="none" stroke="currentColor" stroke-width="2"/>' +
          '<path d="M15.4 15.4L20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
          "</svg>";
      } else {
        btn.textContent = cat;
        if (cat === SAVED_MODE) {
          var cnt = document.createElement("span");
          cnt.className = "filter-btn__count";
          cnt.textContent = String(savedCount());
          btn.appendChild(cnt);
        }
      }
      btn.addEventListener("click", function () {
        if (cat === activeFilter) {
          pressFlash(btn);
          if (cat === SEARCH_MODE && searchInputEl) {
            try {
              searchInputEl.focus();
            } catch (e) {}
          }
          return;
        }
        activeFilter = cat;
        syncTabUrl();
        if (cat !== SEARCH_MODE) clearLiveSearch();
        Array.prototype.forEach.call(filterButtonsEl.children, function (b) {
          var label = b.dataset.filter || b.textContent;
          var on = label === activeFilter;
          b.classList.toggle("is-on", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
        pressFlash(btn);
        try {
          btn.scrollIntoView({
            inline: "nearest",
            block: "nearest",
            behavior: reduceMotion ? "auto" : "smooth"
          });
        } catch (e) {}
        syncSearchPanel();
        renderDeals(allDeals);
        if (cat === SEARCH_MODE) {
          scheduleLiveSearch(searchQuery, { immediate: true });
          if (searchInputEl) {
            setTimeout(function () {
              try {
                searchInputEl.focus();
              } catch (e) {}
            }, 30);
          }
        }
      });
      filterButtonsEl.appendChild(btn);
    });
    filtersEl.hidden = cats.length <= 2;
    try {
      filterButtonsEl.scrollLeft = 0;
    } catch (e) {}
    renderBudgetFilters();
    renderSortFilters();
    syncSearchPanel();
  }


  function formatRatingCount(n) {
    var count = Number(n);
    if (!Number.isFinite(count) || count <= 0) return "";
    if (count >= 1000) {
      var k = count / 1000;
      var rounded = k >= 10 ? Math.round(k) : Math.round(k * 10) / 10;
      return String(rounded).replace(/\.0$/, "") + "k";
    }
    return String(Math.round(count));
  }

  function formatRatingScore(r) {
    var n = Number(r);
    if (!Number.isFinite(n) || n <= 0) return "";
    return (Math.round(n * 10) / 10).toFixed(1);
  }

  function ratingLine(deal) {
    var score = formatRatingScore(deal && deal.rating);
    if (!score) return "";
    var countLabel = formatRatingCount(deal && deal.ratingCount);
    // Compact: "★ 4.3" or "★ 4.3 · 1.2k" — never invent a score
    if (countLabel) return "★ " + score + " · " + countLabel;
    return "★ " + score;
  }

  function buildCard(deal, index) {
    var id = deal.id || "deal-" + slugify(deal.name) + "-" + index;
    var article = document.createElement("article");
    article.className = "deal-card";
    article.id = id;

    var pct = pctOff(deal.price, deal.previousPrice);
    var saved = savings(deal.price, deal.previousPrice);
    var badgeText = "";
    if (pct != null && pct > 0) {
      badgeText = pct + "% off";
      if (saved != null) badgeText += " · save " + formatMoney(saved);
    }

    var nearLow = isNearLow(deal);
    var heat = dealHeat(deal);
    var promo = dealPromoCode(deal);
    // Deals taken from a store's sale ad (e.g. Costco) are never price-checked
    // by the hourly job, so say where the price comes from instead of
    // showing an ever-growing "Checked X days ago".
    var fromAd = !deal.verifiedAt && !!deal.startsAt;
    var startsMs = fromAd ? new Date(deal.startsAt).getTime() : NaN;
    var checkedIso = deal.updatedAt || siteUpdatedAt;
    var checkedLabel = fromAd
      ? startsMs > Date.now()
        ? "Announced price"
        : "Advertised sale price"
      : checkedIso
        ? formatChecked(checkedIso)
        : "";
    var endsLabel = deal.endsAt ? formatEndsIn(deal.endsAt) : "";
    var startsLabel = deal.startsAt ? formatStartsIn(deal.startsAt) : "";
    var endingSoon = endsWithinMs(deal, 48 * 60 * 60 * 1000);

    var dropBadge = "";
    // The badge marks a real recent price drop found by the hourly check
    // (kept ~24h). Savings vs. the list price already show in the savings pill.
    if (deal.priceDropped) {
      var dropAmt = Number(deal.dropAmount);
      var hasDropAmt = Number.isFinite(dropAmt) && dropAmt > 0;
      var dropLabel = hasDropAmt ? "↓ " + formatMoney(dropAmt) : "Dropped";
      var ariaDrop = hasDropAmt
        ? "Price just dropped " + formatMoney(dropAmt)
        : "Price just dropped";
      dropBadge =
        '<span class="deal-card__drop" role="status" aria-label="' +
        escapeAttr(ariaDrop) +
        '">' +
        '<svg class="deal-card__drop-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">' +
        '<path fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" d="M3 5.5 L6.5 10 L9 7.25 L13 12.5"/>' +
        '<path fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" d="M10.25 12.5 H13 V9.75"/>' +
        "</svg>" +
        '<span class="deal-card__drop-label">' +
        escapeHtml(dropLabel) +
        "</span></span>";
    }

    var mediaHtml = "";
    if (deal.image) {
      mediaHtml =
        '<figure class="deal-card__figure deal-card__figure--zoom" tabindex="0" role="button" aria-label="View photo of ' +
        escapeAttr(deal.name) +
        '">' +
        '<img src="' +
        escapeAttr(cardImageSrc(deal.image)) +
        '" data-full="' +
        escapeAttr(deal.image) +
        '" alt="' +
        escapeAttr(deal.name) +
        '" loading="lazy" decoding="async">' +
        dropBadge +
        "</figure>";
    } else {
      mediaHtml =
        '<figure class="deal-card__figure deal-card__figure--placeholder" aria-hidden="true">' +
        categoryTileHtml(deal) +
        dropBadge +
        "</figure>";
    }

    // Honest-discount labels from 30 days of price history (scripts/price_history.py)
    var nearLowHtml = deal.lowest30
      ? '<span class="deal-card__near-low" role="status">Lowest in 30 days</span>'
      : nearLow
        ? '<span class="deal-card__near-low" role="status">Near low</span>'
        : "";
    // Honest savings: below the price it usually sold for (tracked hourly), shown
    // once a week of prices is on record
    var usual = Number(deal.typical30);
    var belowUsual = Number(deal.trackedDays30) >= 7 && usual > 0 ? usual - Number(deal.price) : 0;
    if (belowUsual >= Math.max(5, usual * 0.03)) {
      nearLowHtml +=
        '<span class="deal-card__usual" role="note" title="It usually sold for ' + escapeAttr(formatMoney(usual)) +
        ' over the last 30 days.">' + escapeHtml(formatMoney(Math.round(belowUsual))) + " below usual</span>";
    }
    var savedAt = savedDeals()[deal.id];
    if (savedAt && Number.isFinite(Number(savedAt.price))) {
      var moved = Math.round((Number(deal.price) - Number(savedAt.price)) * 100) / 100;
      if (Math.abs(moved) >= 1) {
        nearLowHtml +=
          '<span class="deal-card__since deal-card__since--' + (moved < 0 ? "down" : "up") + '" title="You saved it at ' +
          escapeAttr(formatMoney(Number(savedAt.price))) + '">' + (moved < 0 ? "↓ " : "↑ ") +
          escapeHtml(formatMoney(Math.abs(moved))) + " since you saved</span>";
      }
    }
    var vRank = valueRankById[deal.id];
    if (vRank) {
      nearLowHtml +=
        '<a class="deal-card__value" href="?tab=' + encodeURIComponent(VALUE_MODE) + '" data-value-link>Best value #' +
        vRank + "</a>";
    }
    if (deal.wasUnseen) {
      nearLowHtml +=
        '<span class="deal-card__unseen" role="note" title="The store lists ' +
        escapeAttr(formatMoney(deal.previousPrice)) +
        " as the regular price, but the highest price we saw in the last 30 days was " +
        escapeAttr(formatMoney(deal.high30)) +
        '.">Was-price not seen in 30 days</span>';
    }

    var endingSoonHtml = endingSoon
      ? '<span class="deal-card__ending-soon" role="status">Ending soon</span>'
      : "";

    var heatHtml =
      '<div class="deal-card__heat deal-card__heat--' +
      escapeAttr(heat.level) +
      '" role="img" aria-label="Deal heat: ' +
      escapeAttr(heat.label) +
      '">' +
      '<span class="deal-card__heat-label">' +
      escapeHtml(heat.label) +
      "</span>" +
      '<span class="deal-card__heat-track" aria-hidden="true">' +
      '<span class="deal-card__heat-fill" style="width:' +
      heat.fill +
      '%"></span>' +
      "</span></div>";

    var promoHtml = promo
      ? '<button type="button" class="deal-card__promo" data-promo="' +
        escapeAttr(promo) +
        '" aria-label="Copy promo code ' +
        escapeAttr(promo) +
        '">Code: ' +
        escapeHtml(promo) +
        " · tap to copy</button>"
      : "";

    var freshnessParts = [];
    if (checkedLabel) freshnessParts.push({ text: checkedLabel, kind: "checked" });
    if (startsLabel) freshnessParts.push({ text: startsLabel, kind: "starts" });
    if (endsLabel) freshnessParts.push({ text: endsLabel, kind: "ends" });
    var freshnessHtml = freshnessParts.length
      ? '<p class="deal-card__fresh">' +
        freshnessParts
          .map(function (p) {
            var cls =
              p.kind === "ends"
                ? "deal-card__fresh-ends"
                : p.kind === "starts"
                  ? "deal-card__fresh-starts"
                  : "deal-card__fresh-checked";
            return '<span class="' + cls + '">' + escapeHtml(p.text) + "</span>";
          })
          .join('<span class="deal-card__fresh-sep"> · </span>') +
        "</p>"
      : "";


    var ratingText = ratingLine(deal);
    var ratingHtml = ratingText
      ? '<span class="deal-card__rating" title="Product rating from retailer">' +
        escapeHtml(ratingText) +
        "</span>"
      : "";

    article.innerHTML =
      mediaHtml +
      '<div class="deal-card__body">' +
      '<div class="deal-card__top">' +
      '<p class="deal-card__meta">' +
      escapeHtml(normalizeCategory(deal.category) || deal.category || "Deal") +
      " · " +
      escapeHtml(deal.merchant || "") +
      "</p>" +
      heatHtml +
      "</div>" +
      '<h2 class="deal-card__title">' +
      escapeHtml(deal.name) +
      "</h2>" +
      '<div class="deal-card__prices">' +
      '<span class="deal-card__price">' +
      formatMoney(deal.price) +
      "</span>" +
      (deal.previousPrice
        ? '<span class="deal-card__was">' + formatMoney(deal.previousPrice) + "</span>"
        : "") +
      (badgeText
        ? '<span class="deal-card__badge">' + escapeHtml(badgeText) + "</span>"
        : "") +
      nearLowHtml +
      endingSoonHtml +
      ratingHtml +
      "</div>" +
      promoHtml +
      freshnessHtml +
      '<div class="deal-card__tools">' +
      (deal.sku && !isFutureDeal(deal)
        ? '<button type="button" class="deal-card__history" data-history>' +
          '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
          '<path d="M1.5 12.5l4-4 3 2.5 6-6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          "Price history</button>"
        : "") +
      (deal.id
        ? '<button type="button" class="deal-card__save' + (savedDeals()[deal.id] ? " is-saved" : "") +
          '" data-save aria-pressed="' + (savedDeals()[deal.id] ? "true" : "false") + '">' +
          (savedDeals()[deal.id] ? "★ Saved" : "☆ Save") + "</button>"
        : "") +
      "</div>" +
      (deal.sourceUrl
        ? '<p class="deal-card__source">Source: <a href="' +
          escapeAttr(deal.sourceUrl) +
          '" target="_blank" rel="noopener noreferrer">' +
          escapeHtml(deal.sourceName || "announcement") +
          "</a></p>"
        : "") +
      '<div class="deal-card__actions">' +
      '<a class="deal-card__cta" href="' +
      escapeAttr(deal.url) +
      '" target="_blank" rel="noopener noreferrer">View at ' +
      escapeHtml(deal.merchant || "retailer") +
      "</a>" +
      "</div></div>";

    if (deal.image) {
      var cardImg = article.querySelector(".deal-card__figure img");
      if (cardImg) wireImageFallback(cardImg, deal);
      var fig = article.querySelector(".deal-card__figure--zoom");
      function zoom() {
        openLightbox(deal.image, deal.name);
      }
      if (fig) {
        fig.addEventListener("click", zoom);
        fig.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            zoom();
          }
        });
      }
    }

    var saveBtn = article.querySelector("[data-save]");
    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        var on = toggleSaved(deal);
        saveBtn.classList.toggle("is-saved", on);
        saveBtn.setAttribute("aria-pressed", on ? "true" : "false");
        saveBtn.textContent = on ? "★ Saved" : "☆ Save";
        showToast(on ? "Saved. Its price change shows here and in the Saved tab." : "Removed from Saved");
        renderFilters(allDeals);
        if (activeFilter === SAVED_MODE && !on) renderDeals(allDeals);
      });
    }

    var valueLink = article.querySelector("[data-value-link]");
    if (valueLink) {
      valueLink.addEventListener("click", function (e) {
        e.preventDefault();
        var chip = document.querySelector('.filter-btn[data-filter="' + VALUE_MODE + '"]') ||
          Array.prototype.find.call(document.querySelectorAll(".filter-btn"), function (b) {
            return b.textContent === VALUE_MODE;
          });
        valueKind = normalizeCategory(deal.category) === "CPUs" ? "cpu" : "gpu";
        if (chip) chip.click();
        try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (err) { window.scrollTo(0, 0); }
      });
    }

    var historyBtn = article.querySelector("[data-history]");
    if (historyBtn) {
      historyBtn.addEventListener("click", function () {
        openPriceHistory(deal, historyBtn);
      });
    }

    var shareBtn = article.querySelector("[data-share]");
    if (shareBtn) {
      shareBtn.addEventListener("click", function () {
        pressFlash(shareBtn);
        var text =
          deal.name +
          " — " +
          formatMoney(deal.price) +
          (pct ? " (" + pct + "% off)" : "") +
          " at " +
          (deal.merchant || "");
        sharePayload({
          title: deal.name,
          text: text,
          url: deal.url || pageUrl(id)
        });
      });
    }

    var promoBtn = article.querySelector("[data-promo]");
    if (promoBtn) {
      promoBtn.addEventListener("click", function () {
        var code = promoBtn.getAttribute("data-promo") || promo;
        pressFlash(promoBtn);
        copyText(code)
          .then(function () {
            showToast("Code " + code + " copied");
          })
          .catch(function () {
            showToast("Couldn’t copy code");
          });
      });
    }

    return article;
  }

  // Line-drawn category icons for cards without a product photo, so every
  // card shows a picture instead of bare text. Unknown categories get a gamepad.
  var CATEGORY_ICONS = {
    "GPUs": "<rect x=\"5\" y=\"14\" width=\"38\" height=\"18\" rx=\"2\"/><circle cx=\"17\" cy=\"23\" r=\"5\"/><circle cx=\"31\" cy=\"23\" r=\"5\"/><path d=\"M9 32v5M5 14V10\"/>",
    "CPUs": "<rect x=\"14\" y=\"14\" width=\"20\" height=\"20\" rx=\"2\"/><rect x=\"19\" y=\"19\" width=\"10\" height=\"10\" rx=\"1\"/><path d=\"M19 10v4M24 10v4M29 10v4M19 34v4M24 34v4M29 34v4M10 19h4M10 24h4M10 29h4M34 19h4M34 24h4M34 29h4\"/>",
    "Monitors": "<rect x=\"5\" y=\"8\" width=\"38\" height=\"25\" rx=\"2\"/><path d=\"M24 33v6M16 39h16\"/>",
    "TVs": "<rect x=\"3\" y=\"9\" width=\"42\" height=\"26\" rx=\"2\"/><path d=\"M12 35l-2 4M36 35l2 4\"/>",
    "Home Theater": "<rect x=\"14\" y=\"5\" width=\"20\" height=\"38\" rx=\"3\"/><circle cx=\"24\" cy=\"30\" r=\"6\"/><circle cx=\"24\" cy=\"14\" r=\"3\"/>",
    "Art Tablets": "<rect x=\"6\" y=\"9\" width=\"28\" height=\"30\" rx=\"3\"/><path d=\"M30 37l12-14 3 3-12 14-4 1z\"/>",
    "PSUs": "<rect x=\"6\" y=\"11\" width=\"36\" height=\"26\" rx=\"2\"/><circle cx=\"20\" cy=\"24\" r=\"7\"/><path d=\"M20 17v14M13 24h14M33 18h5M33 23h5M33 28h5\"/>",
    "Cases": "<rect x=\"13\" y=\"5\" width=\"22\" height=\"38\" rx=\"2\"/><circle cx=\"24\" cy=\"14\" r=\"3\"/><path d=\"M18 34h12M18 38h12\"/>",
    "Motherboards": "<rect x=\"7\" y=\"7\" width=\"34\" height=\"34\" rx=\"2\"/><rect x=\"13\" y=\"13\" width=\"11\" height=\"11\" rx=\"1\"/><path d=\"M29 13h7M29 18h7M29 23h7M13 31h23M13 35h23\"/>",
    "RAM": "<path d=\"M5 16h38v13H5z\"/><rect x=\"9\" y=\"19\" width=\"6\" height=\"6\"/><rect x=\"21\" y=\"19\" width=\"6\" height=\"6\"/><rect x=\"33\" y=\"19\" width=\"6\" height=\"6\"/><path d=\"M8 29v4M13 29v4M18 29v4M30 29v4M35 29v4M40 29v4\"/>",
    "SSDs": "<rect x=\"5\" y=\"17\" width=\"38\" height=\"14\" rx=\"2\"/><rect x=\"10\" y=\"20\" width=\"12\" height=\"8\" rx=\"1\"/><path d=\"M27 21h6M27 27h6\"/><circle cx=\"39\" cy=\"24\" r=\"1.5\"/>",
    "Phones": "<rect x=\"15\" y=\"5\" width=\"18\" height=\"38\" rx=\"3\"/><path d=\"M21 38h6\"/>",
    "Prebuilts": "<rect x=\"16\" y=\"5\" width=\"22\" height=\"38\" rx=\"2\"/><circle cx=\"27\" cy=\"17\" r=\"5\"/><circle cx=\"27\" cy=\"31\" r=\"5\"/><path d=\"M6 43h36\"/>",
    "Laptops": "<rect x=\"10\" y=\"10\" width=\"28\" height=\"20\" rx=\"2\"/><path d=\"M5 34h38l-3 4H8z\"/>",
    "Mice": "<rect x=\"15\" y=\"7\" width=\"18\" height=\"34\" rx=\"9\"/><path d=\"M24 7v11M15 18h18\"/>",
    "Keyboards": "<rect x=\"3\" y=\"15\" width=\"42\" height=\"18\" rx=\"2\"/><path d=\"M8 20h2M14 20h2M20 20h2M26 20h2M32 20h2M38 20h2M8 25h2M14 25h2M20 25h2M26 25h2M32 25h2M38 25h2M15 29h18\"/>",
    "Headsets": "<path d=\"M8 30v-6a16 16 0 0 1 32 0v6\"/><rect x=\"6\" y=\"28\" width=\"8\" height=\"12\" rx=\"3\"/><rect x=\"34\" y=\"28\" width=\"8\" height=\"12\" rx=\"3\"/>",
    "Earbuds": "<circle cx=\"15\" cy=\"17\" r=\"7\"/><path d=\"M19 23l3 16a2 2 0 0 1-4 0l-2-15\"/><circle cx=\"33\" cy=\"17\" r=\"7\"/><path d=\"M29 23l-3 16a2 2 0 0 0 4 0l2-15\"/>",
    "Speakers": "<rect x=\"8\" y=\"14\" width=\"32\" height=\"22\" rx=\"11\"/><circle cx=\"18\" cy=\"25\" r=\"4\"/><circle cx=\"30\" cy=\"25\" r=\"4\"/>",
    "Controllers": "<path d=\"M14 15h20a9 9 0 0 1 8.7 11.3l-2 7.5a4 4 0 0 1-7 1.4L30 31H18l-3.7 4.2a4 4 0 0 1-7-1.4l-2-7.5A9 9 0 0 1 14 15z\"/><path d=\"M15 20v6M12 23h6\"/><circle cx=\"31\" cy=\"21\" r=\"1.4\"/><circle cx=\"34\" cy=\"25\" r=\"1.4\"/>",
    "Webcams": "<circle cx=\"24\" cy=\"19\" r=\"11\"/><circle cx=\"24\" cy=\"19\" r=\"4\"/><path d=\"M18 30l-4 8h20l-4-8\"/>",
    "Microphones": "<rect x=\"18\" y=\"5\" width=\"12\" height=\"22\" rx=\"6\"/><path d=\"M12 22a12 12 0 0 0 24 0M24 34v8M17 42h14\"/>",
    "Networking": "<rect x=\"6\" y=\"28\" width=\"36\" height=\"10\" rx=\"2\"/><path d=\"M14 28l-3-14M34 28l3-14\"/><circle cx=\"14\" cy=\"33\" r=\"1.4\"/><circle cx=\"20\" cy=\"33\" r=\"1.4\"/>",
    "Storage": "<path d=\"M12 6h16l8 8v28H12z\"/><path d=\"M17 10v6M21 10v6M25 10v6\"/>",
    "Charging": "<rect x=\"12\" y=\"7\" width=\"24\" height=\"36\" rx=\"4\"/><path d=\"M26 15l-6 10h8l-6 10\"/>",
    "Tablets": "<rect x=\"9\" y=\"5\" width=\"30\" height=\"38\" rx=\"3\"/><path d=\"M22 38h4\"/>",
    "Coolers": "<circle cx=\"24\" cy=\"24\" r=\"16\"/><circle cx=\"24\" cy=\"24\" r=\"3\"/><path d=\"M24 21c0-6 3-9 7-9M27 24c6 0 9 3 9 7M24 27c0 6-3 9-7 9M21 24c-6 0-9-3-9-7\"/>",
    "Soundbars": "<rect x=\"4\" y=\"19\" width=\"40\" height=\"10\" rx=\"5\"/><circle cx=\"12\" cy=\"24\" r=\"1.6\"/><circle cx=\"18\" cy=\"24\" r=\"1.6\"/><circle cx=\"30\" cy=\"24\" r=\"1.6\"/><circle cx=\"36\" cy=\"24\" r=\"1.6\"/>",
    "AV Receivers": "<rect x=\"4\" y=\"14\" width=\"40\" height=\"20\" rx=\"2\"/><circle cx=\"34\" cy=\"24\" r=\"5\"/><path d=\"M10 21h12M10 27h8\"/><path d=\"M8 34v3M40 34v3\"/>",
    "Subwoofers": "<rect x=\"9\" y=\"8\" width=\"30\" height=\"32\" rx=\"3\"/><circle cx=\"24\" cy=\"25\" r=\"10\"/><circle cx=\"24\" cy=\"25\" r=\"3.5\"/>",
    "Hi-Fi Speakers": "<rect x=\"8\" y=\"5\" width=\"14\" height=\"38\" rx=\"2\"/><circle cx=\"15\" cy=\"31\" r=\"4.5\"/><circle cx=\"15\" cy=\"15\" r=\"2.5\"/><rect x=\"26\" y=\"5\" width=\"14\" height=\"38\" rx=\"2\"/><circle cx=\"33\" cy=\"31\" r=\"4.5\"/><circle cx=\"33\" cy=\"15\" r=\"2.5\"/>",
    "Headphones": "<path d=\"M8 30v-6a16 16 0 0 1 32 0v6\"/><rect x=\"6\" y=\"28\" width=\"8\" height=\"12\" rx=\"3\"/><rect x=\"34\" y=\"28\" width=\"8\" height=\"12\" rx=\"3\"/>",
    "Gaming Headsets": "<path d=\"M8 28v-4a16 16 0 0 1 32 0v4\"/><rect x=\"5\" y=\"26\" width=\"8\" height=\"12\" rx=\"3\"/><rect x=\"35\" y=\"26\" width=\"8\" height=\"12\" rx=\"3\"/><path d=\"M9 38c0 4 5 6 11 6\"/><circle cx=\"22\" cy=\"44\" r=\"1.6\"/>",
    "Wireless Speakers": "<rect x=\"8\" y=\"14\" width=\"32\" height=\"22\" rx=\"11\"/><circle cx=\"18\" cy=\"25\" r=\"4\"/><circle cx=\"30\" cy=\"25\" r=\"4\"/>",
    "Computer Speakers": "<rect x=\"5\" y=\"9\" width=\"12\" height=\"30\" rx=\"2\"/><circle cx=\"11\" cy=\"28\" r=\"3.5\"/><circle cx=\"11\" cy=\"16\" r=\"1.8\"/><rect x=\"31\" y=\"9\" width=\"12\" height=\"30\" rx=\"2\"/><circle cx=\"37\" cy=\"28\" r=\"3.5\"/><circle cx=\"37\" cy=\"16\" r=\"1.8\"/><path d=\"M20 33h8\"/>",
    "Cables": "<path d=\"M8 40c0-10 6-14 16-14s16-4 16-14\"/><rect x=\"4\" y=\"38\" width=\"8\" height=\"7\" rx=\"1.5\"/><rect x=\"36\" y=\"3\" width=\"8\" height=\"7\" rx=\"1.5\"/>",
    "_default": "<rect x=\"5\" y=\"15\" width=\"38\" height=\"20\" rx=\"10\"/><path d=\"M15 21v8M11 25h8\"/><circle cx=\"31\" cy=\"23\" r=\"1.6\"/><circle cx=\"36\" cy=\"27\" r=\"1.6\"/>"
  };

  function categoryIconSvg(cat, cls) {
    var shapes = CATEGORY_ICONS[cat] || CATEGORY_ICONS._default;
    return (
      '<svg class="' + cls + '" viewBox="0 0 48 48" aria-hidden="true" focusable="false" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      shapes +
      "</svg>"
    );
  }

  function categoryTileHtml(deal) {
    var cat = normalizeCategory(deal.category) || deal.category || "Deal";
    return (
      categoryIconSvg(cat, "deal-card__cat-icon") +
      '<span class="deal-card__cat-mark">' +
      escapeHtml(cat) +
      "</span>"
    );
  }

  // Newegg serves each product photo in several sizes. Cards are at most a few
  // hundred pixels wide, so load the 640px version instead of 1280px; the zoomed
  // photo (lightbox) still uses the full-size image.
  var NEWEGG_FULL = "/ProductImageCompressAll1280/";
  var NEWEGG_CARD = "/ProductImageCompressAll640/";

  function cardImageSrc(src) {
    src = String(src || "");
    if (src.indexOf("neweggimages.com") !== -1 && src.indexOf(NEWEGG_FULL) !== -1) {
      return src.replace(NEWEGG_FULL, NEWEGG_CARD);
    }
    return src;
  }

  // If the smaller photo is missing, try the full-size one; if that fails too,
  // swap the broken image for the category placeholder tile.
  function wireImageFallback(img, deal) {
    img.addEventListener("error", function onErr() {
      var full = img.getAttribute("data-full");
      if (full && img.getAttribute("src") !== full) {
        img.setAttribute("src", full);
        return;
      }
      img.removeEventListener("error", onErr);
      var fig = img.closest(".deal-card__figure");
      if (!fig) return;
      var badge = fig.querySelector(".deal-card__drop");
      fig.className = "deal-card__figure deal-card__figure--placeholder";
      fig.removeAttribute("tabindex");
      fig.removeAttribute("role");
      fig.setAttribute("aria-hidden", "true");
      fig.innerHTML = categoryTileHtml(deal);
      if (badge) fig.appendChild(badge);
      var clone = fig.cloneNode(true); // drop the zoom click handlers
      fig.parentNode.replaceChild(clone, fig);
    });
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, "&#39;");
  }

  function renderDeals(deals) {
    // price filter / sort don't apply to Builds and Best Value: hide them there
    if (filtersEl) {
      filtersEl.classList.toggle("filters--no-tools", activeFilter === BUILDS_MODE || activeFilter === VALUE_MODE);
    }
    if (activeFilter === BUILDS_MODE) {
      renderBuilds();
      return;
    }
    if (activeFilter === VALUE_MODE) {
      renderValue();
      return;
    }
    var trimmedQuery = String(searchQuery || "").trim();

    if (activeFilter === SEARCH_MODE && !trimmedQuery) {
      dealsEl.innerHTML = "";
      dealsEl.setAttribute("aria-busy", "false");
      lastSearchShown = { total: 0, live: 0, catalogue: 0 };
      var prompt = document.createElement("p");
      prompt.className = "status";
      prompt.textContent = "Type to search current deals";
      dealsEl.appendChild(prompt);
      syncSearchLiveStatus();
      return;
    }

    var list = deals.filter(function (d) {
      if (activeFilter === SEARCH_MODE) {
        if (!matchesSearchQuery(d, searchQuery)) return false;
      } else if (activeFilter === "Future") {
        if (!isFutureDeal(d)) return false;
      } else if (activeFilter === SAVED_MODE) {
        if (!savedDeals()[d.id]) return false;
      } else if (activeFilter !== "All" && normalizeCategory(d.category) !== activeFilter) {
        return false;
      }
      return matchesBudget(d, activeBudget);
    });
    if (activeFilter === SEARCH_MODE) {
      var liveForQuery =
        liveSearchQuery === trimmedQuery && !liveSearchLoading ? liveSearchDeals : [];
      var liveBudgeted = (liveForQuery || []).filter(function (d) {
        return (
          matchesBudget(d, activeBudget) &&
          isPricedDeal(d) &&
          matchesSearchQuery(d, trimmedQuery)
        );
      });
      // Catalogue search hits should also be real cuts when possible; keep soft matches
      // only if they have a previousPrice drop.
      list = list.filter(isPricedDeal);
      list = mergeSearchResults(applySort(list, activeSort), applySort(liveBudgeted, activeSort));
      list = applySort(list, activeSort);
      var liveN = 0;
      var catN = 0;
      for (var si = 0; si < list.length; si++) {
        if (list[si] && list[si].source === "live") liveN += 1;
        else catN += 1;
      }
      lastSearchShown = { total: list.length, live: liveN, catalogue: catN };
    } else if (activeFilter === SAVED_MODE && activeSort === "savings") {
      var saved = savedDeals();
      list = list.slice().sort(function (a, b) {
        return String((saved[b.id] || {}).at || "").localeCompare(String((saved[a.id] || {}).at || ""));
      });
    } else if (activeFilter === "All" && activeSort === "savings") {
      list = interleaveByCategory(list);
    } else if (activeFilter === "Future" && activeSort === "savings") {
      list = list.slice().sort(function (a, b) {
        var ta = new Date(a.startsAt).getTime();
        var tb = new Date(b.startsAt).getTime();
        if (ta !== tb) return ta - tb;
        return String(a.name || "").localeCompare(String(b.name || ""));
      });
    } else {
      list = applySort(list, activeSort);
    }

    dealsEl.innerHTML = "";
    var waitingLive =
      activeFilter === SEARCH_MODE &&
      !!LIVE_SEARCH_URL &&
      trimmedQuery.length >= LIVE_SEARCH_MIN_CHARS &&
      liveSearchLoading;
    dealsEl.setAttribute("aria-busy", waitingLive ? "true" : "false");
    syncSearchLiveStatus();

    if (!list.length) {
      var empty = document.createElement("p");
      empty.className = "status";
      if (activeFilter === SEARCH_MODE) {
        if (waitingLive) {
          empty.textContent = "Searching live deals…";
        } else if (liveSearchError && LIVE_SEARCH_URL) {
          empty.textContent =
            'No strong catalogue matches for “' + trimmedQuery + '”. Try a model name (e.g. RTX 4070).';
        } else {
          empty.textContent =
            'No deals match “' + trimmedQuery + '”. Try a more specific model or category.';
        }
      } else if (activeFilter === "Future") {
        empty.textContent =
          activeBudget !== "All"
            ? "No upcoming deals in this budget yet."
            : "No upcoming deals found yet.";
      } else if (activeFilter === SAVED_MODE) {
        empty.textContent = savedCount()
          ? "Your saved deals aren’t listed right now (sold out or the sale ended)."
          : "Tap Save on any deal to keep an eye on its price here.";
      } else {
        empty.textContent =
          activeBudget !== "All"
            ? "No deals in this category and budget right now."
            : "No deals in this category right now.";
      }
      dealsEl.appendChild(empty);
      return;
    }

    // Cards are added in pages as the visitor scrolls: building all of them at
    // once (650+) took ~3 s on a mid-range phone.
    var seq = ++dealsRenderSeq;
    if (dealsPager) dealsPager.disconnect();
    dealsPager = null;
    var shown = 0;
    var more = document.createElement("div");
    more.className = "load-more";
    var moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "load-more__btn";
    more.appendChild(moreBtn);
    function addPage() {
      if (seq !== dealsRenderSeq) return;
      var page = list.slice(shown, shown + CARDS_PER_PAGE).map(function (d, i) {
        return buildCard(d, shown + i);
      });
      page.forEach(function (c) {
        dealsEl.insertBefore(c, more);
      });
      observeReveal(page);
      shown += page.length;
      var left = list.length - shown;
      if (left <= 0) {
        if (dealsPager) dealsPager.disconnect();
        more.remove();
      } else {
        moreBtn.textContent = "Show more (" + left + " left)";
      }
    }
    var strip = activeFilter === "All" && activeBudget === "All" ? justDroppedStrip(deals) : null;
    if (strip) dealsEl.appendChild(strip);
    dealsEl.appendChild(more);
    moreBtn.addEventListener("click", addPage);
    addPage();
    if (more.isConnected && "IntersectionObserver" in window) {
      dealsPager = new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) addPage();
      }, { rootMargin: "1200px 0px" });
      dealsPager.observe(more);
    }
  }

  // ---------------------------------------------------------------- Builds tab
  // Complete gaming PCs assembled hourly from today's deals by
  // scripts/build_pcs.py (data/builds.json).
  var BUILD_ROLE_CATEGORY = {
    Processor: "CPUs",
    "CPU cooler": "Coolers",
    Motherboard: "Motherboards",
    Memory: "RAM",
    "Graphics card": "GPUs",
    Storage: "SSDs",
    "Power supply": "PSUs",
    Case: "Cases"
  };

  function loadBuilds() {
    return fetch("data/builds.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        allBuilds = data && Array.isArray(data.builds) ? data : { builds: [], budgets: [] };
      })
      .catch(function () {
        allBuilds = allBuilds || { builds: [], budgets: [] };
      })
      .then(function () {
        if (activeFilter === BUILDS_MODE) renderBuilds();
      });
  }

  function shortPartName(name) {
    var pats = [
      /(RTX|RX|Arc) ?[A-Z]?\d{3,4}(?: ?(?:Ti|XTX|XT|GRE))?/i,
      /Ryzen [3579] \d{4}[A-Z0-9]*/i,
      /Core Ultra [3579] \d{3}[A-Z]*/i,
      /Core i[3579]-\d{4,5}[A-Z]*/i
    ];
    for (var i = 0; i < pats.length; i++) {
      var m = String(name || "").match(pats[i]);
      if (m) return m[0];
    }
    return String(name || "").split(" - ")[0].slice(0, 40);
  }

  function partOnSale(p) {
    var was = Number(p && p.previousPrice);
    var price = Number(p && p.price);
    return Number.isFinite(was) && Number.isFinite(price) && was > price;
  }

  // Which swap options still fit with the rest of the current build.
  // Power supplies too weak for the chosen graphics card, and cases too small
  // for the chosen motherboard, are not offered. Graphics cards and boards are
  // all offered: picking one that needs more swaps in the cheapest PSU or case
  // that fits (see fixDependents).
  function optionFits(slot, opt, cur) {
    if (slot === "psu" && cur.gpu) return !(cur.gpu.need > opt.w);
    if (slot === "case" && cur.board) return (opt.fits || []).indexOf(cur.board.size) !== -1;
    return true;
  }

  function cheapestOption(part, catalog, ok) {
    var best = null;
    (part.options || []).forEach(function (id) {
      var o = catalog[id];
      if (o && ok(o) && (!best || Number(o.price) < Number(best.price))) best = o;
    });
    return best;
  }

  function fixDependents(slot, cur, catalog) {
    var swapped = [];
    if (slot === "gpu" && cur.psu && cur.gpu.need > cur.psu.w) {
      var psu = cheapestOption(cur.psu, catalog, function (o) { return o.w >= cur.gpu.need; });
      if (psu) {
        cur.psu = Object.assign({}, cur.psu, psu, { role: cur.psu.role, slot: "psu" });
        swapped.push("power supply");
      }
    }
    if (slot === "board" && cur["case"] && (cur["case"].fits || []).indexOf(cur.board.size) === -1) {
      var cs = cheapestOption(cur["case"], catalog, function (o) {
        return (o.fits || []).indexOf(cur.board.size) !== -1;
      });
      if (cs) {
        cur["case"] = Object.assign({}, cur["case"], cs, { role: cur["case"].role, slot: "case" });
        swapped.push("case");
      }
    }
    return swapped;
  }

  function buildState(b) {
    var cur = {};
    (b.parts || []).forEach(function (p) {
      if (p.slot) cur[p.slot] = p;
    });
    return cur;
  }

  function buildPartHtml(p, cur, catalog) {
    var cat = BUILD_ROLE_CATEGORY[p.role] || "";
    var shown = (p.slot && cur[p.slot]) || p;
    var thumb = shown.image
      ? '<img src="' + escapeAttr(cardImageSrc(shown.image)) + '" data-full="' + escapeAttr(shown.image) +
        '" data-cat="' + escapeAttr(cat) + '" alt="" loading="lazy" decoding="async">'
      : categoryIconSvg(cat, "build-part__icon");
    var name = shown.url
      ? '<a class="build-part__name" href="' + escapeAttr(shown.url) +
        '" target="_blank" rel="noopener noreferrer">' + escapeHtml(shown.name) + "</a>"
      : '<span class="build-part__name">' + escapeHtml(shown.name) + "</span>";
    var priceNum = Number(shown.price);
    var sale = partOnSale(shown);
    var wasHtml = sale
      ? '<span class="build-part__was">' + escapeHtml(formatMoney(Number(shown.previousPrice))) + "</span>"
      : "";
    var tag = p.estimate
      ? "estimate"
      : sale
        ? '<span class="build-part__sale">on sale</span>'
        : "regular price";
    var swap = "";
    var opts = (p.options || [])
      .map(function (id) { return catalog[id]; })
      .filter(function (o) { return o && optionFits(p.slot, o, cur); });
    if (opts.length > 1) {
      swap =
        '<label class="build-part__swap"><span class="visually-hidden">Swap ' + escapeHtml(p.role) +
        "</span>" +
        '<select data-slot="' + escapeAttr(p.slot) + '">' +
        opts
          .map(function (o) {
            var diff = Math.round((Number(o.price) - priceNum) * 100) / 100;
            var diffTxt =
              o.id === shown.id
                ? "current"
                : (diff >= 0 ? "+" : "−") + formatMoney(Math.abs(diff));
            return (
              '<option value="' + escapeAttr(o.id) + '"' + (o.id === shown.id ? " selected" : "") + ">" +
              escapeHtml(formatMoney(Number(o.price)) + " (" + diffTxt + ") · " + shortOption(o.name) +
                (partOnSale(o) ? " · sale" : "")) +
              "</option>"
            );
          })
          .join("") +
        "</select></label>";
    }
    return (
      '<li class="build-part">' +
      '<span class="build-part__thumb">' + thumb + "</span>" +
      '<span class="build-part__info">' +
      '<span class="build-part__role">' + escapeHtml(p.role) +
      (shown.merchant ? " · " + escapeHtml(shown.merchant) : "") + " · " + tag +
      "</span>" + name + swap + "</span>" +
      '<span class="build-part__price">' + escapeHtml(formatMoney(priceNum)) + wasHtml + "</span>" +
      "</li>"
    );
  }

  function shortOption(name) {
    var n = String(name || "").replace(/\s+-\s+.*$/, "");
    return n.length > 60 ? n.slice(0, 58) + "…" : n;
  }

  function buildCardHtml(b, cur, catalog, changed, notice) {
    var parts = (b.parts || []).map(function (p) { return (p.slot && cur[p.slot]) || p; });
    var total = parts.reduce(function (sum, p) { return sum + Number(p.price || 0); }, 0);
    var was = parts.reduce(function (sum, p) {
      return sum + (partOnSale(p) ? Number(p.previousPrice) : Number(p.price || 0));
    }, 0);
    var save = Math.max(0, was - total);
    var onSale = parts.filter(partOnSale).length;
    var summary = cur.cpu && cur.gpu
      ? shortPartName(cur.cpu.name) + " + " + shortPartName(cur.gpu.name)
      : b.summary || b.title;
    var over = total > Number(b.budget) + 0.005;
    return (
      '<header class="build-card__head">' +
      "<div>" +
      '<p class="build-card__eyebrow">' + escapeHtml(b.platform || "") + "</p>" +
      '<h3 class="build-card__title">' + escapeHtml(summary) + "</h3>" +
      (cur.gpu && gpuGuide(cur.gpu.score)
        ? '<p class="build-card__guide">Good for ' + escapeHtml(gpuGuide(cur.gpu.score)) + " <span>(rough guide)</span></p>"
        : "") +
      '<p class="build-card__meta">' + onSale + " of " + parts.length + " parts on sale" +
      (changed ? ' · <button type="button" class="build-card__reset">Reset</button>' : "") +
      "</p>" +
      (notice ? '<p class="build-card__notice" role="status">' + escapeHtml(notice) + "</p>" : "") +
      "</div>" +
      '<div class="build-card__total">' +
      '<span class="build-card__price">' + escapeHtml(formatMoney(Math.round(total * 100) / 100)) + "</span>" +
      (save > 0.5 ? '<span class="deal-card__badge">save ' + escapeHtml(formatMoney(Math.round(save))) + "</span>" : "") +
      (over ? '<span class="build-card__over">Over $' + Number(b.budget).toLocaleString("en-US") + "</span>" : "") +
      "</div>" +
      "</header>" +
      '<ol class="build-card__parts">' +
      (b.parts || []).map(function (p) { return buildPartHtml(p, cur, catalog); }).join("") +
      "</ol>" +
      ((b.notes || []).length
        ? '<ul class="build-card__notes">' +
          b.notes.map(function (n) { return "<li>" + escapeHtml(n) + "</li>"; }).join("") +
          "</ul>"
        : "")
    );
  }

  function wireBuildCard(card, b, catalog) {
    var cur = card._cur;
    card.innerHTML = buildCardHtml(b, cur, catalog, card._changed, card._notice);
    card.querySelectorAll(".build-part__thumb img").forEach(function (img) {
      img.addEventListener("error", function onErr() {
        var full = img.getAttribute("data-full");
        if (full && img.getAttribute("src") !== full) {
          img.setAttribute("src", full);
          return;
        }
        img.removeEventListener("error", onErr);
        img.outerHTML = categoryIconSvg(img.getAttribute("data-cat") || "", "build-part__icon");
      });
    });
    card.querySelectorAll(".build-part__swap select").forEach(function (sel) {
      sel.addEventListener("change", function () {
        var slot = sel.getAttribute("data-slot");
        var pick = catalog[sel.value];
        if (!pick) return;
        cur[slot] = Object.assign({}, cur[slot], pick, { role: cur[slot].role, slot: slot });
        card._changed = true;
        var also = fixDependents(slot, cur, catalog);
        card._notice = also.length ? "Also switched the " + also.join(" and ") + " so everything fits." : "";
        wireBuildCard(card, b, catalog);
        var again = card.querySelector('select[data-slot="' + slot + '"]');
        if (again) {
          try { again.focus(); } catch (e) {}
        }
      });
    });
    var reset = card.querySelector(".build-card__reset");
    if (reset) {
      reset.addEventListener("click", function () {
        card._cur = buildState(b);
        card._changed = false;
        card._notice = "";
        wireBuildCard(card, b, catalog);
      });
    }
  }

  function renderBuilds() {
    dealsRenderSeq++;
    if (dealsPager) { dealsPager.disconnect(); dealsPager = null; }
    dealsEl.innerHTML = "";
    dealsEl.setAttribute("aria-busy", allBuilds ? "false" : "true");
    if (!allBuilds) {
      var wait = document.createElement("p");
      wait.className = "status";
      wait.textContent = "Loading builds…";
      dealsEl.appendChild(wait);
      return;
    }
    dealsEl.appendChild(buildsSwitch());
    if (buildsView === "custom") {
      renderCustom();
      return;
    }
    var builds = allBuilds.builds || [];
    var catalog = allBuilds.parts || {};
    var intro = document.createElement("p");
    intro.className = "builds-intro";
    var have = builds.map(function (b) { return b.budget; });
    var missing = (allBuilds.budgets || []).filter(function (b) { return have.indexOf(b) === -1; });
    intro.textContent =
      "Complete AMD and Intel gaming PCs built from today’s prices and rebuilt every hour, mixing " +
      "sale and regular-price parts. Sockets, memory type, case size and power are matched for you. " +
      "Use the menus under each part to swap in another compatible option." +
      (missing.length && builds.length
        ? " No build fits " + missing.map(function (b) { return "$" + b.toLocaleString("en-US"); }).join(" or ") +
          " at today’s prices."
        : "");
    dealsEl.appendChild(intro);
    if (!builds.length) {
      var none = document.createElement("p");
      none.className = "status";
      none.textContent = "No complete build fits today’s prices yet. Check back after the next hourly price check.";
      dealsEl.appendChild(none);
      return;
    }
    var budgets = [];
    builds.forEach(function (b) {
      if (budgets.indexOf(b.budget) === -1) budgets.push(b.budget);
    });
    budgets.forEach(function (budget) {
      var group = document.createElement("section");
      group.className = "build-group";
      group.id = "builds-" + budget;
      var h = document.createElement("h2");
      h.className = "build-group__title";
      h.textContent = "Under $" + Number(budget).toLocaleString("en-US");
      group.appendChild(h);
      var row = document.createElement("div");
      row.className = "build-group__row";
      builds
        .filter(function (b) { return b.budget === budget; })
        .forEach(function (b) {
          var card = document.createElement("article");
          card.className = "build-card";
          card.id = "build-" + budget + "-" + String(b.platform || "").toLowerCase();
          card._cur = buildState(b);
          card._changed = false;
          wireBuildCard(card, b, catalog);
          row.appendChild(card);
        });
      group.appendChild(row);
      dealsEl.appendChild(group);
    });
  }

  // ---------------------------------------------------------------- Build your own
  // Pick each part yourself; every list only offers parts that work with the
  // parts already picked (socket, memory type, board size vs case, PSU power).
  var CUSTOM_SLOTS = [
    { slot: "cpu", label: "Processor", noun: "a processor" },
    { slot: "cooler", label: "CPU cooler", noun: "a CPU cooler" },
    { slot: "board", label: "Motherboard", noun: "a motherboard" },
    { slot: "ram", label: "Memory", noun: "memory" },
    { slot: "gpu", label: "Graphics card", noun: "a graphics card" },
    { slot: "ssd", label: "Storage", noun: "storage" },
    { slot: "psu", label: "Power supply", noun: "a power supply" },
    { slot: "case", label: "Case", noun: "a case" }
  ];
  var SOCKET_LABEL = { AM4: "AMD AM4", AM5: "AMD AM5", LGA1700: "Intel LGA 1700", LGA1851: "Intel LGA 1851" };
  // memory types each CPU socket can use (the board decides when one is picked)
  var SOCKET_MEMORY = { AM4: ["DDR4"], AM5: ["DDR5"], LGA1851: ["DDR5"], LGA1700: ["DDR4", "DDR5"] };

  function storeGet(key) {
    try {
      return window.localStorage.getItem("wagd:" + key);
    } catch (e) {
      return null;
    }
  }

  function storeSet(key, value) {
    try {
      if (value == null) window.localStorage.removeItem("wagd:" + key);
      else window.localStorage.setItem("wagd:" + key, value);
    } catch (e) {}
  }

  function readCustomPick() {
    var fromUrl = "";
    try {
      fromUrl = new URLSearchParams(location.search || "").get("build") || "";
    } catch (e) {}
    var raw = fromUrl || storeGet("customBuild") || "";
    var pick = {};
    raw.split(",").forEach(function (pair) {
      var i = pair.indexOf(":");
      if (i > 0) pick[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
    });
    if (fromUrl) buildsView = "custom";
    return pick;
  }

  function customPickString() {
    return CUSTOM_SLOTS.filter(function (s) { return customPick[s.slot]; })
      .map(function (s) { return s.slot + ":" + encodeURIComponent(customPick[s.slot]); })
      .join(",");
  }

  function saveCustomPick() {
    storeSet("customBuild", customPickString() || null);
  }

  function buildsSwitch() {
    var wrap = document.createElement("div");
    wrap.className = "builds-switch";
    wrap.setAttribute("role", "tablist");
    [["recommended", "Recommended"], ["custom", "Build your own"]].forEach(function (v) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "builds-switch__btn" + (buildsView === v[0] ? " is-on" : "");
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", buildsView === v[0] ? "true" : "false");
      b.textContent = v[1];
      b.addEventListener("click", function () {
        if (buildsView === v[0]) return;
        buildsView = v[0];
        storeSet("buildsView", buildsView);
        renderBuilds();
      });
      wrap.appendChild(b);
    });
    return wrap;
  }

  function loadPartsCatalog() {
    return fetch("data/parts-catalog.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        partsCatalog = data && data.slots ? data : { slots: {}, parts: {} };
      })
      .catch(function () {
        partsCatalog = partsCatalog || { slots: {}, parts: {}, failed: true };
      })
      .then(function () {
        if (activeFilter === BUILDS_MODE && buildsView === "custom") renderBuilds();
      });
  }

  function pickedParts() {
    var out = {};
    var parts = (partsCatalog && partsCatalog.parts) || {};
    CUSTOM_SLOTS.forEach(function (s) {
      var id = customPick[s.slot];
      if (id && parts[id]) out[s.slot] = parts[id];
    });
    return out;
  }

  // Does part `p` (for `slot`) work with everything else already picked?
  function customFits(slot, p, sel) {
    var cpu = slot === "cpu" ? p : sel.cpu;
    var board = slot === "board" ? p : sel.board;
    var ram = slot === "ram" ? p : sel.ram;
    var gpu = slot === "gpu" ? p : sel.gpu;
    var psu = slot === "psu" ? p : sel.psu;
    var kase = slot === "case" ? p : sel["case"];
    if (cpu && board && cpu.sock !== board.sock) return false;
    if (board && ram && board.mem !== ram.mem) return false;
    if (cpu && ram && !board && (SOCKET_MEMORY[cpu.sock] || []).indexOf(ram.mem) === -1) return false;
    if (board && kase && (kase.fits || []).indexOf(board.size) === -1) return false;
    if (gpu && psu && gpu.need > psu.w) return false;
    return true;
  }

  function optionGroupKey(slot, p) {
    if (slot === "cpu" || slot === "board") return SOCKET_LABEL[p.sock] || p.sock || "";
    if (slot === "ram") return p.mem || "";
    return "";
  }

  function customRowHtml(def, sel, parts) {
    var picked = sel[def.slot];
    var cat = BUILD_ROLE_CATEGORY[def.label] || "";
    var others = {};
    Object.keys(sel).forEach(function (k) {
      if (k !== def.slot) others[k] = sel[k];
    });
    var ids = ((partsCatalog.slots || {})[def.slot] || []).filter(function (id) {
      return parts[id] && customFits(def.slot, parts[id], others);
    });
    var groups = {};
    var order = [];
    ids.forEach(function (id) {
      var g = optionGroupKey(def.slot, parts[id]);
      if (!groups[g]) {
        groups[g] = [];
        order.push(g);
      }
      groups[g].push(id);
    });
    order.sort();
    var optHtml = function (id) {
      var o = parts[id];
      return (
        '<option value="' + escapeAttr(id) + '"' + (picked && picked.id === id ? " selected" : "") + ">" +
        escapeHtml(formatMoney(Number(o.price)) + " · " + shortOption(o.name) + (partOnSale(o) ? " · sale" : "")) +
        "</option>"
      );
    };
    var select =
      '<select data-slot="' + escapeAttr(def.slot) + '" aria-label="Choose ' + escapeAttr(def.noun) + '">' +
      '<option value="">' +
      escapeHtml((picked ? "Change " : "Choose ") + def.noun + " (" + ids.length + " option" + (ids.length === 1 ? "" : "s") + ")") +
      "</option>" +
      order
        .map(function (g) {
          var inner = groups[g].map(optHtml).join("");
          return g ? '<optgroup label="' + escapeAttr(g) + '">' + inner + "</optgroup>" : inner;
        })
        .join("") +
      "</select>";
    var body;
    if (picked) {
      var thumb = picked.image
        ? '<img src="' + escapeAttr(cardImageSrc(picked.image)) + '" data-full="' + escapeAttr(picked.image) +
          '" data-cat="' + escapeAttr(cat) + '" alt="" loading="lazy" decoding="async">'
        : categoryIconSvg(cat, "build-part__icon");
      var sale = partOnSale(picked);
      body =
        '<span class="build-part__thumb">' + thumb + "</span>" +
        '<span class="build-part__info">' +
        '<span class="build-part__role">' + escapeHtml(def.label) +
        (picked.merchant ? " · " + escapeHtml(picked.merchant) : "") + " · " +
        (sale ? '<span class="build-part__sale">on sale</span>' : "regular price") + "</span>" +
        '<a class="build-part__name" href="' + escapeAttr(picked.url) + '" target="_blank" rel="noopener noreferrer">' +
        escapeHtml(picked.name) + "</a>" +
        '<span class="build-part__swap custom-row__controls">' + select +
        '<button type="button" class="custom-row__clear" data-clear="' + escapeAttr(def.slot) + '" aria-label="Remove ' +
        escapeAttr(def.label) + '">Remove</button></span>' +
        "</span>" +
        '<span class="build-part__price">' + escapeHtml(formatMoney(Number(picked.price))) +
        (sale ? '<span class="build-part__was">' + escapeHtml(formatMoney(Number(picked.previousPrice))) + "</span>" : "") +
        "</span>";
    } else {
      body =
        '<span class="build-part__thumb build-part__thumb--empty">' + categoryIconSvg(cat, "build-part__icon") + "</span>" +
        '<span class="build-part__info">' +
        '<span class="build-part__role">' + escapeHtml(def.label) + "</span>" +
        '<span class="build-part__swap">' + select + "</span>" +
        (ids.length ? "" : '<span class="custom-row__none">Nothing fits your other picks. Remove one to see more.</span>') +
        "</span>" +
        '<span class="build-part__price custom-row__empty">—</span>';
    }
    return '<li class="build-part custom-row' + (picked ? "" : " is-empty") + '">' + body + "</li>";
  }

  function customWarnings(sel) {
    var w = [];
    var missing = CUSTOM_SLOTS.filter(function (s) {
      if (s.slot === "cooler") return false;
      return !sel[s.slot];
    }).map(function (s) { return s.label.toLowerCase(); });
    if (sel.cpu && !sel.cpu.boxed && !sel.cooler) w.push("This processor has no cooler in the box. Pick a CPU cooler.");
    if (sel.cpu && sel.cpu.boxed && !sel.cooler) w.push("The processor comes with its own cooler.");
    if (sel.gpu && !sel.psu) w.push("This graphics card needs a power supply of at least " + sel.gpu.need + "W.");
    if (sel.cooler && sel.cpu) w.push("Make sure the cooler lists " + (SOCKET_LABEL[sel.cpu.sock] || sel.cpu.sock) + " support (most current coolers do).");
    if (sel.gpu && sel["case"]) w.push("Check that the graphics card fits the case before buying.");
    if (missing.length && missing.length < 7) w.push("Still to pick: " + missing.join(", ") + ".");
    return w;
  }

  function renderCustom() {
    if (!partsCatalog) {
      var wait = document.createElement("p");
      wait.className = "status";
      wait.textContent = "Loading parts…";
      dealsEl.appendChild(wait);
      loadPartsCatalog();
      return;
    }
    if (partsCatalog.failed) {
      var err = document.createElement("p");
      err.className = "status status--error";
      err.textContent = "Couldn’t load parts. Try again in a moment.";
      dealsEl.appendChild(err);
      return;
    }
    var parts = partsCatalog.parts || {};
    var sel = pickedParts();
    var chosen = Object.keys(sel).map(function (k) { return sel[k]; });
    var total = chosen.reduce(function (t, p) { return t + Number(p.price || 0); }, 0);
    var was = chosen.reduce(function (t, p) {
      return t + (partOnSale(p) ? Number(p.previousPrice) : Number(p.price || 0));
    }, 0);
    var save = Math.max(0, was - total);
    var card = document.createElement("article");
    card.className = "build-card custom-build";
    var warnings = customWarnings(sel);
    card.innerHTML =
      '<header class="build-card__head">' +
      "<div>" +
      '<p class="build-card__eyebrow">Build your own</p>' +
      '<h2 class="build-card__title">' +
      escapeHtml(sel.cpu && sel.gpu ? shortPartName(sel.cpu.name) + " + " + shortPartName(sel.gpu.name) : "Your gaming PC") +
      "</h2>" +
      '<p class="build-card__meta">' +
      (chosen.length
        ? chosen.length + " part" + (chosen.length === 1 ? "" : "s") + " · " + chosen.filter(partOnSale).length + " on sale" +
          ' · <button type="button" class="build-card__reset" data-act="share">Copy share link</button>' +
          ' · <button type="button" class="build-card__reset" data-act="clear">Start over</button>'
        : "Pick parts in any order. Every list only shows parts that fit your other picks.") +
      "</p>" +
      "</div>" +
      '<div class="build-card__total">' +
      '<span class="build-card__price">' + escapeHtml(formatMoney(Math.round(total * 100) / 100)) + "</span>" +
      (save > 0.5 ? '<span class="deal-card__badge">save ' + escapeHtml(formatMoney(Math.round(save))) + "</span>" : "") +
      "</div>" +
      "</header>" +
      '<ol class="build-card__parts">' +
      CUSTOM_SLOTS.map(function (def) { return customRowHtml(def, sel, parts); }).join("") +
      "</ol>" +
      (warnings.length
        ? '<ul class="build-card__notes">' + warnings.map(function (n) { return "<li>" + escapeHtml(n) + "</li>"; }).join("") + "</ul>"
        : "");
    card.querySelectorAll("select[data-slot]").forEach(function (sl) {
      sl.addEventListener("change", function () {
        if (!sl.value) return;
        customPick[sl.getAttribute("data-slot")] = sl.value;
        saveCustomPick();
        rerenderCustomKeepingFocus(sl.getAttribute("data-slot"));
      });
    });
    card.querySelectorAll("[data-clear]").forEach(function (b) {
      b.addEventListener("click", function () {
        delete customPick[b.getAttribute("data-clear")];
        saveCustomPick();
        rerenderCustomKeepingFocus(b.getAttribute("data-clear"));
      });
    });
    card.querySelectorAll(".build-part__thumb img").forEach(function (img) {
      img.addEventListener("error", function onErr() {
        var full = img.getAttribute("data-full");
        if (full && img.getAttribute("src") !== full) {
          img.setAttribute("src", full);
          return;
        }
        img.removeEventListener("error", onErr);
        img.outerHTML = categoryIconSvg(img.getAttribute("data-cat") || "", "build-part__icon");
      });
    });
    var actions = card.querySelectorAll("[data-act]");
    actions.forEach(function (b) {
      b.addEventListener("click", function () {
        if (b.getAttribute("data-act") === "clear") {
          customPick = {};
          saveCustomPick();
          renderBuilds();
          return;
        }
        var link = location.origin + location.pathname + "?tab=Builds&build=" + customPickString();
        var done = function () { showToast("Link copied"); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(done, function () { window.prompt("Copy this link", link); });
        } else {
          window.prompt("Copy this link", link);
        }
      });
    });
    dealsEl.appendChild(card);
  }

  function rerenderCustomKeepingFocus(slot) {
    var y = window.scrollY;
    renderBuilds();
    try {
      window.scrollTo(0, y);
      var el = dealsEl.querySelector('select[data-slot="' + slot + '"]');
      if (el) el.focus({ preventScroll: true });
    } catch (e) {}
  }

  // ---------------------------------------------------------------- Price history
  // data/price-history.json stores only price changes ([hour, price]; a price
  // holds until the next change) plus the last hour each product was seen.
  // Drawn as a step chart like Amazon / camelcamelcamel.
  var priceHistoryData = null;
  var priceHistoryLoading = null;
  var DAY_MS = 86400000;

  function loadPriceHistory() {
    if (priceHistoryData) return Promise.resolve(priceHistoryData);
    if (!priceHistoryLoading) {
      priceHistoryLoading = fetch("data/price-history.json?t=" + Date.now(), { cache: "no-store" })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (data) {
          priceHistoryData = data && data.items ? data : { items: {} };
          return priceHistoryData;
        })
        .catch(function () {
          priceHistoryLoading = null;
          return { items: {}, failed: true };
        });
    }
    return priceHistoryLoading;
  }

  function dayLabel(day, withYear) {
    return new Date(day * DAY_MS).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: withYear ? "numeric" : undefined,
      timeZone: "UTC"
    });
  }

  // points: [[day (fractional), price], ...] change points; endDay: last seen
  function historyChartSvg(points, range, listPrice, endDay) {
    var today = Date.now() / DAY_MS;
    var start = today - range;
    var inRange = points.filter(function (p) { return p[0] >= start; });
    // carry the last price from before the window in, so the line starts at the left edge
    var before = points.filter(function (p) { return p[0] < start; });
    if (before.length && before[before.length - 1][1] != null) {
      inRange.unshift([start, before[before.length - 1][1], true]);
    }
    if (!inRange.length) return { svg: "", pts: [] };
    var W = 640, H = 230, L = 58, R = 14, T = 14, B = 30;
    var prices = inRange.filter(function (p) { return p[1] != null; }).map(function (p) { return p[1]; });
    if (!prices.length) return { svg: "", pts: [] };
    if (Number.isFinite(listPrice) && listPrice > 0) prices.push(listPrice);
    var lo = Math.min.apply(null, prices), hi = Math.max.apply(null, prices);
    var pad = Math.max((hi - lo) * 0.12, hi * 0.02, 1);
    lo = Math.max(0, lo - pad);
    hi = hi + pad;
    var x = function (d) { return L + ((d - start) / Math.max(1, today - start)) * (W - L - R); };
    var y = function (v) { return T + (1 - (v - lo) / (hi - lo)) * (H - T - B); };
    // step line; a null price is a stretch nobody checked, drawn as a break
    var path = "", area = "", segStart = null, open = false;
    var closeSeg = function (endX) {
      if (!open) return;
      path += "H" + endX.toFixed(1);
      area += "H" + endX.toFixed(1) + "V" + (H - B) + "H" + segStart.toFixed(1) + "Z";
      open = false;
    };
    inRange.forEach(function (p) {
      var px = x(p[0]);
      if (p[1] == null) {
        closeSeg(px);
        return;
      }
      var py = y(p[1]).toFixed(1);
      if (!open) {
        path += "M" + px.toFixed(1) + " " + py;
        area += "M" + px.toFixed(1) + " " + py;
        segStart = px;
        open = true;
      } else {
        path += "H" + px.toFixed(1) + "V" + py;
        area += "H" + px.toFixed(1) + "V" + py;
      }
    });
    closeSeg(x(Math.min(endDay, today))); // held until last checked
    var grid = "";
    for (var g = 0; g <= 3; g++) {
      var v = lo + ((hi - lo) * g) / 3;
      var gy = y(v).toFixed(1);
      grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + gy + '" y2="' + gy + '" class="ph-grid"/>' +
        '<text x="' + (L - 8) + '" y="' + (Number(gy) + 4) + '" class="ph-axis" text-anchor="end">' +
        escapeHtml(formatMoney(Math.round(v))) + "</text>";
    }
    var ticks = "";
    var step = range <= 30 ? 7 : 30;
    for (var d = Math.floor(today); d >= start; d -= step) {
      ticks += '<text x="' + x(d).toFixed(1) + '" y="' + (H - 8) + '" class="ph-axis" text-anchor="middle">' +
        escapeHtml(dayLabel(d)) + "</text>";
    }
    var listLine = Number.isFinite(listPrice) && listPrice > 0
      ? '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(listPrice).toFixed(1) + '" y2="' + y(listPrice).toFixed(1) +
        '" class="ph-list"/><text x="' + (W - R) + '" y="' + (y(listPrice) - 6).toFixed(1) +
        '" class="ph-axis ph-list-label" text-anchor="end">Store’s “was” price ' + escapeHtml(formatMoney(listPrice)) + "</text>"
      : "";
    var dots = inRange.filter(function (p) { return !p[2] && p[1] != null; }).map(function (p) {
      return '<circle cx="' + x(p[0]).toFixed(1) + '" cy="' + y(p[1]).toFixed(1) + '" r="3" class="ph-dot"/>';
    }).join("");
    var svg =
      '<svg class="ph-chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Price over the last ' + range + ' days">' +
      grid + ticks + listLine +
      '<path d="' + area + '" class="ph-area"/>' +
      '<path d="' + path + '" class="ph-line"/>' + dots +
      '<line class="ph-cursor" x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '" visibility="hidden"/>' +
      "</svg>";
    return {
      svg: svg,
      pts: inRange.filter(function (p) { return !p[2] && p[1] != null; }).map(function (p, i) {
        return { day: p[0], price: p[1], x: x(p[0]) / W, first: i === 0 && p[0] === points[0][0] };
      })
    };
  }

  // Lowest / highest / usual (held longest) price between two days.
  function heldStats(points, start, end) {
    var held = {};
    points.forEach(function (p, i) {
      var nxt = i + 1 < points.length ? points[i + 1][0] : end;
      var a = Math.max(p[0], start), b = Math.min(nxt, end);
      if (b > a && p[1] != null) held[p[1]] = (held[p[1]] || 0) + (b - a);
    });
    var prices = Object.keys(held).map(Number);
    if (!prices.length) return null;
    var usual = prices.reduce(function (best, v) {
      return held[v] > held[best] || (held[v] === held[best] && v < best) ? v : best;
    }, prices[0]);
    return { low: Math.min.apply(null, prices), high: Math.max.apply(null, prices), usual: usual };
  }

  function openPriceHistory(deal, opener) {
    var old = document.querySelector(".ph-modal");
    if (old) old.remove();
    var modal = document.createElement("div");
    modal.className = "ph-modal";
    modal.innerHTML =
      '<div class="ph-dialog" role="dialog" aria-modal="true" aria-labelledby="ph-title">' +
      '<button type="button" class="ph-close" aria-label="Close">×</button>' +
      '<p class="ph-eyebrow">Price history</p>' +
      '<h2 class="ph-title" id="ph-title">' + escapeHtml(deal.name) + "</h2>" +
      '<div class="ph-body"><p class="status">Loading price history…</p></div>' +
      "</div>";
    document.body.appendChild(modal);
    document.documentElement.classList.add("ph-open");
    var close = function () {
      modal.remove();
      document.documentElement.classList.remove("ph-open");
      document.removeEventListener("keydown", onKey);
      if (opener) {
        try { opener.focus(); } catch (e) {}
      }
    };
    var onKey = function (e) {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (e.key !== "Tab") return;
      // keep keyboard focus inside the window while it's open
      var focusables = Array.prototype.filter.call(
        modal.querySelectorAll("button, a[href], [tabindex]:not([tabindex='-1'])"),
        function (el) { return !el.disabled && el.offsetParent !== null; }
      );
      if (!focusables.length) return;
      var first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    modal.addEventListener("click", function (e) {
      if (e.target === modal) close();
    });
    modal.querySelector(".ph-close").addEventListener("click", close);
    try { modal.querySelector(".ph-close").focus(); } catch (e) {}

    loadPriceHistory().then(function (data) {
      var body = modal.querySelector(".ph-body");
      if (!body) return;
      var key = String(deal.sku || "").toUpperCase();
      var points = ((data.items || {})[key] || []).map(function (p) { return [p[0] / 24, p[1]]; });
      var endDay = ((data.seen || {})[key] || 0) / 24 + 1 / 24;
      if (data.failed || !points.length) {
        var adv0 = buyAdvice(deal);
        body.innerHTML = (adv0 ? '<p class="ph-advice ph-advice--' + adv0.tone + '">' + escapeHtml(adv0.text) + "</p>" : "") +
          '<p class="status">' +
          (data.failed ? "Couldn’t load price history. Try again in a moment." :
            "No price history yet. We check this price every hour, so the chart starts filling in from today.") +
          "</p>";
        return;
      }
      var range = Date.now() / DAY_MS - points[0][0] > 30 ? 90 : 30;
      var draw = function () {
        var today = Date.now() / DAY_MS;
        var lastKnown = Number(deal.price);
        var st = heldStats(points, today - range, Math.min(endDay, today)) ||
          { low: lastKnown, high: lastKnown, usual: lastKnown };
        var low = st.low, high = st.high, typical = st.usual;
        var chart = historyChartSvg(points, range, Number(deal.previousPrice), endDay);
        var since = points[0][0];
        var tracked = Math.floor(today - since) + 1;
        var lowAt = null;
        points.forEach(function (p) {
          if (p[1] != null && p[1] === low && p[0] >= today - range - 1) lowAt = lowAt == null ? p[0] : lowAt;
        });
        var verdict = "";
        if (deal.lowest30) verdict = "Today’s price is the lowest in the last 30 days.";
        else if (deal.wasUnseen) verdict = "The store’s “was” price of " + formatMoney(deal.previousPrice) +
          " is higher than anything we saw it charge in the last 30 days, so the discount may be overstated.";
        else if (Number(deal.price) > low) verdict = "It has been cheaper recently: " + formatMoney(low) +
          (lowAt != null ? " on " + dayLabel(Math.max(lowAt, today - range)) : "") + ".";
        var advice = buyAdvice(deal);
        body.innerHTML =
          (advice ? '<p class="ph-advice ph-advice--' + advice.tone + '">' + escapeHtml(advice.text) + "</p>" : "") +
          '<div class="ph-range" role="group" aria-label="Time range">' +
          [30, 90].map(function (r) {
            return '<button type="button" data-range="' + r + '" class="' + (r === range ? "is-on" : "") +
              '" aria-pressed="' + (r === range) + '">' + r + " days</button>";
          }).join("") +
          "</div>" +
          '<div class="ph-chart-wrap">' + chart.svg + '<div class="ph-tip" hidden></div></div>' +
          '<dl class="ph-stats">' +
          "<div><dt>Now</dt><dd>" + escapeHtml(formatMoney(Number(deal.price))) + "</dd></div>" +
          "<div><dt>Lowest</dt><dd>" + escapeHtml(formatMoney(low)) + "</dd></div>" +
          "<div><dt>Usual</dt><dd>" + escapeHtml(formatMoney(typical)) + "</dd></div>" +
          "<div><dt>Highest</dt><dd>" + escapeHtml(formatMoney(high)) + "</dd></div>" +
          "</dl>" +
          (verdict ? '<p class="ph-verdict">' + escapeHtml(verdict) + "</p>" : "") +
          '<p class="ph-note">Price at ' + escapeHtml(deal.merchant || "the store") +
          ", checked hourly; dots mark price changes, and breaks in the line are stretches we weren’t checking. " +
          "“Usual” is the price it sat at longest. Tracking since " +
          escapeHtml(dayLabel(since, true)) +
          (tracked < 14 ? ". The chart fills in as more days are recorded." : ".") + "</p>";
        body.querySelectorAll("[data-range]").forEach(function (b) {
          b.addEventListener("click", function () {
            range = Number(b.getAttribute("data-range"));
            draw();
          });
        });
        var wrap = body.querySelector(".ph-chart-wrap");
        var svg = wrap.querySelector("svg");
        var tip = wrap.querySelector(".ph-tip");
        var cursor = svg && svg.querySelector(".ph-cursor");
        var move = function (e) {
          if (!svg || !chart.pts.length) return;
          var rect = svg.getBoundingClientRect();
          var fx = (e.clientX - rect.left) / rect.width;
          var best = chart.pts[0];
          chart.pts.forEach(function (p) {
            if (Math.abs(p.x - fx) < Math.abs(best.x - fx)) best = p;
          });
          tip.hidden = false;
          tip.textContent = (best.first ? "From " : "Changed to ") + formatMoney(best.price) + " · " + dayLabel(best.day);
          tip.style.left = Math.min(Math.max(best.x * 100, 12), 88) + "%";
          cursor.setAttribute("x1", (best.x * 640).toFixed(1));
          cursor.setAttribute("x2", (best.x * 640).toFixed(1));
          cursor.setAttribute("visibility", "visible");
        };
        if (svg) {
          svg.addEventListener("pointermove", move);
          svg.addEventListener("pointerdown", move);
          svg.addEventListener("pointerleave", function () {
            tip.hidden = true;
            cursor.setAttribute("visibility", "hidden");
          });
        }
      };
      draw();
    });
  }

  // The address and page title follow the open tab, so a tab can be shared or
  // bookmarked and search engines see a distinct page per category.
  var TAB_TITLES = {
    Builds: "Gaming PC builds from today’s prices",
    "Best Value": "Best value graphics cards & processors",
    Future: "Upcoming tech sales",
    Saved: "Saved deals",
    Search: "Search deals"
  };

  function syncTabTitle() {
    var base = "What's A Good Deal?";
    var f = activeFilter;
    // "GPUs" → "GPU deals"; "Headphones" → "Deals on Headphones"
    var label = TAB_TITLES[f] || (/^[A-Z]{2,4}s$/.test(f) ? f.slice(0, -1) + " deals" : "Deals on " + f);
    var t = f && f !== "All" ? label + " · " + base : base;
    if (document.title !== t) document.title = t;
  }

  function syncTabUrl() {
    syncTabTitle();
    try {
      var params = new URLSearchParams(location.search || "");
      if (!activeFilter || activeFilter === "All" || activeFilter === SEARCH_MODE) params.delete("tab");
      else params.set("tab", activeFilter);
      if (activeFilter !== BUILDS_MODE) params.delete("build");
      var q = params.toString();
      history.replaceState(null, "", location.pathname + (q ? "?" + q : "") + location.hash);
    } catch (e) {}
  }

  // ---------------------------------------------------------------- Saved deals
  // Kept on this device only: { dealId: { price, at, name } }
  var savedCache = null;

  function savedDeals() {
    if (savedCache) return savedCache;
    try {
      savedCache = JSON.parse(storeGet("saved") || "{}") || {};
    } catch (e) {
      savedCache = {};
    }
    return savedCache;
  }

  function savedCount() {
    return Object.keys(savedDeals()).length;
  }

  function toggleSaved(deal) {
    var saved = savedDeals();
    var on;
    if (saved[deal.id]) {
      delete saved[deal.id];
      on = false;
    } else {
      saved[deal.id] = { price: Number(deal.price), at: new Date().toISOString(), name: deal.name };
      on = true;
    }
    storeSet("saved", JSON.stringify(saved));
    return on;
  }

  // ---------------------------------------------------------------- Black Friday
  // Black Friday = the day after US Thanksgiving (4th Thursday of November);
  // the sale season runs through Cyber Monday.
  function blackFriday(year) {
    var d = new Date(Date.UTC(year, 10, 1));
    var firstThu = 1 + ((4 - d.getUTCDay() + 7) % 7);
    return new Date(year, 10, firstThu + 21 + 1); // local midnight, Friday
  }

  function saleSeason(now) {
    now = now || new Date();
    var bf = blackFriday(now.getFullYear());
    var cyberEnd = new Date(bf.getFullYear(), bf.getMonth(), bf.getDate() + 4); // after Cyber Monday
    if (now >= cyberEnd) bf = blackFriday(now.getFullYear() + 1);
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var days = Math.round((bf - today) / 86400000);
    return {
      date: bf,
      days: days,
      live: now >= bf && now < cyberEnd,
      soon: days > 0 && days <= 21,
      label: bf.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    };
  }

  function renderSaleBanner() {
    var el = document.getElementById("sale-banner");
    if (!el) return;
    var season = saleSeason();
    var key = "saleBannerHidden:" + season.date.getFullYear();
    if ((!season.soon && !season.live) || storeGet(key)) {
      el.hidden = true;
      return;
    }
    el.innerHTML =
      '<span class="sale-banner__text">' +
      (season.live
        ? "<strong>Black Friday sales are on now</strong> through Cyber Monday."
        : "<strong>Black Friday is in " + season.days + " day" + (season.days === 1 ? "" : "s") + "</strong> (" +
          escapeHtml(season.label) + "). Tech prices often drop then.") +
      "</span>" +
      '<button type="button" class="sale-banner__link" data-go-future>' +
      (season.live ? "See sales" : "See announced sales") + "</button>" +
      '<button type="button" class="sale-banner__close" aria-label="Hide this message">×</button>';
    el.hidden = false;
    el.querySelector(".sale-banner__close").addEventListener("click", function () {
      storeSet(key, "1");
      el.hidden = true;
    });
    el.querySelector("[data-go-future]").addEventListener("click", function () {
      var chip = Array.prototype.find.call(document.querySelectorAll(".filter-btn"), function (b) {
        return b.textContent === "Future";
      });
      if (chip) {
        chip.click();
        try { (document.getElementById("filters") || chip).scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) {}
      }
    });
  }

  // Buy now or wait? From the product's price history and the sale calendar.
  function buyAdvice(deal) {
    var season = saleSeason();
    var usual = Number(deal.typical30);
    var belowUsual = Number(deal.trackedDays30) >= 7 && usual > 0 && usual - Number(deal.price) >= Math.max(5, usual * 0.03);
    if (deal.lowest30) return { tone: "good", text: "Good time to buy: this is its lowest price in 30 days." };
    if (season.live) return { tone: "good", text: "Black Friday sales are on now. Check it against its price history below." };
    if (deal.wasUnseen) return { tone: "warn", text: "Careful: the store’s “was” price is higher than anything we saw it charge in 30 days, so the discount may be overstated." };
    if (belowUsual) return { tone: "good", text: "Below its usual price of " + formatMoney(usual) + "." };
    if (season.soon) {
      return {
        tone: "wait",
        text: "Black Friday is " + season.days + " day" + (season.days === 1 ? "" : "s") + " away (" + season.label +
          "). Tech prices often drop then, so if this can wait, it may be worth checking back."
      };
    }
    return null;
  }

  // Rough "what can it play" guide from a graphics card's relative score
  // (scripts/build_pcs.py GPU_SCORES; fastest current card = 100).
  function gpuGuide(score) {
    score = Number(score);
    if (!Number.isFinite(score) || score <= 0) return "";
    if (score >= 90) return "4K at ultra settings";
    if (score >= 70) return "4K at high settings";
    if (score >= 58) return "1440p ultra, 4K at medium";
    if (score >= 45) return "1440p at high settings";
    if (score >= 36) return "1080p ultra, 1440p at medium";
    if (score >= 26) return "1080p at high settings";
    return "1080p at medium settings";
  }

  // "Just dropped": real price drops found by the hourly checks (kept 24 h),
  // shown on the All tab once there are at least three.
  function justDroppedStrip(deals) {
    var drops = deals.filter(function (d) {
      return d.priceDropped && Number(d.dropAmount) >= 5 && !d.startsAt && d.url;
    }).sort(function (a, b) {
      return Number(b.dropAmount) / Number(b.price) - Number(a.dropAmount) / Number(a.price);
    }).slice(0, 10);
    if (drops.length < 3) return null;
    var wrap = document.createElement("section");
    wrap.className = "drops";
    wrap.setAttribute("aria-label", "Just dropped");
    wrap.innerHTML =
      '<h2 class="drops__title">Just dropped <span>price cuts found in the last 24 hours</span></h2>' +
      '<div class="drops__row">' +
      drops.map(function (d) {
        var cat = normalizeCategory(d.category) || d.category || "";
        return (
          '<a class="drop-chip" href="' + escapeAttr(d.url) + '" target="_blank" rel="noopener noreferrer">' +
          '<span class="build-part__thumb">' +
          (d.image
            ? '<img src="' + escapeAttr(cardImageSrc(d.image)) + '" alt="" loading="lazy" decoding="async" ' +
              'onerror="this.style.visibility=\'hidden\'">'
            : categoryIconSvg(cat, "build-part__icon")) +
          "</span>" +
          '<span class="drop-chip__info"><span class="drop-chip__name">' + escapeHtml(shortOption(d.name)) + "</span>" +
          '<span class="drop-chip__price">' + escapeHtml(formatMoney(Number(d.price))) +
          ' <b>↓ ' + escapeHtml(formatMoney(Number(d.dropAmount))) + "</b></span></span></a>"
        );
      }).join("") +
      "</div>";
    return wrap;
  }

  // ---------------------------------------------------------------- Best Value tab
  // Graphics cards and processors ranked by gaming performance per dollar at
  // today's lowest price (scripts/value.py, rebuilt hourly).
  function loadValue() {
    return fetch("data/value.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        valueData = data && data.gpu ? data : { failed: true };
        valueRankById = {};
        ["gpu", "cpu"].forEach(function (k) {
          ((valueData[k] || {}).rows || []).slice(0, 10).forEach(function (r, i) {
            if (r.id) valueRankById[r.id] = i + 1;
          });
        });
      })
      .catch(function () {
        valueData = { failed: true };
      })
      .then(function () {
        if (activeFilter === VALUE_MODE) renderValue();
        else if (activeFilter !== BUILDS_MODE && activeFilter !== SEARCH_MODE && Object.keys(valueRankById).length &&
                 document.querySelector(".deal-card")) {
          renderDeals(allDeals); // add the Best value badges to the cards on screen
        }
      });
  }

  function valueSwitch() {
    var wrap = document.createElement("div");
    wrap.className = "builds-switch";
    wrap.setAttribute("role", "tablist");
    [["gpu", "Graphics cards"], ["cpu", "Processors"]].forEach(function (v) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "builds-switch__btn" + (valueKind === v[0] ? " is-on" : "");
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", valueKind === v[0] ? "true" : "false");
      b.textContent = v[1];
      b.addEventListener("click", function () {
        if (valueKind === v[0]) return;
        valueKind = v[0];
        renderValue();
      });
      wrap.appendChild(b);
    });
    return wrap;
  }

  function renderValue() {
    dealsRenderSeq++;
    if (dealsPager) { dealsPager.disconnect(); dealsPager = null; }
    dealsEl.innerHTML = "";
    if (!valueData) {
      dealsEl.setAttribute("aria-busy", "true");
      var wait = document.createElement("p");
      wait.className = "status";
      wait.textContent = "Loading rankings…";
      dealsEl.appendChild(wait);
      loadValue();
      return;
    }
    dealsEl.setAttribute("aria-busy", "false");
    if (valueData.failed) {
      var err = document.createElement("p");
      err.className = "status status--error";
      err.textContent = "Couldn’t load the rankings. Try again in a moment.";
      dealsEl.appendChild(err);
      return;
    }
    var set = valueData[valueKind] || { rows: [], picks: [] };
    var rows = set.rows || [];
    var noun = valueKind === "gpu" ? "graphics card" : "processor";
    dealsEl.appendChild(valueSwitch());
    var intro = document.createElement("p");
    intro.className = "builds-intro";
    intro.textContent =
      "Which " + noun + " gives you the most gaming performance for your money right now? " +
      "Each model at its lowest price today, ranked by performance per dollar. Rebuilt every hour.";
    dealsEl.appendChild(intro);
    if (!rows.length) {
      var none = document.createElement("p");
      none.className = "status";
      none.textContent = "Not enough prices to rank yet. Check back after the next hourly price check.";
      dealsEl.appendChild(none);
      return;
    }
    var byModel = {};
    rows.forEach(function (r) { byModel[r.model] = r; });
    if ((set.picks || []).length) {
      var picks = document.createElement("div");
      picks.className = "value-picks";
      set.picks.forEach(function (pk) {
        var r = byModel[pk.model];
        var a = document.createElement(r ? "a" : "div");
        a.className = "value-pick";
        if (r) {
          a.href = r.url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
        }
        a.innerHTML =
          '<span class="value-pick__label">Fastest under $' + escapeHtml(Number(pk.limit).toLocaleString("en-US")) + "</span>" +
          '<span class="value-pick__model">' + escapeHtml(pk.model) + "</span>" +
          (r ? '<span class="value-pick__price">' + escapeHtml(formatMoney(r.price)) + "</span>" : "");
        picks.appendChild(a);
      });
      dealsEl.appendChild(picks);
    }
    var top = rows[0].value;
    var card = document.createElement("article");
    card.className = "build-card value-card";
    card.innerHTML =
      '<ol class="value-list">' +
      rows.map(function (r, i) {
        var pct = Math.max(4, Math.round((r.value / top) * 100));
        var sale = r.previousPrice && r.previousPrice > r.price;
        var cat = valueKind === "gpu" ? "GPUs" : "CPUs";
        var thumb = r.image
          ? '<img src="' + escapeAttr(cardImageSrc(r.image)) + '" data-full="' + escapeAttr(r.image) +
            '" data-cat="' + cat + '" alt="" loading="lazy" decoding="async">'
          : categoryIconSvg(cat, "build-part__icon");
        return (
          '<li class="value-row">' +
          '<span class="value-row__rank">' + (i + 1) + "</span>" +
          '<span class="build-part__thumb">' + thumb + "</span>" +
          '<span class="value-row__info">' +
          '<a class="value-row__model" href="' + escapeAttr(r.url) + '" target="_blank" rel="noopener noreferrer">' +
          escapeHtml(r.model) + "</a>" +
          '<span class="value-row__bar" role="img" aria-label="Value ' + pct + '% of the best">' +
          '<span style="width:' + pct + '%"></span></span>' +
          '<span class="value-row__meta">' +
          escapeHtml(Math.round(r.score) + "/100 performance · " + r.value.toFixed(1) + " pts per $100 · " + r.merchant) +
          (valueKind === "gpu" && gpuGuide(r.score)
            ? '<span class="value-row__guide"> · Good for ' + escapeHtml(gpuGuide(r.score)) + "</span>"
            : "") +
          (sale ? ' · <span class="build-part__sale">on sale</span>' : "") +
          "</span>" +
          "</span>" +
          '<span class="build-part__price">' + escapeHtml(formatMoney(r.price)) +
          (sale ? '<span class="build-part__was">' + escapeHtml(formatMoney(r.previousPrice)) + "</span>" : "") +
          "</span>" +
          "</li>"
        );
      }).join("") +
      "</ol>" +
      '<p class="value-note">Performance is our approximate relative gaming score (fastest current ' + noun +
      " = 100), not a benchmark of your games. Prices are the lowest we found for each model today; " +
      "the link opens that listing.</p>";
    card.querySelectorAll(".build-part__thumb img").forEach(function (img) {
      img.addEventListener("error", function onErr() {
        var full = img.getAttribute("data-full");
        if (full && img.getAttribute("src") !== full) {
          img.setAttribute("src", full);
          return;
        }
        img.removeEventListener("error", onErr);
        img.outerHTML = categoryIconSvg(img.getAttribute("data-cat") || "", "build-part__icon");
      });
    });
    dealsEl.appendChild(card);
  }

  function scrollTop() {
    return Math.max(
      0,
      window.scrollY ||
        document.documentElement.scrollTop ||
        document.body.scrollTop ||
        0
    );
  }

  function onScroll() {
    if (!headerEl) return;

    var scrollY = scrollTop();
    var rawProgress = Math.min(scrollY / 72, 1);
    var progress = rawProgress * rawProgress * (3 - 2 * rawProgress);

    headerEl.style.setProperty("--header-progress", String(progress));
    headerEl.classList.toggle("is-scrolled", scrollY > 4);
  }

  function setPullIndicator(distance, state) {
    if (!pullRefreshEl) return;
    var maxDistance = 112;
    var threshold = 72;
    var clamped = Math.max(0, Math.min(maxDistance, distance || 0));
    var progress = Math.min(1, clamped / threshold);
    pullRefreshEl.style.setProperty("--pull-offset", clamped * 0.62 + "px");
    pullRefreshEl.style.setProperty("--pull-progress", String(progress));
    pullRefreshEl.classList.toggle("is-pulling", state === "pulling");
    pullRefreshEl.classList.toggle("is-refreshing", state === "refreshing");
    pullRefreshEl.setAttribute("aria-hidden", state === "idle" ? "true" : "false");
    if (pullRefreshLabelEl) {
      pullRefreshLabelEl.textContent =
        state === "refreshing"
          ? "Refreshing…"
          : progress >= 1
            ? "Release to refresh"
            : "Pull to refresh";
    }
  }

  function resetPullGesture() {
    pullTracking = false;
    pullReady = false;
    pullDistance = 0;
    setPullIndicator(0, "idle");
  }

  function onTouchStart(e) {
    if (loadingDeals || lightboxOpen || !e.touches || e.touches.length !== 1) return;
    if (scrollTop() > 0) return;
    pullStartY = e.touches[0].clientY;
    pullStartX = e.touches[0].clientX;
    pullDistance = 0;
    pullReady = false;
    pullTracking = true;
  }

  function onTouchMove(e) {
    if (!pullTracking || loadingDeals || !e.touches || e.touches.length !== 1) return;
    if (scrollTop() > 0) {
      resetPullGesture();
      return;
    }

    var touch = e.touches[0];
    var dy = touch.clientY - pullStartY;
    var dx = touch.clientX - pullStartX;
    if (dy <= 0 || Math.abs(dx) > Math.abs(dy) * 1.2) {
      resetPullGesture();
      return;
    }

    // Resistance keeps the gesture useful without hijacking ordinary scrolling.
    pullDistance = Math.min(112, dy * 0.62);
    pullReady = pullDistance >= 72;
    setPullIndicator(pullDistance, "pulling");
    e.preventDefault();
  }

  function onTouchEnd() {
    if (!pullTracking) return;
    var shouldRefresh = pullReady && scrollTop() <= 1;
    resetPullGesture();
    if (shouldRefresh) loadDeals(true);
  }

  function dataUrl() {
    return "data/deals.json?t=" + Date.now();
  }

  function tabFromUrl() {
    try {
      var t = new URLSearchParams(location.search || "").get("tab");
      if (!t) return "";
      t = String(t).trim();
      if (t === "Future" || t === "All" || t === SEARCH_MODE || t === BUILDS_MODE || t === VALUE_MODE ||
          t === SAVED_MODE) return t;
      return normalizeCategory(t) || t;
    } catch (e) {
      return "";
    }
  }

  function applyDealsData(data) {
    siteUpdatedAt = data.updatedAt || null;
    allDeals = (Array.isArray(data.deals) ? data.deals : []).map(function (d) {
      var copy = Object.assign({}, d);
      copy.category = normalizeCategory(d.category) || d.category;
      return copy;
    });
    if (weekLabelEl) {
      weekLabelEl.textContent = data.updatedAt
        ? formatUpdated(data.updatedAt)
        : data.weekLabel || "Updated recently";
    }
    if (data.title) SITE_TITLE = data.title;
    var urlTab = tabFromUrl();
    if (urlTab) activeFilter = urlTab;
    syncTabTitle();
    renderFilters(allDeals);
    renderDeals(allDeals);
  }

  function loadDeals(isRefresh, opts) {
    if (loadingDeals) return Promise.resolve(false);
    var quiet = !!(opts && opts.quiet);
    loadingDeals = true;
    var previousUpdatedAt = siteUpdatedAt;
    if (isRefresh && !quiet) {
      setPullIndicator(72, "refreshing");
      dealsEl.setAttribute("aria-busy", "true");
    }

    return fetch(dataUrl(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        applyDealsData(data);
        loadBuilds();
        loadValue();
        lastDealsFetchAt = Date.now();
        if (isRefresh && !quiet) {
          var changed = previousUpdatedAt !== siteUpdatedAt;
          showToast(changed ? "Updated" : "Already up to date");
        }
        return true;
      })
      .catch(function () {
        if (isRefresh) {
          dealsEl.setAttribute("aria-busy", "false");
          if (!quiet) showToast("Couldn’t update — showing current deals");
          return false;
        }
        if (statusEl) {
          statusEl.className = "status status--error";
          statusEl.textContent = "Couldn't load deals. Try refreshing.";
        }
        dealsEl.setAttribute("aria-busy", "false");
        return false;
      })
      .then(function (ok) {
        loadingDeals = false;
        if (isRefresh && !quiet) setPullIndicator(0, "idle");
        return ok;
      });
  }

  function maybeRefreshOnReveal() {
    if (document.visibilityState && document.visibilityState !== "visible") return;
    if (!lastDealsFetchAt || Date.now() - lastDealsFetchAt < VISIBILITY_REFRESH_MS) return;
    loadDeals(true, { quiet: true });
  }

  function init() {
    initSearchUi();
    try { renderSaleBanner(); } catch (e) {}
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    if (lightboxEl) {
      closeLightbox();
      lightboxEl.addEventListener("click", function (e) {
        if (e.target === lightboxEl) closeLightbox();
      });
    }
    if (lightboxClose) lightboxClose.addEventListener("click", closeLightbox);
    if (toastEl) {
      toastEl.hidden = true;
      toastEl.classList.remove("is-on");
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && lightboxOpen) closeLightbox();
    });

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", resetPullGesture, { passive: true });
    document.addEventListener("visibilitychange", maybeRefreshOnReveal);
    window.addEventListener("focus", maybeRefreshOnReveal);
    loadDeals(false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
