// Background service worker — owns the buffer, clipboard, and action logic so
// that both the popup and the keyboard shortcuts share one code path.
//
// MV3 service workers have no DOM, so clipboard writes and toasts are performed
// inside the active LinkedIn tab via chrome.scripting.executeScript.
console.log('LinkedIn Job Scraper: background service worker loaded.');

const BUFFER_KEY = 'jobBuffer';
const SEPARATOR = '\n\n' + '='.repeat(60) + '\n\n';

// --- Hotkey commands -------------------------------------------------------
chrome.commands.onCommand.addListener((command) => {
    if (command === 'scrape-append') {
        performAction('append');
    } else if (command === 'scrape-reset') {
        performAction('reset');
    }
});

// --- Messages from the popup ----------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === 'performAction') {
        performAction(msg.mode)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ ok: false, error: String(err) }));
        return true; // async
    }
    if (msg && msg.action === 'clearBuffer') {
        clearBuffer()
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ ok: false, error: String(err) }));
        return true;
    }
    if (msg && msg.action === 'copyDiagnostics') {
        copyDiagnostics()
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ ok: false, error: String(err) }));
        return true;
    }
});

// --- Core action: scrape the active tab and append / reset+append ----------
async function performAction(mode) {
    const reset = (mode === 'reset');
    const tab = await getActiveLinkedInTab();
    if (!tab) {
        return { ok: false, error: 'No active LinkedIn jobs tab.' };
    }

    let response;
    try {
        response = await sendScrape(tab);
    } catch (e) {
        // Content script likely not present — inject and retry once.
        try {
            await injectContentScript(tab.id);
            await sleep(200);
            response = await sendScrape(tab);
        } catch (e2) {
            return { ok: false, error: 'Scraper not reachable: ' + e2 };
        }
    }

    if (!response || !response.ok) {
        if (response && response.diagnostics) {
            await writeClipboardVerified(tab.id, response.diagnostics);
            await showToast(tab.id, 'Scrape failed — diagnostic copied to clipboard', false);
            return { ok: false, error: response.error, diagnostics: true };
        }
        await showToast(tab.id, 'Scrape failed: ' + ((response && response.error) || 'unknown'), false);
        return { ok: false, error: (response && response.error) || 'unknown error' };
    }

    const data = await chrome.storage.local.get([BUFFER_KEY]);
    let buffer = (!reset && Array.isArray(data[BUFFER_KEY])) ? data[BUFFER_KEY] : [];
    buffer.push(response.text);
    await chrome.storage.local.set({ [BUFFER_KEY]: buffer });

    const combined = buffer.join(SEPARATOR);
    const copied = await writeClipboardVerified(tab.id, combined);

    const n = buffer.length;
    if (!copied) {
        // The job is safely in the buffer; only the clipboard copy failed.
        await showToast(tab.id,
            'Job ' + n + ' buffered, but clipboard copy failed. Clipboard NOT updated; reload/focus the tab and retry if needed.', false);
        return { ok: true, count: n, reset: reset, copyFailed: true };
    }
    const msg = (reset ? 'Buffer reset. ' : '') +
        'Job ' + n + ' added — clipboard has ' + n + ' job' + (n === 1 ? '' : 's');
    await showToast(tab.id, msg, true);
    return { ok: true, count: n, reset: reset };
}

async function clearBuffer() {
    const data = await chrome.storage.local.get([BUFFER_KEY]);
    const buffer = Array.isArray(data[BUFFER_KEY]) ? data[BUFFER_KEY] : [];
    const count = buffer.length;

    await chrome.storage.local.set({ [BUFFER_KEY]: [] });

    // Clearing the buffer is intentionally not tied to a clipboard write and
    // does not require a LinkedIn tab. A page toast is best-effort only.
    const tab = await getActiveLinkedInTab();
    if (tab) {
        await showToast(tab.id,
            count
                ? 'Buffer cleared — removed ' + count + ' job' + (count === 1 ? '' : 's')
                : 'Buffer already empty',
            true);
    }

    return { ok: true, count: count };
}

async function copyDiagnostics() {
    const tab = await getActiveLinkedInTab();
    if (!tab) {
        return { ok: false, error: 'No active LinkedIn jobs tab to diagnose.' };
    }

    // Intentionally clear the clipboard first. If the diagnostic copy fails,
    // a later paste should not accidentally show an old job batch.
    const emptied = await writeClipboardVerified(tab.id, '');
    if (!emptied) {
        await showToast(tab.id, 'Could not clear clipboard — diagnostic NOT copied', false);
        return { ok: false, error: 'Clipboard clear failed; diagnostic not copied.' };
    }

    let response;
    try {
        response = await sendDiagnostics(tab);
    } catch (e) {
        // Content script likely not present — inject and retry once.
        try {
            await injectContentScript(tab.id);
            await sleep(200);
            response = await sendDiagnostics(tab);
        } catch (e2) {
            await showToast(tab.id, 'Diagnostic failed — scraper not reachable', false);
            return { ok: false, error: 'Diagnostic scraper not reachable: ' + e2 };
        }
    }

    if (!response || !response.ok || !response.diagnostics) {
        await showToast(tab.id, 'Diagnostic failed: ' + ((response && response.error) || 'unknown'), false);
        return { ok: false, error: (response && response.error) || 'unknown diagnostic error' };
    }

    const copied = await writeClipboardVerified(tab.id, response.diagnostics);
    if (!copied) {
        await showToast(tab.id, 'Diagnostic generated, but clipboard copy failed', false);
        return { ok: false, error: 'Diagnostic generated, but clipboard copy failed.' };
    }

    await showToast(tab.id, 'Diagnostic report copied to clipboard', true);
    return { ok: true };
}

// --- Helpers ---------------------------------------------------------------
function getActiveLinkedInTab() {
    return new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs || !tabs.length || !tabs[0].id) return resolve(null);
            const tab = tabs[0];
            if (!/https:\/\/www\.linkedin\.com\/jobs\//.test(tab.url || '')) return resolve(null);
            resolve(tab);
        });
    });
}

function sendScrape(tab) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, { action: 'scrapeJob', url: tab.url }, (response) => {
            if (chrome.runtime.lastError) return reject(chrome.runtime.lastError.message);
            resolve(response);
        });
    });
}

function sendDiagnostics(tab) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, { action: 'diagnoseJob', url: tab.url }, (response) => {
            if (chrome.runtime.lastError) return reject(chrome.runtime.lastError.message);
            resolve(response);
        });
    });
}

function injectContentScript(tabId) {
    return chrome.scripting.executeScript({ target: { tabId }, files: ['contentScript.js'] });
}

// Write text to the page clipboard from the tab context, returning whether the
// copy succeeded so callers can decide whether it's safe to clear the buffer.
async function writeClipboardVerified(tabId, text) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: async (payload) => {
                const fallback = () => {
                    try {
                        const ta = document.createElement('textarea');
                        ta.value = payload;
                        ta.style.position = 'fixed';
                        ta.style.top = '-9999px';
                        document.body.appendChild(ta);
                        ta.focus();
                        ta.select();
                        const ok = document.execCommand('copy');
                        document.body.removeChild(ta);
                        return ok;
                    } catch (e) {
                        return false;
                    }
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    try {
                        await navigator.clipboard.writeText(payload);
                        return true;
                    } catch (e) {
                        return fallback();
                    }
                }
                return fallback();
            },
            args: [text]
        });
        return !!(results && results[0] && results[0].result === true);
    } catch (e) {
        return false;
    }
}

// Show a brief fading toast in the page so hotkey actions give feedback even
// though the popup isn't open.
function showToast(tabId, message, success) {
    return chrome.scripting.executeScript({
        target: { tabId },
        func: (msg, ok) => {
            const id = '__lij_toast__';
            const old = document.getElementById(id);
            if (old) old.remove();
            const el = document.createElement('div');
            el.id = id;
            el.textContent = msg;
            el.style.cssText = [
                'position:fixed', 'z-index:2147483647', 'bottom:24px', 'right:24px',
                'max-width:340px', 'padding:12px 16px', 'border-radius:8px',
                'font:600 13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif',
                'color:#fff', 'box-shadow:0 4px 16px rgba(0,0,0,0.25)',
                'background:' + (ok ? '#057642' : '#b24020'),
                'opacity:0', 'transition:opacity .18s ease'
            ].join(';');
            document.body.appendChild(el);
            requestAnimationFrame(() => { el.style.opacity = '1'; });
            setTimeout(() => {
                el.style.opacity = '0';
                setTimeout(() => el.remove(), 250);
            }, 2200);
        },
        args: [message, !!success]
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }