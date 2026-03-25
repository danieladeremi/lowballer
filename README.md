# Lowballer Chrome Extension (MV3)

Lowballer estimates a "funny but plausible" lowball offer by modeling seller history and targeting about 70% acceptance.

## What works now

- Popup UI with offer suggestion + live acceptance probability slider.
- Auto-first mode: one-click `Auto Analyze` for listing + seller crawl workflow.
- 70% target suggested offer from historical sold/base ratios.
- Base price logic: listing price first, retail fallback if listing is missing.
- "Pull From Tab" on supported sites to extract likely listing price and any detectable history candidates.
- Grailed helper flow: detects seller/profile and can open seller reviews directly from popup.
- Grailed crawler flow: from feedback page, iterates listing links and merges sold-price + retail hints.
- Advanced manual inputs are hidden by default and optional.
- Local state persistence with `chrome.storage.local`.

## Supported hosts (current manifest)

- `grailed.com` + `*.grailed.com`
## Things that hopefully will work in the future
- `depop.com` + `*.depop.com`
- `etsy.com` + `*.etsy.com`
- `ebay.com` + `www.ebay.com` + `*.ebay.com`
- `facebook.com/marketplace/*` (+ `www`/`m` subdomains)

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

Harden each per-site adapter with real page snapshots and selector tests so extraction survives UI changes.
