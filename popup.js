import { parseSalesFromJsonInput, sampleHistory, normalizeSales } from "./data-adapters.js";
import { computeOfferModel, estimateAcceptanceProbability, money } from "./model.js";

const STORAGE_KEY = "lowballer_state_v1";

const listingPriceInput = document.getElementById("listingPrice");
const retailPriceInput = document.getElementById("retailPrice");
const historyInput = document.getElementById("historyInput");
const autoAnalyzeBtn = document.getElementById("autoAnalyzeBtn");
const analyzeBtn = document.getElementById("analyzeBtn");
const loadSampleBtn = document.getElementById("loadSampleBtn");
const toggleAdvancedBtn = document.getElementById("toggleAdvancedBtn");
const clearBtn = document.getElementById("clearBtn");
const advancedPanel = document.getElementById("advancedPanel");
const pageStatus = document.getElementById("pageStatus");
const acceptanceValue = document.getElementById("acceptanceValue");
const suggestedOfferEl = document.getElementById("suggestedOffer");
const sliderOfferEl = document.getElementById("sliderOffer");
const offerSlider = document.getElementById("offerSlider");
const rangeMinEl = document.getElementById("rangeMin");
const rangeMaxEl = document.getElementById("rangeMax");
const sellerTraitsEl = document.getElementById("sellerTraits");
const modelNotes = document.getElementById("modelNotes");

let activeModel = null;
let activeReviewsUrl = null;
let activePurchasePrice = null;
let crawlInProgress = false;
let autoAnalyzeInProgress = false;
let advancedVisible = false;

initialize();

async function initialize() {
  await loadState();

  analyze();

  autoAnalyzeBtn.addEventListener("click", autoAnalyzeCurrentPage);
  analyzeBtn.addEventListener("click", analyze);
  loadSampleBtn.addEventListener("click", () => {
    historyInput.value = JSON.stringify(sampleHistory, null, 2);
    setStatus("Loaded sample history.", "ok");
    persistState();
    analyze();
  });

  toggleAdvancedBtn.addEventListener("click", toggleAdvanced);
  clearBtn.addEventListener("click", clearAll);

  [listingPriceInput, retailPriceInput, historyInput].forEach((el) => {
    el.addEventListener("input", debounce(() => {
      persistState();
    }, 250));
  });

  offerSlider.addEventListener("input", () => {
    if (!activeModel) return;
    const offer = Number(offerSlider.value);
    renderOfferState(offer, activeModel);
  });
}

function toggleAdvanced() {
  advancedVisible = !advancedVisible;
  advancedPanel.classList.toggle("hidden", !advancedVisible);
  toggleAdvancedBtn.textContent = advancedVisible ? "Hide Advanced" : "Show Advanced";
}

async function autoAnalyzeCurrentPage() {
  if (autoAnalyzeInProgress) return;
  autoAnalyzeInProgress = true;
  autoAnalyzeBtn.disabled = true;

  try {
    clearSeedHistoryIfPresent();
    setStatus("Lowball: pulling listing and seller data...", "ok");
    const response = await pullFromCurrentTab();
    if (!response) {
      throw new Error("Could not extract listing data from this page.");
    }

    const activeTab = await getActiveTab();
    const isGrailed = Boolean(activeTab?.url?.includes("grailed.com"));
    let crawlRows = 0;
    if (isGrailed) {
      let reviewsUrl = activeReviewsUrl ?? response.reviewsUrl ?? null;
      if (!reviewsUrl && activeTab?.id) {
        reviewsUrl = await discoverGrailedReviewsUrlFromTab(activeTab.id);
      }
      if (!reviewsUrl) {
        throw new Error("Seller reviews URL not found on this listing.");
      }
      setReviewsUrl(reviewsUrl);
      setStatus("Lowball: crawling seller reviews/listings...", "ok");
      const crawlResult = await crawlGrailedReviews();
      crawlRows = crawlResult?.rowsFound ?? 0;
      if (!crawlRows) {
        throw new Error("Crawl finished but produced 0 sold rows.");
      }
    }

    analyze();
    setStatus(`Lowball complete. Added ${crawlRows} seller-history rows.`, "ok");
  } catch (error) {
    setStatus(`Lowball failed: ${error.message}`, "warn");
  } finally {
    autoAnalyzeInProgress = false;
    autoAnalyzeBtn.disabled = false;
  }
}

async function pullFromCurrentTab() {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) {
      throw new Error("No active tab found.");
    }

    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: "LOWBALLER_EXTRACT_PAGE" });
    } catch (_error) {
      // If the tab didn't have the content script yet, inject it and retry once.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-script.js"]
      });
      response = await chrome.tabs.sendMessage(tab.id, { type: "LOWBALLER_EXTRACT_PAGE" });
    }
    if (!response) {
      throw new Error("No extraction response from page.");
    }

    if (Number.isFinite(response.listingPrice)) {
      listingPriceInput.value = String(Math.round(response.listingPrice));
    } else {
      listingPriceInput.value = "";
    }

    activePurchasePrice = Number.isFinite(response.purchasePrice)
      ? Math.round(response.purchasePrice)
      : null;

    if (Number.isFinite(response.retailPrice)) {
      retailPriceInput.value = String(Math.round(response.retailPrice));
    }

    let mergedCount = 0;
    let autoRows = [];
    if (Array.isArray(response.history) && response.history.length) {
      const normalized = normalizeSales(response.history);
      if (normalized.length >= 1) {
        autoRows = autoRows.concat(normalized);
      }
    }

    if (Number.isFinite(response.soldPrice)) {
      autoRows.push({
        title: response.itemName ?? "Unknown item",
        listedPrice: Number.isFinite(response.listingPrice)
          ? response.listingPrice
          : (Number.isFinite(response.purchasePrice) ? response.purchasePrice : null),
        soldPrice: response.soldPrice,
        retailPrice: Number.isFinite(response.retailPrice) ? response.retailPrice : null,
        soldAt: response.soldAt ?? null
      });
    }

    if (autoRows.length) {
      const existing = safeParseHistory(historyInput.value);
      const mergeBase = shouldDiscardSeedHistory(existing, autoRows.length) ? [] : existing;
      const merged = mergeHistory(mergeBase, normalizeSales(autoRows));
      mergedCount = merged.length;
      historyInput.value = JSON.stringify(merged, null, 2);
    }

    const noteParts = [
      `Detected site: ${response.site ?? "unknown"}`,
      response.sellerUsername ? `seller: ${response.sellerUsername}` : "seller missing",
      response.itemName ? `item: ${response.itemName}` : "item title missing",
      Number.isFinite(response.listingPrice) ? "listing price found" : "listing price missing",
      Number.isFinite(response.purchasePrice) ? "purchase price found" : "purchase price missing",
      mergedCount ? `${mergedCount} merged history rows` : "no seller history found"
    ];

    setReviewsUrl(response.reviewsUrl ?? response.profileUrl ?? null);
    setStatus(noteParts.join(" | "), "ok");
    await persistState();
    analyze();
    return response;
  } catch (error) {
    setStatus(`Could not pull from tab: ${error.message}`, "warn");
    return null;
  }
}

function analyze() {
  try {
    const rawHistory = historyInput.value.trim();
    const sales = rawHistory ? parseSalesFromJsonInput(rawHistory) : [];
    const model = computeOfferModel({
      listingPrice: listingPriceInput.value,
      purchasePrice: activePurchasePrice,
      retailPrice: retailPriceInput.value,
      sales
    });

    activeModel = model;

    offerSlider.min = String(model.minOffer);
    offerSlider.max = String(model.maxOffer);
    offerSlider.step = "1";
    offerSlider.value = String(model.suggestedOffer);

    rangeMinEl.textContent = money(model.minOffer);
    rangeMaxEl.textContent = money(model.maxOffer);
    suggestedOfferEl.textContent = money(model.suggestedOffer);

    renderOfferState(model.suggestedOffer, model);
    modelNotes.innerHTML = [
      `<strong>Model details</strong>`,
      `${sales.length} sold items analyzed.`,
      model.usedFallbackRatios
        ? `<span class="warn">Seller history too thin, using baseline marketplace fallback ratios.</span>`
        : `Seller-specific ratios detected from extracted history.`,
      Number.isFinite(model.purchaseCap)
        ? `Purchase price cap: <strong>${money(model.purchaseCap)}</strong> (acceptance becomes <strong>100%</strong> at this offer).`
        : `No purchase-price cap detected on this listing.`,
      `Average sold/base ratio: <strong>${(model.stats.mean * 100).toFixed(1)}%</strong>.`,
      `Spread (std dev): <strong>${(model.stats.stdDev * 100).toFixed(1)}%</strong>.`,
      `Suggested offer targets ~<strong>70%</strong> acceptance.`
    ].join("<br>");
    renderSellerTraits(sales);
  } catch (error) {
    activeModel = null;
    acceptanceValue.textContent = "--%";
    suggestedOfferEl.textContent = "$--";
    sliderOfferEl.textContent = "$--";
    rangeMinEl.textContent = "$--";
    rangeMaxEl.textContent = "$--";
    renderSellerTraits([]);
    modelNotes.innerHTML = `<span class="warn">${escapeHtml(error.message)}</span>`;
  }
}

function renderOfferState(offer, model) {
  const probability = estimateAcceptanceProbability(offer, model);
  const pct = Math.round(probability * 100);
  sliderOfferEl.textContent = money(offer);
  const isHailMary = probability < 0.01;
  acceptanceValue.textContent = isHailMary ? "hail mary 😭" : `${pct}%`;
  const tone = isHailMary ? "hailmary" : (pct < 50 ? "bad" : pct < 70 ? "neutral" : "good");
  acceptanceValue.className = `meter-value ${tone}`.trim();
}

async function clearAll() {
  listingPriceInput.value = "";
  retailPriceInput.value = "";
  historyInput.value = "";
  activePurchasePrice = null;
  setStatus("Cleared current values.", "ok");
  setReviewsUrl(null);
  await persistState();
  analyze();
}

async function crawlGrailedReviews() {
  if (crawlInProgress) return;
  crawlInProgress = true;

  try {
    const activeTab = await getActiveTab();
    const activeUrl = activeTab?.url ?? "";
    const activeIsFeedback = /\/feedback|\/reviews/i.test(activeUrl);

    let feedbackUrl = activeIsFeedback ? activeUrl : activeReviewsUrl;
    if (!feedbackUrl && activeTab?.id && /grailed\.com/i.test(activeUrl)) {
      feedbackUrl = await discoverGrailedReviewsUrlFromTab(activeTab.id);
      if (feedbackUrl) {
        setReviewsUrl(feedbackUrl);
      }
    }

    if (!feedbackUrl || !feedbackUrl.includes("grailed.com")) {
      throw new Error("Open a Grailed listing or feedback page first.");
    }

    setStatus(`Crawler target: ${feedbackUrl}`, "ok");

    let reviewsTab;
    let createdReviewsTab = false;
    if (activeIsFeedback) {
      reviewsTab = activeTab;
    } else {
      reviewsTab = await chrome.tabs.create({ url: feedbackUrl, active: false });
      createdReviewsTab = true;
      await waitForTabComplete(reviewsTab.id, 20000);
    }

    await expandGrailedFeedbackListings(reviewsTab.id);

    const linksPayload = await sendMessageToTab(reviewsTab.id, { type: "LOWBALLER_EXTRACT_GRAILED_REVIEW_LINKS" });
    if (linksPayload?.error) {
      throw new Error(linksPayload.error);
    }
    const links = Array.isArray(linksPayload?.links) ? linksPayload.links : [];
    const reviewsCount = Number.isFinite(linksPayload?.reviewsCount) ? linksPayload.reviewsCount : null;
    if (!links.length) {
      throw new Error("No listing links found on this feedback page.");
    }

    const maxLinks = 25;
    const targetCount = reviewsCount ? Math.min(maxLinks, reviewsCount) : maxLinks;
    const queue = links.slice(0, targetCount);
    setStatus(`Crawler: feedback links found ${links.length}, scanning ${queue.length} seller-review listings...`, "ok");

    const crawlTab = await chrome.tabs.create({ url: queue[0], active: false });
    const rows = [];

    for (let i = 0; i < queue.length; i += 1) {
      const url = queue[i];
      await chrome.tabs.update(crawlTab.id, { url });
      await waitForTabComplete(crawlTab.id, 25000);

      const detail = await sendMessageToTab(crawlTab.id, { type: "LOWBALLER_EXTRACT_GRAILED_LISTING_DETAIL" });
      if (detail && !detail.error && Number.isFinite(detail.soldPrice)) {
        rows.push({
          title: detail.itemName ?? "Unknown item",
          listedPrice: Number.isFinite(detail.listingPrice)
            ? detail.listingPrice
            : (Number.isFinite(detail.purchasePrice) ? detail.purchasePrice : null),
          soldPrice: detail.soldPrice,
          retailPrice: Number.isFinite(detail.retailPrice) ? detail.retailPrice : null,
          soldAt: detail.soldAt ?? null
        });
      }

      if ((i + 1) % 4 === 0 || i === queue.length - 1) {
        setStatus(`Crawler progress: ${i + 1}/${queue.length} scanned, ${rows.length} sold rows found.`, "ok");
      }
    }

    await chrome.tabs.remove(crawlTab.id);
    if (createdReviewsTab && reviewsTab?.id) {
      await chrome.tabs.remove(reviewsTab.id);
    }

    if (rows.length) {
      const existing = safeParseHistory(historyInput.value);
      const mergeBase = shouldDiscardSeedHistory(existing, rows.length) ? [] : existing;
      const merged = mergeHistory(mergeBase, normalizeSales(rows));
      historyInput.value = JSON.stringify(merged, null, 2);
      await persistState();
      analyze();
    }

    setStatus(`Crawler done: merged ${rows.length} sold rows from Grailed reviews/listings.`, rows.length ? "ok" : "warn");
    return { rowsFound: rows.length, linksFound: links.length, scanned: queue.length };
  } catch (error) {
    setStatus(`Crawler failed: ${error.message}`, "warn");
    throw error;
  } finally {
    crawlInProgress = false;
  }
}

function setStatus(text, state) {
  pageStatus.textContent = text;
  pageStatus.className = `status ${state ?? ""}`.trim();
}

function setReviewsUrl(url) {
  activeReviewsUrl = url && /^https?:\/\//.test(url) ? url : null;
}

async function loadState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const state = result?.[STORAGE_KEY];
  if (!state) return;

  listingPriceInput.value = state.listingPrice ?? listingPriceInput.value;
  retailPriceInput.value = state.retailPrice ?? retailPriceInput.value;
  historyInput.value = state.historyInput ?? historyInput.value;
  const purchaseFromState = Number(state.purchasePrice);
  activePurchasePrice = Number.isFinite(purchaseFromState) && purchaseFromState > 0
    ? purchaseFromState
    : null;
}

function persistState() {
  const state = {
    listingPrice: listingPriceInput.value,
    retailPrice: retailPriceInput.value,
    historyInput: historyInput.value,
    purchasePrice: activePurchasePrice
  };
  return chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0] ?? null);
    });
  });
}

async function sendMessageToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"]
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function discoverGrailedReviewsUrlFromTab(tabId) {
  try {
    const execution = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const toAbs = (href) => {
          if (!href) return null;
          try {
            return new URL(href, location.origin).toString();
          } catch (_error) {
            return null;
          }
        };

        const direct = document.querySelector("a[href*='/feedback'], a[href*='/reviews']");
        const directUrl = toAbs(direct?.getAttribute("href"));
        if (directUrl) return directUrl;

        const next = document.querySelector("script#__NEXT_DATA__")?.textContent?.trim();
        if (next) {
          try {
            const parsed = JSON.parse(next);
            const username = parsed?.props?.pageProps?.listing?.seller?.username;
            if (username) return `https://www.grailed.com/${username}/feedback`;
          } catch (_error) {
            // ignore
          }
        }

        const profile = document.querySelector("a[href^='https://www.grailed.com/'][rel*='nofollow'], a[href^='/'][rel*='nofollow']");
        const profileUrl = toAbs(profile?.getAttribute("href"));
        if (profileUrl) {
          const path = new URL(profileUrl).pathname.replace(/\/+$/, "");
          if (path && !path.includes("/listings/") && !path.includes("/feedback")) {
            return `https://www.grailed.com${path}/feedback`;
          }
        }

        return null;
      }
    });

    return execution?.[0]?.result ?? null;
  } catch (_error) {
    return null;
  }
}

async function expandGrailedFeedbackListings(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let i = 0; i < 8; i += 1) {
          window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });
          await pause(450);
        }
        window.scrollTo({ top: 0, behavior: "auto" });
      }
    });
  } catch (_error) {
    // Non-fatal; we'll crawl whatever links are already present.
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;

    function finishOk() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    function finishErr(message) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(message));
    }

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab?.status === "complete") {
        finishOk();
      }
    });

    const timeout = setTimeout(() => {
      finishErr("Timed out waiting for page load.");
    }, timeoutMs);

    function listener(updatedTabId, info) {
      if (updatedTabId !== tabId) return;
      if (info.status !== "complete") return;
      finishOk();
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function debounce(fn, waitMs) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), waitMs);
  };
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeParseHistory(text) {
  try {
    if (!text?.trim()) return [];
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return normalizeSales(parsed);
  } catch (_error) {
    return [];
  }
}

function mergeHistory(existing, incoming) {
  const seen = new Set();
  const merged = [];

  for (const item of [...existing, ...incoming]) {
    const key = `${item.title}|${item.listedPrice}|${item.soldPrice}|${item.retailPrice}|${item.soldAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  return merged.slice(0, 300);
}

function shouldDiscardSeedHistory(existingRows, incomingCount) {
  if (!incomingCount || !existingRows?.length) return false;
  if (existingRows.length !== sampleHistory.length) return false;

  const existingTitles = new Set(existingRows.map((row) => row.title));
  return sampleHistory.every((row) => existingTitles.has(row.title));
}

function clearSeedHistoryIfPresent() {
  const existing = safeParseHistory(historyInput.value);
  if (!shouldDiscardSeedHistory(existing, 1)) return;
  historyInput.value = "[]";
}

function renderSellerTraits(sales) {
  if (!sellerTraitsEl) return;
  const traits = deriveSellerTraits(sales);
  if (!traits.length) {
    sellerTraitsEl.innerHTML = `<span class="trait-empty">No clear trait signal yet. Keep crawling more sold rows.</span>`;
    return;
  }

  sellerTraitsEl.innerHTML = traits
    .map((trait) => {
      const tip = `${trait.meaning} Move: ${trait.move}`;
      return `<span class="trait-chip ${escapeHtml(trait.tone)}" title="${escapeHtml(tip)}" data-tip="${escapeHtml(tip)}">${escapeHtml(trait.name)}</span>`;
    })
    .join("");
}

function deriveSellerTraits(sales) {
  const validRows = (Array.isArray(sales) ? sales : [])
    .map((sale) => {
      const listedPrice = Number(sale?.listedPrice);
      const soldPrice = Number(sale?.soldPrice);
      if (!Number.isFinite(listedPrice) || listedPrice <= 0 || !Number.isFinite(soldPrice) || soldPrice <= 0) {
        return null;
      }

      const soldAtMs = Number.isFinite(Date.parse(sale?.soldAt ?? "")) ? Date.parse(sale.soldAt) : null;
      return {
        listedPrice,
        soldPrice,
        ratio: soldPrice / listedPrice,
        soldAtMs
      };
    })
    .filter(Boolean);

  if (validRows.length < 5) {
    return [];
  }

  const ratios = validRows.map((row) => row.ratio);
  const ratioStdDev = stdDev(ratios);
  const ratioMedian = percentile(ratios, 0.5);
  const deep30Count = validRows.filter((row) => row.ratio <= 0.7).length;
  const ultraDeepCount = validRows.filter((row) => row.ratio <= 0.6).length;
  const nearAskRate = validRows.filter((row) => row.ratio >= 0.95).length / validRows.length;
  const aboveAskRate = validRows.filter((row) => row.ratio > 1).length / validRows.length;

  const traits = [];

  if (deep30Count >= 2 && validRows.length >= 8) {
    traits.push({
      name: "Garage Sale",
      tone: "aggressive",
      meaning: "Seller has repeatedly accepted 30%+ discounts from asking price.",
      move: "Open bold and make them counter up to your target."
    });
  }

  if (ratioStdDev <= 0.085 && validRows.length >= 8) {
    traits.push({
      name: "Metronome",
      tone: "steady",
      meaning: "Seller closes deals in a very predictable rhythm.",
      move: "Anchor near their usual close ratio and resist overbidding."
    });
  }

  if (ratioMedian >= 0.95 && nearAskRate >= 0.62 && deep30Count <= 1 && validRows.length >= 8) {
    traits.push({
      name: "Iron Wall",
      tone: "defensive",
      meaning: "Seller usually protects ask price and caves very little.",
      move: "Use one clean near-ask offer and skip tiny back-and-forth."
    });
  }

  if (aboveAskRate >= 0.08 && validRows.length >= 8) {
    traits.push({
      name: "Greedy",
      tone: "defensive",
      meaning: "Seller frequently closes at or above listed price.",
      move: "Lowball only with strong comps, then escalate in small steps."
    });
  }

  const datedRows = validRows
    .filter((row) => Number.isFinite(row.soldAtMs))
    .sort((a, b) => b.soldAtMs - a.soldAtMs);
  const trendWindow = Math.min(10, Math.floor(datedRows.length / 2));
  if (trendWindow >= 4) {
    const recent = datedRows.slice(0, trendWindow).map((row) => row.ratio);
    const older = datedRows.slice(trendWindow, trendWindow * 2).map((row) => row.ratio);
    if (older.length >= 4) {
      const recentMean = mean(recent);
      const olderMean = mean(older);
      if (recentMean <= olderMean - 0.06 && recentMean <= 0.93) {
        traits.push({
          name: "Going Bankrupt",
          tone: "aggressive",
          meaning: "Recent deals are much softer than older deals.",
          move: "Press harder than historical averages while the trend is weak."
        });
      }
    }
  }

  const priceMedian = percentile(validRows.map((row) => row.listedPrice), 0.5);
  const highRows = validRows.filter((row) => row.listedPrice >= priceMedian);
  const lowRows = validRows.filter((row) => row.listedPrice < priceMedian);
  if (highRows.length >= 4 && lowRows.length >= 4) {
    const highMean = mean(highRows.map((row) => row.ratio));
    const lowMean = mean(lowRows.map((row) => row.ratio));
    const splitDelta = lowMean - highMean;

    if (splitDelta >= 0.06) {
      traits.push({
        name: "Heavyweight Helper",
        tone: "aggressive",
        meaning: "Seller gives bigger percentage discounts on pricier items.",
        move: "Aim lower on expensive listings because they bend there most."
      });
    } else if (splitDelta <= -0.06) {
      traits.push({
        name: "Lightweight Legend",
        tone: "aggressive",
        meaning: "Seller gives bigger percentage discounts on cheaper items.",
        move: "Push harder on lower-ticket pieces and accessories."
      });
    }
  }

  if (ultraDeepCount >= 2 || deep30Count >= 4) {
    traits.push({
      name: "Pleaseeee Buy",
      tone: "aggressive",
      meaning: "Seller has accepted panic-level discounts multiple times.",
      move: "Start very low, then walk up slowly only if needed."
    });
  }

  return dedupeTraits(traits).slice(0, 5);
}

function dedupeTraits(traits) {
  const seen = new Set();
  return traits.filter((trait) => {
    const key = trait.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values) {
  if (!values.length) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const t = idx - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}
