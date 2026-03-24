export function computeOfferModel({ listingPrice, retailPrice, sales }) {
  let anchor = toPositiveNumber(listingPrice) ?? toPositiveNumber(retailPrice);
  if (!anchor && Array.isArray(sales) && sales.length) {
    const historicalSolds = sales
      .map((sale) => toPositiveNumber(sale.soldPrice))
      .filter((value) => Number.isFinite(value));
    if (historicalSolds.length) {
      anchor = percentile(historicalSolds, 0.5);
    }
  }

  if (!anchor) {
    throw new Error("Could not infer anchor price from listing, retail, or seller history.");
  }

  const ratiosFromSales = (Array.isArray(sales) ? sales : [])
    .map((sale) => {
      const base = sale.listedPrice ?? sale.retailPrice;
      return base ? sale.soldPrice / base : null;
    })
    .filter((ratio) => Number.isFinite(ratio));

  const usingFallbackRatios = ratiosFromSales.length < 3;
  const ratios = usingFallbackRatios ? [...DEFAULT_MARKETPLACE_RATIOS] : ratiosFromSales;

  const stats = describeRatios(ratios);
  const p10 = percentile(ratios, 0.1);
  const p70 = percentile(ratios, 0.7);
  const p90 = percentile(ratios, 0.9);

  const rangeMinRatio = clamp(p10 - 0.05, 0.25, 1.05);
  const rangeMaxRatio = clamp(p90 + 0.05, rangeMinRatio + 0.05, 1.1);

  return {
    anchor,
    ratios,
    usedFallbackRatios: usingFallbackRatios,
    stats,
    suggestedOffer: roundDollar(anchor * p70),
    minOffer: roundDollar(anchor * rangeMinRatio),
    maxOffer: roundDollar(anchor * rangeMaxRatio)
  };
}

export function estimateAcceptanceProbability(offer, model) {
  const ratio = offer / model.anchor;
  const bandwidth = Math.max(0.03, model.stats.stdDev * 0.8);
  const smoothCdf = model.ratios.reduce((acc, historicalRatio) => {
    const z = (ratio - historicalRatio) / bandwidth;
    return acc + sigmoid(z);
  }, 0) / model.ratios.length;

  return clamp(smoothCdf, 0.01, 0.99);
}

export function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
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

function roundDollar(value) {
  return Math.max(1, Math.round(value));
}

function toPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const DEFAULT_MARKETPLACE_RATIOS = [0.52, 0.6, 0.67, 0.73, 0.8, 0.87];
