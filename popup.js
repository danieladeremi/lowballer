import { parseSalesFromJsonInput, sampleHistory, normalizeSales } from "./data-adapters.js";
import { computeOfferModel, estimateAcceptanceProbability, money } from "./model.js";

const STORAGE_KEY = "lowballer_state_v1";

const listingPriceInput = document.getElementById("listingPrice");
const retailPriceInput = document.getElementById("retailPrice");
const historyInput = document.getElementById("historyInput");
const autoAnalyzeBtn = document.getElementById("autoAnalyzeBtn");
const analyzeBtn = document.getElementById("analyzeBtn");
const loadSampleBtn = document.getElementById("loadSampleBtn");
const pullFromTabBtn = document.getElementById("pullFromTabBtn");
const openReviewsBtn = document.getElementById("openReviewsBtn");
const crawlGrailedBtn = document.getElementById("crawlGrailedBtn");
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
const modelNotes = document.getElementById("modelNotes");

let activeModel = null;
let activeReviewsUrl = null;
let crawlInProgress = false;
let autoAnalyzeInProgress = false;
let advancedVisible = false;

initialize();

async function initialize() {
  await loadState();
  if (!historyInput.value.trim()) {
    historyInput.value = JSON.stringify(sampleHistory, null, 2);
  }

  analyze();

  autoAnalyzeBtn.addEventListener("click", autoAnalyzeCurrentPage);
  analyzeBtn.addEventListener("click", analyze);
  loadSampleBtn.addEventListener("click", () => {
    historyInput.value = JSON.stringify(sampleHistory, null, 2);
    setStatus("Loaded sample history.", "ok");
    persistState();
    analyze();
  });

  pullFromTabBtn.addEventListener("click", pullFromCurrentTab);
  openReviewsBtn.addEventListener("click", openSellerReviewsTab);
  crawlGrailedBtn.addEventListener("click", crawlGrailedReviews);
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
    setStatus("Auto Analyze: pulling listing and seller data...", "ok");
    const response = await pullFromCurrentTab();
    if (!response) {
      throw new Error("Could not extract listing data from this page.");
    }

    const activeTab = await getActiveTab();
    const isGrailed = Boolean(activeTab?.url?.includes("grailed.com"));
    if (isGrailed && activeReviewsUrl) {
      setStatus("Auto Analyze: crawling seller reviews/listings...", "ok");
      await crawlGrailedReviews();
    }

    analyze();
    setStatus("Auto Analyze complete.", "ok");
  } catch (error) {
    setStatus(`Auto Analyze failed: ${error.message}`, "warn");
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
    }

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
        listedPrice: Number.isFinite(response.listingPrice) ? response.listingPrice : null,
        soldPrice: response.soldPrice,
        retailPrice: Number.isFinite(response.retailPrice) ? response.retailPrice : null,
        soldAt: null
      });
    }

    if (autoRows.length) {
      const existing = safeParseHistory(historyInput.value);
      const merged = mergeHistory(existing, normalizeSales(autoRows));
      mergedCount = merged.length;
      historyInput.value = JSON.stringify(merged, null, 2);
    }

    const noteParts = [
      `Detected site: ${response.site ?? "unknown"}`,
      response.sellerUsername ? `seller: ${response.sellerUsername}` : "seller missing",
      response.itemName ? `item: ${response.itemName}` : "item title missing",
      Number.isFinite(response.listingPrice) ? "listing price found" : "listing price missing",
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
    const sales = parseSalesFromJsonInput(historyInput.value);
    const model = computeOfferModel({
      listingPrice: listingPriceInput.value,
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
      `Average sold/base ratio: <strong>${(model.stats.mean * 100).toFixed(1)}%</strong>.`,
      `Spread (std dev): <strong>${(model.stats.stdDev * 100).toFixed(1)}%</strong>.`,
      `Suggested offer targets ~<strong>70%</strong> acceptance.`
    ].join("<br>");
  } catch (error) {
    activeModel = null;
    acceptanceValue.textContent = "--%";
    suggestedOfferEl.textContent = "$--";
    sliderOfferEl.textContent = "$--";
    rangeMinEl.textContent = "$--";
    rangeMaxEl.textContent = "$--";
    modelNotes.innerHTML = `<span class="warn">${escapeHtml(error.message)}</span>`;
  }
}

function renderOfferState(offer, model) {
  const probability = estimateAcceptanceProbability(offer, model);
  const pct = Math.round(probability * 100);
  sliderOfferEl.textContent = money(offer);
  acceptanceValue.textContent = `${pct}%`;
  const tone = pct < 50 ? "bad" : pct < 70 ? "neutral" : "good";
  acceptanceValue.className = `meter-value ${tone}`.trim();
}

async function clearAll() {
  listingPriceInput.value = "";
  retailPriceInput.value = "";
  historyInput.value = "";
  setStatus("Cleared current values.", "ok");
  setReviewsUrl(null);
  await persistState();
  analyze();
}

async function openSellerReviewsTab() {
  if (!activeReviewsUrl) return;
  await chrome.tabs.create({ url: activeReviewsUrl });
}

async function crawlGrailedReviews() {
  if (crawlInProgress) return;
  crawlInProgress = true;
  crawlGrailedBtn.disabled = true;

  try {
    const sourceUrl = activeReviewsUrl ?? (await getActiveTab())?.url ?? "";
    if (!sourceUrl || !sourceUrl.includes("grailed.com")) {
      throw new Error("Open a Grailed listing or feedback page first.");
    }

    let reviewsTab;
    let createdReviewsTab = false;
    if (/\/feedback|\/reviews/i.test(sourceUrl)) {
      reviewsTab = await getActiveTab();
    } else {
      if (!activeReviewsUrl) {
        throw new Error("Seller reviews URL not found yet. Pull from a Grailed listing first.");
      }
      reviewsTab = await chrome.tabs.create({ url: activeReviewsUrl, active: false });
      createdReviewsTab = true;
      await waitForTabComplete(reviewsTab.id, 20000);
    }

    const linksPayload = await sendMessageToTab(reviewsTab.id, { type: "LOWBALLER_EXTRACT_GRAILED_REVIEW_LINKS" });
    const links = Array.isArray(linksPayload?.links) ? linksPayload.links : [];
    const reviewsCount = Number.isFinite(linksPayload?.reviewsCount) ? linksPayload.reviewsCount : null;
    if (!links.length) {
      throw new Error("No listing links found on this feedback page.");
    }

    const maxLinks = 24;
    const targetCount = reviewsCount ? Math.min(maxLinks, reviewsCount) : maxLinks;
    const queue = links.slice(0, targetCount);
    setStatus(`Crawler: found ${links.length} links, scanning ${queue.length}...`, "ok");

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
          listedPrice: Number.isFinite(detail.listingPrice) ? detail.listingPrice : null,
          soldPrice: detail.soldPrice,
          retailPrice: Number.isFinite(detail.retailPrice) ? detail.retailPrice : null,
          soldAt: null
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
      const merged = mergeHistory(existing, normalizeSales(rows));
      historyInput.value = JSON.stringify(merged, null, 2);
      await persistState();
      analyze();
    }

    setStatus(`Crawler done: merged ${rows.length} sold rows from Grailed reviews/listings.`, rows.length ? "ok" : "warn");
  } catch (error) {
    setStatus(`Crawler failed: ${error.message}`, "warn");
  } finally {
    crawlInProgress = false;
    crawlGrailedBtn.disabled = false;
  }
}

function setStatus(text, state) {
  pageStatus.textContent = text;
  pageStatus.className = `status ${state ?? ""}`.trim();
}

function setReviewsUrl(url) {
  activeReviewsUrl = url && /^https?:\/\//.test(url) ? url : null;
  const canCrawlGrailed = Boolean(activeReviewsUrl && /grailed\.com/i.test(activeReviewsUrl));
  if (activeReviewsUrl) {
    openReviewsBtn.classList.remove("hidden");
  } else {
    openReviewsBtn.classList.add("hidden");
  }

  if (canCrawlGrailed) {
    crawlGrailedBtn.classList.remove("hidden");
  } else {
    crawlGrailedBtn.classList.add("hidden");
  }
}

async function loadState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const state = result?.[STORAGE_KEY];
  if (!state) return;

  listingPriceInput.value = state.listingPrice ?? listingPriceInput.value;
  retailPriceInput.value = state.retailPrice ?? retailPriceInput.value;
  historyInput.value = state.historyInput ?? historyInput.value;
}

function persistState() {
  const state = {
    listingPrice: listingPriceInput.value,
    retailPrice: retailPriceInput.value,
    historyInput: historyInput.value
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
