# Lowballer Chrome Extension (MV3)

Lowballer estimates a "funny but plausible" lowball offer by modeling seller history and targeting about 70% acceptance.

## What works now

- Popup UI with offer suggestion + live acceptance probability slider.
- 70% target suggested offer from historical sold/base ratios.
- Base price logic: listing price first, retail fallback if listing is missing.
- "Pull From Tab" on supported sites to extract likely listing price and any detectable history candidates.
- Local state persistence with `chrome.storage.local`.

## Supported hosts (current manifest)

- `*.grailed.com`
- `*.depop.com`
- `*.ebay.com`
- `*.poshmark.com`
- `*.mercari.com`

## Install locally (Load Unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `C:\Users\danny\Downloads\lowballer`.
5. Open a supported listing page and click the extension icon.

## Files added for extension

- `manifest.json`: MV3 manifest.
- `popup.html`: extension popup UI.
- `popup.css`: popup styles.
- `popup.js`: popup interactions, model wiring, tab extraction, storage.
- `model.js`: shared pricing + acceptance model.
- `content-script.js`: in-page extraction for listing/retail/history candidates.
- `data-adapters.js`: normalization + JSON parsing + sample history.

## Important limits

- No tool can reliably scrape "every" website without custom handling.
- Each marketplace can require adapter updates because DOM/API/anti-bot behavior changes.
- Seller history is often partially hidden, so history extraction is best-effort.
- You should comply with each platform terms and applicable laws before scraping.

## Chrome Web Store go-live checklist

1. Confirm MV3, permissions, and host access are minimal for your use case.
2. Add production icons/screenshots and a clear privacy disclosure.
3. Create/verify your Chrome Web Store developer account.
4. Zip extension files and upload through the developer dashboard.
5. Fill store listing details and privacy fields.
6. Submit for review, address feedback, then publish.

## Next build step (recommended)

Add per-site adapters in `content-script.js` with explicit selectors/JSON paths for each platform so extraction is much more accurate than generic heuristics.