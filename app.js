import { parseSalesFromJsonInput, sampleHistory } from "./data-adapters.js";

const listingPriceInput = document.getElementById("listingPrice");
const retailPriceInput = document.getElementById("retailPrice");
const historyInput = document.getElementById("historyInput");
const loadSampleBtn = document.getElementById("loadSampleBtn");
const analyzeBtn = document.getElementById("analyzeBtn");
const acceptanceValue = document.getElementById("acceptanceValue");
const suggestedOfferEl = document.getElementById("suggestedOffer");
const sliderOfferEl = document.getElementById("sliderOffer");
const offerSlider = document.getElementById("offerSlider");
const rangeMinEl = document.getElementById("rangeMin");
const rangeMaxEl = document.getElementById("rangeMax");
const modelNotes = document.getElementById("modelNotes");

let activeModel = null;

initialize();

function initialize() {
  historyInput.value = JSON.stringify(sampleHistory, null, 2);
  analyze();

  loadSampleBtn.addEventListener("click", () => {
    historyInput.value = JSON.stringify(sampleHistory, null, 2);
    analyze();
  });

  analyzeBtn.addEventListener("click", analyze);

  offerSlider.addEventListener("input", () => {
    if (!activeModel) return;
    const offer = Number(offerSlider.value);
    renderOfferState(offer, activeModel);
  });
}

function analyze() {
  try {
    const currentListing = toPositiveNumber(listingPriceInput.value);
    const currentRetail = toPositiveNumber(retailPriceInput.value);

    if (!currentListing && !currentRetail) {
      throw new Error("Add a listing price or retail price for the target item.");
    }

    const sales = parseSalesFromJsonInput(historyInput.value);
    if (sales.length < 3) {
      throw new Error("Need at least 3 valid sold items to estimate acceptance.");
    }

    const anchor = currentListing ?? currentRetail;
    const ratios = sales
      .map((sale) => {
        const base = sale.listedPrice ?? sale.retailPrice;
        return base ? sale.soldPrice / base : null;
      })
      .filter((ratio) => Number.isFinite(ratio));

    if (ratios.length < 3) {
      throw new Error("Not enough pricing ratios from seller history.");
    }

    const stats = describeRatios(ratios);
    const p10 = percentile(ratios, 0.1);
    const p70 = percentile(ratios, 0.7);
    const p90 = percentile(ratios, 0.9);

    const rangeMinRatio = clamp(p10 - 0.05, 0.25, 1.05);
    const rangeMaxRatio = clamp(p90 + 0.05, rangeMinRatio + 0.05, 1.1);

    const suggestedOffer = roundDollar(anchor * p70);
    const minOffer = roundDollar(anchor * rangeMinRatio);
    const maxOffer = roundDollar(anchor * rangeMaxRatio);

    activeModel = {
      anchor,
      ratios,
      stats,
      suggestedOffer,
      minOffer,
      maxOffer
    };

    offerSlider.min = String(minOffer);
    offerSlider.max = String(maxOffer);
    offerSlider.step = "1";
    offerSlider.value = String(suggestedOffer);

    rangeMinEl.textContent = money(minOffer);
    rangeMaxEl.textContent = money(maxOffer);
    suggestedOfferEl.textContent = money(suggestedOffer);

    renderOfferState(suggestedOffer, activeModel);
    renderNotes(sales.length, stats, currentListing, currentRetail);
  } catch (error) {
    activeModel = null;
    acceptanceValue.textContent = "--%";
    suggestedOfferEl.textContent = "$--";
    sliderOfferEl.textContent = "$--";
    modelNotes.innerHTML = `<span class="warn">${escapeHtml(error.message)}</span>`;
  }
}

function renderOfferState(offer, model) {
  const ratio = offer / model.anchor;
  const probability = acceptanceProbability(ratio, model.ratios, model.stats.stdDev);
  const pct = Math.round(probability * 100);

  sliderOfferEl.textContent = money(offer);
  acceptanceValue.textContent = `${pct}%`;
  acceptanceValue.className = `meter-value ${pct >= 70 ? "good" : ""}`.trim();
}

function renderNotes(sampleSize, stats, hasListing, hasRetail) {
  const anchorText = hasListing
    ? "using current listing price as base"
    : "listing missing, using retail fallback as base";

  modelNotes.innerHTML = [
    `<strong>Model details</strong>`,
    `${sampleSize} sold items analyzed, ${anchorText}.`,
    `Average sold/base ratio: <strong>${(stats.mean * 100).toFixed(1)}%</strong>.`,
    `Spread (std dev): <strong>${(stats.stdDev * 100).toFixed(1)}%</strong>.`,
    `Suggested offer is set where historical acceptance is ~<strong>70%</strong>.`
  ].join("<br>");
}

function acceptanceProbability(offerRatio, historicalRatios, stdDev) {
  const bandwidth = Math.max(0.03, stdDev * 0.8);
  const smoothCdf = historicalRatios.reduce((acc, ratio) => {
    const z = (offerRatio - ratio) / bandwidth;
    return acc + sigmoid(z);
  }, 0) / historicalRatios.length;

  return clamp(smoothCdf, 0.01, 0.99);
}

function describeRatios(ratios) {
  const mean = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
  const variance = ratios.reduce((sum, r) => sum + (r - mean) ** 2, 0) / ratios.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const t = idx - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

function roundDollar(value) {
  return Math.max(1, Math.round(value));
}

function toPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}