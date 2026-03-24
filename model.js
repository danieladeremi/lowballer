export function computeOfferModel({ listingPrice, purchasePrice, retailPrice, sales }) {
  const listingAnchor = toPositiveNumber(listingPrice);
  const purchaseAnchor = toPositiveNumber(purchasePrice);
  const usePurchaseCap = !listingAnchor && Boolean(purchaseAnchor);

  let anchor = listingAnchor ?? purchaseAnchor ?? toPositiveNumber(retailPrice);
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

  // Always allow users to push as low as an 80% discount (offer = 20% of anchor).
  const rangeMinRatio = 0.2;
  const rangeMaxRatio = clamp(p90 + 0.05, rangeMinRatio + 0.05, 1.1);
  const purchaseCap = usePurchaseCap ? roundDollar(purchaseAnchor) : null;

  let minOffer = roundDollar(anchor * rangeMinRatio);
  let maxOffer = roundDollar(anchor * rangeMaxRatio);
  if (purchaseCap) {
    maxOffer = purchaseCap;
  }
  if (minOffer > maxOffer) {
    minOffer = maxOffer;
  }

  const suggestedOffer = clamp(roundDollar(anchor * p70), minOffer, maxOffer);

  return {
    anchor,
    purchaseCap,
    ratios,
    usedFallbackRatios: usingFallbackRatios,
    stats,
    suggestedOffer,
    minOffer,
    maxOffer
  };
}

export function estimateAcceptanceProbability(offer, model) {
  if (Number.isFinite(model?.purchaseCap) && offer >= model.purchaseCap) {
    return 1;
  }

  const ratio = offer / model.anchor;
  const empiricalCdf =
    model.ratios.filter((historicalRatio) => historicalRatio <= ratio).length / model.ratios.length;

  // Keep only light smoothing so probabilities remain close to observed history.
  const bandwidth = Math.max(0.015, Math.min(0.04, model.stats.stdDev * 0.15));
  const smoothCdf = model.ratios.reduce((acc, historicalRatio) => {
    const z = (ratio - historicalRatio) / bandwidth;
    return acc + sigmoid(z);
  }, 0) / model.ratios.length;

  const blended = empiricalCdf * 0.7 + smoothCdf * 0.3;
  return clamp(blended, 0.0001, 0.99);
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
