(() => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "LOWBALLER_EXTRACT_PAGE") {
      return;
    }

    try {
      const payload = extractPageData();
      sendResponse(payload);
    } catch (error) {
      sendResponse({ error: String(error?.message ?? error) });
    }
  });

  function extractPageData() {
    const host = location.hostname;
    const site = detectSite(host);
    const listingPrice = extractListingPrice();
    const retailPrice = extractRetailPrice();
    const history = extractHistoryCandidates();

    return {
      host,
      site,
      listingPrice,
      retailPrice,
      history
    };
  }

  function detectSite(host) {
    if (host.includes("grailed")) return "grailed";
    if (host.includes("depop")) return "depop";
    if (host.includes("ebay")) return "ebay";
    if (host.includes("poshmark")) return "poshmark";
    if (host.includes("mercari")) return "mercari";
    return "unknown";
  }

  function extractListingPrice() {
    return (
      readNumberMeta("meta[property='product:price:amount']") ??
      readNumberMeta("meta[name='twitter:data1']") ??
      readJsonLdOfferPrice() ??
      readFirstCurrencyCandidate(document.body?.innerText ?? "")
    );
  }

  function extractRetailPrice() {
    return (
      readNumberMeta("meta[property='product:original_price:amount']") ??
      readNumberMeta("meta[property='og:price:amount']") ??
      readNumberMeta("meta[itemprop='highPrice']")
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

  function extractHistoryCandidates() {
    const candidates = [];

    const jsonLd = extractHistoryFromJsonLd();
    if (jsonLd.length) candidates.push(...jsonLd);

    const embeddedJson = extractHistoryFromEmbeddedJson();
    if (embeddedJson.length) candidates.push(...embeddedJson);

    return dedupeHistory(candidates).slice(0, 150);
  }

  function extractHistoryFromJsonLd() {
    const out = [];
    const scripts = Array.from(document.querySelectorAll("script[type='application/ld+json']"));

    for (const script of scripts) {
      const text = script.textContent?.trim();
      if (!text) continue;

      try {
        const parsed = JSON.parse(text);
        const saleObjects = collectPotentialSaleObjects(parsed);
        out.push(...saleObjects.map(toHistoryRecord).filter(Boolean));
      } catch (_error) {
        continue;
      }
    }

    return out;
  }

  function extractHistoryFromEmbeddedJson() {
    const out = [];
    const scriptNodes = Array.from(document.scripts).slice(0, 50);

    for (const script of scriptNodes) {
      if (script.type && script.type !== "application/json") continue;
      const text = script.textContent?.trim();
      if (!text || text.length < 20 || text.length > 1500000) continue;
      if (!(text.startsWith("{") || text.startsWith("["))) continue;

      try {
        const parsed = JSON.parse(text);
        const saleObjects = collectPotentialSaleObjects(parsed);
        out.push(...saleObjects.map(toHistoryRecord).filter(Boolean));
      } catch (_error) {
        continue;
      }
    }

    return out;
  }

  function collectPotentialSaleObjects(root) {
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

      if (looksLikeSaleObject(value)) {
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

  function looksLikeSaleObject(obj) {
    const listed = pickNumber(obj, ["listedPrice", "list_price", "price", "askingPrice", "originalPrice", "ask"]);
    const sold = pickNumber(obj, ["soldPrice", "salePrice", "finalPrice", "sold_amount", "sold_price"]);
    const retail = pickNumber(obj, ["retailPrice", "msrp", "rrp", "original_retail"]);

    return Boolean(sold && (listed || retail));
  }

  function toHistoryRecord(obj) {
    const listedPrice = pickNumber(obj, ["listedPrice", "list_price", "price", "askingPrice", "originalPrice", "ask"]);
    const soldPrice = pickNumber(obj, ["soldPrice", "salePrice", "finalPrice", "sold_amount", "sold_price"]);
    const retailPrice = pickNumber(obj, ["retailPrice", "msrp", "rrp", "original_retail"]);
    const title = pickString(obj, ["title", "name", "item_name", "slug"]);
    const soldAt = pickString(obj, ["soldAt", "sold_at", "updatedAt", "createdAt", "date"]);

    if (!soldPrice || (!listedPrice && !retailPrice)) {
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
    const normalized = value.replace(/[,\s]/g, "");
    const match = normalized.match(/(\d+(?:\.\d{1,2})?)/);
    if (!match) return null;

    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function readFirstCurrencyCandidate(text) {
    const candidates = text.match(/[$€£]\s?\d{2,6}(?:[,.]\d{1,2})?/g);
    if (!candidates || !candidates.length) return null;
    return parseMoneyNumber(candidates[0]);
  }
})();