import { parseSalesFromJsonInput, sampleHistory, normalizeSales } from "./data-adapters.js";
import { computeOfferModel, estimateAcceptanceProbability, money } from "./model.js";

const STORAGE_KEY = "lowballer_state_v1";

const listingPriceInput = document.getElementById("listingPrice");
const retailPriceInput = document.getElementById("retailPrice");
const historyInput = document.getElementById("historyInput");
const analyzeBtn = document.getElementById("analyzeBtn");
const loadSampleBtn = document.getElementById("loadSampleBtn");
const pullFromTabBtn = document.getElementById("pullFromTabBtn");
const clearBtn = document.getElementById("clearBtn");
const pageStatus = document.getElementById("pageStatus");
const acceptanceValue = document.getElementById("acceptanceValue");
const suggestedOfferEl = document.getElementById("suggestedOffer");
const sliderOfferEl = document.getElementById("sliderOffer");
const offerSlider = document.getElementById("offerSlider");
const rangeMinEl = document.getElementById("rangeMin");
const rangeMaxEl = document.getElementById("rangeMax");
const modelNotes = document.getElementById("modelNotes");

let activeModel = null;

initialize();

async function initialize() {
  await loadState();
  if (!historyInput.value.trim()) {
    historyInput.value = JSON.stringify(sampleHistory, null, 2);
  }

  analyze();

  analyzeBtn.addEventListener("click", analyze);
  loadSampleBtn.addEventListener("click", () => {
    historyInput.value = JSON.stringify(sampleHistory, null, 2);
    setStatus("Loaded sample history.", "ok");
    persistState();
    analyze();
  });

  pullFromTabBtn.addEventListener("click", pullFromCurrentTab);
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

async function pullFromCurrentTab() {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) {
      throw new Error("No active tab found.");
    }

    const response = await chrome.tabs.sendMessage(tab.id, { type: "LOWBALLER_EXTRACT_PAGE" });
    if (!response) {
      throw new Error("No extraction response from page.");
    }

    if (Number.isFinite(response.listingPrice)) {
      listingPriceInput.value = String(Math.round(response.listingPrice));
    }

    if (Number.isFinite(response.retailPrice)) {
      retailPriceInput.value = String(Math.round(response.retailPrice));
    }

    if (Array.isArray(response.history) && response.history.length) {
      const normalized = normalizeSales(response.history);
      if (normalized.length >= 1) {
        historyInput.value = JSON.stringify(normalized, null, 2);
      }
    }

    const noteParts = [
      `Detected site: ${response.site ?? "unknown"}`,
      Number.isFinite(response.listingPrice) ? "listing price found" : "listing price missing",
      Array.isArray(response.history) && response.history.length ? `${response.history.length} history candidates found` : "no seller history found"
    ];

    setStatus(noteParts.join(" | "), "ok");
    await persistState();
    analyze();
  } catch (error) {
    setStatus(`Could not pull from tab: ${error.message}`, "warn");
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
  acceptanceValue.className = `meter-value ${pct >= 70 ? "good" : ""}`.trim();
}

async function clearAll() {
  listingPriceInput.value = "";
  retailPriceInput.value = "";
  historyInput.value = "";
  setStatus("Cleared current values.", "ok");
  await persistState();
  analyze();
}

function setStatus(text, state) {
  pageStatus.textContent = text;
  pageStatus.className = `status ${state ?? ""}`.trim();
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