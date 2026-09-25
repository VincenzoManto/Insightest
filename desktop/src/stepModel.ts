/**
 * Editable model of a test written against the PlaywrightBuilder engine (ci-runner/pwBuilder.js):
 * the stored `playwright_code` is a list of `await pw.<action>(args);` lines and `steps_json` holds one
 * metadata object per selector-bearing line (all recorded selectors + per-step execution options).
 *
 * parseBuilderTest() turns both into an editable step list; serializeBuilderTest() writes them back in
 * exactly the shape the runner (ci-runner/runner.js: BUILDER_META_METHODS) expects, so the two stay aligned.
 * Tests recorded in the older `page.locator(...)` format are not builder tests (parse returns null).
 */

export type StepAction =
  | 'load'
  | 'click'
  | 'doubleClick'
  | 'rightClick'
  | 'hover'
  | 'type'
  | 'fill'
  | 'select'
  | 'select2'
  | 'keydown'
  | 'clearInput'
  | 'wait'
  | 'resize'
  | 'raw';

/** Must match BUILDER_META_METHODS in ci-runner/runner.js: these lines consume one steps_json entry each. */
export const META_METHODS: readonly string[] = ['click', 'doubleClick', 'rightClick', 'hover', 'type', 'fill', 'select', 'keydown', 'select2', 'clearInput'];

export const SELECTOR_KEYS = ['xpath', 'generalSelector', 'attrSelector', 'testIdSelector', 'id', 'text'] as const;
export type SelectorKey = (typeof SELECTOR_KEYS)[number];
export type StepSelectors = Record<SelectorKey, string>;

/** Actions the editor can create/convert between, in the order shown in the Action dropdown. */
export const EDITABLE_ACTIONS: StepAction[] = ['load', 'click', 'doubleClick', 'rightClick', 'hover', 'fill', 'type', 'select', 'select2', 'keydown', 'clearInput', 'wait', 'resize'];

export const ACTION_LABEL: Record<StepAction, string> = {
  load: 'Load',
  click: 'Click',
  doubleClick: 'Double click',
  rightClick: 'Right click',
  hover: 'Hover',
  type: 'Type keys',
  fill: 'Fill',
  select: 'Choose',
  select2: 'Select2',
  keydown: 'Press',
  clearInput: 'Clear',
  wait: 'Wait',
  resize: 'Resize',
  raw: 'Code',
};

export function hasSelector(action: StepAction): boolean {
  return META_METHODS.includes(action);
}
/** Actions that take a value (typed text, option, key, url, ms, width). */
export function valueLabel(action: StepAction): string | null {
  switch (action) {
    case 'fill':
    case 'type':
      return 'Value';
    case 'select':
      return 'Option value';
    case 'select2':
      return 'Option (text, or position)';
    case 'keydown':
      return 'Key';
    case 'load':
      return 'URL';
    case 'wait':
      return 'Milliseconds';
    case 'resize':
      return 'Width';
    default:
      return null;
  }
}
export function canCauseNavigation(action: StepAction): boolean {
  return ['click', 'doubleClick', 'rightClick', 'hover', 'type', 'fill', 'select', 'select2', 'keydown'].includes(action);
}

export interface EditableStep {
  /** Local id, only for React keys / selection. */
  key: string;
  action: StepAction;
  selectors: StepSelectors;
  /** Adds/removes `:visible` on the CSS selectors (xpath/text are unaffected). */
  visible: boolean;
  /** fill/type/select value, keydown key, select2 option, load url, wait ms, resize width. */
  value: string;
  /** resize height. */
  value2: string;
  /** select2: pick the option by position instead of by text. */
  valueIsNumber: boolean;
  causesNavigation: boolean;
  enabled: boolean;
  skipOnFailure: boolean;
  /** Fixed per-attempt timeout in ms; '' = engine default (8s/15s/20s escalation). */
  timeout: string;
  /** Pause before the action, in ms. */
  waitBeforeMs: string;
  /** Recorded metadata the editor doesn't expose but must not lose. */
  textHint?: string;
  tagHint?: string;
  /** Verbatim source line for 'raw' steps (comments, TODOs, hand-written code). */
  raw?: string;
  /** True when the runner will count this line as selector-bearing (keeps steps_json aligned even for raw lines). */
  countsMeta: boolean;
}

export interface ParsedBuilderTest {
  /** Everything up to and including `const pw = new PlaywrightBuilder(page);`. */
  head: string;
  /** The closing `});` (and anything after). */
  foot: string;
  steps: EditableStep[];
}

let keyCounter = 0;
const newKey = (): string => `s${++keyCounter}`;

export function emptySelectors(): StepSelectors {
  return { xpath: '', generalSelector: '', attrSelector: '', testIdSelector: '', id: '', text: '' };
}

export function newStep(action: StepAction = 'click'): EditableStep {
  return {
    key: newKey(),
    action,
    selectors: emptySelectors(),
    visible: true,
    value: action === 'wait' ? '1000' : action === 'resize' ? '1280' : '',
    value2: action === 'resize' ? '720' : '',
    valueIsNumber: false,
    causesNavigation: false,
    enabled: true,
    skipOnFailure: false,
    timeout: '',
    waitBeforeMs: '',
    countsMeta: hasSelector(action),
  };
}

/* ------------------------------------------------------------------ selector <-> stored strings */

// `:visible` at the end of a CSS selector is our visibility flag. Old imports produced "sel :visible" (a space,
// because the recorded selector ended with one), which the engine treats as "sel:visible" -- so do we.
const GLUED_VISIBLE_RE = /\s*:visible\s*$/;
const stripVisible = (s: string): string => s.replace(GLUED_VISIBLE_RE, '').trim();

function fromStored(key: SelectorKey, raw: string): string {
  const v = String(raw ?? '').trim();
  if (key === 'xpath') return v.replace(/^xpath=/, '');
  if (key === 'text') return v.replace(/^text=/, '');
  return stripVisible(v);
}

function toStored(key: SelectorKey, value: string, visible: boolean): string {
  const v = value.trim();
  if (!v) return '';
  if (key === 'xpath') return v.startsWith('xpath=') ? v : `xpath=${v}`;
  if (key === 'text') return v;
  const css = stripVisible(v);
  return visible && !/:visible\s*$/.test(css) ? `${css}:visible` : css;
}

/** Best-effort classification of a bare selector string (older steps only carry a primary + secondaries). */
function guessKey(sel: string): SelectorKey {
  const s = sel.trim();
  if (s.startsWith('xpath=')) return 'xpath';
  if (s.startsWith('text=')) return 'text';
  if (s.startsWith('#')) return 'id';
  if (/\[data-test/i.test(s)) return 'testIdSelector';
  return 'generalSelector';
}

function selectorsFromMeta(primary: string | null, meta: any): { selectors: StepSelectors; visible: boolean } {
  const selectors = emptySelectors();
  let anyCss = false;
  let anyVisible = false;
  const put = (key: SelectorKey, raw: string): void => {
    if (!raw || !raw.trim()) return;
    if (!selectors[key]) selectors[key] = fromStored(key, raw);
    if (key !== 'xpath' && key !== 'text') {
      anyCss = true;
      if (GLUED_VISIBLE_RE.test(raw.trim())) anyVisible = true;
    }
  };
  const byKey = meta && typeof meta.byKey === 'object' && meta.byKey ? meta.byKey : null;
  if (byKey) {
    for (const key of SELECTOR_KEYS) if (typeof byKey[key] === 'string') put(key, byKey[key]);
  }
  // `byKey` already holds every recorded candidate (primary and secondaries are derived from it), so guessing
  // from those would only duplicate values into the wrong field. Only steps recorded before `byKey` existed need it.
  if (!SELECTOR_KEYS.some((k) => selectors[k])) {
    if (primary) put(guessKey(primary), primary);
    for (const sec of Array.isArray(meta?.secondarySelectors) ? meta.secondarySelectors : []) {
      if (typeof sec === 'string' && !sec.startsWith('select2text:')) put(guessKey(sec), sec);
    }
  }
  // No CSS selector at all: default to visible so a newly typed one behaves like recorded ones.
  return { selectors, visible: anyCss ? anyVisible : true };
}

/** Which selector the code's positional argument carries: the first filled one in the project's priority. */
function primarySelector(step: EditableStep, priority: readonly string[]): string {
  const order = [...priority, ...SELECTOR_KEYS];
  for (const key of order) {
    if (!(SELECTOR_KEYS as readonly string[]).includes(key)) continue;
    const k = key as SelectorKey;
    const stored = toStored(k, step.selectors[k], step.visible);
    if (stored) return k === 'text' ? `text=${stored}` : stored;
  }
  return '';
}

/* ------------------------------------------------------------------ parse */

const CALL_RE = /^await\s+pw\.(\w+)\((.*)\);?\s*$/;
const DISABLED_PREFIX = '// @disabled ';

function parseArgs(args: string): unknown[] | null {
  try {
    const v = JSON.parse(`[${args}]`);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function stepFromCall(method: string, args: unknown[], meta: any, rawLine: string): EditableStep {
  const step = newStep('raw');
  step.raw = rawLine;
  step.countsMeta = META_METHODS.includes(method);
  const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
  const bool = (v: unknown): boolean => v === true;

  const setSel = (primary: unknown): void => {
    const { selectors, visible } = selectorsFromMeta(typeof primary === 'string' && primary ? primary : null, meta);
    step.selectors = selectors;
    step.visible = visible;
  };

  switch (method) {
    case 'load':
      step.action = 'load';
      step.value = str(args[0]);
      break;
    case 'wait':
      step.action = 'wait';
      step.value = str(args[0]);
      break;
    case 'resize':
      step.action = 'resize';
      step.value = str(args[0]);
      step.value2 = str(args[1]);
      break;
    case 'click':
    case 'doubleClick':
    case 'rightClick':
    case 'hover':
      step.action = method;
      setSel(args[0]);
      step.causesNavigation = bool(args[1]);
      break;
    case 'type':
    case 'fill':
    case 'select':
      step.action = method;
      setSel(args[0]);
      step.value = str(args[1]);
      step.causesNavigation = bool(args[2]);
      break;
    case 'keydown':
      step.action = 'keydown';
      setSel(args[0]);
      step.value = str(args[1]);
      step.causesNavigation = bool(args[2]);
      break;
    case 'select2':
      step.action = 'select2';
      setSel(args[0]);
      step.value = str(args[1]);
      step.valueIsNumber = typeof args[1] === 'number';
      step.causesNavigation = bool(args[2]);
      break;
    case 'clearInput':
      step.action = 'clearInput';
      setSel(args[0]);
      break;
    default:
      return step; // unknown method: kept verbatim as a raw step
  }
  step.raw = undefined;
  if (meta && typeof meta === 'object') {
    if (typeof meta.textHint === 'string') step.textHint = meta.textHint;
    if (typeof meta.tagHint === 'string') step.tagHint = meta.tagHint;
    if (meta.timeout) step.timeout = String(meta.timeout);
    if (meta.waitBeforeMs) step.waitBeforeMs = String(meta.waitBeforeMs);
    step.skipOnFailure = meta.skipOnFailure === true;
  }
  return step;
}

/** Splits builder-format code into head / steps / foot and pairs each selector-bearing line with its steps_json entry. */
export function parseBuilderTest(code: string, stepsJson: string | null | undefined): ParsedBuilderTest | null {
  const lines = code.split('\n');
  const ctor = lines.findIndex((l) => /const\s+pw\s*=\s*new\s+PlaywrightBuilder\(/.test(l));
  if (ctor === -1) return null;
  let end = lines.length - 1;
  while (end > ctor && lines[end].trim() === '') end--;
  if (end <= ctor || !/^\}\);?\s*$/.test(lines[end].trim())) return null;

  let metas: any[] = [];
  try {
    const parsed = stepsJson ? JSON.parse(stepsJson) : [];
    if (Array.isArray(parsed)) metas = parsed;
  } catch {
    metas = [];
  }

  const steps: EditableStep[] = [];
  let metaIndex = 0;
  for (const rawLine of lines.slice(ctor + 1, end)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith(DISABLED_PREFIX)) {
      try {
        const saved = JSON.parse(line.slice(DISABLED_PREFIX.length)) as { line: string; meta?: unknown };
        const m = CALL_RE.exec(String(saved.line).trim());
        const args = m ? parseArgs(m[2]) : null;
        if (m && args) {
          const step = stepFromCall(m[1], args, saved.meta ?? null, String(saved.line));
          if (step.action !== 'raw') {
            step.enabled = false;
            steps.push(step);
            continue;
          }
        }
      } catch {
        /* falls through to a raw comment line */
      }
      const raw = newStep('raw');
      raw.raw = line;
      raw.countsMeta = false;
      steps.push(raw);
      continue;
    }

    const m = CALL_RE.exec(line);
    if (!m) {
      const raw = newStep('raw');
      raw.raw = line;
      raw.countsMeta = false;
      steps.push(raw);
      continue;
    }
    const counts = META_METHODS.includes(m[1]);
    const meta = counts ? metas[metaIndex++] ?? null : null;
    const args = parseArgs(m[2]);
    if (!args) {
      const raw = newStep('raw');
      raw.raw = line;
      raw.countsMeta = counts;
      steps.push(raw);
      continue;
    }
    steps.push(stepFromCall(m[1], args, meta, line));
  }

  return { head: lines.slice(0, ctor + 1).join('\n'), foot: lines.slice(end).join('\n'), steps };
}

/* ------------------------------------------------------------------ serialize */

const q = (v: unknown): string => JSON.stringify(v);

function metaOf(step: EditableStep): Record<string, unknown> | null {
  const byKey: Record<string, string> = {};
  for (const key of SELECTOR_KEYS) {
    const stored = toStored(key, step.selectors[key], step.visible);
    if (stored) byKey[key] = stored;
  }
  const meta: Record<string, unknown> = {};
  if (Object.keys(byKey).length) meta.byKey = byKey;
  if (step.textHint) meta.textHint = step.textHint;
  if (step.tagHint) meta.tagHint = step.tagHint;
  const timeout = Number(step.timeout);
  if (timeout > 0) meta.timeout = timeout;
  const wait = Number(step.waitBeforeMs);
  if (wait > 0) meta.waitBeforeMs = wait;
  if (step.skipOnFailure) meta.skipOnFailure = true;
  return Object.keys(meta).length ? meta : null;
}

function callLine(step: EditableStep, priority: readonly string[]): string {
  const nav = step.causesNavigation;
  const sel = q(primarySelector(step, priority));
  const num = (v: string, fallback: number): number => (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : fallback);
  switch (step.action) {
    case 'load':
      return `await pw.load(${q(step.value)});`;
    case 'wait':
      return `await pw.wait(${num(step.value, 0)});`;
    case 'resize':
      return `await pw.resize(${num(step.value, 1280)}, ${num(step.value2, 720)});`;
    case 'click':
    case 'doubleClick':
    case 'rightClick':
    case 'hover':
      return `await pw.${step.action}(${sel}, ${nav});`;
    case 'type':
    case 'fill':
    case 'select':
      return `await pw.${step.action}(${sel}, ${q(step.value)}, ${nav});`;
    case 'keydown':
      return `await pw.keydown(${sel === '""' ? 'null' : sel}, ${q(step.value)}, ${nav});`;
    case 'select2':
      return `await pw.select2(${sel}, ${step.valueIsNumber && step.value.trim() !== '' ? num(step.value, 0) : q(step.value)}, ${nav});`;
    case 'clearInput':
      return `await pw.clearInput(${sel});`;
    default:
      return step.raw ?? '';
  }
}

export function serializeBuilderTest(parsed: ParsedBuilderTest, priority: readonly string[]): { code: string; steps: (Record<string, unknown> | null)[] | null } {
  const body: string[] = [];
  const steps: (Record<string, unknown> | null)[] = [];
  for (const step of parsed.steps) {
    if (step.action === 'raw') {
      body.push(`  ${step.raw ?? ''}`);
      if (step.countsMeta) steps.push(null);
      continue;
    }
    const meta = hasSelector(step.action) ? metaOf(step) : null;
    const line = callLine(step, priority);
    if (!step.enabled) {
      // Kept as a comment (the runner ignores it) with everything needed to restore it.
      body.push(`  ${DISABLED_PREFIX}${q({ line, meta })}`);
      continue;
    }
    body.push(`  ${line}`);
    if (hasSelector(step.action)) steps.push(meta);
  }
  const code = [parsed.head, ...body, parsed.foot].join('\n');
  return { code, steps: steps.some((m) => m !== null) ? steps : null };
}

/* ------------------------------------------------------------------ display helpers */

export function stepPrimaryLabel(step: EditableStep, priority: readonly string[]): string {
  if (step.action === 'raw') return step.raw ?? '';
  if (step.action === 'load') return step.value;
  if (step.action === 'wait') return `${step.value || 0}ms`;
  if (step.action === 'resize') return `${step.value} × ${step.value2}`;
  return primarySelector(step, priority) || '—';
}

/** Value shown after the arrow in the step list (typed text, key, option...). */
export function stepDetail(step: EditableStep): string | undefined {
  if (['fill', 'type', 'select', 'select2', 'keydown'].includes(step.action) && step.value) return step.value;
  return undefined;
}
