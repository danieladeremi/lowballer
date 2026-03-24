(() => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      let payload = null;
      if (message?.type === "LOWBALLER_EXTRACT_PAGE") {
        payload = extractPageData();
      } else if (message?.type === "LOWBALLER_EXTRACT_GRAILED_REVIEW_LINKS") {
        payload = extractGrailedReviewLinksPayload();
      } else if (message?.type === "LOWBALLER_EXTRACT_GRAILED_LISTING_DETAIL") {
        payload = extractGrailedListingDetailPayload();
      } else {
        return;
      }
      sendResponse(payload);
    } catch (error) {
      sendResponse({ error: String(error?.message ?? error) });
    }
  });

  function extractPageData() {
    const host = location.hostname;
    const site = detectSite(host);
    const itemName = extractItemName(site);
    const seller = extractSellerInfo(site);
    const listingPrice = extractListingPrice(site);
    const soldPrice = site === "grailed" ? extractGrailedSoldPrice() : null;
    const retailPrice = extractRetailPrice(site);
    const history = extractHistoryCandidates(site);

    return {
      host,
      site,
      itemName,
      sellerUsername: seller?.username ?? null,
      profileUrl: seller?.profileUrl ?? null,
      reviewsUrl: seller?.reviewsUrl ?? null,
      listingPrice,
      soldPrice,
      retailPrice,
      history
    };
  }

  function detectSite(host) {
    if (host.includes("grailed")) return "grailed";
    if (host.includes("depop")) return "depop";
    if (host.includes("etsy")) return "etsy";
    if (host.includes("ebay")) return "ebay";
    if (host.includes("facebook")) return "facebook_marketplace";
    return "unknown";
  }

  function extractItemName(site) {
    const fromSiteSelector = firstTextBySelectors(siteTitleSelectors[site] ?? []);
    if (fromSiteSelector) return fromSiteSelector;

    const ogTitle = document.querySelector("meta[property='og:title']")?.getAttribute("content");
    if (ogTitle?.trim()) return ogTitle.trim();
    return null;
  }

  function extractSellerInfo(site) {
    if (site !== "grailed") return null;

    const reviewLink = document.querySelector("a[href*='/feedback'], a[href*='/reviews']");
    const profileLink =
      document.querySelector("a[href*='/users/']") ??
      document.querySelector("a[href*='/u/']");

    const profileUrl = absolutizeUrl(profileLink?.getAttribute("href"));
    const reviewsUrl =
      absolutizeUrl(reviewLink?.getAttribute("href")) ??
      (profileUrl ? `${profileUrl.replace(/\/$/, "")}/feedback` : null);

    const username =
      usernameFromUrl(profileUrl) ??
      usernameFromUrl(reviewsUrl) ??
      textFromSelector("[data-testid*='seller'], [class*='Seller'], [class*='seller']");

    return { username, profileUrl, reviewsUrl };
  }

  function extractListingPrice(site) {
    if (site === "grailed") {
      const grailed = extractGrailedListingPrice();
      if (grailed) return grailed;
    }

    const siteSpecific = priceFromSelectors(siteListingSelectors[site]);
    if (siteSpecific) return siteSpecific;

    return (
      readNumberMeta("meta[property='product:price:amount']") ??
      readNumberMeta("meta[property='og:price:amount']") ??
      readNumberMeta("meta[itemprop='price']") ??
      readNumberMeta("meta[name='twitter:data1']") ??
      readJsonLdOfferPrice() ??
      readPriceFromKnownLabels(["price", "current price", "listing price", "asking"]) ??
      readFirstCurrencyCandidate(document.body?.innerText ?? "")
    );
  }

  function extractGrailedListingPrice() {
    const scopedSelectors = [
      "[class*='MainContent_rightColumn'] [class*='Sidebar_price'] span[data-testid='Current']",
      "[class*='MainContent_rightColumn'] [class*='Price_large'] span[data-testid='Current']",
      "[class*='MainContent_rightColumn'] [class*='Price_root'] span[data-testid='Current']"
    ];
    const strictSelectors = [
      "span[data-testid='Current']",
      "span[data-testid='Current Price']"
    ];

    const scopedBest = bestPriceByLargestFont(scopedSelectors);
    if (scopedBest?.price) {
      return scopedBest.price;
    }

    const globalBest = bestPriceByLargestFont(strictSelectors);
    if (globalBest?.price) {
      return globalBest.price;
    }

    const ogPrice = readOgDescriptionPrice();
    if (ogPrice) return ogPrice;

    // Sold listings often show a labeled sold-price block.
    const labeled = readPriceAfterLabel([
      "sold price including shipping",
      "sold price",
      "current"
    ]);
    if (labeled) return labeled;

    // On many Grailed pages this precedes the actual ask price line.
    const afterSaveItems = readPriceAfterLabel(["save items privately"]);
    if (afterSaveItems) return afterSaveItems;

    return null;
  }

  function bestPriceByLargestFont(selectors) {
    let best = null;
    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        const parsed = parseMoneyNumber(node?.textContent ?? "");
        if (!parsed) continue;

        const style = window.getComputedStyle(node);
        const fontSize = parseFloat(style.fontSize || "0") || 0;
        const candidate = { price: parsed, fontSize };

        if (!best) {
          best = candidate;
          continue;
        }

        if (candidate.fontSize > best.fontSize) {
          best = candidate;
        }
      }
    }
    return best;
  }

  function readOgDescriptionPrice() {
    const desc = document.querySelector("meta[property='og:description']")?.getAttribute("content") ?? "";
    if (!desc) return null;
    const match = desc.match(/starting at\s+\$([0-9]+(?:\.[0-9]{1,2})?)/i);
    if (!match) return null;
    return parseMoneyNumber(match[1]);
  }

  function extractGrailedSoldPrice() {
    return readPriceAfterLabel([
      "sold price including shipping",
      "sold price",
      "this listing sold",
      "sold"
    ]);
  }

  function extractRetailPrice(site) {
    const siteSpecific = priceFromSelectors(siteRetailSelectors[site]);
    if (siteSpecific) return siteSpecific;

    return (
      readNumberMeta("meta[property='product:original_price:amount']") ??
      readNumberMeta("meta[itemprop='highPrice']") ??
      readRetailFromLabeledText()
    );
  }

  function readNumberMeta(selector) {
    const el = document.querySelector(selector);
    if (!el) return null;

    const candidate =
      el.getAttribute("content") ??
      el.getAttribute("value") ??
      el.textContent;

    return parseMoneyNumber(candidate);
  }

  function readJsonLdOfferPrice() {
    const scripts = Array.from(document.querySelectorAll("script[type='application/ld+json']"));
    for (const script of scripts) {
      const text = script.textContent?.trim();
      if (!text) continue;

      try {
        const parsed = JSON.parse(text);
        const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (stack.length) {
          const node = stack.pop();
          if (!node || typeof node !== "object") continue;

          if (node.offers) {
            const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
            for (const offer of offers) {
              const price = parseMoneyNumber(offer?.price);
              if (price) return price;
            }
          }

          for (const value of Object.values(node)) {
            if (value && typeof value === "object") stack.push(value);
          }
        }
      } catch (_error) {
        continue;
      }
    }
    return null;
  }

  function extractHistoryCandidates(site) {
    const candidates = [];

    if (site === "grailed") {
      const grailedReviewRows = extractGrailedReviewRows();
      if (grailedReviewRows.length) candidates.push(...grailedReviewRows);
    }

    const jsonLd = extractHistoryFromJsonLd(site);
    if (jsonLd.length) candidates.push(...jsonLd);

    const embeddedJson = extractHistoryFromEmbeddedJson(site);
    if (embeddedJson.length) candidates.push(...embeddedJson);

    return dedupeHistory(candidates).slice(0, 150);
  }

  function extractHistoryFromJsonLd(site) {
    const out = [];
    const scripts = Array.from(document.querySelectorAll("script[type='application/ld+json']"));

    for (const script of scripts) {
      const text = script.textContent?.trim();
      if (!text) continue;

      try {
        const parsed = JSON.parse(text);
        const saleObjects = collectPotentialSaleObjects(parsed, site);
        out.push(...saleObjects.map(toHistoryRecord).filter(Boolean));
      } catch (_error) {
        continue;
      }
    }

    return out;
  }

  function extractHistoryFromEmbeddedJson(site) {
    const out = [];
    const scriptNodes = Array.from(document.scripts).slice(0, 50);

    for (const script of scriptNodes) {
      if (script.type && script.type !== "application/json") continue;
      const text = script.textContent?.trim();
      if (!text || text.length < 20 || text.length > 1500000) continue;
      if (!(text.startsWith("{") || text.startsWith("["))) continue;

      try {
        const parsed = JSON.parse(text);
        const saleObjects = collectPotentialSaleObjects(parsed, site);
        out.push(...saleObjects.map(toHistoryRecord).filter(Boolean));
      } catch (_error) {
        continue;
      }
    }

    return out;
  }

  function collectPotentialSaleObjects(root, site) {
    const matches = [];
    const queue = [{ value: root, depth: 0 }];
    let visited = 0;

    while (queue.length && visited < 5000) {
      const { value, depth } = queue.shift();
      visited += 1;

      if (!value || typeof value !== "object") continue;
      if (Array.isArray(value)) {
        if (depth < 8) {
          for (const item of value.slice(0, 200)) {
            queue.push({ value: item, depth: depth + 1 });
          }
        }
        continue;
      }

      if (looksLikeSaleObject(value, site)) {
        matches.push(value);
      }

      if (depth < 8) {
        for (const child of Object.values(value)) {
          if (child && typeof child === "object") {
            queue.push({ value: child, depth: depth + 1 });
          }
        }
      }
    }

    return matches;
  }

  function looksLikeSaleObject(obj, site) {
    const keys = saleKeyMapBySite[site] ?? saleKeyMapBySite.default;
    const listed = pickNumber(obj, keys.listedKeys);
    const sold = pickNumber(obj, keys.soldKeys);
    const retail = pickNumber(obj, keys.retailKeys);

    return Boolean(sold && (listed || retail));
  }

  function toHistoryRecord(obj) {
    const listedPrice = pickNumber(obj, ["listedPrice", "list_price", "price", "askingPrice", "originalPrice", "ask", "amount"]);
    const soldPrice = pickNumber(obj, ["soldPrice", "salePrice", "finalPrice", "sold_amount", "sold_price", "price_sold", "accepted_offer_amount"]);
    const retailPrice = pickNumber(obj, ["retailPrice", "msrp", "rrp", "original_retail", "original_price"]);
    const title = pickString(obj, ["title", "name", "item_name", "slug"]);
    const soldAt = pickString(obj, ["soldAt", "sold_at", "updatedAt", "createdAt", "date"]);

    if (!soldPrice) {
      return null;
    }

    return {
      title: title ?? "Unknown item",
      listedPrice: listedPrice ?? null,
      soldPrice,
      retailPrice: retailPrice ?? null,
      soldAt: soldAt ?? null
    };
  }

  function dedupeHistory(items) {
    const seen = new Set();
    const deduped = [];

    for (const item of items) {
      const key = `${item.title}|${item.listedPrice}|${item.soldPrice}|${item.retailPrice}|${item.soldAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }

    return deduped;
  }

  function pickNumber(obj, keys) {
    for (const key of keys) {
      if (!(key in obj)) continue;
      const number = parseMoneyNumber(obj[key]);
      if (number) return number;
    }
    return null;
  }

  function pickString(obj, keys) {
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }

  function parseMoneyNumber(value) {
    if (typeof value === "number") {
      return Number.isFinite(value) && value > 0 ? value : null;
    }

    if (typeof value !== "string") return null;
    const normalized = value.replace(/[\s,]/g, "");
    const match = normalized.match(/(\d+(?:\.\d{1,2})?)/);
    if (!match) return null;

    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function readFirstCurrencyCandidate(text) {
    const candidates = text.match(/\$\s?\d{2,6}(?:[,.]\d{1,2})?/g);
    if (!candidates || !candidates.length) return null;
    return parseMoneyNumber(candidates[0]);
  }

  function priceFromSelectors(selectors = []) {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const parsed = parseMoneyNumber(el.textContent ?? el.getAttribute("content"));
      if (parsed) return parsed;
    }
    return null;
  }

  function readPriceFromKnownLabels(labels) {
    const text = document.body?.innerText ?? "";
    if (!text) return null;
    const compact = text.replace(/\s+/g, " ");

    for (const label of labels) {
      const regex = new RegExp(`${escapeRegex(label)}\\s*[:\\-]?\\s*\\$?\\s*(\\d{2,6}(?:[.,]\\d{1,2})?)`, "i");
      const match = compact.match(regex);
      if (!match) continue;
      const parsed = parseMoneyNumber(match[1]);
      if (parsed) return parsed;
    }

    return null;
  }

  function readPriceAfterLabel(labels) {
    const text = document.body?.innerText ?? "";
    if (!text) return null;

    const compact = text.replace(/\s+/g, " ").toLowerCase();
    for (const rawLabel of labels) {
      const label = rawLabel.toLowerCase();
      const start = compact.indexOf(label);
      if (start === -1) continue;
      const window = compact.slice(start, start + 220);
      const match = window.match(/\$\s?(\d{1,6}(?:[.,]\d{1,2})?)/);
      if (!match) continue;
      const parsed = parseMoneyNumber(match[1]);
      if (parsed) return parsed;
    }
    return null;
  }

  function readRetailFromLabeledText() {
    const text = document.body?.innerText ?? "";
    if (!text) return null;

    const compact = text.replace(/\s+/g, " ");
    const patterns = [
      /(?:retail|msrp|rrp|original price|bought for)\s*[:\-]?\s*\$?\s*(\d{2,6}(?:[.,]\d{1,2})?)/i,
      /\$\s*(\d{2,6}(?:[.,]\d{1,2})?)\s*(?:retail|msrp|rrp)/i
    ];

    for (const pattern of patterns) {
      const match = compact.match(pattern);
      if (!match) continue;
      const parsed = parseMoneyNumber(match[1]);
      if (parsed) return parsed;
    }

    return null;
  }

  function firstTextBySelectors(selectors) {
    for (const selector of selectors) {
      const text = textFromSelector(selector);
      if (text) return text;
    }
    return null;
  }

  function textFromSelector(selector) {
    const el = document.querySelector(selector);
    if (!el) return null;
    const text = el.textContent?.trim();
    return text || null;
  }

  function absolutizeUrl(href) {
    if (!href) return null;
    try {
      return new URL(href, location.origin).toString();
    } catch (_error) {
      return null;
    }
  }

  function usernameFromUrl(url) {
    if (!url) return null;
    const match = url.match(/\/(?:users|u)\/([^/?#]+)/i);
    return match?.[1] ?? null;
  }

  function extractGrailedReviewRows() {
    if (!/feedback|reviews/i.test(location.pathname)) return [];

    const links = Array.from(document.querySelectorAll("a[href*='/listings/']")).slice(0, 150);
    const rows = [];

    for (const link of links) {
      const title = (link.textContent ?? "").trim() || "Unknown item";
      const container = link.closest("article, li, div");
      const blockText = container?.innerText ?? "";
      const prices = [...blockText.matchAll(/\$\s?(\d{1,6}(?:[.,]\d{1,2})?)/g)];
      const sold = prices.length ? parseMoneyNumber(prices[prices.length - 1][1]) : null;
      if (!sold) continue;
      rows.push({
        title,
        listedPrice: null,
        soldPrice: sold,
        retailPrice: null,
        soldAt: null
      });
    }

    return rows;
  }

  function extractGrailedReviewLinksPayload() {
    const links = Array.from(document.querySelectorAll("a[href*='/listings/']"))
      .map((a) => absolutizeUrl(a.getAttribute("href")))
      .filter(Boolean);

    const unique = [...new Set(links)];
    const reviewsCount = readReviewsCountFromPage();
    return {
      site: "grailed",
      links: unique,
      reviewsCount
    };
  }

  function readReviewsCountFromPage() {
    const text = document.body?.innerText ?? "";
    const match = text.match(/(\d{1,5})\s+reviews?/i);
    if (!match) return null;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function extractGrailedListingDetailPayload() {
    const site = detectSite(location.hostname);
    if (site !== "grailed") {
      return { error: "Not on a Grailed page." };
    }

    return {
      site,
      url: location.href,
      itemName: extractItemName(site),
      listingPrice: extractGrailedListingPrice(),
      soldPrice: extractGrailedSoldPrice(),
      retailPrice: extractRetailPrice(site)
    };
  }

  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  const siteListingSelectors = {
    grailed: [
      "span[data-testid='Current']",
      "span[data-testid='Current Price']",
      "[data-testid*='price']",
      "[class*='Price']",
      "meta[property='product:price:amount']"
    ],
    depop: [
      "[data-testid*='price']",
      "[class*='price']",
      "meta[property='og:price:amount']"
    ],
    etsy: [
      "[data-buy-box-region] [class*='wt-text-title']",
      "[data-buy-box-listing-price]",
      "[data-selector='price-only']",
      "[itemprop='price']"
    ],
    ebay: [
      "#prcIsum",
      "#mm-saleDscPrc",
      ".x-price-primary span",
      "[itemprop='price']"
    ],
    facebook_marketplace: [
      "h1",
      "[aria-label*='$']",
      "[data-testid*='marketplace_feed_item']"
    ],
    unknown: []
  };

  const siteRetailSelectors = {
    grailed: [
      "[class*='retail']",
      "[data-testid*='retail']"
    ],
    depop: [
      "[class*='retail']",
      "[data-testid*='retail']"
    ],
    etsy: [
      "[data-selector='original-price']",
      "[class*='wt-text-strikethrough']"
    ],
    ebay: [
      ".x-price-previous",
      ".notranslate.strikethrough"
    ],
    facebook_marketplace: [],
    unknown: []
  };

  const siteTitleSelectors = {
    grailed: [
      "p.Details_title__8rdLK",
      "p.Details_detail__7xjgu.Details_title__8rdLK",
      "p[data-testid='Title']"
    ],
    depop: [
      "h1[data-testid*='title']",
      "h1"
    ],
    etsy: [
      "h1[data-buy-box-listing-title]",
      "h1.wt-text-body-03",
      "h1"
    ],
    ebay: [
      "h1.x-item-title__mainTitle",
      "h1#itemTitle",
      "h1"
    ],
    facebook_marketplace: [
      "h1",
      "span[dir='auto']"
    ],
    unknown: ["h1"]
  };

  const saleKeyMapBySite = {
    grailed: {
      listedKeys: ["listedPrice", "list_price", "price", "askingPrice", "originalPrice", "ask", "amount"],
      soldKeys: ["soldPrice", "salePrice", "finalPrice", "sold_amount", "sold_price", "accepted_offer_amount"],
      retailKeys: ["retailPrice", "msrp", "rrp", "original_retail", "original_price"]
    },
    depop: {
      listedKeys: ["listedPrice", "list_price", "price", "askingPrice", "originalPrice", "ask", "amount"],
      soldKeys: ["soldPrice", "salePrice", "finalPrice", "sold_price", "price_sold"],
      retailKeys: ["retailPrice", "msrp", "rrp", "original_retail", "original_price"]
    },
    etsy: {
      listedKeys: ["listedPrice", "list_price", "price", "askingPrice", "originalPrice", "ask", "amount"],
      soldKeys: ["soldPrice", "salePrice", "finalPrice", "sold_price", "price"],
      retailKeys: ["retailPrice", "msrp", "rrp", "original_retail", "original_price"]
    },
    ebay: {
      listedKeys: ["listedPrice", "list_price", "price", "askingPrice", "originalPrice", "ask", "amount"],
      soldKeys: ["soldPrice", "salePrice", "finalPrice", "sold_price", "currentPrice"],
      retailKeys: ["retailPrice", "msrp", "rrp", "originalPrice", "original_price"]
    },
    facebook_marketplace: {
      listedKeys: ["listedPrice", "list_price", "price", "askingPrice", "originalPrice", "ask", "amount"],
      soldKeys: ["soldPrice", "salePrice", "finalPrice", "price"],
      retailKeys: ["retailPrice", "msrp", "rrp", "originalPrice", "original_price"]
    },
    default: {
      listedKeys: ["listedPrice", "list_price", "price", "askingPrice", "originalPrice", "ask", "amount"],
      soldKeys: ["soldPrice", "salePrice", "finalPrice", "sold_amount", "sold_price"],
      retailKeys: ["retailPrice", "msrp", "rrp", "original_retail", "original_price"]
    }
  };
})();
