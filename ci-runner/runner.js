#!/usr/bin/env node
// Deterministic CI test runner: fetches the org's Playwright suite from the PHP backend
// (authenticated via API key), runs it locally with @playwright/test, then reports each
// test's result back. No AI/self-healing here on purpose: CI runs must be reproducible.
//
// CLI usage: node runner.js --key <api-key> --resilient --betweenActionMs 1000 --output r3.xml
// --url only needs to be set for self-hosted backends; it otherwise defaults to the Insightest
// SaaS API. Every flag also has an env var fallback (INSIGHTEST_API_URL, INSIGHTEST_API_KEY).
// --navTimeout <ms>: overrides the navigation (page.goto) timeout used on every attempt (default
// escalates 8000/15000/20000ms); does not affect other action retries.
// --runfailed: only reruns tests whose last CI run failed/errored, plus any prerequisite test
// (depends_on_test_id chain) needed to reach them -- instead of the whole suite.
//
// NOTE: this file is served statically from backend/public/ci-runner/ (see .htaccess), and is
// downloaded fresh by run.ps1/run.sh/run.cmd on every CI invocation -- it is a mirror of
// ci-runner/runner.js in this repo and should be kept in sync with it.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Matches wherever this file itself is hosted (backend/public/ci-runner/runner.js); self-hosted
// deployments can override per-invocation with --url, but SaaS users never need to set it.
const DEFAULT_API_URL = 'https://www.insightest.app/app/api';

// --resilient retries only the failing test (Playwright's native per-test `retries`, via
// PW_RETRIES below) -- not the whole suite -- escalating that single test's action timeout
// across attempts instead of giving up after the first failed action. Read by the escalating
// timeout hook baked into writeCombinedSpec()'s generated file. First attempt must still be
// realistic (a real login page can easily take several seconds) -- too-short first timeouts
// mean the shared page times out mid-navigation almost every run, and Playwright force-closes
// whatever page/context was in-flight when a test times out, killing the shared session for
// every test still queued behind it (see beforeEach's recreate-if-closed guard below).
const RESILIENT_ATTEMPT_TIMEOUTS_MS = [8000, 15000, 20000];

function parseArgs(argv) {
    const args = { resilient: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--timeout':
                args.timeout = argv[++i];
                break;
            case '--key':
                args.key = argv[++i];
                break;
            case '--url':
                args.url = argv[++i];
                break;
            case '--betweenActionMs':
                args.betweenActionMs = argv[++i];
                break;
            case '--output':
                args.output = argv[++i];
                break;
            case '--resilient':
                args.resilient = true;
                break;
            case '--navTimeout':
                args.navTimeout = argv[++i];
                break;
            case '--runfailed':
                args.runfailed = true;
                break;
            default:
                console.error(`Unknown argument: ${arg}`);
                process.exit(2);
        }
    }
    return args;
}

/** Stable topological order: each test is preceded by its whole depends_on_test_id chain (oldest ancestor first);
 * tests with no relation keep their relative order. A cycle or a missing prerequisite never blocks the run. */
function orderByDependencies(list) {
    const byId = new Map(list.map((t) => [t.id, t]));
    const seen = new Set();
    const out = [];
    const visit = (t) => {
        if (seen.has(t.id)) return;
        seen.add(t.id);
        const dep = t.depends_on_test_id != null ? byId.get(t.depends_on_test_id) : null;
        if (dep) visit(dep);
        out.push(t);
    };
    list.forEach(visit);
    return out;
}

function requireValue(value, label) {
    if (!value) {
        console.error(`Missing required value: ${label}`);
        process.exit(2);
    }
    return value;
}

async function apiRequest(baseUrl, apiKey, method, urlPath, body) {
    // Some hosting WAFs strip raw `"` characters from POST bodies, corrupting JSON;
    // base64-encode the body so it survives untouched (backend decodes via this header).
    const jsonBody = body ? JSON.stringify(body) : undefined;
    const encodedBody = jsonBody !== undefined ? Buffer.from(jsonBody, 'utf8').toString('base64') : undefined;
    // new URL(urlPath, baseUrl) would silently drop baseUrl's path (e.g. /app/api) since
    // urlPath starts with '/', which the URL spec treats as replacing the whole base path.
    const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers: {
            'X-Api-Key': apiKey,
            'Content-Type': 'application/json',
            ...(encodedBody !== undefined ? { 'X-Body-Encoding': 'base64' } : {}),
        },
        body: encodedBody,
    });
    const text = await res.text();
    let data;
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { raw: text };
    }
    if (!res.ok) {
        throw new Error(`API ${method} ${urlPath} failed (${res.status}): ${JSON.stringify(data)}`);
    }
    return data;
}

/** Recorded code is `test('...', async ({ page }) => { <body> });`; brace-counting (not regex)
 * survives nested braces in the body, e.g. `.click({ button: 'right' })`. The marker requires
 * `async` right before the arrow so it anchors to the test()'s own callback, not some earlier
 * plain arrow function (e.g. legacy-imported code's `page.on('response', (response) => {`
 * helper from RUNTIME_HELPERS, which otherwise wins as the first `=> {` in the file). */
function extractTestBody(code) {
    const markerMatch = /async\s*\([^)]*\)\s*=>\s*\{/.exec(code);
    if (!markerMatch) throw new Error('Could not locate test body in recorded code');
    const start = markerMatch.index + markerMatch[0].length;
    let depth = 1;
    let i = start;
    // Braces inside string literals / comments (e.g. a selector like "text={x}") must not count.
    // Template literals with ${...} are tracked with a stack so their inner braces balance too.
    const tpl = [];
    for (; i < code.length && depth > 0; i++) {
        const c = code[i];
        const n = code[i + 1];
        if (c === '/' && n === '/') { while (i < code.length && code[i] !== '\n') i++; continue; }
        if (c === '/' && n === '*') { i = code.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
        if (c === '"' || c === "'") {
            for (i++; i < code.length && code[i] !== c && code[i] !== '\n'; i++) if (code[i] === '\\') i++;
            continue;
        }
        if (c === '`' || (c === '}' && tpl.length && tpl[tpl.length - 1] === depth)) {
            if (c === '}') tpl.pop();
            for (i++; i < code.length && code[i] !== '`'; i++) {
                if (code[i] === '\\') { i++; continue; }
                if (code[i] === '$' && code[i + 1] === '{') { tpl.push(depth); depth++; i++; break; }
            }
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') depth--;
    }
    if (depth > 0) throw new Error('Unbalanced braces in recorded code (test body never closes)');
    return code.slice(start, i - 1);
}

/** Real syntax check (V8 parse only, nothing runs): returns null when `code` parses inside an async
 * function, else the syntax error message. TypeScript-only syntax is retried with types stripped
 * (when this Node has module.stripTypeScriptTypes) so recordings that use it aren't skipped by mistake. */
function syntaxError(code) {
    const parse = (src) => new (require('vm').Script)('(async () => {\n' + src + '\n})');
    try {
        parse(code);
        return null;
    } catch (e) {
        try {
            const strip = require('module').stripTypeScriptTypes;
            if (strip) {
                parse(strip(code));
                return null;
            }
        } catch {}
        return e.message;
    }
}

/** Recovers the numeric test id embedded in a combined-spec test title, e.g. "Login (id 12)". */
function testIdFromTitle(title) {
    const match = /\(id (\d+)\)$/.exec(title || '');
    return match ? Number(match[1]) : null;
}

/** Everything declared before the test()'s own call (e.g. the legacy importer's RUNTIME_HELPERS
 * block: `resolveLocator`/`reportNetworkErrors`), minus the `import ... from '@playwright/test'`
 * line. Each test's own copy of this preamble normally lives in the same file as its body, so
 * calls to these helpers resolve fine standalone -- but extractTestBody() below only pulls out
 * the test's inner body, and combining many tests into one file previously dropped this preamble
 * entirely, leaving every helper call to throw ReferenceError with zero visible steps. */
function extractPreamble(code) {
    const testCallMatch = /\btest\(/.exec(code);
    if (!testCallMatch) return '';
    return code
        .slice(0, testCallMatch.index)
        .replace(/^\s*import\s[^;]*;\s*/gm, '')
        .trim();
}

// Action-level resilience (see __insightestAction in the generated source below): each recorded
// action call gets rewritten to go through the resilient engine. Only matches one-line statements
// (codegen/legacy-import already emit one action per line) -- lines the regex doesn't match (e.g.
// multi-line arg objects, goto/waitForTimeout) pass through unchanged, just without retry/fallback.
const ACTION_METHODS = ['click', 'fill', 'dblclick', 'check', 'uncheck', 'selectOption', 'press', 'hover', 'tap', 'type', 'setInputFiles', 'selectText'];
const ACTION_LABELS = {
    click: 'Click', fill: 'Fill', dblclick: 'Doppio click', check: 'Check', uncheck: 'Uncheck',
    selectOption: 'Seleziona opzione', press: 'Premi tasto', hover: 'Hover', tap: 'Tap', type: 'Digita',
    setInputFiles: 'Carica file', selectText: 'Seleziona testo',
};
const ACTION_LINE_RE = new RegExp(`^(\\s*)await\\s+(page\\.[^\\n;]*?)\\.(${ACTION_METHODS.join('|')})\\((.*)\\);\\s*$`, 'gm');

// select2 renders its dropdown in a transient overlay under <body>, and codegen records the picked
// option as a positional xpath into it that doesn't resolve reliably on replay. Rewrite that click
// into "wait for the open dropdown's option, then click it by index". One action line per original
// click is preserved (waitFor isn't in ACTION_METHODS), so steps_json indexes stay aligned.
// Keep in sync with normalizeSelect2Options in desktop/electron/runnerCore.ts.
const SELECT2_OPTION_CLICK_RE = /^(\s*)await\s+page\.locator\((['"])xpath=\/\/html\/body(?![^\n]*app-root)[^\n'"]*?\/ul\[\d+\]\/li\[(\d+)\][^\n'"]*\2\)\.click\(([^)\n]*)\);\s*$/gm;
function normalizeSelect2Options(code) {
    return code.replace(SELECT2_OPTION_CLICK_RE, (full, indent, quote, pos, args) => {
        const option = `page.locator('.select2-results__options:visible > li').nth(${Number(pos) - 1})`;
        return `${indent}await ${option}.waitFor({ state: 'visible' });\n${indent}await ${option}.click(${args});`;
    });
}

/** For a select2 option click normalized above: when the record-time capture stored the option's
 * text (steps_json textHint), pick the option BY TEXT (exact match first, like the legacy puppeteer
 * helper's `contains(., value)` but stricter), falling back to "contains" and finally to the
 * original index via secondary selectors. Returns null for any other chain / no text. */
const SELECT2_INDEX_CHAIN_RE = /^page\.locator\('\.select2-results__options:visible > li'\)\.nth\((\d+)\)$/;
function select2ByText(chain, meta) {
  const m = SELECT2_INDEX_CHAIN_RE.exec(chain.trim());
  const text = meta && meta.textHint ? String(meta.textHint).trim() : '';
  if (!m || !text) return null;
  const quoted = JSON.stringify(text);
  return {
    chain: '__insightestSelect2Option(page, ' + quoted + ')',
    meta: {
      ...meta,
      secondarySelectors: [
        '.select2-results__option:visible:has-text(' + quoted + ')',
        `.select2-results__options:visible > li:nth-child(${Number(m[1]) + 1})`,
        ...((meta && meta.secondarySelectors) || []),
      ],
    },
  };
}

// Per-project selector priority (projects.selector_priority, sent by /ci/tests on every test). Steps imported
// with `byKey` (all recorded selectors) are re-ranked by it at run time; older steps keep their baked order.
const DEFAULT_SELECTOR_PRIORITY = ['xpath', 'generalSelector', 'text', 'id'];
function parseSelectorPriority(raw) {
    try {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(v)) {
            const keys = v.filter((k) => typeof k === 'string');
            if (keys.length) return keys;
        }
    } catch {}
    return DEFAULT_SELECTOR_PRIORITY;
}

/** Rebuilds a step's primary locator + fallbacks from its recorded candidates in `priority` order. For select2
 * option clicks the text-based smart pick (__insightestSelect2Option) is kept, but only as the LAST resort, so the
 * configured order is honored. Returns null when the step has no `byKey` (recorded before this feature). */
function applyProjectPriority(chain, meta, priority) {
    const byKey = meta && meta.byKey;
    if (!byKey) return null;
    const cands = [];
    for (const key of priority) {
        if (key === 'text') {
            if (byKey.text) cands.push({ expr: 'page.getByText(' + JSON.stringify(byKey.text) + ')', raw: 'text=' + JSON.stringify(byKey.text) });
        } else if (byKey[key]) {
            cands.push({ expr: 'page.locator(' + JSON.stringify(byKey[key]) + ')', raw: byKey[key] });
        }
    }
    if (!cands.length) return null;
    const secondary = cands.slice(1).map((c) => c.raw);
    if (chain.includes('select2-results__option') && byKey.text) secondary.push('select2text:' + JSON.stringify(byKey.text));
    return { chain: cands[0].expr, meta: { ...meta, secondarySelectors: secondary } };
}

// Recorded select2 option clicks come in two more shapes, both WITHOUT :visible, so .first()/.nth() can land on a
// hidden leftover option from an earlier dropdown and time out on click. Rewrite them to visible-scoped picks.
const SELECT2_FILTER_CHAIN_RE = /^page\.locator\((['"])\.select2-results__option\1\)\.filter\(\{ hasText: ("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*') \}\)\.first\(\)$/;
const SELECT2_NTH_CHAIN_RE = /^page\.locator\((['"])\.select2-results__option\1\)\.nth\((\d+)\)$/;
function normalizeSelect2Chain(chain) {
  const c = chain.trim();
  const f = SELECT2_FILTER_CHAIN_RE.exec(c);
  if (f) return '__insightestSelect2Option(page, ' + f[2] + ')';
  const n = SELECT2_NTH_CHAIN_RE.exec(c);
  if (n) return "page.locator('.select2-results__option:visible').nth(" + n[2] + ')';
  return chain;
}

/** Rewrites each recorded action call into a call to the resilient-action engine (defined once in
 * the generated suite via __insightestAction), passing that step's own recorded metadata (secondary
 * selectors from steps_json, when the test was recorded with the augmentation pass) positionally --
 * step order here must match the order selectors were captured in at record time. `steps` is the
 * parsed steps_json array for this one test, or null for tests recorded before this feature (still
 * get attempt-1/attempt-2 retry, just no attempt-3 selector fallback). */
function instrumentResilientActions(code, steps, priority = DEFAULT_SELECTOR_PRIORITY) {
    let stepIndex = 0;
    return code.replace(ACTION_LINE_RE, (full, indent, chain, action, argsText) => {
        const label = ACTION_LABELS[action] || action;
        let meta = (steps && steps[stepIndex]) || null;
        stepIndex++;
        if (action === 'click') chain = normalizeSelect2Chain(chain);
        const ranked = applyProjectPriority(chain, meta, priority);
        if (ranked) {
            chain = ranked.chain;
            meta = ranked.meta;
        }
        const byText = !ranked && action === 'click' ? select2ByText(chain, meta) : null;
        if (byText) {
            chain = byText.chain;
            meta = byText.meta;
        }
        return `${indent}await __insightestAction(page, () => ${chain}, ${JSON.stringify(chain.trim())}, (___loc) => ___loc.${action}(${argsText}), ${JSON.stringify(label)}, ${JSON.stringify(meta)});`;
    });
}

// Tests written against the PlaywrightBuilder engine (pwBuilder.js) are plain `await pw.click(sel, nav);` calls:
// all behaviour (retry, fallback, first-match, select2...) lives in the builder. The runner only (a) supplies
// `pw` itself and (b) hands each selector-bearing call its recorded metadata (steps_json[i]) via pw.useMeta(),
// in order. Keep BUILDER_META_METHODS in sync with the scripts/import-legacy-tests.js emitter.
const BUILDER_META_METHODS = ['click', 'doubleClick', 'rightClick', 'hover', 'type', 'fill', 'select', 'keydown', 'select2', 'clearInput'];
const BUILDER_CALL_RE = new RegExp(String.raw`^(\s*)await\s+pw\.(` + BUILDER_META_METHODS.join('|') + String.raw`)\(`, 'gm');
const BUILDER_CTOR_RE = /^[ \t]*const\s+pw\s*=\s*new\s+PlaywrightBuilder\([^\n]*\);?[ \t]*$/gm;
function usesBuilder(code) {
    return /\bpw\.\w+\(/.test(code);
}
function instrumentBuilderCalls(code, steps) {
    let stepIndex = 0;
    return code.replace(BUILDER_CTOR_RE, '').replace(BUILDER_CALL_RE, (full, indent, method) => {
        const meta = (steps && steps[stepIndex]) || null;
        stepIndex++;
        return `${indent}pw.useMeta(${JSON.stringify(meta)});\n${indent}await pw.${method}(`;
    });
}

// `page.goto(...)` never matches ACTION_LINE_RE (it's a direct call on `page`, not a locator
// chain), and has no alternate "selector" to fall back to -- so it gets its own, simpler
// resilient wrapper (__insightestNavigate): same wait-then-retry behavior, just without the
// secondary-selector/similarity fallback step.
const NAV_LINE_RE = /^(\s*)await\s+page\.goto\((.*)\);\s*$/gm;

function instrumentNavigations(code) {
    return code.replace(NAV_LINE_RE, (full, indent, argsText) => {
        return `${indent}await __insightestNavigate(page, (___p) => ___p.goto(${argsText}), ${JSON.stringify(`Naviga ${argsText}`)});`;
    });
}

/**
 * Combines every recorded test into a single spec file sharing one browser context/page (created
 * once in `beforeAll`), so a login test's session (cookies, storage) carries over to whatever
 * runs after it -- Playwright normally isolates every test in its own context, which is wrong
 * for suites that depend on being logged in once at the start.
 */
function writeCombinedSpec(tests, dir) {
    // Deduplicated (tests are usually generated from the same importer boilerplate, so most
    // preambles are identical -- redeclaring the same function twice is a SyntaxError).
    const preambles = [...new Set(tests.map((t) => extractPreamble(t.playwright_code)).filter(Boolean))].filter((p) => {
        if (!syntaxError(p)) return true;
        console.error('[insightest] Skipping a malformed preamble (syntax error): ' + p.slice(0, 120).replace(/\s+/g, ' '));
        return false;
    });
    const body = tests
        .map((t) => {
            const title = `${(t.name || `Test ${t.id}`).replace(/`/g, '\\`')} (id ${t.id})`;
            let steps = null;
            try {
                steps = t.steps_json ? JSON.parse(t.steps_json) : null;
            } catch {
                steps = null;
            }
            let testBody;
            let skipReason = null;
            let builderTest = false;
            try {
                const rawBody = extractTestBody(t.playwright_code);
                builderTest = usesBuilder(rawBody);
                if (builderTest) {
                    testBody = instrumentBuilderCalls(rawBody, steps);
                } else {
                    testBody = instrumentNavigations(rawBody);
                    testBody = instrumentResilientActions(normalizeSelect2Options(testBody), steps, parseSelectorPriority(t.selector_priority));
                }
                skipReason = syntaxError(testBody);
            } catch (e) {
                skipReason = e.message;
            }
            if (skipReason) {
                // One malformed recording must not stop the suite from loading: it is skipped, the rest run.
                console.error(`[insightest] Skipping test "${t.name}" (id ${t.id}): invalid recorded code -- ${skipReason}`);
                testBody = `    test.skip(true, ${JSON.stringify('Invalid recorded code: ' + skipReason)});`;
            }
            const pwInit = builderTest ? `    const pw = new PlaywrightBuilder(page, { priority: ${JSON.stringify(parseSelectorPriority(t.selector_priority))} });\n` : '';
            return `  test(\`${title}\`, async () => {\n    const page = __sharedPage;\n${pwInit}${testBody}\n  });`;
        })
        .join('\n\n');


    const source = `import { test, expect } from '@playwright/test';
const fs = require('fs');
const { PlaywrightBuilder } = require(${JSON.stringify(path.join(__dirname, 'pwBuilder.js'))});

${preambles.join('\n\n')}

let __sharedPage;
const STORAGE_STATE_PATH = ${JSON.stringify(path.join(dir, 'storage-state.json'))};

// Playwright discards the ENTIRE worker process (browser included) after ANY test failure, not
// just timeouts, and starts a fresh one for the retry -- confirmed in Playwright's own docs:
// "Should any test fail, Playwright Test will discard the entire worker process along with the
// browser and will start a new one." This can't be disabled from test code, so a failed test
// can never simply "keep the same browser" on retry. Instead, every context creation below
// persists/restores cookies+localStorage via STORAGE_STATE_PATH (a file on disk, so it survives
// the worker restart), so a brand new worker's brand new browser still resumes the same
// logged-in session instead of starting logged out.
async function newSharedContext(browser) {
  const opts = fs.existsSync(STORAGE_STATE_PATH) ? { storageState: STORAGE_STATE_PATH } : {};
  return browser.newContext(opts);
}

// Engine-level fix (applies to EVERY test, hand-recorded or legacy-imported -- not tied to any
// per-test helper): recorded selectors sometimes point at a wrapper element (e.g. a styled
// div/label around the real <input>) rather than the writable element itself. Patches the
// shared Locator.prototype once per worker so .fill() redirects to the nearest writable
// (input/textarea/select/[contenteditable]) descendant instead of throwing.
function __insightestEnsureSmartFill(page) {
  const proto = Object.getPrototypeOf(page.locator('body'));
  if (proto.__insightestSmartFill) return;
  const originalFill = proto.fill;
  proto.fill = async function (...args) {
    const isFillable = await this.evaluate((el) => el.matches('input, textarea, select, [contenteditable]')).catch(() => true);
    if (isFillable) return originalFill.apply(this, args);
    const nested = this.locator('input, textarea, select, [contenteditable]').first();
    const nestedCount = await nested.count().catch(() => 0);
    if (nestedCount === 0) return originalFill.apply(this, args);
    console.warn('[insightest] target is not writable, filling nearest writable descendant instead');
    return originalFill.apply(nested, args);
  };
  proto.__insightestSmartFill = true;
}

// Resilient action engine: 1) run the action; 2) on failure wait INSIGHTEST_BETWEEN_ACTION_MS and
// retry the SAME selector once; 3) on a second failure, try the step's recorded secondary selectors
// (ranked by similarity to the primary) and, absent those, a live DOM rescan by text similarity;
// 4) if that also fails, rethrow so the test fails and Playwright moves on to the next test.
function __insightestSimilarity(a, b) {
  a = String(a || '').toLowerCase().trim();
  b = String(b || '').toLowerCase().trim();
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  const d = [];
  for (let i = 0; i <= m; i++) d[i] = [i];
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
    }
  }
  return 1 - d[m][n] / Math.max(m, n);
}

async function __insightestFindBySimilarity(page, textHint, tagHint) {
  if (!textHint) return null;
  return page
    .evaluate(({ textHint, tagHint }) => {
      function similarity(a, b) {
        a = String(a || '').toLowerCase().trim();
        b = String(b || '').toLowerCase().trim();
        if (!a || !b) return 0;
        const m = a.length, n = b.length;
        const d = [];
        for (let i = 0; i <= m; i++) d[i] = [i];
        for (let j = 0; j <= n; j++) d[0][j] = j;
        for (let i = 1; i <= m; i++) {
          for (let j = 1; j <= n; j++) {
            d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
          }
        }
        return 1 - d[m][n] / Math.max(m, n);
      }
      const selector = tagHint || 'button, a, input, select, textarea, [role], label, [onclick]';
      let best = null;
      for (const el of document.querySelectorAll(selector)) {
        const text = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.getAttribute('value') || '').trim();
        if (!text) continue;
        const score = similarity(text, textHint);
        if (score > 0.55 && (!best || score > best.score)) {
          let sel;
          if (el.id) {
            sel = \`#\${CSS.escape(el.id)}\`;
          } else {
            const tag = el.tagName.toLowerCase();
            const siblings = Array.from(el.parentElement ? el.parentElement.children : []).filter((s) => s.tagName === el.tagName);
            sel = \`\${tag}:nth-of-type(\${siblings.indexOf(el) + 1})\`;
          }
          best = { selector: sel, score };
        }
      }
      return best;
    }, { textHint, tagHint })
    .catch(() => null);
}

// select2 option picked BY TEXT: exact (trim, case-insensitive) > equal ignoring punctuation/spacing
// ("AE - DUBAI" vs "AE-DUBAI") > contains. If nothing visible matches (e.g. an ajax list that only shows
// the value once searched), types the text into the open dropdown's search box and looks again. Throws if
// still absent, so the secondary selectors take over.
async function __insightestSelect2Option(page, text) {
  const all = page.locator('.select2-results__option:visible');
  const norm = (s) => Array.from(String(s).toLowerCase()).filter((ch) => ch !== ch.toUpperCase() || (ch >= '0' && ch <= '9')).join('');
  const raw = String(text).trim().toLowerCase();
  const want = norm(text);
  const find = async () => {
    const texts = await all.allInnerTexts();
    let i = texts.findIndex((t) => t.trim().toLowerCase() === raw);
    if (i < 0) i = texts.findIndex((t) => norm(t) === want);
    if (i < 0) i = texts.findIndex((t) => norm(t).includes(want));
    return i;
  };
  const poll = async (ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const i = await find();
      if (i >= 0) return i;
      if (Date.now() >= end) return -1;
      await page.waitForTimeout(250);
    }
  };
  let i = await poll(3000);
  if (i < 0) {
    const search = page.locator('.select2-container--open .select2-search__field').last();
    if (await search.isVisible().catch(() => false)) {
      await search.fill('');
      await search.pressSequentially(String(text), { delay: 20 });
      i = await poll(8000);
    }
  }
  if (i < 0) throw new Error('select2 option not found: ' + text);
  return all.nth(i);
}

async function __insightestAction(page, primaryBuild, primaryLabel, perform, actionLabel, stepMeta) {
  const betweenActionMs = Number(process.env.INSIGHTEST_BETWEEN_ACTION_MS || 0);
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    // Escalating per-attempt timeout, entirely local to this one action -- never depends on
    // Playwright's own test-level retries (there are none: PW_RETRIES is never set).
    page.setDefaultTimeout(RESILIENT_RETRY_TIMEOUTS_MS[attempt - 1] ?? RESILIENT_RETRY_TIMEOUTS_MS[RESILIENT_RETRY_TIMEOUTS_MS.length - 1]);
    const prefix = attempt === 1 ? '' : \`Retry \${attempt}/3: \`;
    console.log(\`[insightest] \${prefix}\${actionLabel} \${primaryLabel}\`);
    try {
      await perform((await primaryBuild()).first()); // first match, like Puppeteer (no strict-mode failure)
      return;
    } catch (e) {
      lastError = e;
      console.warn(\`[insightest] Tentativo \${attempt}/3 fallito: \${actionLabel} \${primaryLabel} -- \${e && e.message ? e.message.split('\\n')[0] : e}\`);
      if (attempt === 1 && betweenActionMs > 0) await new Promise((r) => setTimeout(r, betweenActionMs));
    }
  }
  page.setDefaultTimeout(RESILIENT_RETRY_TIMEOUTS_MS[RESILIENT_RETRY_TIMEOUTS_MS.length - 1]);
  // Iterated in the order the importer already ranked them (xpath > data-test > attr >
  // general > id) -- NOT re-sorted by string similarity, which would undo that priority.
  const secondary = (stepMeta && stepMeta.secondarySelectors) || [];
  for (const sel of secondary) {
    console.log(\`[insightest] Fallback 3/3 (selettore secondario): \${actionLabel} \${sel}\`);
    try {
      await perform(sel.startsWith('select2text:') ? await __insightestSelect2Option(page, JSON.parse(sel.slice(12))) : page.locator(sel).first());
      return;
    } catch (e) {
      lastError = e;
    }
  }
  if (secondary.length === 0 && stepMeta && stepMeta.textHint) {
    const best = await __insightestFindBySimilarity(page, stepMeta.textHint, stepMeta.tagHint);
    if (best) {
      console.log(\`[insightest] Fallback 3/3 (similarita \${best.score.toFixed(2)}): \${actionLabel} \${best.selector}\`);
      try {
        await perform(page.locator(best.selector).first());
        return;
      } catch (e) {
        lastError = e;
      }
    }
  }
  console.error(\`[insightest] Azione fallita dopo 3 tentativi: \${actionLabel} \${primaryLabel}\`);
  // Why did it time out? Dump page state + the tail of Playwright's call log (e.g. "element is
  // not visible" / "<div> intercepts pointer events") so CI logs are actionable.
  try {
    let count = '?';
    try { count = await (await primaryBuild()).count(); } catch {}
    console.error(\`[insightest]   diagnostica: url=\${page.url()} titolo="\${await page.title().catch(() => '')}" match=\${count}\`);
    const tail = String((lastError && lastError.message) || '').split('\\n').slice(1, 8).map((l) => l.trim()).filter(Boolean);
    for (const l of tail) console.error(\`[insightest]   | \${l}\`);
  } catch {}
  throw lastError;
}

// Navigation has no alternate "selector" to fall back to, so it gets a flat wait-then-retry
// loop across the same 3 escalating timeouts instead of __insightestAction's selector fallback.
async function __insightestNavigate(page, perform, label) {
  const betweenActionMs = Number(process.env.INSIGHTEST_BETWEEN_ACTION_MS || 0);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const timeout = NAV_RETRY_TIMEOUTS_MS[attempt - 1] ?? NAV_RETRY_TIMEOUTS_MS[NAV_RETRY_TIMEOUTS_MS.length - 1];
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);
    const prefix = attempt === 1 ? '' : \`Retry \${attempt}/3: \`;
    console.log(\`[insightest] \${prefix}\${label}\`);
    try {
      await perform(page);
      return;
    } catch (e) {
      lastError = e;
      console.warn(\`[insightest] Tentativo \${attempt}/3 fallito: \${label} -- \${e && e.message ? e.message.split('\\n')[0] : e}\`);
      if (attempt < 3 && betweenActionMs > 0) await new Promise((r) => setTimeout(r, betweenActionMs));
    }
  }
  console.error(\`[insightest] Navigazione fallita dopo 3 tentativi: \${label}\`);
  throw lastError;
}


// Escalating per-attempt timeouts used by __insightestAction/__insightestNavigate above --
// entirely internal to a single test execution. Playwright's own retries stay at 0 always
// (never set via PW_RETRIES): a test either passes within its own action-level attempts or
// fails once and Playwright moves on to the next test, it is never re-run from scratch.
const RESILIENT_RETRY_TIMEOUTS_MS = ${JSON.stringify(RESILIENT_ATTEMPT_TIMEOUTS_MS)};

// --navTimeout overrides just navigation's timeout (flat, same value every attempt) -- action
// retries elsewhere keep using RESILIENT_RETRY_TIMEOUTS_MS's escalation untouched.
const __navTimeoutOverride = Number(process.env.INSIGHTEST_NAV_TIMEOUT_MS || 0) || null;
const NAV_RETRY_TIMEOUTS_MS = __navTimeoutOverride ? [__navTimeoutOverride, __navTimeoutOverride, __navTimeoutOverride] : RESILIENT_RETRY_TIMEOUTS_MS;

// Deliberately NOT .serial: describe.serial retries the WHOLE group from its first test whenever
// any test in it fails, which would redo every dependency test again. Plain describe runs this
// single file's tests in declaration order (Playwright doesn't parallelize within one file
// unless fullyParallel is set).
test.describe('Insightest CI suite', () => {
  let __sharedContext;

  test.beforeAll(async ({ browser }) => {
    __sharedContext = await newSharedContext(browser);
  });

  test.afterAll(async () => {
    await __sharedContext.close().catch(() => {});
  });

  test.beforeEach(async ({ browser }, testInfo) => {
    // A fresh page per test (same context, so cookies/login carry over) -- NOT the same page
    // reused across all 6 tests. Reusing one page let framework-generated state leak between
    // tests (e.g. PrimeNG-style auto-incrementing element ids like #dropDown106, or Angular's
    // .ng-dirty class from a PREVIOUS test's form) silently drift recorded selectors out from
    // under a LATER test -- exactly the state isolation an independent per-test Puppeteer run
    // never had to fight. A failed test also makes Playwright discard the whole worker (browser
    // included) before the next test runs, so the context itself is recreated defensively too.
    try {
      __sharedPage = await __sharedContext.newPage();
    } catch {
      __sharedContext = await newSharedContext(browser);
      __sharedPage = await __sharedContext.newPage();
    }
    __insightestEnsureSmartFill(__sharedPage);
    if (!process.env.INSIGHTEST_RESILIENT) return;
    __sharedPage.setDefaultTimeout(RESILIENT_RETRY_TIMEOUTS_MS[0]);
    __sharedPage.setDefaultNavigationTimeout(RESILIENT_RETRY_TIMEOUTS_MS[0]);
    // Generous ceiling so a test that needs all 3 escalating attempts on several actions never
    // hits Playwright's own per-test timeout mid-attempt (which would report it as a *timeout*
    // instead of a plain failure, and force-close the shared page for whatever runs next).
    testInfo.setTimeout(RESILIENT_RETRY_TIMEOUTS_MS.reduce((a, b) => a + b, 0) * 6);
  });

  // Persists cookies/localStorage after every test (pass or fail) so the NEXT worker --
  // which Playwright always spins up fresh after any failure -- restores this exact session
  // instead of starting logged out.
  test.afterEach(async () => {
    await __sharedContext.storageState({ path: STORAGE_STATE_PATH }).catch(() => {});
    if (!__sharedPage.isClosed()) await __sharedPage.close().catch(() => {});
  });

${body}
});
`;
    fs.writeFileSync(path.join(dir, 'suite.spec.ts'), source, 'utf8');
}

/** Playwright's JSON report nests specs inside each describe block's own `suites` array. */
function collectSpecs(suites) {
    const specs = [];
    for (const suite of suites || []) {
        specs.push(...(suite.specs || []));
        specs.push(...collectSpecs(suite.suites));
    }
    return specs;
}

/** Bare filenames land in `test-results/`, matching the glob Azure Pipelines' PublishTestResults task expects. */
function resolveJunitOutputPath(output) {
    if (!output) return path.join('test-results', 'junit.xml');
    return output.includes('/') || output.includes('\\') ? output : path.join('test-results', output);
}

function quoteForShell(value) {
    // Only used for internal, fixed paths (never user input) -- still quote defensively so
    // paths containing spaces work under cmd.exe's shell:true parsing.
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

function runPlaywright(dir, jsonReportPath, junitOutputPath, opts) {
    const configPath = path.join(__dirname, 'playwright.config.js');
    // Node refuses to spawn .cmd files directly on Windows (EINVAL) unless shell is used; passing
    // a single pre-quoted command string (rather than shell:true + an args array) avoids Node's
    // DEP0190 warning about unescaped argument concatenation.
    const command =
        process.platform === 'win32'
            ? `npx.cmd playwright test --config ${quoteForShell(configPath)}`
            : `npx playwright test --config ${quoteForShell(configPath)}`;
    const result = spawnSync(command, {
        // Run from __dirname (where `npm install` put node_modules), not `dir` (just the
        // generated spec files) -- otherwise npx can't resolve the installed @playwright/test.
        cwd: __dirname,
        // Inherit stdio so the live reporter's per-step/per-test output streams straight to
        // the pipeline log as it happens, instead of being buffered until the run ends.
        stdio: 'inherit',
        shell: true,
        env: {
            ...process.env,
            // Points playwright.config.js's testDir at the generated spec files, since its
            // default (the config file's own directory) would otherwise contain none.
            INSIGHTEST_TEST_DIR: dir,
            PLAYWRIGHT_JSON_OUTPUT_NAME: jsonReportPath,
            PLAYWRIGHT_JUNIT_OUTPUT_NAME: junitOutputPath,
            ...(opts.timeout ? { PW_TIMEOUT: String(opts.timeout) } : {}),
            ...(opts.betweenActionMs ? { PW_SLOWMO: String(opts.betweenActionMs), INSIGHTEST_BETWEEN_ACTION_MS: String(opts.betweenActionMs) } : {}),
            // Deliberately NEVER sets PW_RETRIES: resilience must retry the failing ACTION
            // in-place, never the whole test (which would discard the browser/page and
            // re-run every prior step from scratch). Retries always stay 0 here.
            ...(opts.resilient ? { INSIGHTEST_RESILIENT: '1' } : {}),
            ...(opts.navTimeout ? { INSIGHTEST_NAV_TIMEOUT_MS: String(opts.navTimeout) } : {}),
            // liveReporter.js publishes each test's result as soon as it ends, using these.
            INSIGHTEST_REPORT_URL: opts.apiUrl,
            INSIGHTEST_REPORT_KEY: opts.apiKey,
            INSIGHTEST_REPORTED_FILE: opts.reportedFile,
        },
    });
    return result;
}

function statusFromTestResult(test) {
    // Playwright's JSON reporter exposes the verdict as a `status` field
    // ('expected'|'unexpected'|'flaky'|'skipped'), not `outcome` -- same bug fixed in
    // desktop/electron/playwrightRunner.ts. Getting this wrong means every run reports
    // as failed regardless of the real result.
    const status = test?.status;
    if (status === 'expected' || status === 'flaky') return 'passed';
    if (status === 'skipped') return 'error';
    return 'failed';
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const apiUrl = args.url || process.env.INSIGHTEST_API_URL || DEFAULT_API_URL;
    const apiKey = requireValue(args.key || process.env.INSIGHTEST_API_KEY, 'INSIGHTEST_API_KEY (env) or --key');

    // Lives under __dirname (not os.tmpdir()) so Node's module resolution, walking up from the
    // generated spec file, finds the @playwright/test that `npm install` put in __dirname/node_modules.
    const workDir = fs.mkdtempSync(path.join(__dirname, '.insightest-ci-'));
    const jsonReportPath = path.join(workDir, 'report.json');
    const junitOutputPath = path.resolve(resolveJunitOutputPath(args.output));
    fs.mkdirSync(path.dirname(junitOutputPath), { recursive: true });

    console.log(`Fetching deterministic test suite from ${apiUrl} ...`);
    let { tests } = await apiRequest(apiUrl, apiKey, 'GET', '/ci/tests');
    if (!tests || tests.length === 0) {
        console.log('No tests registered for this organization, nothing to run.');
        return;
    }
    // The API's JSON types are not reliable: ids can arrive as strings ("54") while depends_on_test_id is a number
    // (or the reverse). Lookups by id -- prerequisite chains, --runfailed, ordering -- silently miss otherwise.
    tests = tests.map((t) => ({
        ...t,
        id: Number(t.id),
        depends_on_test_id: t.depends_on_test_id === null || t.depends_on_test_id === undefined || t.depends_on_test_id === '' ? null : Number(t.depends_on_test_id),
    }));

    if (args.runfailed) {
        const byId = new Map(tests.map((t) => [t.id, t]));
        const failedIds = new Set(tests.filter((t) => t.last_ci_status === 'failed' || t.last_ci_status === 'error').map((t) => t.id));
        if (failedIds.size === 0) {
            console.log('--runfailed: no test has a failed/errored last CI run, nothing to run.');
            return;
        }
        // Pulls in each failed test's prerequisite chain (depends_on_test_id), even if that
        // prerequisite itself last passed -- it still needs to run first to set up the shared
        // session/state the failed test depends on.
        const needed = new Set();
        const addWithDeps = (id) => {
            if (needed.has(id) || !byId.has(id)) return;
            needed.add(id);
            const dep = byId.get(id).depends_on_test_id;
            console.log(`Adding test id ${id} to needed set`);
            if (dep) {
                console.log(`Test id ${id} depends on test id ${dep}`);
                addWithDeps(dep);
            }
        };
        failedIds.forEach(addWithDeps);
        tests = tests.filter((t) => needed.has(t.id));
        const prereqCount = tests.filter((t) => !failedIds.has(t.id)).length;
        console.log(`--runfailed: rerunning ${failedIds.size} failed test(s) plus ${prereqCount} prerequisite test(s) (run first, even if they passed last time).`);
    }

    // Every prerequisite (depends_on_test_id chain) must run BEFORE the tests that need it, whatever order the
    // API returned them in: the whole suite shares one browser session, so e.g. the login test has to come first.
    tests = orderByDependencies(tests);

    console.log(`Running ${tests.length} test(s) locally with Playwright (in order, sharing one browser session):`);
    const idsPresent = new Set(tests.map((t) => t.id));
    tests.forEach((t, i) => {
        const dep = t.depends_on_test_id;
        const note = dep == null ? '' : idsPresent.has(dep) ? `  (pretest: id ${dep} runs first)` : `  (pretest: id ${dep} -- NOT RETURNED BY THE SERVER)`;
        console.log(`  ${i + 1}. ${t.name || `Test ${t.id}`}${note}`);
    });
    const missingPrereqs = [...new Set(tests.filter((t) => t.depends_on_test_id != null && !idsPresent.has(t.depends_on_test_id)).map((t) => t.depends_on_test_id))];
    if (missingPrereqs.length) {
        console.error(
            `[insightest] WARNING: prerequisite test id(s) ${missingPrereqs.join(', ')} were not returned by the server, so the tests that need them run WITHOUT that setup (e.g. without login). ` +
                `Cause: the backend is older than the runner (it only returns tests included in CI/CD, not their prerequisites) -- deploy the latest backend, or enable "include in CI/CD" on those tests.`
        );
    }

    console.log(`Selector priority: ${[...new Set(tests.map((t) => parseSelectorPriority(t.selector_priority).join(' > ')))].join(' | ')}`);
    writeCombinedSpec(tests, workDir);

    // --resilient no longer re-runs the whole suite: it's a single Playwright invocation where
    // native per-test `retries` re-runs only a failing test (on the same shared page), with an
    // escalating action timeout injected via writeCombinedSpec()'s beforeEach hook.
    const reportedFile = path.join(workDir, 'reported-ids.txt');
    const playwrightResult = runPlaywright(workDir, jsonReportPath, junitOutputPath, {
        apiUrl,
        apiKey,
        reportedFile,
        timeout: args.timeout,
        betweenActionMs: args.betweenActionMs,
        resilient: args.resilient,
        navTimeout: args.navTimeout,
    });
    // A spawn failure (bad shell/path) or Playwright crashing before it can write the JSON
    // report (missing browsers, a config/syntax error in the generated spec, etc.) must not
    // be swallowed: without this check the code below falls back to an empty report and the
    // run prints a false "JUnit report written" success message with 0 tests recorded anywhere.
    if (playwrightResult.error || !fs.existsSync(jsonReportPath)) {
        console.error(
            playwrightResult.error
                ? `Failed to launch Playwright: ${playwrightResult.error.message}`
                : `Playwright exited (status ${playwrightResult.status}) without producing a report -- see output above for the real error.`
        );
        fs.rmSync(workDir, { recursive: true, force: true });
        process.exitCode = 1;
        return;
    }

    let report = { suites: [] };
    try {
        report = JSON.parse(fs.readFileSync(jsonReportPath, 'utf8'));
    } catch (e) {
        console.error('Could not parse Playwright JSON report:', e.message);
    }

    let anyFailed = false;
    let passedCount = 0;
    // Tests the live reporter already published while the run was in progress.
    let alreadyReported = new Set();
    try {
        alreadyReported = new Set(fs.readFileSync(reportedFile, 'utf8').split(/\s+/).filter(Boolean).map(Number));
    } catch {
        // Nothing was published live; every result gets reported below.
    }
    const specs = collectSpecs(report.suites);
    if (specs.length === 0) {
        console.error(`[insightest] Playwright ran 0 of ${tests.length} tests -- the generated suite failed to load (see "Playwright error" above).`);
        anyFailed = true;
        try {
            const keep = path.join(path.dirname(junitOutputPath), 'suite.spec.failed.ts');
            fs.copyFileSync(path.join(workDir, 'suite.spec.ts'), keep);
            console.error('[insightest] Saved the generated suite for debugging: ' + keep);
        } catch {}
    }
    for (const spec of specs) {
        const testId = testIdFromTitle(spec.title);
        if (!testId) continue;

        const test = (spec.tests || [])[0];
        const result = test ? test.results?.[0] : null;
        const status = statusFromTestResult(test);
        const durationMs = result?.duration ?? 0;
        const log = [result?.stdout?.map((c) => c.text).join(''), result?.error?.message]
            .filter(Boolean)
            .join('\n');

        if (status !== 'passed') anyFailed = true;
        else passedCount++;

        if (alreadyReported.has(testId)) continue;

        console.log(`Reporting test ${testId}: ${status}`);
        try {
            await apiRequest(apiUrl, apiKey, 'POST', `/tests/${testId}/runs`, {
                status,
                duration_ms: durationMs,
                log: log || null,
            });
        } catch (e) {
            console.error(`Failed to report result for test ${testId}:`, e.message);
            anyFailed = true;
        }
    }

    fs.rmSync(workDir, { recursive: true, force: true });
    console.log(`JUnit report written to ${junitOutputPath}`);

    const total = tests.length;
    const percent = total ? Math.round((passedCount / total) * 100) : 0;
    const recapColor = passedCount === total ? '\x1b[32m' : passedCount === 0 ? '\x1b[31m' : '\x1b[33m';
    console.log(`\n[insightest] Recap: ${recapColor}${passedCount}/${total} tests passed (${percent}%)\x1b[0m`);

    // --resilient: don't fail the pipeline step over failed tests -- PublishTestResults@2
    // (with failTaskOnFailedTests: false) is meant to be the source of truth for build health.
    if (anyFailed && !args.resilient) {
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
