import { spawn } from 'child_process';
import { dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { makeScratchDir } from './runnerCore';
import { m } from './messages';

/*
 * Insightest recorder: NOT Playwright's codegen. A plain headed Chromium is launched and a recorder script is
 * injected in every page (context.addInitScript); it listens to the user's real DOM events, computes ALL the
 * selectors of the target element on the spot (live DOM, no replay needed), and reports them through an exposed
 * binding as Insightest actions (the ActionType vocabulary of the Insighter NPM package). The main process then
 * folds the raw event stream into the final action list and translates it into PlaywrightBuilder steps.
 *
 * The page script and the child-process driver are real functions serialized with Function#toString(), so they
 * must stay self-contained: no references to anything outside their own body.
 */

/** Insightest ActionType values (Insighter NPM `ActionType`). */
export type InsightestActionType =
  | 'awaitText'
  | 'click'
  | 'use'
  | 'back'
  | 'forward'
  | 'refresh'
  | 'doubleClick'
  | 'customAction'
  | 'dragAndDrop'
  | 'fullScreenshot'
  | 'hover'
  | 'rightClick'
  | 'clear'
  | 'input'
  | 'awaitNetworkStatus'
  | 'keydown'
  | 'load'
  | 'resize'
  | 'wheel'
  | 'wait'
  | 'select2'
  | 'alert'
  | 'prompt'
  | 'confirm'
  | 'upload';

/** Every selector computed for an element at record time (same set as Insighter's genSelectors). */
export interface RecordedSelectors {
  id?: string | null;
  generalSelector?: string | null;
  attrSelector?: string | null;
  testIdSelector?: string | null;
  text?: string | null;
  xpath?: string | null;
  href?: string | null;
  hrefSelector?: string | null;
  accessibilitySelector?: string | null;
  formSelector?: string | null;
  /** Extra Playwright selectors (id-anchored xpath, text xpath...) tried as fallbacks. */
  alternatives?: string[];
}

/** One recorded action, in the Insighter `Action` shape (plus the record-time hints the builder keeps). */
export interface InsightestAction {
  type: InsightestActionType;
  timestamp: number;
  selectors: RecordedSelectors;
  tagName?: string;
  inputType?: string;
  isPassword?: boolean;
  hasOnlyText?: boolean;
  /** input on a [contenteditable] element (value = its whole text). */
  contentEditable?: boolean;
  textHint?: string;
  value?: string;
  causesNavigation?: boolean;
  url?: string;
  key?: string;
  width?: number;
  height?: number;
  deltaX?: number;
  deltaY?: number;
  pageXOffset?: number;
  pageYOffset?: number;
  sourceX?: number;
  sourceY?: number;
  targetX?: number;
  targetY?: number;
  millis?: number;
  code?: string;
  status?: number;
  /** select2: the `value` attribute of the chosen <option> (`value` holds its visible text). */
  optionValue?: string;
  /** Internal: identity of the DOM element within its document, used to merge consecutive events. */
  elKey?: string;
}

export interface RecordedBuilderStep {
  action: string;
  selectors: Partial<Record<'xpath' | 'generalSelector' | 'attrSelector' | 'testIdSelector' | 'id' | 'text', string>>;
  /** Further recorded selectors (form/accessibility/href/anchored xpath...), engine fallbacks after `selectors`. */
  secondarySelectors?: string[];
  value: string;
  value2?: string;
  valueIsNumber: boolean;
  causesNavigation: boolean;
  textHint?: string;
  tagHint?: string;
  optionValue?: string;
}

/* =================================================================================================== page script */

interface PageRecorderConfig {
  labels: Record<string, string>;
}

/** Runs inside every page of the recording browser (serialized: must stay self-contained). */
function insightestPageRecorder(cfg: PageRecorderConfig): void {
  const w = window as any;
  if (w.top !== w || w.__insightestRecorder) return;
  w.__insightestRecorder = true;
  const L = (k: string): string => cfg.labels[k] || k;

  /* ---------------------------------------------------------------- transport (exposed binding) */
  const queue: any[] = [];
  let flushTimer: any = null;
  function flush(): Promise<any> {
    const fn = w.__insightestEmit;
    if (typeof fn !== 'function') {
      if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 50);
      return Promise.resolve(null);
    }
    let last: any = null;
    while (queue.length) last = fn(queue.shift());
    return Promise.resolve(last).catch(() => null);
  }
  function send(evt: any): Promise<any> {
    evt.ts = evt.ts || Date.now();
    queue.push(evt);
    return flush();
  }

  let paused = true;
  let started = false;
  let trackHoverScroll = false;
  let host: HTMLElement | null = null;
  const fromToolbar = (e: Event): boolean => !!host && e.composedPath().includes(host);

  const docId = Math.random().toString(36).slice(2, 8);
  const keys = new WeakMap<Element, string>();
  let keySeq = 0;
  const elKey = (el: Element): string => {
    let k = keys.get(el);
    if (!k) {
      k = `${docId}:${++keySeq}`;
      keys.set(el, k);
    }
    return k;
  };

  /* ---------------------------------------------------------------- selectors */
  const DYNAMIC = /(select2|mat-|ng-|cdk-|ui-id|react|:r\d)|\d{3,}|^\d|[0-9a-f]{8}-[0-9a-f]{4}/i;
  const stableId = (id: string | null | undefined): boolean => !!id && id.length < 64 && !DYNAMIC.test(id);
  const BAD_CLASS = /^(ng-|select2|is-|has-|js-|ui-state|ui-corner|css-|sc-|jsx-|emotion-|svelte-)|^(active|focus|focused|hover|open|opened|show|shown|selected|disabled|checked|in|collapsed)$/i;
  const hashy = (c: string): boolean => /\d{3,}/.test(c) || (/\d/.test(c) && /[a-z0-9]{5,}$/i.test(c.split(/[-_]/).pop() || ''));
  const stableClasses = (el: Element): string[] =>
    Array.from(el.classList).filter((c) => /^[a-zA-Z_][\w-]*$/.test(c) && !BAD_CLASS.test(c) && !hashy(c)).slice(0, 3);
  const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-testing', 'data-test', 'data-qa', 'data-cy'];
  const ATTR_ORDER = ['name', 'placeholder', 'aria-label', 'for', 'title', 'alt', 'role', 'type', 'href', 'value', 'src', 'formcontrolname'];
  const BAD_ATTR = /^(class|style|id|tabindex|aria-(describedby|labelledby|owns|controls|activedescendant|expanded|selected|checked|hidden)|data-(select2-id|reactid|reactroot|v-.*)|_ng.*|ng-.*|on\w+|x-.*|autocomplete|maxlength|size|width|height|data-testid|data-test-id|data-testing|data-test|data-qa|data-cy)$/i;
  const cssStr = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');
  const clean = (s: string | null | undefined, max = 80): string => (s || '').replace(/\s+/g, ' ').trim().slice(0, max);

  function isVisible(el: Element): boolean {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  /** Exactly one (visible, when the element itself is visible) match, and it is `el`. */
  function unique(sel: string, el: Element): boolean {
    let all: NodeListOf<Element>;
    try {
      all = document.querySelectorAll(sel);
    } catch {
      return false;
    }
    if (all.length === 1) return all[0] === el;
    if (!all.length || !isVisible(el)) return false;
    let found: Element | null = null;
    for (const n of Array.from(all)) {
      if (n !== el && !isVisible(n)) continue;
      if (found) return false;
      found = n;
    }
    return found === el;
  }
  function nth(el: Element): string {
    const p = el.parentElement;
    if (!p) return '';
    const same = Array.from(p.children).filter((c) => c.tagName === el.tagName);
    return same.length > 1 ? `:nth-of-type(${same.indexOf(el) + 1})` : '';
  }
  function seg(el: Element, strict: boolean): string {
    if (el === document.body) return 'body';
    if (stableId(el.id)) return `#${CSS.escape(el.id)}`;
    const base = el.tagName.toLowerCase() + stableClasses(el).map((c) => `.${CSS.escape(c)}`).join('');
    return strict ? base + nth(el) : base;
  }
  function ancestors(el: Element, max: number): Element[] {
    const out: Element[] = [];
    let cur = el.parentElement;
    while (cur && cur !== document.documentElement && out.length < max) {
      out.push(cur);
      if (cur === document.body) break;
      cur = cur.parentElement;
    }
    return out;
  }
  /** `base` as is if unique, else prefixed by more and more of its ancestors (`a > b > base`). */
  function withContext(base: string, el: Element, max = 6): string | null {
    if (unique(base, el)) return base;
    const anc = ancestors(el, max);
    const parts: string[] = [];
    for (const a of anc) {
      parts.unshift(seg(a, true));
      const s = `${parts.join(' > ')} > ${base}`;
      if (unique(s, el)) return s;
    }
    return null;
  }
  /** Shortest unique CSS path built from ids / stable classes / nth-of-type (finder-like). */
  function generalSelector(el: Element): string | null {
    const chain = [el, ...ancestors(el, 12)];
    const parts: string[] = [];
    for (const e of chain) {
      for (const s of [seg(e, false), seg(e, true)]) {
        const cand = [s, ...parts].join(' > ');
        if (unique(cand, el)) return cand;
      }
      parts.unshift(seg(e, true));
    }
    const full = parts.join(' > ');
    return unique(full, el) ? full : null;
  }
  function attrPairs(el: Element, only?: string[]): [string, string][] {
    const names = only || [...ATTR_ORDER, ...Array.from(el.attributes).map((a) => a.name).filter((n) => /^data-/.test(n))];
    const out: [string, string][] = [];
    for (const n of names) {
      if (!only && BAD_ATTR.test(n)) continue;
      const v = el.getAttribute(n);
      if (v === null || v === '' || v.length > 120) continue;
      if (n === 'value' && /^(text|email|password|search|tel|url|number)$/i.test((el as HTMLInputElement).type || '') && el.tagName === 'INPUT') continue; // typed text, not identity
      if (!out.some(([k]) => k === n)) out.push([n, v]);
    }
    return out;
  }
  function attrSelectorFor(el: Element, only?: string[]): string | null {
    const tag = el.tagName.toLowerCase();
    const pairs = attrPairs(el, only);
    if (!pairs.length) return null;
    const one = (p: [string, string]): string => `[${p[0]}="${cssStr(p[1])}"]`;
    for (const p of pairs) {
      if (unique(one(p), el)) return one(p);
      if (unique(tag + one(p), el)) return tag + one(p);
    }
    for (let i = 0; i < pairs.length; i++)
      for (let j = i + 1; j < pairs.length; j++) {
        const s = tag + one(pairs[i]) + one(pairs[j]);
        if (unique(s, el)) return s;
      }
    return withContext(tag + one(pairs[0]), el);
  }
  function xpathOf(node: Element): string {
    if (node === document.body) return '/html/body';
    if (node === document.documentElement) return '/html';
    const p = node.parentElement;
    if (!p) return '';
    const same = Array.from(p.children).filter((s) => s.tagName === node.tagName);
    const isSvg = node.namespaceURI === 'http://www.w3.org/2000/svg';
    const tag = isSvg ? `*[local-name()="${node.tagName}"]` : node.tagName.toLowerCase();
    return `${xpathOf(p)}/${tag}${same.length > 1 ? `[${same.indexOf(node) + 1}]` : ''}`;
  }
  /** Relative xpath anchored on the nearest ancestor with a stable id: `//*[@id="form"]/div[2]/button`. */
  function anchoredXpath(el: Element): string | null {
    const steps: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body && steps.length < 12) {
      if (cur !== el && stableId(cur.id)) return `//*[@id="${cur.id}"]/${steps.join('/')}`;
      const p: Element | null = cur.parentElement;
      if (!p) return null;
      const node: Element = cur;
      const same = Array.from(p.children).filter((s) => s.tagName === node.tagName);
      const tag = node.namespaceURI === 'http://www.w3.org/2000/svg' ? `*[local-name()="${node.tagName}"]` : node.tagName.toLowerCase();
      steps.unshift(`${tag}${same.length > 1 ? `[${same.indexOf(node) + 1}]` : ''}`);
      cur = p;
    }
    return null;
  }
  function labelText(el: Element): string {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) return clean(labels[0].innerText);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      if (clean(t)) return clean(t);
    }
    return clean(el.getAttribute('aria-label'));
  }
  function textOf(el: Element): string {
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const type = ((el as HTMLInputElement).type || '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') return clean((el as HTMLInputElement).value);
      return labelText(el);
    }
    if (tag === 'TEXTAREA' || tag === 'SELECT') return labelText(el);
    const first = ((el as HTMLElement).innerText || el.textContent || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
    return clean(first);
  }

  function selectorsOf(el: Element): any {
    const tag = el.tagName.toLowerCase();
    let id: string | null = null;
    if (stableId(el.id)) id = withContext(`#${CSS.escape(el.id)}`, el) || withContext(`${tag}#${CSS.escape(el.id)}`, el);
    const testAttr = TEST_ATTRS.find((a) => el.getAttribute(a));
    const testIdSelector = testAttr ? attrSelectorFor(el, [testAttr]) : null;
    const text = textOf(el);
    const href = el.getAttribute('href');
    const xp = xpathOf(el);
    const alternatives: string[] = [];
    const anchored = anchoredXpath(el);
    if (anchored) alternatives.push(`xpath=${anchored}`);
    if (text && text.length <= 50 && !/["]/.test(text) && el.children.length === 0 && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      alternatives.push(`xpath=//${tag}[normalize-space()="${text}"]`);
    }
    return {
      id,
      generalSelector: generalSelector(el),
      attrSelector: attrSelectorFor(el),
      testIdSelector,
      text: text || null,
      xpath: xp || null,
      href,
      hrefSelector: href ? attrSelectorFor(el, ['href']) : null,
      accessibilitySelector: attrSelectorFor(el, ['aria-label', 'alt', 'title'].filter((a) => el.getAttribute(a))),
      formSelector: attrSelectorFor(el, ['name', 'placeholder', 'for'].filter((a) => el.getAttribute(a))),
      alternatives,
    };
  }

  function describe(el: Element): any {
    const isInput = el.tagName === 'INPUT';
    const inputType = isInput ? ((el as HTMLInputElement).type || 'text').toLowerCase() : undefined;
    const r = el.getBoundingClientRect();
    return {
      elKey: elKey(el),
      tagName: el.tagName,
      inputType,
      isPassword: inputType === 'password',
      hasOnlyText: el.children.length === 0 && !!clean(el.textContent),
      textHint: textOf(el),
      selectors: selectorsOf(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    };
  }

  /* ---------------------------------------------------------------- "Auto" (non-AI auto-fill + record) */
  // Same heuristics as the project's standalone DOM-crawling agent, trimmed to "what's on screen right now"
  // instead of a multi-page crawl: this scans the CURRENT page, fills every field it can with deterministic
  // non-ML values, clicks the safe action(s), and opens tabs/accordions to fill whatever they reveal too --
  // every one of those steps goes through the exact same `action()` used for a human's own clicks/typing, so
  // it becomes a normal, continuous part of THIS recording (no separate flow, no separate browser).
  const FILLABLE_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"]';
  const ACTION_SELECTOR = 'button, input[type="submit"], input[type="button"], [role="button"], a';
  const isFillable = (el: Element): boolean => {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    if ((el as HTMLElement).isContentEditable) return true;
    if (el.tagName === 'INPUT') return !/^(submit|button|reset|image|hidden)$/i.test((el as HTMLInputElement).type || 'text');
    const role = el.getAttribute('role');
    return !!role && /^(textbox|combobox|checkbox|radio|switch|spinbutton)$/.test(role);
  };
  const ACTION_WORDS = /\b(save|submit|send|confirm|add|create|update|apply|login|log in|sign in|signin|search|go|continue|next|ok|invia|salva|conferma|aggiungi|crea|accedi|cerca|continua)\b/i;
  const isActionLike = (el: Element): boolean => {
    if (!isVisible(el)) return false;
    const tag = el.tagName;
    if (tag === 'BUTTON' || (tag === 'INPUT' && /^(submit|button)$/i.test((el as HTMLInputElement).type || ''))) return true;
    const role = el.getAttribute('role');
    if (role === 'button') return true;
    if ((el as any).onclick) return true;
    if (tag === 'A' && ACTION_WORDS.test(textOf(el))) return true;
    return false;
  };
  const AUTO_DESTRUCTIVE = /\b(delete|remove|destroy|unsubscribe|deactivate|archive|cancel|elimina|cancella|rimuovi|disiscrivi|disattiva)\b/i;

  /** Nearest ancestor action button for one field (same idea as the crawling agent's clustering, trimmed:
   * this only needs to decide what to click after filling, not build named flow groups). */
  function nearestAction(el: Element): Element | null {
    let cur = el.parentElement;
    let hops = 0;
    while (cur && cur !== document.body && hops < 14) {
      const candidate = Array.from(cur.querySelectorAll(ACTION_SELECTOR)).find((a) => isActionLike(a));
      if (candidate) return candidate;
      cur = cur.parentElement;
      hops++;
    }
    return null;
  }

  const AUTO_EMAIL_RAND = (): string => Math.random().toString(36).slice(2, 8);
  /** Deterministic, rule-based value inference -- no ML/LLM, no network. File inputs always return null:
   * a path isn't a "value" in this sense, and only the main process (via requestFile/electron.dialog) can
   * supply a real, usable one. */
  function inferValue(el: Element): string | null {
    const tag = el.tagName;
    const input = el as HTMLInputElement;
    const type = tag === 'INPUT' ? (input.type || 'text').toLowerCase() : tag === 'TEXTAREA' ? 'text' : '';
    const signal = `${el.getAttribute('name') || ''} ${el.getAttribute('autocomplete') || ''} ${labelText(el)} ${el.getAttribute('placeholder') || ''}`.toLowerCase();
    if (type === 'hidden' || type === 'file') return null;
    if (type === 'checkbox' || type === 'radio') return 'true';
    if (type === 'email' || /e-?mail/.test(signal)) return `insightest.test+${AUTO_EMAIL_RAND()}@example.com`;
    if (type === 'tel' || /phone|tel/.test(signal)) return '+1 555 0100';
    if (type === 'url') return 'https://example.com/';
    if (type === 'number' || /age|quantity|amount|count/.test(signal)) {
      const min = input.min !== '' ? Number(input.min) : undefined;
      const max = input.max !== '' ? Number(input.max) : undefined;
      if (min !== undefined && max !== undefined) return String(Math.round((min + max) / 2));
      if (min !== undefined) return String(min + 1);
      if (max !== undefined) return String(Math.max(0, max - 1));
      return '1';
    }
    if (['date', 'datetime-local', 'month', 'week'].includes(type)) return new Date().toISOString().slice(0, 10);
    if (type === 'password') return 'Insightest!2024x';
    if (/first.?name/.test(signal)) return 'Jordan';
    if (/last.?name/.test(signal)) return 'Avery';
    if (/\bname\b/.test(signal)) return 'Jordan Avery';
    if (/address|street/.test(signal)) return '123 Example St';
    if (/city/.test(signal)) return 'Springfield';
    if (/zip|postal/.test(signal)) return '94105';
    if (tag === 'SELECT') {
      const sel = el as HTMLSelectElement;
      const opt = Array.from(sel.options).find((o) => o.value && !/^(select|choose|--)/i.test(o.text));
      return (opt || sel.options[0])?.value ?? null;
    }
    if (/state|province/.test(signal)) return 'CA';
    if (/country/.test(signal)) return 'US';
    const maxLen = input.maxLength > 0 ? input.maxLength : undefined;
    const fallback = 'Test value';
    return maxLen ? fallback.slice(0, maxLen) : fallback;
  }

  /** Sets a form field's value the way a real user effectively would (the native property setter, so
   * React/Vue/Angular's own change tracking sees it) and dispatches input/change for the SITE's own
   * listeners -- the recorder's own listeners only react to isTrusted events, so this never double-records;
   * the caller always calls `action()` itself right after. */
  function setFieldValue(el: Element, value: string): void {
    if ((el as HTMLElement).isContentEditable) {
      (el as HTMLElement).innerText = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const tag = el.tagName;
    const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : tag === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else (el as HTMLInputElement).value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function setChecked(el: Element, checked: boolean): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
    if (setter) setter.call(el, checked);
    else (el as HTMLInputElement).checked = checked;
    el.dispatchEvent(new Event('click', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Asks the main process (via electron.dialog -- the only place that can return a real, usable path) for a
   * file to upload. The driver itself sets it on the page and records the step once a file was actually
   * chosen -- see insightestRecorderDriver's `needsFile` case -- so there is nothing further to record here. */
  function requestFile(desc: any): Promise<boolean> {
    return send({ ...desc, kind: 'needsFile' }).then((r: any) => !!(r && r.filled));
  }

  async function autoFillField(el: Element): Promise<void> {
    if (!isVisible(el) || !isFillable(el)) return;
    const desc = describe(el);
    if (desc.inputType === 'hidden') return;
    if (desc.inputType === 'file') {
      await requestFile(desc);
      return;
    }
    if (desc.inputType === 'checkbox' || desc.inputType === 'radio') {
      setChecked(el, true);
      action('click', desc, `${L('Click')} ${nameOf(desc)}`);
      return;
    }
    const value = inferValue(el);
    if (value === null) return;
    setFieldValue(el, value);
    action('input', { ...desc, value }, `${L('Fill')} ${nameOf(desc)}`);
  }

  async function autoClick(el: Element): Promise<void> {
    const desc = describe(el);
    if (AUTO_DESTRUCTIVE.test(desc.textHint || '')) return;
    action('click', desc, `${L('Click')} ${nameOf(desc)}`);
    (el as HTMLElement).click();
  }

  /** One pass over whatever is in `scope` right now: fields grouped by their nearest action button get
   * filled then that button is clicked; fields with no nearby action, and action buttons no field claimed
   * (e.g. a lone "Load more"), are still filled/clicked on their own. */
  async function autoFillScope(scope: ParentNode): Promise<void> {
    const fillable = Array.from(scope.querySelectorAll(FILLABLE_SELECTOR)).filter((el) => isFillable(el) && isVisible(el));
    const byAction = new Map<Element, Element[]>();
    const standaloneFields: Element[] = [];
    for (const el of fillable) {
      const owner = nearestAction(el);
      if (!owner) {
        standaloneFields.push(el);
        continue;
      }
      const list = byAction.get(owner);
      if (list) list.push(el);
      else byAction.set(owner, [el]);
    }
    for (const [actionEl, fields] of byAction) {
      for (const f of fields) await autoFillField(f);
      await autoClick(actionEl);
    }
    for (const f of standaloneFields) await autoFillField(f);
    const usedActions = new Set(byAction.keys());
    const standaloneActions = Array.from(scope.querySelectorAll(ACTION_SELECTOR)).filter((a) => isActionLike(a) && !usedActions.has(a));
    for (const a of standaloneActions) await autoClick(a);
  }

  /** Tabs (ARIA or common non-ARIA widgets) and closed accordion/collapsible triggers are opened one at a
   * time -- each becomes a recorded click -- then whatever they reveal is filled the same way as the page
   * itself. Already-open accordions need no click: their fields are already reachable by the scan above. */
  async function autoExplore(): Promise<void> {
    const ariaTabs = Array.from(document.querySelectorAll('[role="tab"], [aria-selected]'));
    const classTabs = Array.from(
      document.querySelectorAll('.nav-tabs [data-toggle="tab"], .nav-tabs [data-bs-toggle="tab"], [class*="tab-trigger"], [class*="tab-button"]')
    ).filter((el) => !ariaTabs.includes(el));
    for (const tab of [...ariaTabs, ...classTabs].filter((t) => isVisible(t))) {
      await autoClick(tab);
      await new Promise((r) => setTimeout(r, 400));
      await autoFillScope(document);
    }
    const accordions = Array.from(
      document.querySelectorAll('[aria-expanded="false"], [data-toggle="collapse"], [data-bs-toggle="collapse"]')
    ).filter((el) => isVisible(el));
    for (const acc of accordions) {
      await autoClick(acc);
      await new Promise((r) => setTimeout(r, 400));
      await autoFillScope(document);
    }
  }

  let autoRunning = false;
  /** The "Auto" toolbar button. */
  async function runAuto(): Promise<void> {
    if (paused || autoRunning) return;
    autoRunning = true;
    renderStatus(L('Auto-filling…'));
    try {
      await autoFillScope(document);
      await autoExplore();
    } finally {
      autoRunning = false;
      renderStatus();
    }
  }

  const INTERACTIVE =
    'button, a[href], input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [onclick], [contenteditable=""], [contenteditable="true"]';
  function clickTarget(t: Element): Element {
    const hit = t.closest(INTERACTIVE);
    if (hit && hit !== document.body) return hit;
    const svg = t.closest('svg');
    return svg && svg.parentElement ? svg : t;
  }
  function hoverTarget(t: Element): Element {
    return t.closest('a, button, [role="menuitem"], [aria-haspopup], [data-toggle], [data-bs-toggle], li') || t;
  }
  const isTextField = (el: Element | null): boolean => {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if ((el as HTMLElement).isContentEditable) return true;
    if (el.tagName !== 'INPUT') return false;
    return !/^(checkbox|radio|file|submit|button|reset|image|range|color)$/i.test((el as HTMLInputElement).type || '');
  };
  const eventTarget = (e: Event): Element | null => {
    const t = (e.composedPath()[0] || e.target) as any;
    return t && t.nodeType === 1 ? (t as Element) : t && t.parentElement ? t.parentElement : null;
  };

  let lastLabel = '';
  function action(type: string, data: any, label: string): void {
    if (paused) return;
    send({ kind: 'action', type, ...data });
    lastLabel = label;
    renderStatus();
  }
  const short = (s: string): string => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
  const nameOf = (d: any): string => short(d.textHint || d.selectors?.id || d.selectors?.attrSelector || d.selectors?.generalSelector || d.tagName?.toLowerCase() || '');

  /* ---------------------------------------------------------------- select2 */
  let s2: null | { container: Element; select: HTMLSelectElement | null; before: string[]; desc: any; liText: string; timer: any; opened: number } = null;
  const inSelect2 = (el: Element | null): boolean => !!el && !!el.closest('.select2-container, .select2-dropdown');
  function selectFor(container: Element): HTMLSelectElement | null {
    const prev = container.previousElementSibling;
    if (prev && prev.tagName === 'SELECT') return prev as HTMLSelectElement;
    const jq = w.jQuery || w.$;
    for (const s of Array.from(document.querySelectorAll('select.select2-hidden-accessible'))) {
      try {
        if (s.nextElementSibling === container) return s as HTMLSelectElement;
        const inst = jq && jq(s).data('select2');
        if (inst && inst.$container && inst.$container[0] === container) return s as HTMLSelectElement;
      } catch {
        /* not a jQuery select2 */
      }
    }
    return null;
  }
  const selectedValues = (s: HTMLSelectElement | null): string[] => (s ? Array.from(s.selectedOptions).map((o) => o.value) : []);
  function select2Describe(trigger: Element, select: HTMLSelectElement | null): any {
    const d = describe(trigger);
    const sel = d.selectors;
    sel.text = null; // the rendered text is the CURRENT choice: it changes with every selection
    d.hasOnlyText = false;
    if (select) {
      // The select2's own identity lives on its <select> (data-test, id, name): those selectors target the <select>
      // itself, and pw.select2 opens the select2 widget that belongs to it.
      const own = (s: string): string | null => (unique(s, select) ? s : null);
      if (stableId(select.id)) sel.id = own(`#${CSS.escape(select.id)}`) || sel.id;
      const name = select.getAttribute('name');
      if (name) sel.attrSelector = own(`select[name="${cssStr(name)}"]`) || sel.attrSelector;
      const testAttr = TEST_ATTRS.find((a) => select.getAttribute(a));
      if (testAttr) sel.testIdSelector = own(`[${testAttr}="${cssStr(select.getAttribute(testAttr) || '')}"]`) || sel.testIdSelector;
      if (name) sel.formSelector = sel.attrSelector;
      d.textHint = labelText(select) || d.textHint;
    }
    return d;
  }
  function startSelect2(container: Element): void {
    if (s2 && s2.container === container) return;
    finishSelect2();
    const trigger = container.querySelector('.select2-selection') || container;
    const select = selectFor(container);
    s2 = { container, select, before: selectedValues(select), desc: select2Describe(trigger, select), liText: '', timer: null, opened: Date.now() };
    const cur = s2;
    cur.timer = setInterval(() => {
      if (s2 !== cur) return clearInterval(cur.timer);
      const open = document.querySelector('.select2-container--open .select2-dropdown, .select2-dropdown.select2-dropdown--below:not(:empty), .select2-dropdown.select2-dropdown--above:not(:empty)');
      if (!open && Date.now() - cur.opened > 250) finishSelect2();
    }, 150);
  }
  function finishSelect2(): void {
    const cur = s2;
    if (!cur) return;
    s2 = null;
    clearInterval(cur.timer);
    const after = selectedValues(cur.select);
    const added = after.filter((v) => !cur.before.includes(v));
    if (cur.select) {
      for (const v of added) {
        const opt = Array.from(cur.select.options).find((o) => o.value === v);
        const text = (added.length === 1 && cur.liText) || clean(opt ? opt.text : v, 200);
        action('select2', { ...cur.desc, value: text, optionValue: v }, `Select2 "${short(text)}"`);
      }
    } else if (cur.liText) {
      action('select2', { ...cur.desc, value: cur.liText }, `Select2 "${short(cur.liText)}"`);
    }
  }

  /* ---------------------------------------------------------------- pick mode (wait for text) */
  let picking = false;
  let pickBox: HTMLElement | null = null;
  function setPicking(on: boolean): void {
    picking = on;
    if (pickBox) pickBox.style.display = on ? 'block' : 'none';
    renderStatus(on ? L('Click the element whose text to wait for (Esc to cancel)') : undefined);
  }

  /* ---------------------------------------------------------------- DOM listeners (capture phase) */
  const opts = { capture: true, passive: true } as const;
  const active = (e: Event): boolean => e.isTrusted && !paused && !fromToolbar(e);

  // drag & drop (mouse based and HTML5)
  let down: null | { x: number; y: number; el: Element } = null;
  let html5: null | { x: number; y: number; el: Element } = null;
  // The click the browser fires right after a mouseup we already turned into an action (drag end, select2 pick):
  // dispatched in the same task, so a flag cleared on the next tick swallows exactly that one.
  let swallowClick = false;
  const swallowNextClick = (): void => { swallowClick = true; setTimeout(() => { swallowClick = false; }, 0); };
  let lastKeydownTs = 0;
  let lastLabelControl: { el: Element | null; ts: number } = { el: null, ts: 0 };
  let pointerEl: Element | null = null;

  window.addEventListener('mousedown', (e) => {
    if (!active(e) || picking) return;
    const t = eventTarget(e);
    if (!t) return;
    const container = t.closest('.select2-container');
    if (container && !container.querySelector('.select2-dropdown') && !t.closest('.select2-selection__clear, .select2-selection__choice__remove')) {
      startSelect2(container);
      return;
    }
    if (s2 && !inSelect2(t)) finishSelect2();
    down = e.button === 0 ? { x: e.clientX, y: e.clientY, el: t } : null;
  }, opts);

  window.addEventListener('mouseup', (e) => {
    if (!active(e)) return;
    const t = eventTarget(e);
    if (s2 && t) {
      const li = t.closest('.select2-results__option');
      if (li && !li.classList.contains('select2-results__message') && !li.classList.contains('loading-results')) s2.liText = clean((li as HTMLElement).innerText, 200);
      // select2 closes (and detaches) the dropdown on mouseup: the click that follows lands on whatever is left.
      if (inSelect2(t)) swallowNextClick();
    }
    const d = down;
    down = null;
    if (!d || html5 || picking) return;
    const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    const selection = String(window.getSelection() || '');
    if (dist < 10 || selection || isTextField(d.el) || d.el === document.body || d.el === document.documentElement || inSelect2(d.el)) return;
    if (!d.el.isConnected) return;
    const desc = describe(clickTarget(d.el));
    swallowNextClick();
    action('dragAndDrop', { ...desc, sourceX: Math.round(d.x), sourceY: Math.round(d.y), targetX: Math.round(e.clientX), targetY: Math.round(e.clientY) }, `${L('Drag and drop')} ${nameOf(desc)}`);
  }, opts);

  window.addEventListener('dragstart', (e) => {
    if (!active(e)) return;
    const t = eventTarget(e);
    if (t) html5 = { x: e.clientX, y: e.clientY, el: t };
  }, opts);
  window.addEventListener('drop', (e) => {
    if (!active(e) || !html5) return;
    const src = html5;
    html5 = null;
    const desc = src.el.isConnected ? describe(clickTarget(src.el)) : { selectors: {} };
    action('dragAndDrop', { ...desc, sourceX: Math.round(src.x), sourceY: Math.round(src.y), targetX: Math.round(e.clientX), targetY: Math.round(e.clientY) }, `${L('Drag and drop')} ${nameOf(desc)}`);
  }, opts);
  window.addEventListener('dragend', () => { html5 = null; }, opts);

  // click / pick mode (not passive: pick mode swallows the click)
  window.addEventListener('click', (e) => {
    if (!e.isTrusted || fromToolbar(e)) return;
    const t = eventTarget(e);
    if (!t) return;
    if (picking) {
      e.preventDefault();
      e.stopPropagation();
      const target = t;
      const text = clean((target as HTMLElement).innerText || target.textContent, 200);
      setPicking(false);
      if (text) action('awaitText', { ...describe(target), value: text }, `${L('Wait for text')} "${short(text)}"`);
      return;
    }
    if (paused) return;
    if (swallowClick) return;
    // detail 0 = not a mouse click: Enter/Space activating a button, implicit form submit. The key itself is recorded.
    if (e.detail === 0 && Date.now() - lastKeydownTs < 500) return;
    if (inSelect2(t)) return; // folded into the select2 action
    const el = clickTarget(t);
    if (el === document.body || el === document.documentElement) return;
    if (el.tagName === 'SELECT' || el.tagName === 'OPTION') return; // recorded on change
    // A click on a <label> makes the browser click its control too: keep only the label click.
    if (el === lastLabelControl.el && Date.now() - lastLabelControl.ts < 200) return;
    if (el.tagName === 'LABEL') lastLabelControl = { el: (el as HTMLLabelElement).control, ts: Date.now() };
    recordCssHovers(el);
    lastHoverKey = '';
    const desc = describe(el);
    action('click', desc, `${L('Click')} ${nameOf(desc)}`);
  }, { capture: true });

  const isRoot = (el: Element): boolean => el === document.body || el === document.documentElement;

  window.addEventListener('dblclick', (e) => {
    if (!active(e) || picking) return;
    const t = eventTarget(e);
    if (!t || inSelect2(t)) return;
    const el = clickTarget(t);
    if (isRoot(el)) return;
    recordCssHovers(el);
    const desc = describe(el);
    action('doubleClick', desc, `${L('Double click')} ${nameOf(desc)}`);
  }, opts);

  window.addEventListener('contextmenu', (e) => {
    if (!active(e) || picking) return;
    const t = eventTarget(e);
    if (!t || inSelect2(t)) return;
    const el = clickTarget(t);
    if (isRoot(el)) return;
    recordCssHovers(el);
    const desc = describe(el);
    action('rightClick', desc, `${L('Right click')} ${nameOf(desc)}`);
  }, opts);

  // typing: every input event is sent, the main process merges consecutive ones on the same field
  window.addEventListener('input', (e) => {
    if (!active(e)) return;
    const t = eventTarget(e);
    if (!t || inSelect2(t)) return;
    const el = (t as HTMLElement).isContentEditable ? (t.closest('[contenteditable]:not([contenteditable="false"])') as Element) || t : t;
    if (!isTextField(el) && !(el.tagName === 'INPUT' && /^(range|color)$/i.test((el as HTMLInputElement).type))) return;
    const editable = (el as HTMLElement).isContentEditable;
    const value = editable ? (el as HTMLElement).innerText : (el as HTMLInputElement).value;
    const desc = describe(el);
    action('input', { ...desc, value, contentEditable: editable || undefined }, `${L('Fill')} ${nameOf(desc)}`);
  }, opts);

  window.addEventListener('change', (e) => {
    if (!active(e)) return;
    const t = eventTarget(e);
    if (!t || t.tagName !== 'SELECT' || t.classList.contains('select2-hidden-accessible')) return;
    const desc = describe(t);
    const value = (t as HTMLSelectElement).value;
    action('input', { ...desc, value }, `${L('Choose')} "${short(value)}"`);
  }, opts);

  const SPECIAL_KEYS = /^(Enter|Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End|Delete|Backspace|Insert|F\d{1,2}| )$/;
  const EDITING_KEYS = /^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|Delete|Backspace| )$/;
  const BROWSER_SHORTCUTS = /^(F5|F11|F12|Control\+(r|l|t|w|n|f|p|s|Tab|Shift\+(r|t|i|j|Tab))|Alt\+(ArrowLeft|ArrowRight|Home)|Meta\+.*)$/i;
  window.addEventListener('keydown', (e) => {
    if (!e.isTrusted || fromToolbar(e)) return;
    lastKeydownTs = Date.now();
    if (picking && e.key === 'Escape') return setPicking(false);
    if (e.ctrlKey && e.shiftKey && (e.key === 'H' || e.key === 'h')) {
      // manual hover on whatever is under the pointer
      if (!paused && pointerEl && pointerEl.isConnected) {
        const desc = describe(hoverTarget(pointerEl));
        action('hover', desc, `${L('Hover')} ${nameOf(desc)}`);
      }
      return;
    }
    if (paused || picking || e.repeat || /^(Control|Shift|Alt|Meta|AltGraph|CapsLock|Dead|Unidentified)$/.test(e.key)) return;
    const t = eventTarget(e);
    if (s2 || inSelect2(t)) return; // typing in / navigating the select2 dropdown
    const editing = isTextField(t);
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.metaKey && 'Meta'].filter(Boolean) as string[];
    if (e.ctrlKey && e.altKey && e.key.length === 1) return; // AltGr: just typing
    let key = e.key === ' ' ? 'Space' : e.key;
    if (mods.length) {
      if (editing && /^[acvxzy]$/i.test(e.key)) return; // clipboard/undo: the resulting value is recorded as input
      if (e.shiftKey) mods.push('Shift');
      key = `${mods.join('+')}+${key.length === 1 ? key.toLowerCase() : key}`;
    } else {
      if (!SPECIAL_KEYS.test(e.key)) return; // plain characters end up in the input action
      if (editing && (EDITING_KEYS.test(e.key) || (e.key === 'Enter' && (t!.tagName === 'TEXTAREA' || (t as HTMLElement).isContentEditable)))) return;
      if (t && t.tagName === 'SELECT' && /^(Arrow\w+|Home|End|PageUp|PageDown| |Enter)$/.test(e.key)) return; // the resulting choice is recorded on change
      if (e.shiftKey) key = `Shift+${key}`;
    }
    if (BROWSER_SHORTCUTS.test(key)) return; // handled by the browser itself (reload/back/tabs...): not replayable keys
    if (key === 'Enter' && t && t.closest('.select2-container')) return;
    const focused = t && t !== document.body && t !== document.documentElement ? t : null;
    const desc = focused ? describe(focused) : { selectors: {} };
    action('keydown', { ...desc, key }, `${L('Press')} ${key}`);
  }, { capture: true });

  // scroll: only real page scrolls (inner containers are not replayable), one action per burst
  // With passive listeners the compositor has often scrolled already when `wheel` reaches us: the burst starts
  // from the last settled position, kept up to date by every scroll the wheel did not cause.
  let wheelBurst: null | { x: number; y: number; timer: any } = null;
  let settled = { x: window.scrollX, y: window.scrollY };
  let lastWheel = 0;
  window.addEventListener('scroll', () => {
    if (!wheelBurst && Date.now() - lastWheel > 300) settled = { x: window.scrollX, y: window.scrollY };
  }, { passive: true });
  window.addEventListener('wheel', (e) => {
    lastWheel = Date.now();
    if (!active(e) || picking) return;
    const t = eventTarget(e);
    if (inSelect2(t)) return;
    if (!wheelBurst) wheelBurst = { x: settled.x, y: settled.y, timer: null };
    clearTimeout(wheelBurst.timer);
    const burst = wheelBurst;
    burst.timer = setTimeout(() => {
      wheelBurst = null;
      settled = { x: window.scrollX, y: window.scrollY };
      if (!trackHoverScroll) return;
      const dx = Math.round(window.scrollX - burst.x);
      const dy = Math.round(window.scrollY - burst.y);
      if (!dx && !dy) return;
      action('wheel', { selectors: {}, deltaX: dx, deltaY: dy, pageXOffset: Math.round(window.scrollX), pageYOffset: Math.round(window.scrollY) }, `${L('Scroll')} ${dx}, ${dy}`);
    }, 450);
  }, opts);

  let resizeTimer: any = null;
  window.addEventListener('resize', () => {
    if (paused) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => action('resize', { selectors: {}, width: window.innerWidth, height: window.innerHeight }, `${L('Resize')} ${window.innerWidth}×${window.innerHeight}`), 600);
  });

  // hover: recorded when resting on an element makes something appear next to it (menus, submenus, toolbars)
  let hoverCand: null | { el: Element; ts: number; mutated: boolean; scope: Element | null; visible: number; timer: any } = null;
  let lastHoverKey = '';
  const visibleCount = (scope: Element | null): number => {
    if (!scope) return 0;
    const all = scope.querySelectorAll('*');
    if (all.length > 400) return -1;
    let n = 0;
    all.forEach((x) => { if (x.getClientRects().length) n++; });
    return n;
  };
  window.addEventListener('mouseover', (e) => {
    if (!e.isTrusted || fromToolbar(e)) return;
    const t = eventTarget(e);
    if (!t) return;
    pointerEl = t;
    if (paused || picking || inSelect2(t) || down || !trackHoverScroll) return;
    const el = hoverTarget(t);
    if (el === document.body || el === document.documentElement) return;
    if (hoverCand && hoverCand.el === el) return;
    if (hoverCand) clearTimeout(hoverCand.timer);
    const anc = ancestors(el, 2).filter((a) => a !== document.body);
    const scope = anc[anc.length - 1] || el;
    const cand = { el, ts: Date.now(), mutated: false, scope, visible: visibleCount(scope), timer: null as any };
    hoverCand = cand;
    cand.timer = setTimeout(() => {
      if (hoverCand !== cand || !el.isConnected || !el.matches(':hover')) return;
      const grew = cand.visible >= 0 && visibleCount(cand.scope) > cand.visible;
      if (!cand.mutated && !grew) return;
      const k = elKey(el);
      if (k === lastHoverKey) return;
      lastHoverKey = k;
      const desc = describe(el);
      action('hover', desc, `${L('Hover')} ${nameOf(desc)}`);
    }, 700);
  }, opts);
  // Pure-CSS hover (`.menu li:hover ul { display: block }`) changes nothing in the DOM: it is found at click
  // time instead, from the :hover rules that currently make an ancestor of the clicked element visible.
  let hoverRules: string[] = [];
  let hoverRulesKey = '';
  function cssHoverRules(): string[] {
    const key = `${document.styleSheets.length}`;
    if (key === hoverRulesKey) return hoverRules;
    const out: string[] = [];
    const walk = (rules: CSSRuleList): void => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSStyleRule) {
          if (!r.selectorText.includes(':hover')) continue;
          const s = r.style;
          if (s.display || s.visibility || s.opacity || s.maxHeight || s.height || s.transform || s.left || s.top || s.clip || s.pointerEvents) {
            out.push(...r.selectorText.split(',').map((x) => x.trim()).filter((x) => x.includes(':hover')));
          }
        } else if ((r as any).cssRules) {
          try { walk((r as any).cssRules); } catch { /* not readable */ }
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try { walk(sheet.cssRules); } catch { /* cross-origin stylesheet */ }
    }
    hoverRules = out;
    hoverRulesKey = key;
    return out;
  }
  const matches = (el: Element, sel: string): boolean => {
    try { return el.matches(sel); } catch { return false; }
  };
  function recordCssHovers(el: Element): void {
    if (paused) return;
    const chain = [el, ...ancestors(el, 15)].filter((x) => !isRoot(x));
    const found = new Set<Element>();
    for (const sel of cssHoverRules()) {
      const shown = chain.find((x) => matches(x, sel));
      if (!shown) continue;
      // The element that has to be hovered: the one matching the selector up to its last `:hover` compound.
      let end = sel.lastIndexOf(':hover') + ':hover'.length;
      end += (/^[^\s>+~]*/.exec(sel.slice(end)) || [''])[0].length;
      const hoverSel = sel.slice(0, end);
      let h: Element | null = shown;
      while (h && !isRoot(h) && !matches(h, hoverSel)) h = h.parentElement;
      if (h && !isRoot(h) && h !== el) found.add(h);
    }
    const depth = (x: Element): number => ancestors(x, 100).length;
    for (const h of Array.from(found).sort((a, b) => depth(a) - depth(b))) {
      const k = elKey(h);
      if (k === lastHoverKey) continue;
      lastHoverKey = k;
      const desc = describe(h);
      action('hover', desc, `${L('Hover')} ${nameOf(desc)}`);
    }
  }

  new MutationObserver((list) => {
    const cand = hoverCand;
    if (!cand || cand.mutated || Date.now() - cand.ts > 700 || !cand.scope) return;
    for (const mu of list) {
      const target = mu.target as Node;
      if (host && host.contains(target)) continue;
      if (cand.scope.contains(target)) {
        cand.mutated = true;
        return;
      }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-expanded'] });

  /* ---------------------------------------------------------------- dialogs: answer captured, placed before the trigger */
  const nativeAlert = w.alert, nativeConfirm = w.confirm, nativePrompt = w.prompt;
  w.alert = function (msg?: any): void {
    const ts = Date.now();
    nativeAlert.call(w, msg);
    if (!paused) send({ kind: 'dialog', type: 'alert', openedTs: ts, message: String(msg ?? '') });
  };
  w.confirm = function (msg?: any): boolean {
    const ts = Date.now();
    const r = nativeConfirm.call(w, msg);
    if (!paused) send({ kind: 'dialog', type: 'confirm', openedTs: ts, value: r ? 'true' : 'false', message: String(msg ?? '') });
    return r;
  };
  w.prompt = function (msg?: any, def?: any): string | null {
    const ts = Date.now();
    const r = nativePrompt.call(w, msg, def);
    if (!paused) send({ kind: 'dialog', type: 'prompt', openedTs: ts, value: r === null ? '' : String(r), message: String(msg ?? '') });
    return r;
  };

  /* ---------------------------------------------------------------- document start (navigation tracking) */
  let navType = 'navigate';
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav && nav.type) navType = nav.type;
  } catch {
    /* old browser */
  }
  send({ kind: 'document', url: location.href, navType }).then((s) => {
    if (!s) return;
    if (typeof s.paused === 'boolean') paused = s.paused;
    if (s.toolbarPos) {
      toolbarPos = s.toolbarPos;
      placeToolbar(s.toolbarPos.x, s.toolbarPos.y);
    }
    renderStatus();
  });

  /* ---------------------------------------------------------------- toolbar */
  let statusEl: HTMLElement | null = null;
  let pauseBtn: HTMLElement | null = null;
  let dot: HTMLElement | null = null;
  let panel: HTMLElement | null = null;
  function renderStatus(hint?: string): void {
    if (!statusEl || !pauseBtn || !dot) return;
    statusEl.textContent = hint || (!started ? L('Not recording') : paused ? L('Paused') : lastLabel ? `${L('Last:')} ${lastLabel}` : L('Recording…'));
    pauseBtn.textContent = !started ? L('Record') : paused ? L('Resume') : L('Pause');
    dot.className = !started || paused ? 'dot paused' : 'dot';
  }
  function showPanel(content: HTMLElement | null): void {
    if (!panel) return;
    panel.innerHTML = '';
    if (content) panel.appendChild(content);
    panel.style.display = content ? 'block' : 'none';
  }
  function button(label: string, title: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    if (cls) b.className = cls;
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the page's text selection
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  }
  let toolbarPos: { x: number; y: number } | null = null;
  /** Moves the toolbar to (x, y), kept fully inside the window. */
  function placeToolbar(x: number, y: number): void {
    if (!host) return;
    const r = host.getBoundingClientRect();
    host.style.left = `${Math.min(Math.max(0, x), Math.max(0, window.innerWidth - r.width))}px`;
    host.style.top = `${Math.min(Math.max(0, y), Math.max(0, window.innerHeight - r.height))}px`;
    host.style.right = 'auto';
  }
  window.addEventListener('resize', () => { if (toolbarPos) placeToolbar(toolbarPos.x, toolbarPos.y); });
  function buildToolbar(): void {
    if (host && host.isConnected) return;
    host = document.createElement('insightest-recorder');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:10px;right:10px;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .bar{font:12px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;color:#1f2328;background:#fff;border:1px solid #d0d7de;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);padding:6px;display:flex;flex-direction:column;gap:6px;max-width:380px}
      .row{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
      .bar{cursor:grab;user-select:none;touch-action:none}.bar.dragging{cursor:grabbing;opacity:.85}
      .grip{display:flex;align-items:center;gap:6px;font-weight:600;padding:0 4px;margin-right:auto}
      .handle{color:#8c959f;letter-spacing:-2px;font-size:14px;line-height:1}
      .row button,.row input,.panel{cursor:auto}.row button{cursor:pointer}
      .dot{width:9px;height:9px;border-radius:50%;background:#d1242f;animation:p 1.2s infinite}.dot.paused{background:#9a6700;animation:none}
      @keyframes p{50%{opacity:.35}}
      button{font:inherit;border:1px solid #d0d7de;background:#f6f8fa;border-radius:6px;padding:3px 7px;cursor:pointer;color:inherit}
      button:hover{background:#eaeef2}button.stop{background:#d1242f;border-color:#d1242f;color:#fff}
      input,textarea{font:inherit;border:1px solid #d0d7de;border-radius:6px;padding:2px 5px}
      input{width:64px}textarea{width:100%;box-sizing:border-box;font-family:ui-monospace,Consolas,monospace}
      .status{color:#59636e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 4px}
      .panel{display:none;border-top:1px solid #d0d7de;padding-top:6px;max-height:240px;overflow:auto}
      .item{display:block;width:100%;text-align:left;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .muted{color:#59636e}`;
    const bar = document.createElement('div');
    bar.className = 'bar';
    const top = document.createElement('div');
    top.className = 'row';
    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.title = L('Drag to move, double click to reset');
    const handle = document.createElement('span');
    handle.className = 'handle';
    handle.textContent = '⋮⋮';
    dot = document.createElement('span');
    grip.append(handle, dot, document.createTextNode('Insightest'));
    top.appendChild(grip);
    pauseBtn = button(L('Record'), L('Pause / resume recording'), () => {
      finishSelect2();
      started = true;
      paused = !paused;
      send({ kind: paused ? 'pause' : 'resume', url: location.href });
      renderStatus();
    });
    top.appendChild(pauseBtn);
    const hoverScrollBtn = button(L('Record hover/scroll'), L('Also record hover and scroll movements'), () => {
      trackHoverScroll = !trackHoverScroll;
      hoverScrollBtn.style.background = trackHoverScroll ? '#ddf4ff' : '';
    });
    top.appendChild(hoverScrollBtn);
    top.appendChild(button(L('Stop recording'), L('Ends the recording and closes the browser'), () => { finishSelect2(); send({ kind: 'stop' }); }, 'stop'));

    const tools = document.createElement('div');
    tools.className = 'row';
    tools.appendChild(button(L('Wait for text'), L('Select some text on the page first, or click here and then on the element'), () => {
      if (paused) return;
      const selText = clean(String(window.getSelection() || ''), 200);
      if (selText) {
        const node = window.getSelection()!.anchorNode;
        const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
        action('awaitText', { ...(el ? describe(el) : { selectors: {} }), value: selText }, `${L('Wait for text')} "${short(selText)}"`);
        window.getSelection()!.removeAllRanges();
      } else setPicking(!picking);
    }));
    tools.appendChild(button(L('Wait for network'), L('Wait for one of the recent network responses'), async () => {
      if (paused) return;
      const list = ((await send({ kind: 'listNetwork' })) || []) as { url: string; status: number; method: string; reqTs: number }[];
      const box = document.createElement('div');
      if (!list.length) {
        box.className = 'muted';
        box.textContent = L('No recent network responses');
      }
      for (const r of list) {
        let p = r.url;
        try { p = new URL(r.url).pathname; } catch { /* keep the full url */ }
        box.appendChild(button(`${r.status} ${r.method} ${p}`, r.url, () => {
          showPanel(null);
          action('awaitNetworkStatus', { selectors: {}, url: p, status: r.status, reqTs: r.reqTs }, `${L('Wait for network')} ${r.status} ${short(p)}`);
        }, 'item'));
      }
      showPanel(panel && panel.style.display === 'block' ? null : box);
    }));
    const ms = document.createElement('input');
    ms.type = 'number';
    ms.min = '0';
    ms.step = '500';
    ms.value = '1000';
    ms.title = L('Milliseconds');
    tools.appendChild(button(L('Wait'), L('Adds a fixed pause (ms)'), () => {
      const v = Math.max(0, Number(ms.value) || 0);
      action('wait', { selectors: {}, millis: v }, `${L('Wait')} ${v}ms`);
    }));
    tools.appendChild(ms);
    tools.appendChild(button(L('Screenshot'), L('Full page screenshot'), () => action('fullScreenshot', { selectors: {} }, L('Screenshot'))));
    tools.appendChild(button('JS', L('Custom JavaScript code run in the page'), () => {
      const box = document.createElement('div');
      const ta = document.createElement('textarea');
      ta.rows = 4;
      ta.placeholder = 'document.querySelector(...)';
      box.appendChild(ta);
      box.appendChild(button(L('Add'), '', () => {
        if (ta.value.trim()) action('customAction', { selectors: {}, code: ta.value }, L('Custom code'));
        showPanel(null);
      }));
      showPanel(panel && panel.style.display === 'block' ? null : box);
      ta.focus();
    }));
    tools.appendChild(button(L('Auto'), L('Auto-fill this page (fields, buttons, tabs, sections) and record it'), () => { runAuto(); }));

    statusEl = document.createElement('div');
    statusEl.className = 'status';
    const hint = document.createElement('div');
    hint.className = 'status muted';
    hint.textContent = L('Hover: Ctrl+Shift+H on the element under the pointer');
    panel = document.createElement('div');
    panel.className = 'panel';
    bar.append(top, tools, statusEl, hint, panel);
    root.append(style, bar);

    pickBox = document.createElement('div');
    pickBox.style.cssText = 'position:fixed;inset:0;pointer-events:none;display:none;box-shadow:inset 0 0 0 3px #0969da;';
    root.appendChild(pickBox);

    // Drag the toolbar from anywhere that is not a control; the position survives page changes (kept by the driver).
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as Element).closest('button, input, textarea, .panel')) return;
      e.preventDefault();
      const r = host!.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
      const move = (ev: PointerEvent): void => placeToolbar(ev.clientX - ox, ev.clientY - oy);
      const up = (): void => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
        bar.classList.remove('dragging');
        const p = host!.getBoundingClientRect();
        toolbarPos = { x: Math.round(p.left), y: Math.round(p.top) };
        send({ kind: 'toolbarPos', pos: toolbarPos });
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });
    // Double click on the title: back to the default corner.
    grip.addEventListener('dblclick', () => {
      toolbarPos = null;
      host!.style.left = 'auto';
      host!.style.top = '10px';
      host!.style.right = '10px';
      send({ kind: 'toolbarPos', pos: null });
    });
    document.documentElement.appendChild(host);
    if (toolbarPos) placeToolbar(toolbarPos.x, toolbarPos.y);
    renderStatus();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildToolbar);
  else buildToolbar();
  // Apps that rewrite the whole document must not lose the toolbar.
  setInterval(buildToolbar, 1500);
}

/* =================================================================================================== child driver */

interface DriverConfig {
  startUrl: string;
  initScript: string;
}

/** Runs in a child Node process (ELECTRON_RUN_AS_NODE) with playwright-core; prints one event per stdout line. */
async function insightestRecorderDriver(pw: any, cfg: DriverConfig): Promise<void> {
  const out = (o: any): void => {
    process.stdout.write(`@@insightest ${JSON.stringify(o)}\n`);
  };
  const browser = await pw.chromium.launch({ headless: false, args: ['--window-size=1366,900'] });
  const context = await browser.newContext({ viewport: null });
  const pages: any[] = [];
  const network: { url: string; status: number; method: string; reqTs: number }[] = [];
  const requestTs = new WeakMap<any, number>();
  let paused = true;
  let toolbarPos: { x: number; y: number } | null = null;
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    browser.close().catch(() => process.exit(0));
  };
  browser.on('disconnected', () => process.exit(0));

  // The "Auto" toolbar button's file-upload fields: this plain Node child (ELECTRON_RUN_AS_NODE=1) has no
  // electron.dialog of its own, so the request is relayed up to the real Electron main process (which spawned
  // this child and is reading its stdout -- see recordInsightestActions) and the answer comes back on stdin.
  let fileReqSeq = 0;
  const pendingFileAnswers = new Map<string, (filePath: string | null) => void>();
  readline.createInterface({ input: process.stdin }).on('line', (line: string) => {
    try {
      const msg = JSON.parse(line) as { requestId: string; filePath: string | null };
      const resolve = pendingFileAnswers.get(msg.requestId);
      if (resolve) {
        pendingFileAnswers.delete(msg.requestId);
        resolve(msg.filePath ?? null);
      }
    } catch {
      /* partial/foreign line */
    }
  });
  /** Best Playwright-usable selector string for a page-computed RecordedSelectors bundle, same priority
   * (id > testId > attr > general > xpath > text) used everywhere else in the engine. */
  function pwSelectorOf(s: any): string | null {
    if (!s) return null;
    if (s.id) return s.id;
    if (s.testIdSelector) return s.testIdSelector;
    if (s.attrSelector) return s.attrSelector;
    if (s.generalSelector) return s.generalSelector;
    if (s.xpath) return `xpath=${s.xpath}`;
    if (s.text) return `text=${s.text}`;
    return null;
  }

  await context.exposeBinding('__insightestEmit', async (source: any, evt: any) => {
    if (!evt || typeof evt !== 'object' || !source || !source.page) return null;
    if (source.frame !== source.page.mainFrame()) return { paused, toolbarPos };
    switch (evt.kind) {
      case 'listNetwork':
        return network.slice(-40).reverse();
      case 'stop':
        setTimeout(close, 50);
        return { paused, toolbarPos };
      case 'toolbarPos':
        toolbarPos = evt.pos && Number.isFinite(evt.pos.x) && Number.isFinite(evt.pos.y) ? { x: evt.pos.x, y: evt.pos.y } : null;
        return { paused, toolbarPos };
      case 'pause':
        paused = true;
        break;
      case 'resume':
        paused = false;
        break;
      case 'needsFile': {
        // Only electron.dialog can return a real, usable absolute path -- a page script can never read one
        // back from a file input (browsers redact it to "C:\fakepath\..." for security), so there is no way
        // to synthesize this step; the user is asked for a real file, exactly as the "Auto" button promises.
        const requestId = `f${++fileReqSeq}`;
        const filePath = await new Promise<string | null>((resolve) => {
          pendingFileAnswers.set(requestId, resolve);
          out({ kind: 'needsFile', requestId, label: evt.textHint || '' });
        });
        if (filePath) {
          const sel = pwSelectorOf(evt.selectors);
          if (sel) await source.page.setInputFiles(sel, filePath).catch(() => {});
          out({ kind: 'action', type: 'upload', ts: Date.now(), selectors: evt.selectors || {}, textHint: evt.textHint, tagName: evt.tagName, value: filePath, page: pages.indexOf(source.page) });
        }
        return { paused, toolbarPos, filled: !!filePath };
      }
      default:
        if (paused && evt.kind !== 'document') return { paused, toolbarPos };
    }
    out({ ...evt, page: pages.indexOf(source.page) });
    return { paused, toolbarPos };
  });
  await context.addInitScript({ content: cfg.initScript });

  const attach = (p: any): void => {
    pages.push(p);
    // A listener that does nothing keeps alert/confirm/prompt open for the user (no listener = auto-dismiss).
    p.on('dialog', () => {});
    p.on('request', (r: any) => requestTs.set(r, Date.now()));
    p.on('response', (r: any) => {
      const req = r.request();
      const type = req.resourceType();
      if (type !== 'xhr' && type !== 'fetch') return;
      network.push({ url: r.url(), status: r.status(), method: req.method(), reqTs: requestTs.get(req) || Date.now() });
      if (network.length > 200) network.shift();
    });
    p.on('close', () => {
      if (p === pages[0]) close();
    });
  };
  context.on('page', attach);
  const page = await context.newPage();
  await page.goto(cfg.startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
}

/* =================================================================================================== reduction */

export interface RawEvent {
  kind: 'action' | 'document' | 'dialog' | 'pause' | 'resume';
  type?: InsightestActionType;
  ts: number;
  page: number;
  [k: string]: any;
}

const NAVIGATING: InsightestActionType[] = ['click', 'doubleClick', 'rightClick', 'keydown', 'input', 'select2', 'dragAndDrop'];
const NAVIGATION_WINDOW_MS = 6000;

const sameUrl = (a: string, b: string): boolean => a.replace(/#.*$/, '').replace(/\/$/, '') === b.replace(/#.*$/, '').replace(/\/$/, '');

/** Folds the raw page event stream into the final Insightest action list. */
export function reduceRecording(events: RawEvent[], startUrl: string): InsightestAction[] {
  const actions: InsightestAction[] = [{ type: 'load', timestamp: 0, selectors: {}, url: startUrl, value: startUrl }];
  const history = [startUrl];
  let pointer = 0;
  let firstDocument = true;
  let currentUrl = startUrl;
  let urlAtPause: string | null = null;

  const last = (): InsightestAction | undefined => actions[actions.length - 1];
  const fromEvent = (e: RawEvent): InsightestAction => {
    const { kind, ts, page, rect, ...rest } = e;
    void kind; void page; void rect;
    return { ...(rest as any), type: e.type as InsightestActionType, timestamp: ts, selectors: e.selectors || {} };
  };
  /** Index of the last action that happened at or before `ts` (the dialog/response's trigger). */
  const lastBefore = (ts: number): number => {
    for (let i = actions.length - 1; i >= 0; i--) if (actions[i].timestamp <= ts) return i;
    return -1;
  };

  for (const e of events) {
    if (e.page !== 0) continue; // only the main tab is replayable
    switch (e.kind) {
      case 'pause':
        urlAtPause = currentUrl;
        continue;
      case 'resume':
        if (urlAtPause !== null && e.url && !sameUrl(e.url, urlAtPause)) {
          actions.push({ type: 'load', timestamp: e.ts, selectors: {}, url: e.url, value: e.url });
          history.splice(pointer + 1);
          history.push(e.url);
          pointer = history.length - 1;
        }
        urlAtPause = null;
        continue;
      case 'document': {
        const url = String(e.url || '');
        if (!/^https?:|^file:/i.test(url)) continue; // about:blank of a new tab, chrome-error://...
        if (firstDocument) {
          firstDocument = false;
          currentUrl = url;
          history[0] = url;
          continue;
        }
        currentUrl = url;
        if (urlAtPause !== null) continue; // navigating while paused: synced on resume
        const triggerWithin = (ms: number): InsightestAction | undefined => {
          for (let i = actions.length - 1; i >= 0; i--) {
            const a = actions[i];
            if (e.ts - a.timestamp > ms) return undefined;
            // An earlier navigation in between means this one is not that action's doing.
            if (a.causesNavigation || ['load', 'back', 'forward', 'refresh'].includes(a.type)) return undefined;
            if (NAVIGATING.includes(a.type)) return a;
          }
          return undefined;
        };
        if (e.navType === 'reload') {
          // The app reloading itself right after an action (location.reload()) is that action's navigation.
          const trigger = triggerWithin(2000);
          if (trigger) trigger.causesNavigation = true;
          else actions.push({ type: 'refresh', timestamp: e.ts, selectors: {} });
        } else if (e.navType === 'back_forward') {
          if (pointer > 0 && sameUrl(history[pointer - 1], url)) {
            pointer--;
            actions.push({ type: 'back', timestamp: e.ts, selectors: {} });
          } else if (pointer < history.length - 1 && sameUrl(history[pointer + 1], url)) {
            pointer++;
            actions.push({ type: 'forward', timestamp: e.ts, selectors: {} });
          } else {
            pointer = Math.max(0, pointer - 1);
            actions.push({ type: 'back', timestamp: e.ts, selectors: {} });
          }
        } else {
          history.splice(pointer + 1);
          history.push(url);
          pointer = history.length - 1;
          const trigger = triggerWithin(NAVIGATION_WINDOW_MS);
          if (trigger) trigger.causesNavigation = true;
          else actions.push({ type: 'load', timestamp: e.ts, selectors: {}, url, value: url });
        }
        continue;
      }
      case 'dialog': {
        const a = fromEvent(e);
        a.timestamp = e.openedTs || e.ts;
        delete (a as any).openedTs;
        delete (a as any).message;
        a.selectors = {};
        // pw.alert/confirm/prompt arm the answer for the NEXT dialog: it goes right before the action that opened it.
        const i = lastBefore(a.timestamp);
        if (i > 0) actions.splice(i, 0, a);
        else actions.push(a);
        continue;
      }
      case 'action':
        break;
      default:
        continue;
    }

    const a = fromEvent(e);
    const prev = last();
    switch (a.type) {
      case 'input': {
        const isSelect = a.tagName === 'SELECT';
        if (!isSelect && prev && (prev.type === 'input' || prev.type === 'clear') && prev.elKey === a.elKey) {
          prev.value = a.value;
          prev.type = a.value === '' ? 'clear' : 'input';
          prev.selectors = a.selectors;
          continue;
        }
        if (!isSelect && a.value === '') a.type = 'clear';
        actions.push(a);
        continue;
      }
      case 'doubleClick': {
        // The browser fires click, click, dblclick: the two clicks are part of the double click.
        for (let n = 0; n < 2; n++) {
          const p = last();
          if (p && p.type === 'click' && p.elKey === a.elKey && a.timestamp - p.timestamp < 1000) actions.pop();
        }
        actions.push(a);
        continue;
      }
      case 'hover':
        if (prev && prev.type === 'hover' && prev.elKey === a.elKey) continue;
        actions.push(a);
        continue;
      case 'wheel':
        if (prev && prev.type === 'wheel') {
          prev.deltaX = (prev.deltaX || 0) + (a.deltaX || 0);
          prev.deltaY = (prev.deltaY || 0) + (a.deltaY || 0);
          prev.pageXOffset = a.pageXOffset;
          prev.pageYOffset = a.pageYOffset;
          continue;
        }
        actions.push(a);
        continue;
      case 'resize':
        if (prev && prev.type === 'resize') {
          prev.width = a.width;
          prev.height = a.height;
          continue;
        }
        actions.push(a);
        continue;
      case 'awaitNetworkStatus': {
        // Waits for a response the PREVIOUS action triggers: placed right after the action that preceded the request.
        const reqTs = Number((a as any).reqTs) || a.timestamp;
        delete (a as any).reqTs;
        const i = lastBefore(reqTs);
        actions.splice(i + 1, 0, a);
        continue;
      }
      default:
        actions.push(a);
    }
  }

  // A hover right before a click on the same element adds nothing: the click hovers it anyway.
  return actions.filter((a, i) => {
    const next = actions[i + 1];
    return !(a.type === 'hover' && next && ['click', 'doubleClick', 'rightClick'].includes(next.type) && next.elKey === a.elKey);
  });
}

/* =================================================================================================== builder steps */

const FILLABLE_INPUT_TYPES = ['', 'date', 'datetime', 'datetime-local', 'email', 'month', 'number', 'password', 'search', 'tel', 'text', 'time', 'url', 'week', 'color'];

function builderSelectors(s: RecordedSelectors): { selectors: RecordedBuilderStep['selectors']; secondarySelectors: string[] } {
  const selectors: RecordedBuilderStep['selectors'] = {};
  const put = (key: keyof RecordedBuilderStep['selectors'], v: string | null | undefined): void => {
    if (v && v.trim()) selectors[key] = v.trim();
  };
  put('xpath', s.xpath);
  put('generalSelector', s.generalSelector);
  put('attrSelector', s.attrSelector);
  put('testIdSelector', s.testIdSelector);
  put('id', s.id);
  put('text', s.text);
  const primary = new Set(Object.values(selectors));
  const secondarySelectors = [s.formSelector, s.accessibilitySelector, s.hrefSelector, ...(s.alternatives || [])].filter(
    (v, i, arr): v is string => !!v && !primary.has(v) && arr.indexOf(v) === i
  );
  return { selectors, secondarySelectors };
}

/** Insightest action -> PlaywrightBuilder step (same mapping as Insighter's ScriptBuilder.transformActionIntoCodes). */
export function actionToBuilderStep(a: InsightestAction): RecordedBuilderStep | null {
  const base = (action: string, value = '', value2?: string): RecordedBuilderStep => {
    const { selectors, secondarySelectors } = builderSelectors(a.selectors || {});
    const step: RecordedBuilderStep = {
      action,
      selectors,
      value,
      valueIsNumber: false,
      causesNavigation: !!a.causesNavigation,
      textHint: a.textHint || undefined,
      tagHint: a.tagName ? a.tagName.toLowerCase() : undefined,
    };
    if (value2 !== undefined) step.value2 = value2;
    if (secondarySelectors.length) step.secondarySelectors = secondarySelectors;
    return step;
  };
  switch (a.type) {
    case 'load':
      return base('load', a.url || a.value || '');
    case 'click':
    case 'doubleClick':
    case 'rightClick':
    case 'hover':
      return base(a.type);
    case 'input': {
      const tag = (a.tagName || '').toUpperCase();
      if (tag === 'SELECT') return base('select', a.value ?? '');
      // contenteditable too: the recorded value is the WHOLE content, fill replaces it (type would append to it).
      if (tag === 'TEXTAREA' || a.contentEditable || (tag === 'INPUT' && FILLABLE_INPUT_TYPES.includes(a.inputType || ''))) return base('fill', a.value ?? '');
      return base('type', a.value ?? '');
    }
    case 'clear':
      return base('clearInput');
    case 'keydown':
      return base('keydown', a.key || '');
    case 'select2': {
      const step = base('select2', a.value ?? '');
      if (a.optionValue !== undefined) step.optionValue = a.optionValue;
      return step;
    }
    case 'wait':
      return base('wait', String(a.millis ?? 1000));
    case 'resize':
      return base('resize', String(a.width ?? 1280), String(a.height ?? 720));
    case 'wheel':
      return base('wheel', String(a.deltaX ?? 0), String(a.deltaY ?? 0));
    case 'dragAndDrop':
      return base('dragAndDrop', `${a.sourceX ?? 0},${a.sourceY ?? 0}`, `${a.targetX ?? 0},${a.targetY ?? 0}`);
    case 'awaitText':
      return base('awaitText', a.value ?? '');
    case 'awaitNetworkStatus':
      return base('awaitNetworkStatus', a.url ?? '', String(a.status ?? 200));
    case 'back':
    case 'forward':
    case 'refresh':
    case 'fullScreenshot':
    case 'alert':
      return base(a.type);
    case 'prompt':
      return base('prompt', a.value ?? '');
    case 'confirm':
      return base('confirm', a.value === 'false' ? 'false' : 'true');
    case 'customAction':
      return base('customAction', a.code ?? '');
    case 'upload':
      return base('upload', a.value ?? '');
    default:
      return null; // 'use' (test dependency) has no browser event
  }
}

/* =================================================================================================== entry point */

const TOOLBAR_LABELS = [
  'Pause', 'Resume', 'Record', 'Not recording', 'Paused', 'Recording…', 'Last:', 'Stop recording', 'Pause / resume recording', 'Ends the recording and closes the browser',
  'Record hover/scroll', 'Also record hover and scroll movements',
  'Wait for text', 'Select some text on the page first, or click here and then on the element', 'Click the element whose text to wait for (Esc to cancel)',
  'Wait for network', 'Wait for one of the recent network responses', 'No recent network responses', 'Wait', 'Adds a fixed pause (ms)', 'Milliseconds',
  'Screenshot', 'Full page screenshot', 'Custom JavaScript code run in the page', 'Custom code', 'Add', 'Hover: Ctrl+Shift+H on the element under the pointer',
  'Double click', 'Right click', 'Fill', 'Choose', 'Press', 'Resize', 'Click', 'Hover', 'Drag and drop', 'Scroll',
  'Drag to move, double click to reset',
  'Auto', 'Auto-fill this page (fields, buttons, tabs, sections) and record it', 'Auto-filling…',
];

/** The script injected in every page of the recording browser. It reports to `window.__insightestEmit`. */
export function pageRecorderScript(): string {
  const labels: Record<string, string> = {};
  for (const k of TOOLBAR_LABELS) labels[k] = m(k);
  return `(${insightestPageRecorder.toString()})(${JSON.stringify({ labels } as PageRecorderConfig)});`;
}

/** Raw recording: launches the browser, waits for the user to close it (or press Stop), returns the Insightest actions. */
export async function recordInsightestActions(startUrl: string): Promise<InsightestAction[]> {
  const workDir = makeScratchDir('record-');
  const scriptPath = path.join(workDir, 'record.js');
  const driverCfg: DriverConfig = { startUrl, initScript: pageRecorderScript() };
  fs.writeFileSync(
    scriptPath,
    `const pw = require('playwright-core');\n` +
      `const readline = require('readline');\n` +
      `const cfg = ${JSON.stringify(driverCfg)};\n` +
      `(${insightestRecorderDriver.toString()})(pw, cfg).catch((e) => { console.error(e); process.exit(1); });\n`,
    'utf8'
  );

  const events: RawEvent[] = [];
  let stderr = '';
  const status = await new Promise<number | null>((resolve, reject) => {
    // stdin is piped (not 'ignore'): the "Auto" toolbar button's file-upload fields need a real path, which
    // only this main process can get (electron.dialog is unavailable in the child -- see the `needsFile`
    // handling below) -- the child's exposeBinding handler for it blocks on a reply written here.
    const child = spawn(process.execPath, [scriptPath], {
      cwd: workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      if (!line.startsWith('@@insightest ')) return;
      let evt: RawEvent | { kind: 'needsFile'; requestId: string };
      try {
        evt = JSON.parse(line.slice('@@insightest '.length));
      } catch {
        return; /* partial line */
      }
      if (evt.kind === 'needsFile') {
        const requestId = (evt as { requestId: string }).requestId;
        const label = (evt as { label?: string }).label || '';
        dialog
          .showOpenDialog({ properties: ['openFile'], title: label ? m('Choose a file for "{label}"', { label }) : undefined })
          .then((result) => {
            const filePath = result.canceled ? null : (result.filePaths[0] ?? null);
            child.stdin!.write(`${JSON.stringify({ requestId, filePath })}\n`);
          })
          .catch(() => {
            child.stdin!.write(`${JSON.stringify({ requestId, filePath: null })}\n`);
          });
        return;
      }
      events.push(evt as RawEvent);
    });
    child.stderr!.on('data', (d) => { stderr = (stderr + String(d)).slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  fs.rmSync(workDir, { recursive: true, force: true });
  if (status !== 0 && !events.length) throw new Error(stderr.trim() || m('Error while recording'));
  return reduceRecording(events, startUrl);
}

/** Records a session and returns it as PlaywrightBuilder steps (pw.click / pw.fill / pw.select2 / ...). */
export async function recordBuilderSteps(startUrl: string): Promise<RecordedBuilderStep[] | null> {
  const actions = await recordInsightestActions(startUrl);
  const steps = actions.map(actionToBuilderStep).filter((s): s is RecordedBuilderStep => !!s);
  return steps.length > 1 ? steps : null;
}
