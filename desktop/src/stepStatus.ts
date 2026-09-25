/** Per-step outcome of a run, reconstructed from its stored log: green / red / grey. */
export type StepStatus = 'passed' | 'failed' | 'skipped';

export interface StatusStep {
  action: string;
  /** The step's source line, trimmed (as written in the recorded code). */
  raw: string;
  /** `page.<locator chain>` for click/fill/... steps; the resilient engine logs it for each action. */
  chain?: string;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ACTION_LOG_RE =
  /\[insightest\]\s+(?:Retry \d\/\d:\s+)?(Click destro|Click|Fill|Svuota|Doppio click|Check|Uncheck|Seleziona opzione|Premi tasto|Hover|Tap|Digita|Carica file|Seleziona testo|Naviga)\b\s*(.*)$/;
const squash = (s: string): string => s.replace(/\s+/g, '');

/**
 * Works out which step a run stopped on. Two signals, in order of precision:
 *  1. the resilient engine's `[insightest] <Action> <selector>` lines (one per attempt), which say
 *     which steps were started and where the final "fallita dopo" failure happened;
 *  2. the `> 123 | <code>` excerpt Playwright prints in the error message, for steps that don't go
 *     through the engine (e.g. legacy recordings).
 * Returns null when the log doesn't allow telling (no statuses are better than wrong ones).
 */
export function computeStepStatuses(steps: StatusStep[], log: string | null | undefined, runStatus: string): StepStatus[] | null {
  if (steps.length === 0) return null;
  if (runStatus === 'passed') return steps.map(() => 'passed');
  if (runStatus !== 'failed' && runStatus !== 'error') return null;
  const lines = (log ?? '').replace(ANSI_RE, '').split(/\r?\n/);

  let failIdx: number | null = null;

  // 1. Engine log lines.
  let pointer = 0;
  let current: number | null = null;
  let currentRetried = false;
  let matchedAny = false;
  let engineFailure = false;
  for (const line of lines) {
    if (/\[insightest\]\s+(Azione|Navigazione) fallita dopo/.test(line)) {
      engineFailure = true;
      continue;
    }
    const m = ACTION_LOG_RE.exec(line);
    if (!m) continue;
    const isRetry = /\[insightest\]\s+Retry \d\/\d:/.test(line);
    if (isRetry) {
      currentRetried = true;
      continue;
    }
    const [, label, rest] = m;
    let found = -1;
    for (let j = pointer; j < steps.length; j++) {
      const step = steps[j];
      const isMatch =
        label === 'Naviga'
          ? step.action === 'load' && (!rest.trim() || squash(step.raw).includes(squash(rest.trim())))
          : !!step.chain && squash(rest) === squash(step.chain);
      if (isMatch) {
        found = j;
        break;
      }
    }
    if (found === -1) continue; // e.g. a dependency test's action, not one of this test's own steps
    matchedAny = true;
    current = found;
    currentRetried = false;
    pointer = found + 1;
  }
  if (matchedAny && current !== null) {
    if (engineFailure || currentRetried) failIdx = current;
    else failIdx = Math.min(current + 1, steps.length - 1); // last started step passed; the next (unlogged) one failed
  }

  // 2. Error excerpt (`> 283 |   await ...`).
  if (failIdx === null) {
    for (const line of lines) {
      const m = /^\s*>\s*\d+\s*\|\s?(.*)$/.exec(line);
      if (!m) continue;
      const code = squash(m[1]);
      const idx = steps.findIndex((s) => squash(s.raw) === code);
      if (idx !== -1) {
        failIdx = idx;
        break;
      }
    }
  }

  if (failIdx === null) return null;
  return steps.map((_, i) => (i < failIdx! ? 'passed' : i === failIdx ? 'failed' : 'skipped'));
}
