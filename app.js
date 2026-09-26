(function () {
  "use strict";

  var dealsEl = document.getElementById("deals");
  var statusEl = document.getElementById("status");
  var weekLabelEl = document.getElementById("week-label");
  var headerEl = document.getElementById("site-header");
  var filtersEl = document.getElementById("filters");
  var filterButtonsEl = document.getElementById("filter-buttons");
  var budgetFiltersEl = document.getElementById("budget-filters");
  var budgetButtonsEl = document.getElementById("budget-buttons");
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
  var SEARCH_MODE = "Search";
  var SEARCH_STORAGE_KEY = "wagd-search-state";
  var MAX_RECENT_SEARCHES = 6;
  var searchQuery = "";
  var recentSearches = [];
  var searchDebounceTimer = null;
  var siteUpdatedAt = null;
  var loadingDeals = false;
  var pullStartY = 0;
  var pullStartX = 0;
  var pullDistance = 0;
  var pullTracking = false;
  var pullReady = false;
  var SITE_TITLE = "What's A Good Deal?";

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
    "Pen Display": "Art Tablets"
  };

  var BUDGET_OPTIONS = [
    { id: "All", label: "Any price" },
    { id: "under50", label: "Under $50", min: 0, max: 50 },
    { id: "50-150", label: "$50–150", min: 50, max: 150 },
    { id: "150-400", label: "$150–400", min: 150, max: 400 },
    { id: "400plus", label: "$400+", min: 400, max: Infinity }
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
    return (
      "Updated " +
      d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Los_Angeles"
      }) +
      " PT"
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

  /** Upcoming promo: startsAt between +1 day and +30 days from now. */
  function isFutureDeal(deal) {
    if (!deal || !deal.startsAt) return false;
    var t = new Date(deal.startsAt).getTime();
    if (Number.isNaN(t)) return false;
    var now = Date.now();
    var day = 24 * 60 * 60 * 1000;
    return t >= now + day && t <= now + 30 * day;
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

  function matchesSearchQuery(deal, query) {
    var tokens = tokenizeQuery(query);
    if (!tokens.length) return false;
    var blob = dealSearchBlob(deal);
    for (var i = 0; i < tokens.length; i++) {
      if (blob.indexOf(tokens[i]) === -1) return false;
    }
    return true;
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
    if (activeFilter === SEARCH_MODE) renderDeals(allDeals);
    if (opts.focus && searchInputEl) {
      try {
        searchInputEl.focus();
      } catch (e) {}
    }
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
      }, 180);
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

  function ensureBudgetDom() {
    if (budgetFiltersEl && budgetButtonsEl) return true;
    var filters = document.getElementById("filters");
    if (!filters || !filters.parentNode) return false;
    var section = document.getElementById("budget-filters");
    if (!section) {
      section = document.createElement("section");
      section.className = "filters filters--budget";
      section.id = "budget-filters";
      section.setAttribute("aria-label", "Filter by budget");
      section.hidden = true;
      var inner = document.createElement("div");
      inner.className = "filters__inner filters__inner--budget";
      inner.id = "budget-buttons";
      section.appendChild(inner);
      filters.parentNode.insertBefore(section, filters.nextSibling);
    }
    budgetFiltersEl = section;
    budgetButtonsEl = document.getElementById("budget-buttons");
    return !!(budgetFiltersEl && budgetButtonsEl);
  }

  function renderBudgetFilters() {
    if (!ensureBudgetDom()) return;
    budgetButtonsEl.innerHTML = "";
    BUDGET_OPTIONS.forEach(function (opt) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "filter-btn filter-btn--budget" + (opt.id === activeBudget ? " is-on" : "");
      btn.textContent = opt.label;
      btn.setAttribute("aria-pressed", opt.id === activeBudget ? "true" : "false");
      btn.dataset.budget = opt.id;
      btn.addEventListener("click", function () {
        if (opt.id === activeBudget) {
          pressFlash(btn);
          return;
        }
        activeBudget = opt.id;
        Array.prototype.forEach.call(budgetButtonsEl.children, function (b) {
          var on = b.dataset.budget === activeBudget;
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
        renderDeals(allDeals);
      });
      budgetButtonsEl.appendChild(btn);
    });
    budgetFiltersEl.hidden = false;
  }

  function renderFilters(deals) {
    if (!filtersEl || !filterButtonsEl) return;
    var present = {};
    deals.forEach(function (d) {
      var c = normalizeCategory(d.category);
      if (c) present[c] = true;
    });
    var cats = ["All", "Future"];
    CATEGORY_ORDER.forEach(function (cat) {
      if (cat !== "All" && cat !== "Future" && present[cat]) cats.push(cat);
    });
    Object.keys(present).forEach(function (cat) {
      if (cats.indexOf(cat) === -1) cats.push(cat);
    });
    // Mode chip — not a deal.category; keep at end so real categories stay primary.
    if (cats.indexOf(SEARCH_MODE) === -1) cats.push(SEARCH_MODE);
    filterButtonsEl.innerHTML = "";
    cats.forEach(function (cat) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "filter-btn" + (cat === activeFilter ? " is-on" : "");
      btn.textContent = cat;
      btn.setAttribute("aria-pressed", cat === activeFilter ? "true" : "false");
      if (cat === SEARCH_MODE) {
        btn.setAttribute("aria-label", "Search deals");
        btn.dataset.filter = SEARCH_MODE;
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
        if (cat === SEARCH_MODE && searchInputEl) {
          setTimeout(function () {
            try {
              searchInputEl.focus();
            } catch (e) {}
          }, 30);
        }
      });
      filterButtonsEl.appendChild(btn);
    });
    filtersEl.hidden = cats.length <= 2;
    renderBudgetFilters();
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
    var checkedIso = deal.updatedAt || siteUpdatedAt;
    var checkedLabel = checkedIso ? formatChecked(checkedIso) : "";
    var endsLabel = deal.endsAt ? formatEndsIn(deal.endsAt) : "";
    var startsLabel = deal.startsAt ? formatStartsIn(deal.startsAt) : "";
    var endingSoon = endsWithinMs(deal, 48 * 60 * 60 * 1000);

    var dropBadge = "";
    var priceNum = Number(deal.price);
    var prevNum = Number(deal.previousPrice);
    var belowList =
      Number.isFinite(priceNum) && Number.isFinite(prevNum) && priceNum < prevNum;
    var fromCheck = !!deal.priceDropped;
    if (belowList || fromCheck) {
      var dropAmt = Number(deal.dropAmount);
      var hasCheckAmt = fromCheck && Number.isFinite(dropAmt) && dropAmt > 0;
      var listSave = belowList ? prevNum - priceNum : null;
      var showAmt = hasCheckAmt ? dropAmt : listSave;
      var hasShowAmt = Number.isFinite(showAmt) && showAmt > 0;
      var dropLabel = hasShowAmt ? "↓ " + formatMoney(showAmt) : "Dropped";
      var ariaDrop;
      if (hasCheckAmt) {
        ariaDrop = "Price dropped " + formatMoney(dropAmt) + " since last refresh";
      } else if (belowList && hasShowAmt) {
        ariaDrop = "Price " + formatMoney(showAmt) + " below list/MSRP";
      } else if (fromCheck) {
        ariaDrop = "Price dropped since last refresh";
      } else {
        ariaDrop = "Price below list/MSRP";
      }
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
      '<p class="deal-card__why">' +
      escapeHtml(deal.why || "") +
      "</p>" +
      '<div class="deal-card__actions">' +
      '<a class="deal-card__cta" href="' +
      escapeAttr(deal.url) +
      '" target="_blank" rel="noopener noreferrer">View at ' +
      escapeHtml(deal.merchant || "retailer") +
      "</a>" +
      '<button type="button" class="deal-card__share" data-share>Share</button>' +
      "</div></div>";

    if (deal.image) {
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
      var prompt = document.createElement("p");
      prompt.className = "status";
      prompt.textContent = "Type to search current deals";
      dealsEl.appendChild(prompt);
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
    if (activeFilter === "All") {
      list = interleaveByCategory(list);
    } else if (activeFilter === "Future") {
      list = list.slice().sort(function (a, b) {
        var ta = new Date(a.startsAt).getTime();
        var tb = new Date(b.startsAt).getTime();
        if (ta !== tb) return ta - tb;
        return String(a.name || "").localeCompare(String(b.name || ""));
      });
    } else {
      // Category tabs and Search: biggest savings first
      list = sortBySavingsDesc(list);
    }

    dealsEl.innerHTML = "";
    dealsEl.setAttribute("aria-busy", "false");

    if (!list.length) {
      var empty = document.createElement("p");
      empty.className = "status";
      if (activeFilter === SEARCH_MODE) {
        empty.textContent = 'No deals match “' + trimmedQuery + '”';
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

  function dataUrl(cacheBust) {
    return cacheBust ? "data/deals.json?refresh=" + Date.now() : "data/deals.json";
  }

  function applyDealsData(data) {
    siteUpdatedAt = data.updatedAt || null;
    allDeals = (Array.isArray(data.deals) ? data.deals : []).map(function (d) {
      var copy = Object.assign({}, d);
      copy.category = normalizeCategory(d.category) || d.category;
      return copy;
    });
    if (weekLabelEl) {
      weekLabelEl.textContent =
        data.weekLabel ||
        (data.updatedAt ? formatUpdated(data.updatedAt) : "Updated recently");
    }
    if (data.title) SITE_TITLE = data.title;
    renderFilters(allDeals);
    renderDeals(allDeals);
  }

  function loadDeals(isRefresh) {
    if (loadingDeals) return Promise.resolve(false);
    loadingDeals = true;
    var previousUpdatedAt = siteUpdatedAt;
    if (isRefresh) {
      setPullIndicator(72, "refreshing");
      dealsEl.setAttribute("aria-busy", "true");
    }

    return fetch(dataUrl(!!isRefresh), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        applyDealsData(data);
        if (isRefresh) {
          var changed = previousUpdatedAt !== siteUpdatedAt;
          showToast(changed ? "Updated" : "Already up to date");
        }
        return true;
      })
      .catch(function () {
        if (isRefresh) {
          dealsEl.setAttribute("aria-busy", "false");
          showToast("Couldn’t update — showing current deals");
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
        if (isRefresh) setPullIndicator(0, "idle");
        return ok;
      });
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
    loadDeals(false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
