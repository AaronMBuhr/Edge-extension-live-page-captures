// Popup — thin UI over the background worker, which owns the actual buffer /
// clipboard / scrape logic. This guarantees the buttons and the hotkeys behave
// identically.
const BUFFER_KEY = 'jobBuffer';
const BUILD = 11;                     // increment on every change

const statusEl = document.getElementById('status');
const bufferCountEl = document.getElementById('bufferCount');

document.addEventListener('DOMContentLoaded', () => {
    refreshBufferCount();
    const b = document.getElementById('buildNum');
    if (b) b.textContent = 'Build ' + BUILD;
});

document.getElementById('scrapeButton').addEventListener('click', (event) => {
    handleScrape(event.shiftKey ? 'reset' : 'append');
});

document.getElementById('clearButton').addEventListener('click', (event) => {
    if (event.shiftKey) {
        handleDiagnostics();
    } else {
        handleClearBuffer();
    }
});

function handleClearBuffer() {
    setStatus('Clearing buffer…');
    chrome.runtime.sendMessage({ action: 'clearBuffer' }, (res) => {
        if (chrome.runtime.lastError) {
            setStatus('Error: ' + chrome.runtime.lastError.message, 'err');
            return;
        }
        if (!res || !res.ok) {
            setStatus(res && res.error ? res.error : 'Could not clear buffer.', 'err');
        } else if (res.count === 0) {
            setStatus('Buffer was already empty.', 'ok');
        } else {
            setStatus('Cleared ' + res.count + ' job' + (res.count === 1 ? '' : 's') +
                ' from the buffer.', 'ok');
        }
        refreshBufferCount();
    });
}

function handleDiagnostics() {
    setStatus('Clearing clipboard and generating diagnostic report…');
    chrome.runtime.sendMessage({ action: 'copyDiagnostics' }, (res) => {
        if (chrome.runtime.lastError) {
            setStatus('Error: ' + chrome.runtime.lastError.message, 'err');
            return;
        }
        if (!res || !res.ok) {
            setStatus(res && res.error ? res.error : 'Could not generate diagnostics.', 'err');
        } else {
            setStatus('Diagnostic report copied to clipboard. Paste it back for analysis.', 'ok');
        }
        refreshBufferCount();
    });
}

function handleScrape(mode) {
    setStatus(mode === 'reset' ? 'Resetting buffer and scraping…' : 'Scraping…');
    chrome.runtime.sendMessage({ action: 'performAction', mode: mode }, (res) => {
        if (chrome.runtime.lastError) {
            setStatus('Error: ' + chrome.runtime.lastError.message, 'err');
            return;
        }
        if (!res || !res.ok) {
            if (res && res.diagnostics) {
                setStatus('Scrape failed. A diagnostic report was copied to your clipboard — paste it back for analysis. (Buffer untouched.)', 'err');
            } else {
                setStatus('Scrape failed: ' + ((res && res.error) || 'unknown error'), 'err');
            }
            refreshBufferCount();
            return;
        }
        setStatus(
            (res.reset ? 'Buffer reset. ' : '') +
            'Added job ' + res.count + '. Clipboard now has ' + res.count +
            ' job' + (res.count === 1 ? '' : 's') + '.', 'ok');
        refreshBufferCount();
    });
}

function refreshBufferCount() {
    chrome.storage.local.get([BUFFER_KEY], (data) => {
        const buffer = Array.isArray(data[BUFFER_KEY]) ? data[BUFFER_KEY] : [];
        bufferCountEl.textContent = 'Buffer: ' + buffer.length + ' job' + (buffer.length === 1 ? '' : 's');
    });
}

function setStatus(msg, cls) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
}