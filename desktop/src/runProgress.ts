/**
 * Progress of a local run, derived from what the runner already prints: one `[insightest] <Action> <selector>` line
 * each time an action STARTS (retries and fallbacks are marked "Retry n/3" / "Fallback" and are not counted).
 * The total is the number of logged actions in the test's own code plus every prerequisite test that runs before it.
 */

// PlaywrightBuilder actions that log a start line (a keydown without a selector goes straight to the keyboard: no log).
const BUILDER_LOGGED_RE = /^\s*await\s+pw\.(?:load|click|doubleClick|rightClick|hover|type|fill|select|select2|clearInput|keydown\((?!null))/gm;
// Older page.locator(...) recordings: only the actions go through the logging engine (page.goto does not).
const LEGACY_LOGGED_RE = /^\s*await\s+page\.[^\n;]*?\.(?:click|fill|dblclick|check|uncheck|selectOption|press|hover|tap|type|setInputFiles|selectText)\(/gm;

/** Number of actions in one test's code that will print a start line when executed. */
export function countLoggedActions(code: string): number {
  const builder = code.match(BUILDER_LOGGED_RE)?.length ?? 0;
  const legacy = code.match(LEGACY_LOGGED_RE)?.length ?? 0;
  return builder + legacy;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const START_LINE_RE =
  /\[insightest\]\s+(?:Click destro|Click|Fill|Svuota|Doppio click|Check|Uncheck|Seleziona opzione|Premi tasto|Hover|Tap|Digita|Carica file|Seleziona testo|Naviga)\b/;

/** How many actions have started so far, counted from the live output. */
export function countStartedActions(lines: string[]): number {
  let started = 0;
  for (const raw of lines) {
    const line = raw.replace(ANSI_RE, '');
    if (START_LINE_RE.test(line) && !/\[insightest\]\s+Retry \d\/\d:/.test(line)) started++;
  }
  return started;
}

/** 0..100 while running: the action in flight counts as half done, so the ring moves as soon as a step starts. */
export function runningPercent(started: number, total: number): number {
  if (total <= 0 || started <= 0) return 0;
  const done = Math.min(started, total) - 0.5;
  return Math.max(0, Math.min(99, Math.round((done / total) * 100)));
}
