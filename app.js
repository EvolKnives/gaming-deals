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
  var CATEGORY_ORDER = [
    "All",
    "Future",
    "GPUs",
    "CPUs",
    "Monitors",
    "TVs",
    "Home Theater",
    "Art Tablets",
    "PSUs",
    "Cases",
    "Motherboards",
    "RAM",
    "SSDs",
    "Phones",
    "Prebuilts",
    "Laptops",
    "Mice",
    "Keyboards"
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
    "Home Theater": "Home Theater",
    "Home theatre": "Home Theater",
    "Home theatre equipment": "Home Theater",
    HT: "Home Theater",
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
    Headset: "Home Theater",
    Headsets: "Home Theater",
    Headphone: "Home Theater",
    Headphones: "Home Theater",
    Earbuds: "Home Theater",
    Earphones: "Home Theater",
    Xbox: "Other",
    PlayStation: "Other",
    Console: "Other",
    Controller: "Other",
    Controllers: "Other",
    Gamepad: "Other"
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
    if (/^(headset|headsets|headphone|headphones)$/.test(q)) return "Home Theater";
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
    if (intent === "Home Theater") {
      return /\b(headset|headphones?|earbuds?|earphones?|soundbar|subwoofer|speaker|receiver|home\s*theat)/i.test(hay);
    }
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
      if (intent === "Home Theater" && /^(headset|headsets|headphone|headphones)$/i.test(String(query || "").trim())) {
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
    if (/\b(headset|headphones?|earbuds?|earphones?)\b/i.test(name)) guessed = "Home Theater";
    else if (/\b(xbox|playstation|\bps[45]\b|nintendo\s*switch|wireless\s*controller|gamepad)\b/i.test(name) &&
             !/\b(headset|headphones?)\b/i.test(name))
      guessed = "Other";
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
    var cats = [SEARCH_MODE, "All", "Future"];
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
        '<span class="deal-card__cat-mark">' +
        escapeHtml(normalizeCategory(deal.category) || deal.category || "Deal") +
        "</span>" +
        dropBadge +
        "</figure>";
    }

    var nearLowHtml = nearLow
      ? '<span class="deal-card__near-low" role="status">Near low</span>'
      : "";

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
      fig.innerHTML =
        '<span class="deal-card__cat-mark">' +
        escapeHtml(normalizeCategory(deal.category) || deal.category || "Deal") +
        "</span>";
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
      } else {
        empty.textContent =
          activeBudget !== "All"
            ? "No deals in this category and budget right now."
            : "No deals in this category right now.";
      }
      dealsEl.appendChild(empty);
      return;
    }

    var cards = list.map(function (d, i) {
      return buildCard(d, i);
    });
    cards.forEach(function (c) {
      dealsEl.appendChild(c);
    });
    observeReveal(cards);
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
      if (t === "Future" || t === "All" || t === SEARCH_MODE) return t;
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
