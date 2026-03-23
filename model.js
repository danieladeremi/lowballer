export function computeOfferModel({ listingPrice, retailPrice, sales }) {
  const anchor = toPositiveNumber(listingPrice) ?? toPositiveNumber(retailPrice);
  if (!anchor) {
    throw new Error("Add a listing price or retail fallback.");
  }

  if (!Array.isArray(sales) || sales.length < 3) {
    throw new Error("Need at least 3 valid sold items.");
  }

  const ratios = sales
    .map((sale) => {
      const base = sale.listedPrice ?? sale.retailPrice;
      return base ? sale.soldPrice / base : null;
    })
    .filter((ratio) => Number.isFinite(ratio));

  if (ratios.length < 3) {
    throw new Error("Not enough sold/listed or sold/retail ratios.");
  }

  const stats = describeRatios(ratios);
  const p10 = percentile(ratios, 0.1);
  const p70 = percentile(ratios, 0.7);
  const p90 = percentile(ratios, 0.9);

  const rangeMinRatio = clamp(p10 - 0.05, 0.25, 1.05);
  const rangeMaxRatio = clamp(p90 + 0.05, rangeMinRatio + 0.05, 1.1);

  return {
    anchor,
    ratios,
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