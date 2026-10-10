// PlaywrightBuilder: the test engine's ready-made action library (Playwright port of the legacy
// PuppeteerBuilder). Recorded tests are plain calls on it -- `await pw.click(selector, causesNavigation)`,
// `pw.select2(...)`, `pw.load(url)`... -- and every bit of behaviour (waiting, retries, selector fallback,
// first-match, select2, navigation settling) lives HERE, never in the generated test code.
//
// Selectors are Playwright selector strings: `xpath=//...`, CSS (usually with `:visible`), or `text=...`.
// Per-step recorded metadata (secondary selectors, all recorded candidates) is handed over by the runner
// via `pw.useMeta(...)` right before each selector-bearing call.
//
// Mirrored at backend/public/ci-runner/pwBuilder.js (served statically to CI) and desktop/electron/pwBuilder.js
// (local runs); keep all three in sync.
'use strict';

const { runQuery, diffRows } = require('./dbClient');

const DEFAULT_PRIORITY = ['xpath', 'generalSelector', 'text', 'id'];
const DEFAULT_ACTION_TIMEOUTS_MS = [8000, 15000, 20000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (e) => (e && e.message ? String(e.message).split('\n')[0] : String(e));

// Framework-generated ids (select2-xxxx-container, ng-…, mat-…, a React :rN, or any run of 3+ digits) are a NEW
// random value on every page load/widget instantiation: a selector built on one is guaranteed to be stale the
// moment it is replayed in a different run, yet it still looks like a perfectly fine recorded candidate. Trying
// it anyway just burns a full escalating-timeout attempt for nothing, delaying the fallbacks that could actually
// find the element (recorded alternative, live similarity match, heal probing).
const DYNAMIC_ID_RE = /(select2|mat-|ng-|cdk-|ui-|react|:r\d)|\d{3,}/i;
function isDynamicIdSelector(sel) {
  const m = /^#([\w-]+)/.exec(String(sel).trim());
  return !!m && DYNAMIC_ID_RE.test(m[1]);
}

const dialogHandled = new WeakSet();

/** Watches `page` for failed HTTP responses (4xx/5xx) without failing the test, collecting them on
 * the page itself (`page.__insightestApiErrors`) so they survive across whoever created the page
 * (PlaywrightBuilder or a plain Playwright test) -- a plain property on the shared `page` object,
 * not a module-local WeakSet, so this works even when called from a different copy of this file
 * (ci-runner/ vs backend/public/ci-runner/ vs desktop/electron/) in the same process. Guarded so a
 * test that also builds a PlaywrightBuilder doesn't get the listener attached twice. */
function trackApiErrors(page) {
  if (page.__insightestNetworkTracked) return;
  page.__insightestNetworkTracked = true;
  page.__insightestApiErrors = [];
  page.__insightestApiErrorReads = [];
  page.on('response', (r) => {
    if (r.status() < 400) return;
    console.warn(`[insightest] HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
    // Reading the body is async and must finish before reportApiErrors() runs (afterEach, right
    // after the test ends) or the error is silently dropped -- tracked here so it can be awaited.
    const read = r
      .text()
      .then((body) => {
        page.__insightestApiErrors.push({ status: r.status(), url: r.url(), body: String(body || '').replace(/\s+/g, ' ').trim().slice(0, 2000) });
      })
      .catch(() => {
        page.__insightestApiErrors.push({ status: r.status(), url: r.url(), body: '' });
      });
    page.__insightestApiErrorReads.push(read);
  });
}

/** Prints one line per failed HTTP response seen on `page` since it was created, in the
 * `{nome test} > {status code} > {url} > {body}` format the pipeline/app scan for and save --
 * meant to be called once a test (or the whole run) ends, so API errors are surfaced even when
 * the test itself passed. Returns the list (also useful for an end-of-run recap). */
async function reportApiErrors(page, testName) {
  await Promise.all(page.__insightestApiErrorReads || []).catch(() => {});
  const errors = page.__insightestApiErrors || [];
  for (const e of errors) {
    console.log(`[insightest-api-error] ${testName} > ${e.status} > ${e.url} > ${e.body}`);
  }
  return errors;
}

class PlaywrightBuilder {
  /**
   * @param page     Playwright Page
   * @param opts     { priority?: string[], variables?: Record<string,string>, timeouts?: number[], navTimeouts?: number[], dbConnectionString?: string }
   */
  constructor(page, opts = {}) {
    this.page = page;
    this.variables = opts.variables || {};
    this.dbConnectionString = opts.dbConnectionString || null;
    this._dbSnapshots = {};
    this.priority = Array.isArray(opts.priority) && opts.priority.length ? opts.priority : DEFAULT_PRIORITY;
    // Heal mode: a step that cannot be performed is searched for on the live page instead of failing the run.
    this.healMode = opts.heal !== undefined ? !!opts.heal : process.env.INSIGHTEST_HEAL === '1';
    // While healing, broken steps should be detected fast (the heal search runs right after); navigation keeps its patience.
    this.timeouts = opts.timeouts || (this.healMode ? [4000, 6000, 8000] : DEFAULT_ACTION_TIMEOUTS_MS);
    const navOverride = Number(process.env.INSIGHTEST_NAV_TIMEOUT_MS || 0) || null;
    this.navTimeouts = opts.navTimeouts || (navOverride ? [navOverride, navOverride, navOverride] : this.healMode ? DEFAULT_ACTION_TIMEOUTS_MS : this.timeouts);
    this.betweenActionMs = Number(process.env.INSIGHTEST_BETWEEN_ACTION_MS || 0);
    this.promptValue = '';
    this.confirmValue = true;
    this._meta = null;

    // alert/confirm/prompt: accept by default (Playwright would auto-dismiss); alert()/prompt()/confirm() below set the answer.
    if (!dialogHandled.has(page)) {
      dialogHandled.add(page);
      page.on('dialog', (d) => {
        const accept = d.type() === 'confirm' ? this.confirmValue !== false : true;
        (accept ? d.accept(d.type() === 'prompt' ? this.promptValue : undefined) : d.dismiss()).catch(() => {});
      });
    }
    // Report failed HTTP responses without failing the test.
    trackApiErrors(page);
  }

  // ---------------------------------------------------------------- plumbing

  /** Runner hook: metadata of the NEXT selector-bearing call (secondary selectors, byKey, textHint). */
  useMeta(meta) {
    this._meta = meta || null;
  }
  _takeMeta() {
    const m = this._meta;
    this._meta = null;
    return m;
  }
  setPriority(priority) {
    if (Array.isArray(priority) && priority.length) this.priority = priority;
  }

  /** Replaces $$name$$ placeholders with this.variables. */
  clean(value) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'string') return value;
    return value.replace(/\$\$(.*?)\$\$/g, (match, name) => (this.variables[name] !== undefined ? String(this.variables[name]) : match));
  }

  /** Candidate selectors for one step, best first: the recorded candidates re-ranked by the project's
   * selector priority when the step carries them, else the primary followed by its secondaries. */
  _candidates(primary, meta) {
    const out = [];
    const byKey = meta && meta.byKey;
    if (byKey && Object.keys(byKey).length) {
      for (const key of this.priority) {
        if (key === 'text') {
          if (byKey.text) out.push({ text: byKey.text });
        } else if (byKey[key] && !isDynamicIdSelector(byKey[key])) {
          out.push({ sel: String(byKey[key]).trim() });
        }
      }
    }
    if (!out.length && primary) out.push({ sel: primary });
    for (const s of (meta && meta.secondarySelectors) || []) {
      if (s && !s.startsWith('select2text:') && !isDynamicIdSelector(s)) out.push({ sel: String(s).trim() });
    }
    const seen = new Set();
    return out.filter((c) => {
      const k = c.text !== undefined ? 'text:' + c.text : c.sel;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /** Always the FIRST match (Puppeteer semantics) -- never a strict-mode failure. */
  _locator(cand) {
    return (cand.text !== undefined ? this.page.getByText(cand.text) : this.page.locator(cand.sel)).first();
  }

  _label(cand) {
    return cand.text !== undefined ? `text=${JSON.stringify(cand.text)}` : cand.sel;
  }

  /**
   * The resilient core: run `perform(locator)` on the best candidate (two attempts with escalating timeouts),
   * then walk the remaining recorded candidates, then a live DOM text-similarity rescan; rethrow if all fail.
   */
  async _do(label, primary, perform, meta) {
    const cands = this._candidates(primary, meta);
    if (!cands.length) throw new Error(`${label}: no selector`);
    // Per-step options set in the desktop step editor (steps_json): pause before, fixed timeout, skip on failure.
    if (meta && Number(meta.waitBeforeMs) > 0) await sleep(Number(meta.waitBeforeMs));
    const timeouts = meta && Number(meta.timeout) > 0 ? [Number(meta.timeout), Number(meta.timeout), Number(meta.timeout)] : this.timeouts;
    const main = cands[0];
    const mainLabel = this._label(main);
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      this.page.setDefaultTimeout(timeouts[attempt - 1] ?? timeouts[timeouts.length - 1]);
      console.log(`[insightest] ${attempt === 1 ? '' : `Retry ${attempt}/3: `}${label} ${mainLabel}`);
      try {
        await perform(this._locator(main));
        return true;
      } catch (e) {
        lastError = e;
        console.warn(`[insightest] Tentativo ${attempt}/3 fallito: ${label} ${mainLabel} -- ${firstLine(e)}`);
        if (attempt === 1 && this.betweenActionMs > 0) await sleep(this.betweenActionMs);
      }
    }
    this.page.setDefaultTimeout(timeouts[timeouts.length - 1]);
    // The selector may well be right and the element real, but not "actionable" by Playwright's stricter
    // definition (covered by a sticky header/overlay, mid-animation, or destabilized by the auto-scroll that
    // precedes the action): force the action through, bypassing those checks, before concluding the selector
    // itself is stale. Always reported (never silently treated as the normal path) since forcing an action can
    // just as easily hit an element a real user could never actually interact with.
    try {
      await perform(this._locator(main), { force: true, noScroll: true });
      this._emitHeal({ ...this._ref(meta), action: label, failed: mainLabel, failedAll: [mainLabel], kind: 'force-interaction', strategy: 'force', confidence: 0.6, evidence: 'the element is only reachable by bypassing Playwright\'s actionability checks (force, no auto-scroll)' });
      return true;
    } catch (e) {
      lastError = e;
    }
    const failedLabels = [mainLabel];
    for (const cand of cands.slice(1)) {
      console.log(`[insightest] Fallback 3/3 (selettore secondario): ${label} ${this._label(cand)}`);
      try {
        await perform(this._locator(cand));
        // The step passed, but only thanks to a recorded alternative: the selectors tried before it are stale.
        this._emitHeal({ ...this._ref(meta), action: label, failed: mainLabel, failedAll: failedLabels, kind: 'selector', selector: cand.text !== undefined ? `text=${JSON.stringify(cand.text)}` : cand.sel, strategy: 'recorded-alternative', confidence: 0.9, matches: 1, evidence: 'another selector recorded for this step still works' });
        return true;
      } catch (e) {
        lastError = e;
        failedLabels.push(this._label(cand));
      }
    }
    if (cands.length === 1 && meta && meta.textHint) {
      const best = await this._findBySimilarity(meta.textHint, meta.tagHint);
      if (best) {
        console.log(`[insightest] Fallback 3/3 (similarita ${best.score.toFixed(2)}): ${label} ${best.selector}`);
        try {
          await perform(this.page.locator(best.selector).first());
          return true;
        } catch (e) {
          lastError = e;
        }
      }
    }
    if (this.healMode) {
      try {
        if (await this._heal(label, main, cands, perform, meta)) return true;
      } catch (e) {
        lastError = e;
      }
    }
    console.error(`[insightest] Azione fallita dopo 3 tentativi: ${label} ${mainLabel}`);
    try {
      let count = '?';
      try { count = await this._locator(main).count(); } catch {}
      console.error(`[insightest]   diagnostica: url=${this.page.url()} titolo="${await this.page.title().catch(() => '')}" match=${count}`);
      for (const l of String((lastError && lastError.message) || '').split('\n').slice(1, 8).map((s) => s.trim()).filter(Boolean)) {
        console.error(`[insightest]   | ${l}`);
      }
    } catch {}
    if (meta && meta.skipOnFailure) {
      console.warn(`[insightest] Passo saltato (salta in caso di errore): ${label} ${mainLabel}`);
      return false;
    }
    throw lastError;
  }

  // ------------------------------------------------------------------ self-healing
  // With INSIGHTEST_HEAL=1 a step that still fails after its normal attempts does not just throw: the engine looks for
  // the element on the LIVE page with deterministic strategies, performs the action on the first one that works and
  // reports what it changed as `[insightest-heal] {json}` lines. The desktop app turns those into proposals the user
  // reviews and saves; nothing is written to the test by the engine itself. Steps that only worked thanks to a
  // recorded secondary selector are reported too (in any mode): the primary selector is stale.

  _emitHeal(evt) {
    let line = JSON.stringify(evt);
    if (line.length > 14000) line = JSON.stringify({ ...evt, snapshot: undefined, truncated: true });
    console.log('[insightest-heal] ' + line);
  }

  /** Which test (t: 0..n-1 = prerequisites in run order, last = the test itself) and which selector-bearing call (i). */
  _ref(meta) {
    return { t: meta && meta.__t !== undefined ? meta.__t : 0, i: meta && meta.__i !== undefined ? meta.__i : -1 };
  }

  /** What the recorded selectors tell us about the element: its data-test/id/name/label-for/text and xpath. */
  _fingerprint(cands, meta) {
    const fp = { dataAttr: 'data-test', dataTest: null, id: null, forAttr: null, name: null, text: null, xpath: null };
    // Everything recorded for the step, including kinds the project's selector priority leaves out of normal runs
    // (data-test, attributes): they are exactly what identifies the element when the used selector went stale.
    const all = [...cands];
    if (meta && meta.byKey && typeof meta.byKey === 'object') {
      for (const [k, v] of Object.entries(meta.byKey)) {
        if (!v || !String(v).trim()) continue;
        all.push(k === 'text' ? { text: String(v) } : { sel: String(v).trim() });
      }
    }
    for (const c of all) {
      if (c.text !== undefined) {
        if (!fp.text && String(c.text).trim()) fp.text = String(c.text).trim();
        continue;
      }
      const s = String(c.sel || '');
      let m = /\[(data-test(?:id)?)=["']?([^"'\]]+)["']?\]/.exec(s);
      if (m && !fp.dataTest) { fp.dataAttr = m[1]; fp.dataTest = m[2]; }
      m = /^#([\w-]+)/.exec(s.trim());
      if (m && !fp.id) fp.id = m[1];
      m = /\[for=["']?([^"'\]]+)["']?\]/.exec(s);
      if (m && !fp.forAttr) fp.forAttr = m[1];
      m = /\[name=["']?([^"'\]]+)["']?\]/.exec(s);
      if (m && !fp.name) fp.name = m[1];
      if (s.startsWith('xpath=') && !fp.xpath) fp.xpath = s.slice(6);
    }
    if (!fp.text && meta && meta.textHint && String(meta.textHint).trim()) fp.text = String(meta.textHint).trim();
    // Framework-generated ids (select2-xxxx-container, ng-…, mat-…) change on every render: not a stable anchor.
    fp.dynamicId = !!fp.id && /(select2|mat-|ng-|cdk-|ui-|react|:r\d)|\d{3,}/i.test(fp.id);
    return fp;
  }

  /** Alternative selectors for the same element, each with how many visible elements it matches. */
  async _healProbe(fp) {
    const out = [];
    const seen = new Set();
    const add = async (strategy, selector, confidence, note) => {
      if (seen.has(selector)) return;
      seen.add(selector);
      let matches = 0;
      try { matches = await this.page.locator(selector).count(); } catch { return; }
      if (!matches) return;
      out.push({ strategy, selector, matches, confidence: matches === 1 ? confidence : confidence * 0.6, evidence: note });
    };
    const q = (s) => JSON.stringify(String(s));

    if (fp.dataTest) await add('data-test', `[${fp.dataAttr}=${q(fp.dataTest)}]:visible`, 0.95, `same ${fp.dataAttr} "${fp.dataTest}"`);
    if (fp.id && !fp.dynamicId) await add('id', `#${fp.id.replace(/([^\w-])/g, '\\$1')}:visible`, 0.9, `same id "${fp.id}"`);
    if (fp.forAttr) await add('label-for', `label[for=${q(fp.forAttr)}]:visible`, 0.85, `label for "${fp.forAttr}"`);
    if (fp.name) await add('name', `[name=${q(fp.name)}]:visible`, 0.85, `same name "${fp.name}"`);
    if (fp.text) {
      const esc = fp.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await add('text', `text=${q(fp.text)}`, 0.8, `same visible text "${fp.text}"`);
      await add('text', `text=/^\\s*${esc}\\s*$/i`, 0.7, `visible text "${fp.text}" (case-insensitive)`);
      await add('aria-label', `[aria-label=${q(fp.text)} i]:visible`, 0.75, `aria-label "${fp.text}"`);
      await add('placeholder', `[placeholder=${q(fp.text)} i]:visible`, 0.75, `placeholder "${fp.text}"`);
    }
    if (fp.xpath) {
      // The page structure drifted (a wrapper added/removed): the tail of the recorded path is usually still right.
      const segs = fp.xpath.split('/').filter(Boolean);
      const tails = [];
      for (let k = Math.min(segs.length - 1, 8); k >= 2; k--) tails.push(segs.slice(-k));
      for (const tail of tails) {
        await add('xpath-tail', `xpath=//${tail.join('/')}`, 0.7 - (0.2 * (8 - tail.length)) / 8, `end of the recorded path (${tail.length} levels)`);
      }
      // Anchored on the routed page component (app-…) with the structure in between relaxed.
      const anchor = segs.findIndex((s) => /^app-/.test(s) && !/^app-root/.test(s));
      if (anchor >= 0) {
        for (const n of [4, 3, 2]) {
          const tail = segs.slice(-n);
          if (segs.length - n > anchor) await add('xpath-anchor', `xpath=//${segs[anchor]}//${tail.join('/')}`, 0.65, `inside ${segs[anchor]}`);
        }
      }
    }
    return out;
  }

  /** Last resort for a failing step: returns true if the action was performed on an element found on the live page. */
  async _heal(label, main, cands, perform, meta) {
    const ref = this._ref(meta);
    const base = { ...ref, action: label, failed: this._label(main), failedAll: cands.map((c) => this._label(c)) };
    const fp = this._fingerprint(cands, meta);
    this.page.setDefaultTimeout(4000);

    /** Keeps retrying the ORIGINAL selector for a while: it may just be slow (present but hidden, or inserted late). */
    const waitForOriginal = async (budgetMs) => {
      const start = Date.now();
      while (Date.now() - start < budgetMs) {
        try {
          await perform(this._locator(main));
          const elapsed = Date.now() - start;
          this._emitHeal({ ...base, kind: 'timing', strategy: 'wait', confidence: 0.6, timeoutMs: Math.ceil(((elapsed + 10000) * 1.3) / 1000) * 1000, evidence: `the element becomes actionable only ~${Math.round(elapsed / 1000) + 10}s after the step starts` });
          return true;
        } catch {}
        await sleep(1000);
      }
      return false;
    };

    // 1) The element exists in the DOM but was not visible/enabled in time: wait a bit more.
    try {
      const raw = main.text !== undefined ? null : String(main.sel).replace(/\s*:visible\s*$/, '');
      if (raw && (await this.page.locator(raw).count()) > 0 && (await waitForOriginal(12000))) return true;
    } catch {}

    // 2) Same element, found another way.
    const probes = (await this._healProbe(fp)).sort((a, b) => b.confidence - a.confidence);
    for (const p of probes) {
      if (p.confidence < 0.5) continue;
      try {
        await perform(this.page.locator(p.selector).first());
        this._emitHeal({ ...base, kind: 'selector', selector: p.selector, strategy: p.strategy, confidence: Math.round(p.confidence * 100) / 100, matches: p.matches, evidence: p.evidence });
        return true;
      } catch {}
    }

    // 3) Not found any other way: maybe the original is simply inserted late. Give it one long chance.
    try {
      if (await waitForOriginal(20000)) return true;
    } catch {}

    // 4) Text-similarity rescan (recorded text/tag hint).
    if (meta && meta.textHint) {
      const best = await this._findBySimilarity(meta.textHint, meta.tagHint);
      if (best) {
        try {
          await perform(this.page.locator(best.selector).first());
          this._emitHeal({ ...base, kind: 'selector', selector: best.selector, strategy: 'similarity', confidence: Math.round(Math.min(0.6, best.score) * 100) / 100, matches: 1, evidence: `element whose text is ${Math.round(best.score * 100)}% similar to "${meta.textHint}"` });
          return true;
        } catch {}
      }
    }

    // 5) Unresolved: hand over what the page looks like now (for the AI healer and the user).
    this._emitHeal({ ...base, kind: 'unresolved', snapshot: await this._pageDigest(), url: this.page.url() });
    return false;
  }

  /** Compact description of the page's interactive elements at the moment a step could not be healed. */
  async _pageDigest() {
    try {
      return await this.page.evaluate(() => {
        const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
        const attr = (el, n) => (el.getAttribute(n) || '').slice(0, 60);
        const els = Array.from(document.querySelectorAll('button,a,input,select,textarea,label,[role=button],[role=option],[role=tab],[data-test],[data-testid],h1,h2,h3')).filter(vis).slice(0, 70);
        return {
          title: document.title,
          elements: els.map((el) => {
            const o = { tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 50) };
            for (const n of ['data-test', 'data-testid', 'id', 'name', 'type', 'aria-label', 'placeholder', 'role', 'for']) { const v = attr(el, n); if (v) o[n] = v; }
            return o;
          }),
        };
      });
    } catch {
      return null;
    }
  }

  async _findBySimilarity(textHint, tagHint) {
    if (!textHint) return null;
    return this.page
      .evaluate(({ textHint, tagHint }) => {
        const sim = (a, b) => {
          a = String(a || '').toLowerCase().trim();
          b = String(b || '').toLowerCase().trim();
          if (!a || !b) return 0;
          const m = a.length, n = b.length, d = [];
          for (let i = 0; i <= m; i++) d[i] = [i];
          for (let j = 0; j <= n; j++) d[0][j] = j;
          for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
          return 1 - d[m][n] / Math.max(m, n);
        };
        // A selector relative only to the element's immediate parent (e.g. `button:nth-of-type(1)`) is not unique
        // across the WHOLE page: page.locator() matches it anywhere, so `.first()` can resolve to a completely
        // different element (seen in practice: a modal's "Ok" button healed into the page's navbar toggler, which
        // also happens to be its parent's first <button>). Walk up to an id'd ancestor (or <html>) instead, so the
        // path is unique on the page.
        const uniquePath = (node) => {
          const parts = [];
          while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
            if (node.id) {
              parts.unshift(`#${CSS.escape(node.id)}`);
              break;
            }
            const parent = node.parentElement;
            if (!parent) {
              parts.unshift(node.tagName.toLowerCase());
              break;
            }
            const sibs = Array.from(parent.children).filter((s) => s.tagName === node.tagName);
            parts.unshift(sibs.length > 1 ? `${node.tagName.toLowerCase()}:nth-of-type(${sibs.indexOf(node) + 1})` : node.tagName.toLowerCase());
            node = parent;
          }
          return parts.join(' > ');
        };
        let best = null;
        for (const el of document.querySelectorAll(tagHint || 'button, a, input, select, textarea, [role], label, [onclick]')) {
          const text = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.getAttribute('value') || '').trim();
          if (!text) continue;
          const score = sim(text, textHint);
          if (score > 0.55 && (!best || score > best.score)) {
            best = { selector: el.id ? `#${CSS.escape(el.id)}` : uniquePath(el), score };
          }
        }
        return best;
      }, { textHint, tagHint })
      .catch(() => null);
  }

  // ---------------------------------------------------------------- navigation

  /** Settles after an action that navigates: DOM ready, then a bounded wait for the network to calm down
   * (never fails -- SPA route changes and pages with permanent polling must not break the test). */
  async waitForNavigation() {
    console.log('[insightest] Attendo navigazione');
    await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await sleep(500);
  }

  async _afterAction(causesNavigation) {
    if (causesNavigation) await this.waitForNavigation();
  }

  async waitForSelector(selector, options = {}) {
    selector = this.clean(selector);
    await this.page.locator(selector).first().waitFor({ state: 'attached', ...options });
  }

  load = async (url) => {
    url = this.clean(url);
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const timeout = this.navTimeouts[attempt - 1] ?? this.navTimeouts[this.navTimeouts.length - 1];
      this.page.setDefaultTimeout(timeout);
      this.page.setDefaultNavigationTimeout(timeout);
      console.log(`[insightest] ${attempt === 1 ? '' : `Retry ${attempt}/3: `}Naviga ${JSON.stringify(url)}`);
      try {
        // domcontentloaded: 'load' blocks on every image/script and routinely exceeds the first timeout.
        await this.page.goto(url, { waitUntil: 'domcontentloaded' });
        await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await sleep(500);
        return;
      } catch (e) {
        lastError = e;
        console.warn(`[insightest] Tentativo ${attempt}/3 fallito: Naviga ${url} -- ${firstLine(e)}`);
        if (attempt < 3 && this.betweenActionMs > 0) await sleep(this.betweenActionMs);
      }
    }
    console.error(`[insightest] Navigazione fallita dopo 3 tentativi: ${url}`);
    throw lastError;
  };

  back = async () => { await this.page.goBack(); };
  forward = async () => { await this.page.goForward(); };
  refresh = async () => { await this.page.reload(); };

  // ---------------------------------------------------------------- simple actions

  wait = async (milliseconds) => {
    await sleep(Number(this.clean(milliseconds)) || 0);
  };

  resize = async (width, height) => {
    await this.page.setViewportSize({ width: Number(width) || 1280, height: Number(height) || 720 });
  };

  alert = async () => {};
  prompt = async (value) => { this.promptValue = String(this.clean(value) ?? ''); };
  confirm = async (value) => { this.confirmValue = !!value; };

  wheel = async (deltaX, deltaY) => {
    await this.page.evaluate(([dx, dy]) => window.scrollBy(dx, dy), [Number(deltaX) || 0, Number(deltaY) || 0]);
  };

  dragAndDrop = async (sourceX, sourceY, targetX, targetY) => {
    await this.page.mouse.move(sourceX, sourceY);
    await this.page.mouse.down();
    await this.page.mouse.move(targetX, targetY);
    await this.page.mouse.up();
  };

  customAction = async (code) => {
    await this.page.evaluate((c) => (0, eval)(c), this.clean(code));
  };

  /** Runs a SQL query against the project's DB connection string. `opts.mode === 'snapshot'` stores
   * the result rows under `opts.name` for a later diff; `opts.mode === 'diff'` re-runs the query,
   * compares it against that snapshot by `opts.keyColumn`, and asserts the inserted/updated/deleted
   * row counts in `opts.expect` ({ inserted?, updated?, deleted? }) match -- throwing (failing the
   * step) on a mismatch. */
  DB = async (query, opts = {}) => {
    const sql = this.clean(query);
    console.log(`[insightest] DB ${opts.mode === 'diff' ? 'diff' : 'snapshot'} (${opts.name || ''}): ${sql}`);
    const { rows } = await runQuery(this.dbConnectionString, sql);

    if (opts.mode !== 'diff') {
      this._dbSnapshots[opts.name] = rows;
      return;
    }

    const before = this._dbSnapshots[opts.name] || [];
    const { inserted, updated, deleted } = diffRows(before, rows, opts.keyColumn);
    console.log(`[insightest] DB diff (${opts.name || ''}): inserted=${inserted} updated=${updated} deleted=${deleted}`);
    for (const [key, expected] of Object.entries(opts.expect || {})) {
      const actual = { inserted, updated, deleted }[key];
      if (expected !== undefined && expected !== null && actual !== expected) {
        throw new Error(`DB diff assertion failed for "${opts.name}": expected ${key}=${expected}, got ${actual}`);
      }
    }
  };

  awaitText = async (property, selector, text) => {
    text = this.clean(text);
    await this.page.waitForFunction((t) => document.body.innerText.includes(t), text);
  };

  awaitNetworkStatus = async (url, status) => {
    url = this.clean(url);
    await this.page.waitForResponse((r) => r.url().includes(url) && r.status() === Number(status));
  };

  fullScreenshot = async () => {};

  // ---------------------------------------------------------------- selector actions

  click = async (selector, causesNavigation = false, options = {}) => {
    const meta = this._takeMeta();
    if (await this._do('Click', this.clean(selector), (l, extra) => l.click({ ...options, ...extra }), meta)) await this._afterAction(causesNavigation);
  };

  doubleClick = async (selector, causesNavigation = false, options = {}) => {
    const meta = this._takeMeta();
    if (await this._do('Doppio click', this.clean(selector), (l, extra) => l.dblclick({ ...options, ...extra }), meta)) await this._afterAction(causesNavigation);
  };

  rightClick = async (selector, causesNavigation = false, options = {}) => {
    const meta = this._takeMeta();
    if (await this._do('Click destro', this.clean(selector), (l, extra) => l.click({ ...options, ...extra, button: 'right' }), meta)) await this._afterAction(causesNavigation);
  };

  hover = async (selector, causesNavigation = false, options = {}) => {
    const meta = this._takeMeta();
    if (await this._do('Hover', this.clean(selector), (l, extra) => l.hover({ ...options, ...extra }), meta)) await this._afterAction(causesNavigation);
  };

  /** Key-by-key typing (appends), like puppeteer's page.type. */
  type = async (selector, value, causesNavigation = false, options = {}) => {
    const meta = this._takeMeta();
    value = String(this.clean(value) ?? '');
    if (await this._do('Digita', this.clean(selector), (l, extra) => l.pressSequentially(value, { ...options, ...extra }), meta)) await this._afterAction(causesNavigation);
  };

  /** Sets the field's value. If the recorded target is a wrapper (label/div) fills its nearest writable descendant. */
  fill = async (selector, value, causesNavigation = false, options = {}) => {
    const meta = this._takeMeta();
    value = String(this.clean(value) ?? '');
    if (await this._do('Fill', this.clean(selector), (l, extra) => this._smartFill(l, value, { ...options, ...extra }), meta)) await this._afterAction(causesNavigation);
    return this;
  };

  async _smartFill(loc, value, options) {
    const fillable = await loc.evaluate((el) => el.matches('input, textarea, select, [contenteditable]')).catch(() => true);
    if (fillable) return loc.fill(value, options);
    const nested = loc.locator('input, textarea, select, [contenteditable]').first();
    if ((await nested.count().catch(() => 0)) === 0) return loc.fill(value, options);
    console.warn('[insightest] target is not writable, filling nearest writable descendant instead');
    return nested.fill(value, options);
  }

  clearInput = async (selector) => {
    const meta = this._takeMeta();
    await this._do('Svuota', this.clean(selector), (l, extra) => this._smartFill(l, '', extra || {}), meta);
  };

  /** Native <select>: by option value (or label). */
  select = async (selector, option, causesNavigation = false, options = {}) => {
    const meta = this._takeMeta();
    option = String(this.clean(option) ?? '');
    if (await this._do('Seleziona opzione', this.clean(selector), (l, extra) => l.selectOption(option, { ...options, ...extra }), meta)) await this._afterAction(causesNavigation);
  };

  /** selector null/'' => key goes to whatever has focus (page.keyboard). */
  keydown = async (selector, key, causesNavigation = false, options = {}) => {
    const meta = this._takeMeta();
    key = String(this.clean(key) ?? '');
    if (!selector) {
      await this.page.keyboard.press(key);
    } else {
      if (!(await this._do('Premi tasto', this.clean(selector), (l, extra) => l.press(key, { ...options, ...extra }), meta))) return;
    }
    await this._afterAction(causesNavigation);
  };

  // ---------------------------------------------------------------- select2

  /**
   * select2 dropdown: open it, then pick an option BY TEXT (string) or by position (number).
   * Text match order among visible options: exact > "CODE - name" starting with the value > equal ignoring
   * punctuation/spacing > contains. If nothing visible matches (ajax lists only fill once searched) the text is
   * typed into the open dropdown's search box and matching is retried. One full reopen-and-retry on failure.
   */
  select2 = async (selector, value, causesNavigation = false, options = {}) => {
    const meta = this._takeMeta();
    selector = this.clean(selector);
    value = typeof value === 'string' ? this.clean(value) : value;
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (!(await this._do('Click', selector, (l) => l.click(), meta))) return;
      try {
        await this.page.locator('.select2-container--open').first().waitFor({ state: 'visible', timeout: 5000, ...options });
        const option = await this._select2Option(value);
        await option.click();
        await this._afterAction(causesNavigation);
        return;
      } catch (e) {
        lastError = e;
        console.warn(`[insightest] select2 tentativo ${attempt}/2 fallito: ${JSON.stringify(value)} -- ${firstLine(e)}`);
        await this.page.keyboard.press('Escape').catch(() => {});
      }
    }
    // Heal mode: the option text no longer exists (renamed/typo): pick the closest one and report it.
    if (this.healMode && typeof value === 'string' && /select2 option not found/.test(String(lastError && lastError.message))) {
      if (await this._healSelect2(selector, value, meta, causesNavigation)) return;
    }
    throw lastError;
  };

  /** How alike two labels are, 0..1: word-prefix containment ("FORLI" ~ "Forlì (FC)") or edit distance. */
  _textScore(a, b) {
    const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const tok = (s) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
    const ta = tok(a), tb = tok(b);
    if (!ta.length || !tb.length) return 0;
    let score = 0;
    if (ta.every((x) => tb.some((y) => y.startsWith(x)))) score = Math.max(score, 0.85 - Math.min(0.3, (tb.length - ta.length) * 0.05));
    const fa = ta.join(' '), fb = tb.join(' ');
    const m = fa.length, n = fb.length, d = [];
    for (let i = 0; i <= m; i++) d[i] = [i];
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = fa[i - 1] === fb[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
    score = Math.max(score, 1 - d[m][n] / Math.max(m, n));
    return score;
  }

  async _healSelect2(selector, value, meta, causesNavigation) {
    const ref = this._ref(meta);
    try {
      this.page.setDefaultTimeout(4000);
      if (!(await this._do('Click', selector, (l) => l.click(), meta))) return false;
      await this.page.locator('.select2-container--open').first().waitFor({ state: 'visible', timeout: 5000 });
      const search = this.page.locator('.select2-container--open .select2-search__field').last();
      const hasSearch = await search.isVisible().catch(() => false);
      const options = this.page.locator('.select2-results__option:not(.select2-results__message):not(.loading-results):visible');
      // Long/ajax lists only show what matches the search box: try the whole list, then shorter and shorter prefixes
      // of the wanted text, and take the first query whose results contain something that resembles it.
      const queries = hasSearch ? ['', value.slice(0, Math.max(3, Math.ceil(value.length / 2))), value.slice(0, 3), value.slice(0, 2)] : [null];
      let picked = null;
      const seenTexts = [];
      for (const query of [...new Set(queries)]) {
        if (query !== null) {
          await search.fill(query);
          await sleep(800); // ajax select2 debounces, then shows "Searching…"
          for (let w = 0; w < 30 && (await this.page.locator('.select2-results__option.loading-results').count()) > 0; w++) await sleep(150);
        }
        const texts = (await options.allInnerTexts()).map((s) => s.trim());
        seenTexts.push(...texts);
        let best = -1, bestScore = 0;
        texts.forEach((t, i) => {
          const s = this._textScore(value, t);
          if (s > bestScore) { bestScore = s; best = i; }
        });
        if (best >= 0 && bestScore >= 0.5) {
          picked = { index: best, score: bestScore, texts };
          break;
        }
      }
      if (!picked) {
        this._emitHeal({ ...ref, action: 'select2', failed: JSON.stringify(value), kind: 'unresolved', evidence: `no option resembles "${value}"`, snapshot: { options: [...new Set(seenTexts)].slice(0, 60) } });
        await this.page.keyboard.press('Escape').catch(() => {});
        return false;
      }
      await options.nth(picked.index).click();
      this._emitHeal({ ...ref, action: 'select2', failed: JSON.stringify(value), kind: 'value', option: picked.texts[picked.index], strategy: 'closest-option', confidence: Math.round(picked.score * 0.9 * 100) / 100, evidence: `closest option to "${value}" among ${picked.texts.length} listed` });
      await this._afterAction(causesNavigation);
      return true;
    } catch {
      await this.page.keyboard.press('Escape').catch(() => {});
      return false;
    }
  }

  async _select2Option(value) {
    // Real options only: not the "Searching…" / "No results found" message rows.
    const options = this.page.locator('.select2-results__option:not(.select2-results__message):not(.loading-results):visible');
    if (typeof value === 'number') {
      await options.first().waitFor({ state: 'visible', timeout: 8000 });
      return options.nth(value);
    }
    const text = String(value);
    // Case/accent-insensitive ("FORLI" matches "Forlì").
    const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const alnum = (s) => fold(s).replace(/[^a-z0-9]/g, '');
    const raw = fold(text);
    const want = alnum(text);
    const find = async () => {
      const texts = (await options.allInnerTexts()).map(fold);
      let i = texts.findIndex((t) => t === raw);
      if (i < 0) i = texts.findIndex((t) => t.startsWith(raw) && !/[a-z0-9]/.test(t.charAt(raw.length) || ' '));
      if (i < 0 && want) i = texts.findIndex((t) => alnum(t) === want);
      if (i < 0) i = texts.findIndex((t) => t.includes(raw));
      if (i < 0 && want) i = texts.findIndex((t) => alnum(t).includes(want));
      return i;
    };
    const poll = async (ms) => {
      const end = Date.now() + ms;
      for (;;) {
        const i = await find();
        if (i >= 0) return i;
        if (Date.now() >= end) return -1;
        await sleep(250);
      }
    };

    // Same as the legacy builder: TYPE the value into the open dropdown's search box, so the app itself filters the
    // list -- essential for long or ajax-backed lists (e.g. the provinces of the chosen nation), where the wanted
    // option is not in the initial page of results. Dropdowns without a search box are matched as they are.
    const search = this.page.locator('.select2-container--open .select2-search__field').last();
    const hasSearch = await search.isVisible().catch(() => false);
    if (hasSearch) {
      await search.fill('');
      await search.pressSequentially(text, { delay: 30 });
      await sleep(450); // ajax select2 debounces (default 250ms) before it even shows "Searching…"
      const loading = this.page.locator('.select2-results__option.loading-results, .select2-results__option--loading');
      const end = Date.now() + 10000;
      while (Date.now() < end && (await loading.count().catch(() => 0)) > 0) await sleep(150);
    }
    const i = await poll(hasSearch ? 8000 : 3000);
    if (i < 0) throw new Error('select2 option not found: ' + text);
    return options.nth(i);
  }
}

module.exports = { PlaywrightBuilder, DEFAULT_PRIORITY, trackApiErrors, reportApiErrors };
