console.log("LinkedIn Job Scraper: contentScript loaded.");

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request.action === 'scrapeJob') {
        scrapeJob(request.url)
            .then(result => sendResponse(result))
            .catch(error => {
                console.error("LinkedIn Job Scraper: error in scrapeJob:", error);
                sendResponse({ ok: false, error: String(error) });
            });
        return true; // keep the message channel open for async sendResponse
    }
    if (request.action === 'diagnoseJob') {
        diagnoseJob(request.url)
            .then(result => sendResponse(result))
            .catch(error => {
                console.error("LinkedIn Job Scraper: error in diagnoseJob:", error);
                sendResponse({ ok: false, error: String(error) });
            });
        return true;
    }
    if (request.action === 'listJobs') {
        try {
            sendResponse({ ok: true, jobs: listJobCards() });
        } catch (error) {
            console.error("LinkedIn Job Scraper: error in listJobs:", error);
            sendResponse({ ok: false, error: String(error) });
        }
        return false; // synchronous
    }
    if (request.action === 'clickAndScrapeJob') {
        clickAndScrapeJob(request.jobId)
            .then(result => sendResponse(result))
            .catch(error => {
                console.error("LinkedIn Job Scraper: error in clickAndScrapeJob:", error);
                sendResponse({ ok: false, error: String(error) });
            });
        return true;
    }
});

// ---------------------------------------------------------------------------
// Batch mode: enumerate the left-hand result list and scrape one job by
// clicking its card. The background service worker drives the loop with one
// short message per job so the MV3 worker never sits idle long enough to die.
//
// Anchors (verified against captured DOMs of the 2026 SDUI jobs view):
//  - each card:   div[role="button"][componentkey="job-card-component-ref-<id>"]
//  - detail sync: an element with componentkey="JobDetails_AboutTheJob_<id>"
//    appears once the right panel is actually showing job <id>.
// ---------------------------------------------------------------------------
function findJobCards() {
    // The componentkey appears on a nested div too; keep only the clickable
    // role="button" wrapper, deduped by job id in DOM (list) order.
    const nodes = document.querySelectorAll(
        'div[role="button"][componentkey^="job-card-component-ref-"]');
    const byId = new Map();
    for (const node of nodes) {
        const id = (node.getAttribute('componentkey') || '')
            .replace('job-card-component-ref-', '');
        if (/^\d+$/.test(id) && !byId.has(id)) byId.set(id, node);
    }
    // Classic (pre-SDUI) UI fallback: <li data-occludable-job-id="<id>">.
    if (byId.size === 0) {
        for (const li of document.querySelectorAll('[data-occludable-job-id]')) {
            const id = li.getAttribute('data-occludable-job-id') || '';
            if (/^\d+$/.test(id) && !byId.has(id)) byId.set(id, li);
        }
    }
    return byId;
}

function listJobCards() {
    const jobs = [];
    for (const [id, card] of findJobCards()) {
        const t = cleanText(card.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
        jobs.push({ id: id, title: t[0] || null });
    }
    return jobs;
}

function detailPanelShows(jobId) {
    return !!document.querySelector(
        '[componentkey="JobDetails_AboutTheJob_' + jobId + '"]');
}

async function clickAndScrapeJob(jobId) {
    const card = findJobCards().get(String(jobId));
    if (!card) {
        return { ok: false, error: 'Job card ' + jobId + ' no longer found in the list.' };
    }

    if (!detailPanelShows(jobId)) {
        card.scrollIntoView({ block: 'center' });
        await sleep(150); // let the scroll settle so elementFromPoint hits the card

        const started = Date.now();
        clickLikeAUser(card);
        let ready = await waitForDetailPanel(jobId, 4000);
        if (!ready) {
            // Retry: role="button" elements also activate on Enter, and a
            // keyboard path sidesteps any pointer-specific handling.
            pressEnterOn(card);
            ready = await waitForDetailPanel(jobId, 4000);
        }
        if (!ready) {
            return {
                ok: false,
                error: 'Detail panel never showed job ' + jobId + ' after click + Enter retry (' +
                    (Date.now() - started) + 'ms) — the page may be ignoring synthetic clicks.'
            };
        }
        await sleep(300); // the About section just mounted; let its text settle
    }

    // Reuse the single-job pipeline; the canonical URL comes from the card's
    // job id because clicking a card doesn't reliably update the tab URL.
    await expandSeeMore();
    const parsed = parseCurrentJob('https://www.linkedin.com/jobs/view/' + jobId + '/');

    const heading = findHeadingByText(['about the job', 'job description', 'about this job']);
    const titleOk = parsed.title && !looksLikeNavChrome(parsed.title);
    const hasRealContent = !!heading || (parsed.description && parsed.description.length >= 40);
    if (!titleOk || !hasRealContent) {
        return { ok: false, error: 'Job ' + jobId + ' loaded but could not be parsed.' };
    }
    return { ok: true, text: parsed.formattedText, md: parsed.markdown, title: parsed.title };
}

// Wait until the right panel is showing this specific job. On the SDUI view
// the componentkey marker is exact. The classic view has no per-job marker,
// so there accept the URL pointing at this job plus the generic readiness
// check — but only when no SDUI marker exists at all, otherwise a stale
// marker from the previous job would let us scrape the wrong panel.
async function waitForDetailPanel(jobId, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
        if (detailPanelShows(jobId)) return true;
        if (!document.querySelector('[componentkey^="JobDetails_AboutTheJob_"]') &&
            location.href.indexOf('currentJobId=' + jobId) !== -1 && isJobReady()) {
            return true;
        }
        await sleep(200);
    }
    return detailPanelShows(jobId);
}

// SDUI cards are div[role=button] rendered by React. React may bind the
// handler on a DESCENDANT of the card wrapper, and a bubbling event dispatched
// on the wrapper never reaches handlers below it — so aim at the topmost
// element a real pointer would hit (elementFromPoint at the card's center) and
// let the sequence bubble up through every layer.
function clickLikeAUser(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let target = document.elementFromPoint(cx, cy);
    if (!target || !el.contains(target)) target = el;

    const opts = {
        bubbles: true, cancelable: true, composed: true, view: window,
        detail: 1, button: 0, buttons: 1, clientX: cx, clientY: cy
    };
    const up = Object.assign({}, opts, { buttons: 0 });
    try { target.dispatchEvent(new PointerEvent('pointerover', opts)); } catch (e) { /* ignore */ }
    try { target.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) { /* ignore */ }
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    try { el.focus(); } catch (e) { /* ignore */ }
    try { target.dispatchEvent(new PointerEvent('pointerup', up)); } catch (e) { /* ignore */ }
    target.dispatchEvent(new MouseEvent('mouseup', up));
    target.dispatchEvent(new MouseEvent('click', up));
}

// Keyboard activation fallback for role="button" cards.
function pressEnterOn(el) {
    try { el.focus(); } catch (e) { /* ignore */ }
    const opts = {
        bubbles: true, cancelable: true, composed: true,
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13
    };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
}

// ---------------------------------------------------------------------------
// Main scrape routine.
//
// LinkedIn's logged-in app view uses randomized/obfuscated CSS class names and
// ships NO JSON-LD, so we anchor on stable things: document.title, heading
// TEXT ("About the job"), aria-labels, and link hrefs — never class names.
// ---------------------------------------------------------------------------
async function scrapeJob(pageUrl) {
    // The detail panel loads asynchronously (and a stray click can navigate the
    // tab to the full job-view page, which then re-loads). If we parse too early
    // we read LinkedIn's global-nav chrome ("Post", "0 notifications") instead of
    // the job. Wait for the real job content to render before touching anything.
    await waitForJobReady(3000);

    await expandSeeMore(); // best-effort: open "…more" so we get full text

    const parsed = parseCurrentJob(pageUrl);

    // Only treat this as a successful scrape when we actually landed on a loaded
    // job. A non-chrome title is required, plus either the description heading or
    // a substantial description body — otherwise we'd append nav-bar garbage.
    const heading = findHeadingByText(['about the job', 'job description', 'about this job']);
    const titleOk = parsed.title && !looksLikeNavChrome(parsed.title);
    const hasRealContent = !!heading || (parsed.description && parsed.description.length >= 40);

    if (!titleOk || !hasRealContent) {
        return {
            ok: false,
            error: "Could not find job data on this page (the job panel may not have finished loading). A diagnostic report was copied to the clipboard — paste it back for analysis.",
            diagnostics: buildDiagnostics(pageUrl, parsed, parsed.descNode)
        };
    }

    return { ok: true, text: parsed.formattedText };
}

// A job is "ready" to scrape once a real (non-chrome) title <h1> and the
// description heading have both rendered. Poll briefly so an in-progress
// navigation / async load doesn't get parsed as global-nav chrome.
async function waitForJobReady(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 3000);
    while (Date.now() < deadline) {
        if (isJobReady()) return true;
        await sleep(150);
    }
    return isJobReady();
}

// The SDUI search view has no title <h1> at all, so the title may come from
// document.title instead (parseTitleCompany prefers a real <h1> when present).
// Requiring the description body to have rendered too keeps a half-loaded
// panel from counting as ready.
function isJobReady() {
    const heading = findHeadingByText(['about the job', 'job description', 'about this job']);
    if (!heading) return false;
    const t = parseTitleCompany().title;
    if (!t || looksLikeNavChrome(t)) return false;
    return !!findDescriptionNode(getJobPanel());
}

async function diagnoseJob(pageUrl) {
    await expandSeeMore(); // diagnostics should inspect the same expanded state as scraping
    const parsed = parseCurrentJob(pageUrl);
    return { ok: true, diagnostics: buildDiagnostics(pageUrl, parsed, parsed.descNode) };
}

function parseCurrentJob(pageUrl) {
    const panel       = getJobPanel();
    const headerText  = getPanelHeaderText(panel);

    const titleCompany = parseTitleCompany();
    const title       = titleCompany.title;
    const company     = findCompany(panel, headerText, titleCompany.company, title);
    const descNode    = findDescriptionNode(panel);
    let description   = descNode ? cleanText(descNode.innerText || descNode.textContent || '') : null;
    if (description) {
        // The chosen container often includes the heading text itself; drop it.
        description = description.replace(/^\s*(about the job|job description|about this job)\s*\n+/i, '').trim();
        // LinkedIn auto-appends a "Benefits found in job post" block that isn't
        // part of the employer's text — trim it and anything after.
        description = description.replace(/\n+Benefits found in job post[\s\S]*$/i, '').trim();
    }
    const location    = findLocation(headerText);
    const workplace   = findWorkplace(headerText);
    const employment  = findEmployment(headerText);
    const seniority   = findSeniority(panel);
    const salary      = findSalary(headerText, extractJobId(pageUrl));
    const canonicalUrl = buildCanonicalUrl(pageUrl);

    const fields = { title, company, location, workplace, employment, seniority, salary, description, canonicalUrl };
    const formattedText = formatBlock(fields);
    const markdown = formatMarkdown(fields);

    return {
        title, company, location, workplace, employment, seniority, salary,
        description, canonicalUrl, formattedText, markdown, descNode, headerText,
        panelText: cleanText(panel.innerText || '')
    };
}

// ---------------------------------------------------------------------------
// Title + company from document.title: "<job> | <company> | LinkedIn"
// Falls back to the first non-chrome <h1> for the title if needed.
// ---------------------------------------------------------------------------
function parseTitleCompany() {
    const out = { title: null, company: null };
    const dt = document.title || '';
    // Strip a trailing " | LinkedIn"
    const cleaned = dt.replace(/\s*\|\s*LinkedIn\s*$/i, '').trim();
    const parts = cleaned.split('|').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
        out.title = parts[0];
        out.company = parts[1];
    } else if (parts.length === 1 && parts[0]) {
        out.title = parts[0];
    }

    // Prefer a real on-page <h1> for the title if it looks like a job title
    // (document.title can get truncated by LinkedIn). pickTitleH1 already filters
    // out global-nav chrome and prefers the heading tied to the job description.
    const h1 = pickTitleH1();
    if (h1) {
        const t = cleanText(h1.innerText || h1.textContent || '');
        if (t && t.length > 2 && !looksLikeNavChrome(t)) {
            out.title = t;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Company: prefer a real LinkedIn company/school link near the job title.
// document.title is only a fallback because LinkedIn sometimes omits or
// truncates it. Never derive company from the description text; that is too
// likely to capture clients, recruiters, boilerplate, or unrelated vendors.
// ---------------------------------------------------------------------------
function findCompany(panel, headerText, fallbackCompany, title) {
    const fromLink = findCompanyFromLinks(panel, title);
    if (fromLink) return fromLink;

    const fromHeader = findCompanyFromHeader(headerText, title);
    if (fromHeader) return fromHeader;

    fallbackCompany = cleanupCompanyText(fallbackCompany || '');
    return isPlausibleCompanyName(fallbackCompany, title) ? fallbackCompany : null;
}

function findCompanyFromLinks(panel, title) {
    const scopes = [];
    const h1 = pickTitleH1();

    // LinkedIn normally puts the company link close to the title. Walk upward
    // from the title so we inspect the top card before the broader panel.
    if (h1) {
        let node = h1.parentElement;
        for (let i = 0; i < 6 && node; i++) {
            scopes.push(node);
            node = node.parentElement;
        }
    }
    if (panel) scopes.push(panel);

    const seen = new Set();
    for (const scope of scopes) {
        if (!scope || !scope.querySelectorAll) continue;
        const links = Array.from(scope.querySelectorAll(
            'a[href*="/company/"], a[href*="/school/"], a[href*="/showcase/"]'
        ));

        for (const a of links) {
            const href = a.getAttribute('href') || '';
            // "Show Premium Insights" etc. link to /company/<x>/insights/ — UI, not a name.
            if (/\/insights\b/i.test(href)) continue;
            const raw = cleanText(
                (a.innerText || a.textContent || '') ||
                a.getAttribute('aria-label') ||
                a.getAttribute('title') ||
                ''
            );
            const candidate = cleanupCompanyText(raw);
            const key = href + '|' + candidate;
            if (seen.has(key)) continue;
            seen.add(key);

            if (isPlausibleCompanyName(candidate, title)) return candidate;
        }
    }
    return null;
}

function findCompanyFromHeader(headerText, title) {
    const lines = (headerText || '')
        .split('\n')
        .map(l => cleanupCompanyText(l))
        .filter(Boolean);

    // Common LinkedIn shape:
    //   Job Title
    //   Company · City, ST · Reposted ...
    // Grab the segment before the first middle dot when the rest of the line
    // looks like location / timing / applicant metadata.
    for (const line of lines.slice(0, 12)) {
        if (sameText(line, title)) continue;
        if (!/[·•]/.test(line)) continue;

        const parts = line.split(/[·•]/).map(p => cleanupCompanyText(p)).filter(Boolean);
        if (!parts.length) continue;

        const first = parts[0];
        const rest = parts.slice(1).join(' · ');
        if (isPlausibleCompanyName(first, title) && looksLikeLinkedInHeaderRemainder(rest)) {
            return first;
        }
    }

    // Fallback for layouts where company is on its own line directly under the
    // title. Keep this conservative to avoid returning location/status text.
    for (const line of lines.slice(0, 8)) {
        if (sameText(line, title)) continue;
        if (looksLikeHeaderChrome(line)) continue;
        if (looksLikeLocationLine(line)) continue;
        if (isPlausibleCompanyName(line, title)) return line;
    }

    return null;
}

function cleanupCompanyText(text) {
    return cleanText(text || '')
        .replace(/^Company\s+/i, '')
        .replace(/\s+logo$/i, '')
        .replace(/\s+company logo$/i, '')
        .replace(/\s+\d[\d,]*(?:\.\d+)?\s*(?:K|M)?\s+followers\b[\s\S]*$/i, '')
        .replace(/\s+View all jobs[\s\S]*$/i, '')
        .replace(/\s+Follow\b[\s\S]*$/i, '')
        .replace(/\s+Visit website\b[\s\S]*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isPlausibleCompanyName(text, title) {
    if (!text) return false;
    if (text.length < 2 || text.length > 120) return false;
    if (sameText(text, title)) return false;
    if (/^(LinkedIn|Jobs|Search|Apply|Easy Apply|Save|Saved|Follow|Following|Show more|See more|Visit website|Company|About the job)$/i.test(text)) return false;
    if (/^(Remote|Hybrid|On-?site|Full-?time|Part-?time|Contract|Temporary|Internship|Freelance)$/i.test(text)) return false;
    if (/^(Entry level|Associate|Mid-Senior level|Director|Executive|Not Applicable)$/i.test(text)) return false;
    if (/\b(applicants?|people clicked apply|reposted|posted|promoted)\b/i.test(text)) return false;
    if (/^(Show|See|View)\b/i.test(text)) return false; // "Show Premium Insights", "Show more"
    if (looksLikeLocationLine(text)) return false;
    return true;
}

function looksLikeLinkedInHeaderRemainder(text) {
    return /\b(remote|hybrid|on-?site|full-?time|part-?time|contract|temporary|internship|freelance|applicants?|people clicked apply|reposted|posted|ago|promoted)\b/i.test(text) ||
        /\b[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\b/.test(text);
}

function looksLikeHeaderChrome(text) {
    return /\b(apply|easy apply|save|saved|applicants?|people clicked apply|reposted|posted|promoted|actively reviewing applicants|your profile matches)\b/i.test(text) ||
        /^(Remote|Hybrid|On-?site|Full-?time|Part-?time|Contract|Temporary|Internship|Freelance)$/i.test(text);
}

// "Coalition, Inc." / "Acme, LLC" have the same "Word, Word" shape as
// "City, State"; a corporate suffix after the comma means it's a company.
// Deliberately no 2-letter suffixes (Co, NV, PA...) — they collide with states.
function hasCorporateSuffix(text) {
    return /,\s*(Inc|LLC|Ltd|Limited|Corp|Corporation|Company|LLP|PLC|PLLC|GmbH|Pty)\b\.?/i.test(text || '');
}

function looksLikeLocationLine(text) {
    if (hasCorporateSuffix(text)) return false;
    return /^([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})(?:\b|\s*[·(])/i.test(text) ||
        /^([A-Z][A-Za-z .'-]+,\s*[A-Z][A-Za-z .'-]+)(?:\b|\s*[·(])/i.test(text);
}

function sameText(a, b) {
    if (!a || !b) return false;
    return cleanText(a).toLowerCase() === cleanText(b).toLowerCase();
}

// ---------------------------------------------------------------------------
// Description: find the heading whose text is "About the job" and return the
// nearest following content container. Structure-anchored, not class-anchored.
// ---------------------------------------------------------------------------
function findDescriptionNode(panel) {
    const heading = findHeadingByText(['about the job', 'job description', 'about this job'], panel);
    if (!heading) return null;

    // Strategy: walk up to a reasonable section ancestor, then find the largest
    // text block within it that follows the heading. We look at the heading's
    // parent and its next siblings, picking the element with the most text.
    let candidates = [];

    // 1) Next siblings of the heading
    let sib = heading.nextElementSibling;
    let hops = 0;
    while (sib && hops < 4) {
        candidates.push(sib);
        sib = sib.nextElementSibling;
        hops++;
    }
    // 2) Next siblings of the heading's parent (LinkedIn often wraps the heading
    //    in its own div, with the body as the parent's sibling)
    if (heading.parentElement) {
        let psib = heading.parentElement.nextElementSibling;
        hops = 0;
        while (psib && hops < 4) {
            candidates.push(psib);
            psib = psib.nextElementSibling;
            hops++;
        }
        // 3) The parent container itself (description may be nested inside)
        candidates.push(heading.parentElement);
        if (heading.parentElement.parentElement) {
            candidates.push(heading.parentElement.parentElement);
        }
    }

    // Pick the candidate with the most text that doesn't look like UI chrome.
    let best = null, bestLen = 0;
    for (const c of candidates) {
        if (!c) continue;
        const t = cleanText(c.innerText || c.textContent || '');
        if (t.length > bestLen && !looksLikeChrome(t)) {
            best = c;
            bestLen = t.length;
        }
    }
    return bestLen >= 40 ? best : null;
}

function looksLikeChrome(text) {
    // Reject blocks that are clearly navigation / upsell rather than the JD.
    const t = text.toLowerCase();
    if (t.length < 40) return true;
    if (/people clicked apply|top applicant|tailor my resume|get job alerts/.test(t) && t.length < 200) return true;
    return false;
}

// ---------------------------------------------------------------------------
// Establish the "job panel" scope: the right-hand detail container. We anchor
// on the job-title <h1> and walk up to an ancestor large enough to contain the
// description. Everything else is scoped to this so we never pick up text from
// the left-hand results list.
// ---------------------------------------------------------------------------
function getJobPanel() {
    // SDUI search view: there is no title <h1>, and walking up from the
    // description eventually swallows the left-hand result list. Take the
    // largest ancestor of the "About the job" heading that still contains no
    // job card — that is the right-hand detail pane (top card + description).
    const cardSel = '[componentkey^="job-card-component-ref-"], [data-occludable-job-id]';
    const descHeading = findHeadingByText(['about the job', 'job description', 'about this job']);
    if (descHeading && document.querySelector(cardSel)) {
        let best = null;
        let node = descHeading.parentElement;
        while (node && node !== document.body && !node.querySelector(cardSel)) {
            best = node;
            node = node.parentElement;
        }
        if (best) return best;
    }

    const h1 = pickTitleH1();
    if (!h1) return document.body;
    // Walk up until the ancestor's text also contains "About the job" (i.e. it
    // spans both the header and the description), or we hit a sensible cap.
    let node = h1;
    for (let i = 0; i < 8 && node.parentElement; i++) {
        node = node.parentElement;
        const t = (node.innerText || '').toLowerCase();
        if (t.includes('about the job') || t.includes('job description')) {
            return node;
        }
    }
    // Fallback: a few levels up from the h1.
    let p = h1;
    for (let i = 0; i < 4 && p.parentElement; i++) p = p.parentElement;
    return p;
}

function pickTitleH1() {
    const h1s = Array.from(document.querySelectorAll('h1'));
    const nonChrome = h1s.filter(h =>
        !looksLikeNavChrome(cleanText(h.innerText || h.textContent || '')));

    // The real job title shares a (non-body) ancestor with the description
    // heading. Global-nav h1s ("Post", "0 notifications") live in the top bar and
    // only share <body> with it, so they get rejected here.
    const descHeading = findHeadingByText(['about the job', 'job description', 'about this job']);
    if (descHeading) {
        for (const h of nonChrome) {
            let node = h.parentElement;
            for (let i = 0; i < 10 && node; i++) {
                if (node !== document.body && node !== document.documentElement &&
                    node.contains(descHeading)) {
                    return h;
                }
                node = node.parentElement;
            }
        }
    }

    return nonChrome[0] || h1s[0] || null;
}

// Text that belongs to LinkedIn's global navigation / app chrome rather than a
// job. Used to reject bogus titles like "Post" or "0 notifications".
function looksLikeNavChrome(text) {
    const t = cleanText(text || '');
    if (!t || t.length <= 2) return true;
    if (/^(linkedin|post|home|jobs|messaging|my network|search|feed|me|work|notifications?)$/i.test(t)) return true;
    if (/\bnotifications?$/i.test(t)) return true; // "0 notifications", "3 new notifications"
    if (/^\d+\s+new\b/i.test(t)) return true;      // "3 new messages"
    return false;
}

// The header region: the panel text from the title down to (but not including)
// the description. This is where the location line and the pills live.
function getPanelHeaderText(panel) {
    const full = cleanText(panel.innerText || '');
    const idx = full.toLowerCase().indexOf('about the job');
    const header = idx > 0 ? full.slice(0, idx) : full.slice(0, 1500);
    return header;
}

// ---------------------------------------------------------------------------
// Location, workplace, employment, seniority, salary — scoped to the job panel
// header so left-rail results never contaminate them.
// ---------------------------------------------------------------------------
function findLocation(headerText) {
    const lines = headerText.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines.slice(0, 10)) {
        if (hasCorporateSuffix(line)) continue; // "Coalition, Inc. • United States (Remote)"
        // e.g. "Jacksonville, FL · 1 week ago · 11 people clicked apply"
        const m = line.match(/^([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})\b(?:\s*\([^)]+\))?/);
        if (m) return m[1].trim();
        const m2 = line.match(/^([A-Z][A-Za-z .'-]+,\s*[A-Z][A-Za-z .'-]+?)(?:\s*·|\s*\()/);
        if (m2) return m2[1].trim();
    }
    // Non-"City, ST" locations ("United States", "Greater Boston") are only
    // trusted on the top-card metadata line: "<location> · Reposted 6 days ago · …".
    for (const line of lines.slice(0, 15)) {
        const parts = line.split('·').map(p => p.trim()).filter(Boolean);
        if (parts.length < 2) continue;
        if (!/\b(posted|reposted|ago|applicants?|clicked apply)\b/i.test(parts.slice(1).join(' '))) continue;
        const loc = parts[0].replace(/\s*\([^)]*\)\s*$/, '').trim();
        if (loc && loc.length <= 60 && !/\d/.test(loc) &&
            !/\b(posted|reposted|ago|applicants?)\b/i.test(loc)) return loc;
    }
    return null;
}

function findWorkplace(headerText) {
    const m = headerText.match(/\b(Remote|Hybrid|On-?site)\b/i);
    return m ? titleCase(m[1]) : null;
}

function findEmployment(headerText) {
    const m = headerText.match(/\b(Full-?time|Part-?time|Contract|Temporary|Internship|Freelance)\b/i);
    return m ? titleCase(m[1]) : null;
}

// Seniority: only trust it when LinkedIn presents it as a labeled field
// ("Seniority level\nMid-Senior level"). A bare keyword match elsewhere is too
// unreliable (it pulled "Associate" from the results list before), so if we
// can't find the labeled form, return null rather than guess.
function findSeniority(panel) {
    const text = cleanText(panel.innerText || '');
    const m = text.match(/Seniority level\s*\n?\s*(Entry level|Associate|Mid-Senior level|Director|Executive|Internship|Not Applicable)/i);
    return m ? m[1] : null;
}

function findSalary(headerText, jobId) {
    // Prefer the detail header; on the SDUI search view the pay range is only
    // shown on this job's own card in the left-hand list. Never scan the JD
    // prose (stray dollar figures) or other cards (another job's pay).
    const card = jobId ? findJobCards().get(String(jobId)) : null;
    const cardText = card ? cleanText(card.innerText || card.textContent || '') : '';
    const scope = headerText + '\n' + cardText;
    // One amount: "$209.5K/yr", "$180,000", "$45/hr". A range repeats it after
    // a dash ("$209.5K/yr - $246.5K/yr", "$180,000—$220,000 USD").
    const amount = String.raw`\$[\d,]+(?:\.\d+)?\s*[KM]?(?:\s*\/\s*[A-Za-z]+)?`;
    const re = new RegExp(amount + String.raw`(?:\s*[-–—]\s*` + amount + String.raw`)?(?:\s*USD|\s*per\s+[A-Za-z]+)?`, 'i');
    const m = scope.match(re);
    return m ? m[0].replace(/\s+/g, ' ').trim() : null;
}

// ---------------------------------------------------------------------------
// Expand the "…more" / "see more" description button if present.
// We click any button whose text/aria suggests "more", then wait briefly.
// ---------------------------------------------------------------------------
async function expandSeeMore() {
    // Scope to the job panel and to genuine description expanders only. The old
    // version matched the bare word "more" across the whole document and included
    // anchors, so it could click navigation links / overflow menus and send the
    // tab to the full job-view page (re-loading it mid-scrape).
    const panel = getJobPanel();
    const root = (panel && panel.querySelectorAll) ? panel : document;
    const buttons = Array.from(root.querySelectorAll('button'));
    for (const btn of buttons) {
        if (btn.closest('a[href]')) continue; // never click something that navigates
        const label = ((btn.textContent || '') + ' ' + (btn.getAttribute('aria-label') || ''))
            .replace(/\s+/g, ' ').trim().toLowerCase();
        if (!label || label.length > 24) continue;
        if (/less/.test(label)) continue;
        // Skip overflow / list expanders that aren't the description "…more".
        if (/jobs|results|actions|options|reactions|comments|replies|skills/.test(label)) continue;

        const isDescExpander =
            /(see|show|read)\s+more\b/.test(label) ||
            /(…|\.\.\.)\s*more\b/.test(label);
        if (isDescExpander) {
            try { btn.click(); await sleep(250); } catch (e) { /* ignore */ }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function findHeadingByText(needles, scope) {
    const root = scope || document;
    const heads = root.querySelectorAll('h1, h2, h3, h4');
    for (const h of heads) {
        const t = cleanText(h.innerText || h.textContent || '').toLowerCase();
        for (const n of needles) {
            if (t === n || t.startsWith(n)) return h;
        }
    }
    return null;
}

function cleanText(s) {
    return (s || '')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function titleCase(s) {
    return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function buildCanonicalUrl(pageUrl) {
    const id = extractJobId(pageUrl);
    if (id) return `https://www.linkedin.com/jobs/view/${id}/`;
    return pageUrl;
}

function extractJobId(url) {
    if (!url) return null;
    let m = url.match(/\/jobs\/view\/(\d+)/);
    if (m) return m[1];
    m = url.match(/[?&]currentJobId=(\d+)/);
    if (m) return m[1];
    m = url.match(/-(\d{6,})(?:\/|\?|$)/);
    if (m) return m[1];
    return null;
}

function formatBlock(d) {
    const lines = [];
    if (d.title)        lines.push('TITLE: ' + d.title);
    if (d.company)      lines.push('COMPANY: ' + d.company);
    if (d.location)     lines.push('LOCATION: ' + d.location);
    if (d.workplace)    lines.push('WORKPLACE: ' + d.workplace);
    if (d.employment)   lines.push('EMPLOYMENT TYPE: ' + d.employment);
    if (d.seniority)    lines.push('SENIORITY: ' + d.seniority);
    if (d.salary)       lines.push('SALARY: ' + d.salary);
    if (d.canonicalUrl) lines.push('URL: ' + d.canonicalUrl);
    let block = lines.join('\n');
    if (d.description) block += '\n\nDESCRIPTION:\n' + d.description;
    return block;
}

// Markdown rendering of one job — a "## Title — Company" section, a labeled
// bullet list of the metadata, then the full description under "### Description".
// Used by the "Save Job List" flow; the background worker stitches sections
// together into one dated document.
function formatMarkdown(d) {
    const lines = [];
    const heading = d.title || 'Untitled role';
    lines.push('## ' + (d.company ? heading + ' — ' + d.company : heading));
    lines.push('');
    if (d.company)      lines.push('- **Company:** ' + d.company);
    if (d.location)     lines.push('- **Location:** ' + d.location);
    if (d.workplace)    lines.push('- **Workplace:** ' + d.workplace);
    if (d.employment)   lines.push('- **Employment type:** ' + d.employment);
    if (d.seniority)    lines.push('- **Seniority:** ' + d.seniority);
    if (d.salary)       lines.push('- **Compensation:** ' + d.salary);
    if (d.canonicalUrl) lines.push('- **URL:** ' + d.canonicalUrl);
    if (d.description) {
        lines.push('');
        lines.push('### Description');
        lines.push('');
        lines.push(d.description);
    }
    return lines.join('\n');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Diagnostics — built on scrape failure or manually via Shift-click Clear
// Buffer. Includes parsed output plus the HTML around the "About the job"
// heading so selectors can be perfected without guessing.
// Safe to paste back: page structure + your own search query, no credentials.
// ---------------------------------------------------------------------------
function buildDiagnostics(pageUrl, parsed, descNode) {
    const lines = [];
    const trim = (v, n) => {
        if (v === null || v === undefined) return '(null)';
        const s = String(v).replace(/\s+/g, ' ').trim();
        n = n || 120;
        return s.length > n ? s.slice(0, n) + ` …[${s.length} chars total]` : s;
    };

    lines.push('===== LINKEDIN JOB SCRAPER — DIAGNOSTIC REPORT =====');
    lines.push('Build: 12');
    lines.push('Generated: ' + new Date().toISOString());
    lines.push('');
    lines.push('--- PAGE ---');
    lines.push('URL: ' + pageUrl);
    lines.push('Path: ' + location.pathname);
    lines.push('Extracted job id: ' + (extractJobId(pageUrl) || '(none)'));
    lines.push('document.title: ' + trim(document.title));
    lines.push('');
    lines.push('--- PARSED RESULT ---');
    lines.push('title=' + trim(parsed.title));
    lines.push('company=' + trim(parsed.company));
    lines.push('location=' + trim(parsed.location));
    lines.push('workplace=' + trim(parsed.workplace));
    lines.push('employment=' + trim(parsed.employment));
    lines.push('seniority=' + trim(parsed.seniority));
    lines.push('salary=' + trim(parsed.salary));
    lines.push('description length=' + ((parsed.description || '').length));
    lines.push('');

    lines.push('--- FORMATTED SCRAPE OUTPUT (truncated) ---');
    lines.push(trim(parsed.formattedText, 1600));
    lines.push('');

    lines.push('--- PANEL HEADER TEXT (truncated) ---');
    lines.push(trim(parsed.headerText, 1200));
    lines.push('');

    lines.push('--- PANEL TEXT PREVIEW (truncated) ---');
    lines.push(trim(parsed.panelText, 1600));
    lines.push('');

    lines.push('--- "ABOUT THE JOB" HEADING ---');
    const heading = findHeadingByText(['about the job', 'job description', 'about this job']);
    if (!heading) {
        lines.push('NOT FOUND. All headings on page:');
        document.querySelectorAll('h1,h2,h3,h4').forEach((h, i) => {
            if (i < 20) lines.push(`  <${h.tagName.toLowerCase()}> ${trim(h.innerText, 60)}`);
        });
    } else {
        lines.push('Found heading: <' + heading.tagName.toLowerCase() + '> ' + trim(heading.innerText, 50));
        lines.push('Heading parent tag: ' + (heading.parentElement ? heading.parentElement.tagName.toLowerCase() : '(none)'));
        lines.push('');
        lines.push('Description node chosen: ' + (descNode ? '<' + descNode.tagName.toLowerCase() + '> textLen=' + (descNode.innerText || '').length : '(none)'));
        lines.push('');
        lines.push('--- HTML AROUND HEADING (outerHTML, truncated) ---');
        // Dump the heading's grandparent so we see the surrounding structure.
        const container = heading.parentElement && heading.parentElement.parentElement
            ? heading.parentElement.parentElement
            : (heading.parentElement || heading);
        let html = container.outerHTML || '';
        html = html.replace(/\s+/g, ' ');
        lines.push(html.slice(0, 1800) + (html.length > 1800 ? ` …[${html.length} chars total]` : ''));
    }
    lines.push('');
    lines.push('===== END REPORT =====');
    return lines.join('\n');
}