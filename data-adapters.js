export const sampleHistory = [
  { title: "Arc'teryx shell", listedPrice: 280, soldPrice: 242, retailPrice: 450, soldAt: "2025-09-12" },
  { title: "Needles track pant", listedPrice: 190, soldPrice: 160, retailPrice: 295, soldAt: "2025-11-03" },
  { title: "Vintage denim", listedPrice: 140, soldPrice: 126, retailPrice: 180, soldAt: "2025-10-20" },
  { title: "Designer hoodie", listedPrice: 260, soldPrice: 205, retailPrice: 380, soldAt: "2025-12-01" },
  { title: "Leather boots", listedPrice: 310, soldPrice: 280, retailPrice: 520, soldAt: "2025-08-17" },
  { title: "Work jacket", listedPrice: 170, soldPrice: 144, retailPrice: 240, soldAt: "2025-09-24" },
  { title: "Wool coat", listedPrice: 340, soldPrice: 292, retailPrice: 620, soldAt: "2025-11-28" }
];

// Adapter interface. Real scraping should map platform response into this shared shape.
export function normalizeSales(rawItems) {
  return rawItems
    .map((item) => {
      const listedPrice = toNumber(item.listedPrice ?? item.originalPrice ?? item.askingPrice);
      const soldPrice = toNumber(item.soldPrice ?? item.finalPrice ?? item.salePrice);
      const retailPrice = toNumber(item.retailPrice ?? item.msrp);
      return {
        title: String(item.title ?? item.name ?? "Unknown item"),
        listedPrice,
        soldPrice,
        retailPrice,
        soldAt: item.soldAt ? String(item.soldAt) : null
      };
    })
    .filter((item) => Number.isFinite(item.soldPrice));
}

export function parseSalesFromJsonInput(jsonText) {
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed)) {
    throw new Error("Seller history JSON must be an array.");
  }
  return normalizeSales(parsed);
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}
