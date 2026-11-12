// Regression tests: run src/contentScript.js against saved LinkedIn DOM
// captures (www.linkedin.com_*.dom.html in the repo root, produced by saving
// the page's DOM). Run with:  npm test
//
// jsdom has no layout engine, so innerText is approximated (newline around
// block elements). That is enough for the text-based parsing tested here; the
// click / timing paths still need a real browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const CONTENT_SCRIPT = fs.readFileSync(path.join(ROOT, 'src', 'contentScript.js'), 'utf8');

const BLOCK = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'SECTION',
    'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'TR', 'TABLE', 'FORM']);

function approxInnerText(node) {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toUpperCase();
    if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'SVG' || tag === 'TEMPLATE') return '';
    if (tag === 'BR') return '\n';
    let s = '';
    for (const c of node.childNodes) s += approxInnerText(c);
    return BLOCK.has(tag) ? '\n' + s + '\n' : s;
}

// Load a capture (or inline HTML) and return the content script's functions.
function loadScraper(html) {
    html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    const dom = new JSDOM(html, {
        url: 'https://www.linkedin.com/jobs/search/',
        runScripts: 'outside-only',
        virtualConsole: new VirtualConsole(), // silence CSS parse noise + load log
    });
    const { window } = dom;
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
        get() {
            return approxInnerText(this).replace(/[ \t]+/g, ' ')
                .replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
        },
    });
    window.chrome = { runtime: { onMessage: { addListener() {} } } };
    window.eval(CONTENT_SCRIPT + '\n;window.__cs = { listJobCards, parseCurrentJob, getJobPanel,' +
        ' findSalary, looksLikeLocationLine, isPlausibleCompanyName, findLocation, isJobReady };');
    return window.__cs;
}

function capture(name) {
    const file = path.join(ROOT, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

const CAPTURES = [
    {
        file: 'www.linkedin.com_20260709-093428.dom.html',
        jobId: '4361942801',
        expect: {
            title: 'Senior Software Engineer', company: 'Datavant', location: 'United States',
            workplace: 'Remote', employment: 'Full-Time',
            // The selected job shows no pay; old code reported another card's.
            salary: null,
        },
        otherCardSalary: ['4366512682', '$209.5K/yr - $246.5K/yr'],
        descStartsWith: 'Datavant is the data collaboration platform',
    },
    {
        // Company name contains a comma ("Coalition, Inc.") — used to be
        // rejected as a "City, State" location, yielding "Show Premium Insights".
        file: 'www.linkedin.com_20260919-104122.dom.html',
        jobId: '4439367733',
        expect: {
            title: 'Senior Software Engineer, Underwriting', company: 'Coalition, Inc.',
            location: 'United States', workplace: 'Remote', employment: 'Full-Time',
            salary: null,
        },
        otherCardSalary: ['4412151386', '$225K/yr - $265K/yr'],
        descStartsWith: 'About Us\nCoalition is',
    },
];

for (const c of CAPTURES) {
    const html = capture(c.file);
    test(`parses ${c.file}`, { skip: html ? false : 'capture not present' }, () => {
        const cs = loadScraper(html);
        assert.equal(cs.listJobCards().length, 25);
        // No title <h1> on this view; readiness must not depend on one.
        assert.equal(cs.isJobReady(), true, 'isJobReady');

        const p = cs.parseCurrentJob('https://www.linkedin.com/jobs/search/?currentJobId=' + c.jobId);
        for (const [k, v] of Object.entries(c.expect)) assert.equal(p[k], v, k);
        assert.equal(p.canonicalUrl, `https://www.linkedin.com/jobs/view/${c.jobId}/`);
        assert.ok(p.description.startsWith(c.descStartsWith), 'description start');
        assert.ok(p.description.length > 5000, 'description length');

        // Header must be the detail pane, not global nav / the result list.
        assert.ok(!/notifications|99\+ results/i.test(p.headerText), 'header scoped to detail pane');
    });

    test(`salary comes from the job's own card in ${c.file}`, { skip: html ? false : 'capture not present' }, () => {
        const cs = loadScraper(html);
        const [id, pay] = c.otherCardSalary;
        assert.equal(cs.findSalary('', id), pay);
        assert.equal(cs.findSalary('', c.jobId), null);
    });
}

test('company names with corporate suffixes are not locations', () => {
    const cs = loadScraper('<html><body></body></html>');
    for (const name of ['Coalition, Inc.', 'Acme, LLC', 'Foo Bar, Ltd']) {
        assert.equal(cs.looksLikeLocationLine(name), false, name);
        assert.equal(cs.isPlausibleCompanyName(name, 'Engineer'), true, name);
    }
    for (const loc of ['Denver, CO', 'Jacksonville, FL · 1 week ago', 'Carson City, NV']) {
        assert.equal(cs.looksLikeLocationLine(loc), true, loc);
    }
    assert.equal(cs.isPlausibleCompanyName('Show Premium Insights', 'Engineer'), false);
    assert.equal(cs.findLocation('Coalition, Inc. • United States (Remote)\nDenver, CO · 2 days ago'), 'Denver, CO');
});

test('isJobReady rejects nav chrome and half-loaded panels', () => {
    // Global-nav <h1> only, no job loaded yet.
    let cs = loadScraper('<html><head><title>Jobs | LinkedIn</title></head><body><h1>Post</h1></body></html>');
    assert.equal(cs.isJobReady(), false);
    // Heading rendered but description body still empty.
    cs = loadScraper('<html><head><title>Engineer | Acme | LinkedIn</title></head><body>' +
        '<div><div><h2>About the job</h2></div><p></p></div></body></html>');
    assert.equal(cs.isJobReady(), false);
    // Heading + body + title from document.title (no <h1>) is ready.
    cs = loadScraper('<html><head><title>Engineer | Acme | LinkedIn</title></head><body>' +
        '<div><div><h2>About the job</h2></div><p>' + 'We build things and need help building them. '.repeat(3) +
        '</p></div></body></html>');
    assert.equal(cs.isJobReady(), true);
});
