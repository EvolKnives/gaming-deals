(function () {
  "use strict";

  var dealsEl = document.getElementById("deals");
  var statusEl = document.getElementById("status");
  var weekLabelEl = document.getElementById("week-label");
  var headerEl = document.getElementById("site-header");
  var sharePageBtn = document.getElementById("share-page");
  var filtersEl = document.getElementById("filters");
  var filterButtonsEl = document.getElementById("filter-buttons");
  var toastEl = document.getElementById("toast");
  var lightboxEl = document.getElementById("lightbox");
  var lightboxImg = document.getElementById("lightbox-img");
  var lightboxClose = document.getElementById("lightbox-close");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var toastTimer = null;
  var lightboxOpen = false;
  var allDeals = [];
  var activeFilter = "All";
  var SITE_TITLE = "What's A Good Deal?";

  // Canonical plural filter labels (never apostrophe plurals).
  var CATEGORY_ORDER = [
    "All",
    "GPUs",
    "CPUs",
    "Monitors",
    "TVs",
    "Home Theater",
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
    HT: "Home Theater"
  };

  function normalizeCategory(cat) {
    if (!cat) return "";
    var key = String(cat).trim();
    if (CATEGORY_ALIASES[key]) return CATEGORY_ALIASES[key];
    // Fallback: strip trailing apostrophe-s / bare s already pluralized above
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
    // force reflow so re-triggering works
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
    // Failsafe: never leave cards untappable if IO misses
    setTimeout(function () {
      nodes.forEach(function (n) {
        if (!n.classList.contains("is-visible")) {
          n.classList.add("is-visible");
          n.classList.remove("will-reveal");
        }
      });
    }, 1200);
  }

  function renderFilters(deals) {
    if (!filtersEl || !filterButtonsEl) return;
    var present = {};
    deals.forEach(function (d) {
      var c = normalizeCategory(d.category);
      if (c) present[c] = true;
    });
    var cats = ["All"];
    CATEGORY_ORDER.forEach(function (cat) {
      if (cat !== "All" && present[cat]) cats.push(cat);
    });
    // Any unexpected categories still appear after the canonical set
    Object.keys(present).forEach(function (cat) {
      if (cats.indexOf(cat) === -1) cats.push(cat);
    });
    filterButtonsEl.innerHTML = "";
    cats.forEach(function (cat) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "filter-btn" + (cat === activeFilter ? " is-on" : "");
      btn.textContent = cat;
      btn.setAttribute("aria-pressed", cat === activeFilter ? "true" : "false");
      btn.addEventListener("click", function () {
        if (cat === activeFilter) {
          pressFlash(btn);
          return;
        }
        activeFilter = cat;
        Array.prototype.forEach.call(filterButtonsEl.children, function (b) {
          var on = b.textContent === activeFilter;
          b.classList.toggle("is-on", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
        pressFlash(btn);
        try {
          btn.scrollIntoView({ inline: "nearest", block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
        } catch (e) {}
        renderDeals(allDeals);
      });
      filterButtonsEl.appendChild(btn);
    });
    filtersEl.hidden = cats.length <= 2;
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

    var dropBadge = "";
    // Show Dropped when below list/MSRP (previousPrice) or down since last hourly check.
    // Compute from existing fields only — never invent prices.
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
        ariaDrop =
          "Price dropped " + formatMoney(dropAmt) + " since last refresh";
      } else if (belowList && hasShowAmt) {
        ariaDrop =
          "Price " +
          formatMoney(showAmt) +
          " below list/MSRP";
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

    article.innerHTML =
      mediaHtml +
      '<div class="deal-card__body">' +
      '<p class="deal-card__meta">' +
      escapeHtml(normalizeCategory(deal.category) || deal.category || "Deal") +
      " · " +
      escapeHtml(deal.merchant || "") +
      "</p>" +
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
      "</div>" +
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
      var img = fig && fig.querySelector("img");
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
    var list =
      activeFilter === "All"
        ? deals.slice()
        : deals.filter(function (d) {
            return normalizeCategory(d.category) === activeFilter;
          });
    list = sortBySavingsDesc(list);

    dealsEl.innerHTML = "";
    dealsEl.setAttribute("aria-busy", "false");

    if (!list.length) {
      var empty = document.createElement("p");
      empty.className = "status";
      empty.textContent = "No deals in this category right now.";
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

  function onScroll() {
    if (!headerEl) return;

    var scrollY = Math.max(
      0,
      window.scrollY || document.documentElement.scrollTop || 0
    );
    // Faster, more obvious fade (~72px) so it reads clearly on phone.
    var rawProgress = Math.min(scrollY / 72, 1);
    var progress = rawProgress * rawProgress * (3 - 2 * rawProgress);

    headerEl.style.setProperty("--header-progress", String(progress));
    headerEl.classList.toggle("is-scrolled", scrollY > 4);
  }

  function init() {
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    if (sharePageBtn) {
      sharePageBtn.addEventListener("click", function () {
        pressFlash(sharePageBtn);
        sharePayload({
          title: SITE_TITLE,
          text: "Current deals — GPUs, monitors, home theater, and more.",
          url: pageUrl()
        });
      });
    }

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

    fetch("data/deals.json", { cache: "no-cache" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
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
      })
      .catch(function () {
        if (statusEl) {
          statusEl.className = "status status--error";
          statusEl.textContent = "Couldn't load deals. Try refreshing.";
        }
        dealsEl.setAttribute("aria-busy", "false");
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
