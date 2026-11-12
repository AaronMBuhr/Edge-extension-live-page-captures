# LinkedIn Job Scraper (Edge / Chrome Extension)

Reads a LinkedIn job posting and copies a clean, labeled, AI-ready block to the
clipboard for pasting into your job-filtering workflow. Supports a running
buffer so you can scrape several jobs and paste them all at once.

## Install (Edge or Chrome, unpacked)

1. Go to `edge://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode** (toggle, top-right).
3. Click **Load unpacked** and select the `src` folder of this project.
4. Pin the extension so its icon shows in the toolbar.

## Use

Open a LinkedIn job — either a standalone posting (`/jobs/view/...`) or a job
selected in the search results panel (`/jobs/search/?currentJobId=...`). Click
the toolbar icon, then:

- **Click "Copy Current Job to Clipboard"** — expands the "see more"
  description, scrapes the open job, *adds* it to the buffer, and copies the
  whole buffer to the clipboard. The popup shows how many jobs are buffered.
- **Shift-click that button** — clears the buffer first, then scrapes the
  current job fresh (buffer = just this one job).
- **Click "Save Job List (Markdown)"** (or press **Alt+Shift+J**) — on a
  search-results page, clicks each job card in the left-hand list in turn,
  waits for the right-hand detail panel to load that job, scrapes it, and
  collects each as a markdown section. When done it saves all of them to a
  dated file, `linkedin-jobs-YYYYMMDD.md`, in your Downloads folder. Progress
  shows as toasts on the page; jobs that fail to load are skipped and counted
  in the final toast (details in the extension's service-worker console). This
  path is independent of the clipboard buffer and does not disturb it.
- **"Clear Buffer"** — empties the clipboard buffer for a clean slate.
  Shift-click it to clear the clipboard and copy a diagnostic report instead.

Clipboard batches separate jobs with a `======` divider; the saved markdown
file separates them with `---` rules under `##` job headings.

## Output format

```
TITLE: ...
COMPANY: ...
LOCATION: ...
WORKPLACE: Remote
EMPLOYMENT TYPE: Full-time
SENIORITY: Mid-Senior level
SALARY: ...        (only if LinkedIn shows it)
URL: https://www.linkedin.com/jobs/view/<id>/

DESCRIPTION:
<full description text>
```

The URL is always normalized to the canonical `/jobs/view/<id>/` form, so the
link opens the posting directly in a new tab even when scraped from the search
panel.

## How it scrapes (and why it may need upkeep)

- **Primary source:** LinkedIn's embedded JSON-LD `JobPosting` structured data.
  This is the most stable source and survives LinkedIn's frequent CSS class
  changes.
- **Fallbacks:** DOM selectors for both the logged-in app view and the public
  guest view, anchored on the most durable selectors available.

LinkedIn changes its markup periodically. If a field stops populating, the
selectors in `src/contentScript.js` (the `readDom()` function) are where to
update. The labeled-block output and buffer logic won't be affected by such
changes.

## Files

- `src/manifest.json` — Manifest V3 config
- `src/background.js` — minimal service worker
- `src/contentScript.js` — scraping logic (JSON-LD + DOM fallbacks)
- `src/popup.html` / `src/popup.js` — UI, buffer management, clipboard
- `src/icons/` — toolbar icons
- `tests/captures.test.js` — regression tests against saved page captures

## Tests

`npm install` once, then `npm test`. The tests run `src/contentScript.js`
under jsdom against saved LinkedIn DOM captures
(`www.linkedin.com_*.dom.html` in the repo root) and check the parsed
title / company / location / salary / description. A capture that is missing
is skipped. When LinkedIn changes its markup, save a fresh capture, add it to
the `CAPTURES` list, and fix until it passes.
