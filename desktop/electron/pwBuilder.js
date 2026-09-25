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

const DEFAULT_PRIORITY = ['xpath', 'generalSelector', 'text', 'id'];
const DEFAULT_ACTION_TIMEOUTS_MS = [8000, 15000, 20000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (e) => (e && e.message ? String(e.message).split('\n')[0] : String(e));

const dialogHandled = new WeakSet();
const networkLogged = new WeakSet();

class PlaywrightBuilder {
  /**
   * @param page     Playwright Page
   * @param opts     { priority?: string[], variables?: Record<string,string>, timeouts?: number[], navTimeouts?: number[] }
   */
  constructor(page, opts = {}) {
    this.page = page;
    this.variables = opts.variables || {};
    this.priority = Array.isArray(opts.priority) && opts.priority.length ? opts.priority : DEFAULT_PRIORITY;
    this.timeouts = opts.timeouts || DEFAULT_ACTION_TIMEOUTS_MS;
    const navOverride = Number(process.env.INSIGHTEST_NAV_TIMEOUT_MS || 0) || null;
    this.navTimeouts = opts.navTimeouts || (navOverride ? [navOverride, navOverride, navOverride] : this.timeouts);
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
    if (!networkLogged.has(page)) {
      networkLogged.add(page);
      page.on('response', (r) => {
        if (r.status() >= 400) console.warn(`[insightest] HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
      });
    }
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
        } else if (byKey[key]) {
          out.push({ sel: String(byKey[key]).trim() });
        }
      }
    }
    if (!out.length && primary) out.push({ sel: primary });
    for (const s of (meta && meta.secondarySelectors) || []) {
      if (s && !s.startsWith('select2text:')) out.push({ sel: String(s).trim() });
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
    for (const cand of cands.slice(1)) {
      console.log(`[insightest] Fallback 3/3 (selettore secondario): ${label} ${this._label(cand)}`);
      try {
        await perform(this._locator(cand));
        return true;
      } catch (e) {
        lastError = e;
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
        let best = null;
        for (const el of document.querySelectorAll(tagHint || 'button, a, input, select, textarea, [role], label, [onclick]')) {
          const text = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.getAttribute('value') || '').trim();
          if (!text) continue;
          const score = sim(text, textHint);
          if (score > 0.55 && (!best || score > best.score)) {
            let selector;
            if (el.id) selector = `#${CSS.escape(el.id)}`;
            else {
              const sibs = Array.from(el.parentElement ? el.parentElement.children : []).filter((s) => s.tagName === el.tagName);
              selector = `${el.tagName.toLowerCase()}:nth-of-type(${sibs.indexOf(el) + 1})`;
            }
            best = { selector, score };
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
    if (await this._do('Click', this.clean(selector), (l) => l.click(options), meta)) await this._afterAction(causesNavigation);
  };

  doubleClick = async (selector, causesNavigation = false, options = {}) => {
    const meta = this._takeMeta();
    if (await this._do('Doppio click', this.clean(selector), (l) => l.dblclick(options), meta)) await this._afterAction(causesNavigation);
  };

  rightClick = async (selector, causesNavigation = false, options = {}) => {
    const meta = this._takeMeta();
    if (await this._do('Click destro', this.clean(selector), (l) => l.click({ ...options, button: 'right' }), meta)) await this._afterAction(causesNavigation);
  };

  hover = async (selector, causesNavigation = false, options = {}) => {
    const meta = this._takeMeta();
    if (await this._do('Hover', this.clean(selector), (l) => l.hover(options), meta)) await this._afterAction(causesNavigation);
  };

  /** Key-by-key typing (appends), like puppeteer's page.type. */
  type = async (selector, value, causesNavigation = false, options = {}) => {
    const meta = this._takeMeta();
    value = String(this.clean(value) ?? '');
    if (await this._do('Digita', this.clean(selector), (l) => l.pressSequentially(value, options), meta)) await this._afterAction(causesNavigation);
  };

  /** Sets the field's value. If the recorded target is a wrapper (label/div) fills its nearest writable descendant. */
  fill = async (selector, value, causesNavigation = false, options = {}) => {
    const meta = this._takeMeta();
    value = String(this.clean(value) ?? '');
    if (await this._do('Fill', this.clean(selector), (l) => this._smartFill(l, value, options), meta)) await this._afterAction(causesNavigation);
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
    await this._do('Svuota', this.clean(selector), (l) => this._smartFill(l, '', {}), meta);
  };

  /** Native <select>: by option value (or label). */
  select = async (selector, option, causesNavigation = false, options = {}) => {
    const meta = this._takeMeta();
    option = String(this.clean(option) ?? '');
    if (await this._do('Seleziona opzione', this.clean(selector), (l) => l.selectOption(option, options), meta)) await this._afterAction(causesNavigation);
  };

  /** selector null/'' => key goes to whatever has focus (page.keyboard). */
  keydown = async (selector, key, causesNavigation = false, options = {}) => {
    const meta = this._takeMeta();
    key = String(this.clean(key) ?? '');
    if (!selector) {
      await this.page.keyboard.press(key);
    } else {
      if (!(await this._do('Premi tasto', this.clean(selector), (l) => l.press(key, options), meta))) return;
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
    throw lastError;
  };

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

module.exports = { PlaywrightBuilder, DEFAULT_PRIORITY };
