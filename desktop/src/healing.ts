/**
 * Turns the events of a heal run (what the engine fixed on the fly) into PROPOSALS the user reviews, and applies the
 * accepted ones to the editable step model. Nothing here talks to the network or the disk: the flow that runs the
 * tests, asks the AI and saves lives in components/HealPanel.tsx.
 */
import type { HealEvent } from './electron-bridge';
import { ACTION_LABEL, SELECTOR_KEYS, stepAtMetaIndex, storedSelectorLabel, type EditableStep, type ParsedBuilderTest, type SelectorKey } from './stepModel';

/** One test taking part in a heal run, in the order the engine runs them (prerequisites first, the test last). */
export interface HealTest {
  testId: number;
  name: string;
  /** Working copy: proposals of earlier rounds are already applied to it. */
  draft: ParsedBuilderTest;
}

export interface HealChange {
  /** New selector, in the editor's form for `key` (xpath without the `xpath=` prefix, text plain). */
  selector?: { key: SelectorKey; value: string };
  /** Selector kinds that were found stale and must be blanked, so a dead selector is not retried on every run. */
  clear: SelectorKey[];
  /** New option text (select2). */
  option?: string;
  /** Fixed timeout in ms (steps whose element only shows up late). */
  timeoutMs?: number;
}

export type HealSource = 'deterministic' | 'ai';

export interface HealProposal {
  id: string;
  testId: number;
  testName: string;
  /** EditableStep.key of the step it applies to (stable while the user reviews). */
  stepKey: string;
  /** 1-based position of the step in its test, for display. */
  stepNumber: number;
  actionLabel: string;
  kind: 'selector' | 'timing' | 'value';
  source: HealSource;
  strategy: string;
  /** 0..1 */
  confidence: number;
  evidence: string;
  before: string;
  after: string;
  change: HealChange;
  accepted: boolean;
}

/** A step the deterministic healer could not fix: the input for the AI. */
export interface UnresolvedStep {
  testId: number;
  testName: string;
  t: number;
  i: number;
  stepKey: string;
  stepNumber: number;
  actionLabel: string;
  failed: string;
  /** Every selector the step currently has (engine form): all of them are stale when it could not be healed. */
  allLabels: string[];
  evidence: string;
  url?: string;
  snapshot?: HealEvent['snapshot'];
  /** Human-readable description of the step as it is now (selectors, value). */
  description: string;
}

/* ------------------------------------------------------------------ selector strings -> editor form */

const CSS_KEYS: SelectorKey[] = ['testIdSelector', 'attrSelector', 'generalSelector'];

/** Reads the inside of `text="Salva"` / `text=/^\s*Salva\s*$/i` / `text=Salva`. */
function textOf(selector: string): string {
  const body = selector.slice('text='.length).trim();
  if (body.startsWith('"')) {
    try {
      return JSON.parse(body) as string;
    } catch {
      /* fall through */
    }
  }
  const regex = /^\/\^\\s\*(.*)\\s\*\$\/i$/.exec(body);
  if (regex) return regex[1].replace(/\\(.)/g, '$1');
  return body.replace(/^\/|\/i?$/g, '');
}

/**
 * Where a Playwright selector string goes in the step model. CSS goes to whichever CSS kind the project's selector
 * priority actually uses (a kind outside the priority would be ignored by normal runs).
 */
export function classifySelector(selector: string, priority: readonly string[]): { key: SelectorKey; value: string; visible: boolean } {
  const s = selector.trim();
  if (s.startsWith('xpath=')) return { key: 'xpath', value: s.slice('xpath='.length), visible: false };
  if (s.startsWith('text=')) return { key: 'text', value: textOf(s), visible: false };
  const visible = /:visible\s*$/.test(s);
  const css = s.replace(/\s*:visible\s*$/, '');
  if (/^#[\w-]+$/.test(css) && priority.includes('id')) return { key: 'id', value: css, visible };
  const used = CSS_KEYS.filter((k) => priority.includes(k));
  const isDataTest = /\[data-test(id)?=/i.test(css);
  const key: SelectorKey = (isDataTest && used.includes('testIdSelector') ? 'testIdSelector' : used.find((k) => k === 'generalSelector') ?? used[0] ?? 'generalSelector') as SelectorKey;
  return { key, value: css, visible };
}

/** Selector kinds of `step` whose engine-visible form is one of `failed` (the labels the engine reported as stale). */
function staleKeys(step: EditableStep, failed: readonly string[]): SelectorKey[] {
  const norm = (x: string): string => x.trim().replace(/\s+:visible$/, ':visible');
  const wanted = new Set(failed.map(norm));
  return SELECTOR_KEYS.filter((k) => {
    const label = storedSelectorLabel(step, k);
    return label !== '' && wanted.has(norm(label));
  });
}

/** Short description of a step's current selectors, for the review UI and the AI prompt. */
export function describeStep(step: EditableStep): string {
  const parts: string[] = [`${ACTION_LABEL[step.action]}`];
  for (const k of SELECTOR_KEYS) {
    const label = storedSelectorLabel(step, k);
    if (label) parts.push(`${k}: ${label}`);
  }
  if (step.value) parts.push(`value: ${step.value}`);
  return parts.join(' | ');
}

/* ------------------------------------------------------------------ events -> proposals */

let proposalCounter = 0;

export interface EventsToProposals {
  proposals: HealProposal[];
  unresolved: UnresolvedStep[];
}

/**
 * `tests[t]` is the test the engine called `t` (prerequisites oldest first, the test under repair last). Events for
 * steps that no longer exist in the draft are ignored.
 */
export function proposalsFromEvents(events: HealEvent[], tests: HealTest[], priority: readonly string[], source: HealSource = 'deterministic'): EventsToProposals {
  const proposals: HealProposal[] = [];
  const unresolved: UnresolvedStep[] = [];
  const seen = new Set<string>();

  for (const ev of events) {
    const test = tests[ev.t];
    if (!test) continue;
    const found = stepAtMetaIndex(test.draft, ev.i);
    if (!found) continue;
    const { step, position } = found;
    const base = { testId: test.testId, testName: test.name, stepKey: step.key, stepNumber: position + 1, actionLabel: ACTION_LABEL[step.action] };

    if (ev.kind === 'unresolved') {
      const allLabels = SELECTOR_KEYS.map((k) => storedSelectorLabel(step, k)).filter(Boolean);
      unresolved.push({ ...base, t: ev.t, i: ev.i, failed: ev.failed, allLabels, evidence: ev.evidence ?? '', url: ev.url, snapshot: ev.snapshot, description: describeStep(step) });
      continue;
    }

    let change: HealChange;
    let before: string;
    let after: string;
    if (ev.kind === 'selector' && ev.selector) {
      const target = classifySelector(ev.selector, priority);
      const failed = ev.failedAll && ev.failedAll.length ? ev.failedAll : [ev.failed];
      const clear = staleKeys(step, failed).filter((k) => k !== target.key || step.selectors[k] !== target.value);
      change = { selector: { key: target.key, value: target.value }, clear };
      before = failed.join('  ·  ') || ev.failed;
      after = ev.selector;
    } else if (ev.kind === 'timing' && ev.timeoutMs) {
      change = { clear: [], timeoutMs: ev.timeoutMs };
      before = step.timeout ? `timeout ${step.timeout}ms` : 'timeout 8s → 15s → 20s';
      after = `timeout ${ev.timeoutMs}ms`;
    } else if (ev.kind === 'value' && ev.option !== undefined) {
      change = { clear: [], option: ev.option };
      before = step.value;
      after = ev.option;
    } else {
      continue;
    }

    const dedupeKey = `${test.testId}:${step.key}:${ev.kind}:${after}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    proposals.push({
      id: `p${++proposalCounter}`,
      ...base,
      kind: ev.kind,
      source,
      strategy: ev.strategy ?? (source === 'ai' ? 'ai' : ''),
      confidence: ev.confidence ?? 0.5,
      evidence: ev.evidence ?? '',
      before,
      after,
      change,
      accepted: true,
    });
  }
  return { proposals, unresolved };
}

/* ------------------------------------------------------------------ applying */

/** The step with the proposal's change applied (a new object: the model is never mutated). */
export function applyChange(step: EditableStep, change: HealChange): EditableStep {
  const next: EditableStep = { ...step, selectors: { ...step.selectors } };
  for (const k of change.clear) next.selectors[k] = '';
  if (change.selector) {
    next.selectors[change.selector.key] = change.selector.value;
    // `visible` is one flag per step: a healed CSS selector that was matched with :visible keeps it on.
    if (change.selector.key !== 'xpath' && change.selector.key !== 'text') next.visible = true;
  }
  if (change.option !== undefined) {
    next.value = change.option;
    next.valueIsNumber = false;
  }
  if (change.timeoutMs) {
    const current = Number(next.timeout) || 0;
    next.timeout = String(Math.max(current, change.timeoutMs));
  }
  return next;
}

/** A copy of `parsed` with every given proposal (that targets one of its steps) applied. */
export function applyProposals(parsed: ParsedBuilderTest, proposals: readonly HealProposal[]): ParsedBuilderTest {
  const byStep = new Map<string, HealProposal[]>();
  for (const p of proposals) byStep.set(p.stepKey, [...(byStep.get(p.stepKey) ?? []), p]);
  return {
    ...parsed,
    steps: parsed.steps.map((s) => {
      const list = byStep.get(s.key);
      return list ? list.reduce((step, p) => applyChange(step, p.change), s) : s;
    }),
  };
}

/** Clones the drafts and applies the proposals to the test each one belongs to. */
export function applyToTests(tests: readonly HealTest[], proposals: readonly HealProposal[]): HealTest[] {
  return tests.map((t) => ({ ...t, draft: applyProposals(t.draft, proposals.filter((p) => p.testId === t.testId)) }));
}

/* ------------------------------------------------------------------ AI answers -> events */

export interface AiFix {
  t: number;
  i: number;
  selector?: string | null;
  option?: string | null;
  timeoutMs?: number | null;
  why?: string;
}

/** The AI's structured answer, expressed as the same events the deterministic healer emits (one path for both). */
export function eventsFromAiFixes(fixes: AiFix[], unresolved: UnresolvedStep[]): HealEvent[] {
  const out: HealEvent[] = [];
  for (const fix of fixes) {
    const target = unresolved.find((u) => u.t === fix.t && u.i === fix.i);
    if (!target) continue; // only steps that really are unresolved: never let the AI rewrite the rest of the test
    if (fix.selector && fix.selector.trim()) {
      out.push({ t: fix.t, i: fix.i, kind: 'selector', action: target.actionLabel, failed: target.failed, failedAll: target.allLabels, selector: fix.selector.trim(), strategy: 'ai', confidence: 0.6, evidence: fix.why ?? '' });
    } else if (fix.option !== undefined && fix.option !== null) {
      out.push({ t: fix.t, i: fix.i, kind: 'value', action: target.actionLabel, failed: target.failed, option: String(fix.option), strategy: 'ai', confidence: 0.6, evidence: fix.why ?? '' });
    } else if (fix.timeoutMs) {
      out.push({ t: fix.t, i: fix.i, kind: 'timing', action: target.actionLabel, failed: target.failed, timeoutMs: Number(fix.timeoutMs), strategy: 'ai', confidence: 0.5, evidence: fix.why ?? '' });
    }
  }
  return out;
}
