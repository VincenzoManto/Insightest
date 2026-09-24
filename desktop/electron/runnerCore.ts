import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface PlaywrightRunResult {
  status: 'passed' | 'failed' | 'error';
  durationMs: number;
  log: string;
  healingDetail?: string;
}

export interface PlaywrightRunOptions {
  headed?: boolean;
  /** Delay (ms) Playwright waits between simulated actions, so a headed run is actually watchable by a person. */
  betweenActionMs?: number;
}

export interface BaselineResult {
  capturedCount: number;
  failedCount: number;
  log: string;
}

export interface HealResult {
  status: 'healed' | 'blocked' | 'unchanged' | 'no-baseline' | 'error';
  summary: string;
  proposedCode?: string;
  /** Whether the proposed rewrite was re-run and actually passes; undefined if not re-run. */
  verified?: boolean;
}

/**
 * This module has no dependency on Electron so it can be loaded both by the desktop app's
 * main process and by the standalone MCP server process; each caller supplies its own paths
 * once at startup via `initRunnerPaths`.
 */
export interface RunnerPaths {
  /** Directory whose node_modules resolves `@playwright/test`/`ia-qa-heal` (this project's own install). */
  appRoot: string;
  /** Persistent directory for per-project ia-qa-heal state; survives across runs. */
  userDataDir: string;
  /** Forward-slash path to liveReporter.js, embedded verbatim into a generated JS config file. */
  liveReporterPath: string;
}

let runnerPaths: RunnerPaths | null = null;

export function initRunnerPaths(paths: RunnerPaths): void {
  runnerPaths = paths;
}

function getPaths(): RunnerPaths {
  if (!runnerPaths) throw new Error('Runner paths not initialized -- call initRunnerPaths() first');
  return runnerPaths;
}

/**
 * `npx playwright` resolves the standalone `playwright` package from its own npx
 * cache (unrelated to this project's `@playwright/test` devDependency), and a plain
 * OS temp dir has no node_modules at all -- either way, spec files can't resolve
 * `@playwright/test`. Instead we run the project's own locally-installed CLI, with
 * scratch dirs created under the app root so Node's module resolution (which walks
 * up looking for node_modules) finds this project's install.
 */
// The CLIs are run as plain JS entry points under this app's own binary (ELECTRON_RUN_AS_NODE, see
// runProcessAsync) rather than through node_modules/.bin shims: the shims aren't shipped in a
// packaged build and would need a separate Node install on the user's machine.
/** Finds `node_modules/<rel>` under appRoot or any parent: npm/npx may hoist dependencies out of the app's own folder. */
export function resolveNodeModule(appRoot: string, rel: string): string {
  let dir = appRoot;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return path.join(appRoot, 'node_modules', rel);
    dir = parent;
  }
}

function playwrightBin(): string {
  return resolveNodeModule(getPaths().appRoot, path.join('@playwright', 'test', 'cli.js'));
}

function iaQaHealBin(): string {
  return resolveNodeModule(getPaths().appRoot, path.join('@ia-qa', 'self-healing', 'dist', 'cli', 'index.js'));
}

const NO_BASELINE_MESSAGE =
  "Analisi non disponibile: questo motore di self-healing ha bisogno di una \"baseline\" " +
  '(una mappa del sito testato) che per ora non viene creata automaticamente per i progetti Insightest. ' +
  "Il log del fallimento resta comunque salvato qui sotto per l'ispezione manuale.";

/**
 * `spawnSync` blocks the entire Electron main process for as long as the child runs
 * (a whole browser test, tens of seconds) -- freezing the app's window, menu, and every
 * other IPC call. `spawn` + this Promise wrapper keeps the same "wait for the result"
 * call shape for callers while letting Electron's event loop keep servicing the UI.
 */
function runProcessAsync(
  bin: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string; onLine?: (line: string) => void }
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve, reject) => {
    const isScript = bin.endsWith('.js');
    const child = isScript
      ? spawn(process.execPath, [bin, ...args], {
          cwd: options.cwd,
          env: { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' },
        })
      : spawn(bin, args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          shell: process.platform === 'win32',
        });
    let stdout = '';
    let stderr = '';
    // Line-buffers stdout so the caller (the desktop UI's live progress panel) gets one
    // callback per printed line as it happens, instead of only the full text at the end.
    let lineBuf = '';
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (options.onLine) {
        lineBuf += text;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() ?? '';
        for (const line of lines) options.onLine(line);
      }
    });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (options.onLine && lineBuf) options.onLine(lineBuf);
      resolve({ stdout, stderr, status: code });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/** Recorded code is `test('...', async ({ page }) => { <body> });`; brace-counting (not
 * regex) survives nested braces in the body, e.g. `.click({ button: 'right' })`. Used to
 * chain a prerequisite test's steps into the same page/session without duplicating them
 * in storage (see `depends_on_test_id`). The marker requires the `async` keyword right
 * before the arrow so it anchors to the test()'s own callback, not some earlier plain arrow
 * function (e.g. legacy-imported code's `page.on('response', (response) => {` helper). */
function extractTestBody(code: string): string {
  const markerMatch = /async\s*\([^)]*\)\s*=>\s*\{/.exec(code);
  if (!markerMatch) throw new Error('Could not locate test body in recorded code');
  let depth = 1;
  let i = markerMatch.index + markerMatch[0].length;
  for (; i < code.length && depth > 0; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
  }
  return code.slice(markerMatch.index + markerMatch[0].length, i - 1);
}

/**
 * Classifies a failed run's log via `ia-qa-heal explain`: a read-only, offline check
 * that intersects the failure text against known locators to say whether this looks
 * like selector drift (a locator that used to work and stopped) versus a real bug.
 * Never rewrites anything; without a project baseline (not yet set up) it just says so.
 * Exported so the UI can also trigger this on-demand against an already-stored run log.
 *
 * The log is piped via stdin rather than passed as a `--message` argv value: on Windows
 * this spawn goes through `cmd.exe` (required for a .cmd shim), which re-tokenizes a
 * multi-line/quoted argument on whitespace and newlines, so `--message` would end up
 * followed by a stray token (often starting with "-", e.g. a Playwright "- waiting for
 * locator..." log line) and the CLI would reject it with "--message needs a value.".
 */
export async function explainFailure(log: string): Promise<string | undefined> {
  const result = await runProcessAsync(iaQaHealBin(), ['explain'], { cwd: getPaths().appRoot, input: log });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (!output) return undefined;
  // `ia-qa-heal` refuses to classify anything without a project "baseline" (a snapshot of
  // the target site's DOM, captured via `ia-qa-heal init`/`map`) -- something Insightest
  // doesn't set up per-project yet. Surface a plain-language explanation instead of the
  // raw CLI wording, which reads like a bug report about this app's own install folder.
  if (/not an ia-qa-heal project/i.test(output) || /No \.ia-qa\//i.test(output)) {
    return NO_BASELINE_MESSAGE;
  }
  return output;
}

function makeScratchDir(prefix: string): string {
  const base = path.join(getPaths().appRoot, '.insightest-tmp');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

/**
 * Persistent root for a project's ia-qa-heal state (`.ia-qa/`: config, baseline, capture
 * shards) -- unlike `makeScratchDir` above, this must survive across runs, so it lives under
 * the injected userData dir instead of a temp folder that gets deleted at the end of every run.
 */
function iaQaProjectDir(projectId: number): string {
  const dir = path.join(getPaths().userDataDir, 'ia-qa-projects', String(projectId));
  fs.mkdirSync(path.join(dir, '.ia-qa'), { recursive: true });
  return dir;
}

/**
 * Writes/refreshes `.ia-qa/config.json` with the project's baseUrl. Capture-during-run (see
 * `runWithCapture`) never needs `config.pages` declared -- coverage is whatever the suite visits.
 */
function ensureIaQaConfig(projectId: number, baseUrl: string): string {
  const projectDir = iaQaProjectDir(projectId);
  const configPath = path.join(projectDir, '.ia-qa', 'config.json');
  let existingBaseUrl: string | undefined;
  try {
    existingBaseUrl = JSON.parse(fs.readFileSync(configPath, 'utf8')).baseUrl;
  } catch {
    // No config yet, or unreadable -- (re)write it below.
  }
  if (existingBaseUrl !== baseUrl) {
    fs.writeFileSync(configPath, JSON.stringify({ baseUrl }, null, 2), 'utf8');
  }
  return projectDir;
}

function hasBaseline(projectDir: string): boolean {
  const baselineDir = path.join(projectDir, '.ia-qa', 'baseline');
  return fs.existsSync(baselineDir) && fs.readdirSync(baselineDir).length > 0;
}

/** Recorded/template code always starts `import { test, expect } from '@playwright/test';` --
 * swap it for the capture-instrumented re-export so the run records the live DOM as it goes,
 * inert unless IAQA_CAPTURE=1 (set by the caller below). */
function withCaptureImport(code: string): string {
  const re = /^import\s*\{\s*test\s*,\s*expect\s*\}\s*from\s*['"]@playwright\/test['"];?/m;
  return re.test(code)
    ? code.replace(re, "import { test, expect } from '@ia-qa/self-healing/capture';")
    : `import { test, expect } from '@ia-qa/self-healing/capture';\n${code}`;
}

/** Engine-level fix (applies to EVERY test run through this function -- hand-recorded or
 * legacy-imported, not tied to any per-test helper): recorded selectors sometimes point at a
 * wrapper element (e.g. a styled div/label around the real <input>) rather than the writable
 * element itself. Wraps whichever `{ test, expect }` import is currently at the top of the code
 * (plain @playwright/test, or already swapped by withCaptureImport above) with a `page` fixture
 * override that patches the shared Locator.prototype once per worker, so `.fill()` redirects to
 * the nearest writable (input/textarea/select/[contenteditable]) descendant instead of throwing. */
function withSmartFill(code: string): string {
  const re = /^import\s*\{\s*test\s*,\s*expect\s*\}\s*from\s*(['"])([^'"]+)\1;?/m;
  const match = re.exec(code);
  const specifier = match ? match[2] : '@playwright/test';
  const header =
    `import { test as __insightestBaseTest, expect } from '${specifier}';\n\n` +
    `function __insightestEnsureSmartFill(page) {\n` +
    `  const proto = Object.getPrototypeOf(page.locator('body'));\n` +
    `  if (proto.__insightestSmartFill) return;\n` +
    `  const originalFill = proto.fill;\n` +
    `  proto.fill = async function (...args) {\n` +
    `    const isFillable = await this.evaluate((el) => el.matches('input, textarea, select, [contenteditable]')).catch(() => true);\n` +
    `    if (isFillable) return originalFill.apply(this, args);\n` +
    `    const nested = this.locator('input, textarea, select, [contenteditable]').first();\n` +
    `    const nestedCount = await nested.count().catch(() => 0);\n` +
    `    if (nestedCount === 0) return originalFill.apply(this, args);\n` +
    `    console.warn('[insightest] target is not writable, filling nearest writable descendant instead');\n` +
    `    return originalFill.apply(nested, args);\n` +
    `  };\n` +
    `  proto.__insightestSmartFill = true;\n` +
    `}\n\n` +
    `const test = __insightestBaseTest.extend({\n` +
    `  page: async ({ page }, use) => {\n` +
    `    __insightestEnsureSmartFill(page);\n` +
    `    await use(page);\n` +
    `  },\n` +
    `});`;
  return match ? code.replace(re, header) : `${header}\n${code}`;
}

// Action methods eligible for call-site rewriting into the resilient-action engine below.
// Kept in sync with the identical list in ci-runner/runner.js / backend/public/ci-runner/runner.js.
const ACTION_METHODS = ['click', 'fill', 'dblclick', 'check', 'uncheck', 'selectOption', 'press', 'hover', 'tap', 'type', 'setInputFiles', 'selectText'];
const ACTION_LABELS: Record<string, string> = {
  click: 'Click',
  fill: 'Fill',
  dblclick: 'Double-click',
  check: 'Check',
  uncheck: 'Uncheck',
  selectOption: 'Select option on',
  press: 'Press key on',
  hover: 'Hover',
  tap: 'Tap',
  type: 'Type into',
  setInputFiles: 'Set files on',
  selectText: 'Select text on',
};
const ACTION_LINE_RE = new RegExp(`^(\\s*)await\\s+(page\\.[^\\n;]*?)\\.(${ACTION_METHODS.join('|')})\\((.*)\\);\\s*$`, 'gm');

/** select2 renders its dropdown in a transient overlay under <body> (outside the app root), and
 * codegen records the picked option as a positional xpath into it (`xpath=//html/body//span[1]/
 * span[1]/span[2]/ul[1]/li[2]`) that doesn't resolve reliably on replay. Rewrites that click into
 * "wait for the open dropdown's option, then click it by index" -- the same thing the legacy
 * puppeteer helper did. Keeps exactly one action line per original click (the added waitFor isn't
 * an ACTION_METHODS call), so steps_json indexes stay aligned. Keep in sync with ci-runner/runner.js. */
const SELECT2_OPTION_CLICK_RE = /^(\s*)await\s+page\.locator\((['"])xpath=\/\/html\/body(?![^\n]*app-root)[^\n'"]*?\/ul\[\d+\]\/li\[(\d+)\][^\n'"]*\2\)\.click\(([^)\n]*)\);\s*$/gm;
function normalizeSelect2Options(code: string): string {
  return code.replace(SELECT2_OPTION_CLICK_RE, (_m, indent: string, _q: string, pos: string, args: string) => {
    const option = `page.locator('.select2-results__options:visible > li').nth(${Number(pos) - 1})`;
    return `${indent}await ${option}.waitFor({ state: 'visible' });\n${indent}await ${option}.click(${args});`;
  });
}

export interface ResilientStepMeta {
  secondarySelectors?: string[];
  textHint?: string;
  tagHint?: string;
}

/** For a select2 option click normalized above: when the record-time capture stored the option's
 * text (steps_json textHint), pick the option BY TEXT (exact match first, like the legacy puppeteer
 * helper's `contains(., value)` but stricter), falling back to "contains" and finally to the
 * original index via secondary selectors. Returns null for any other chain / no text. */
const SELECT2_INDEX_CHAIN_RE = /^page\.locator\('\.select2-results__options:visible > li'\)\.nth\((\d+)\)$/;
function select2ByText(chain: string, meta: ResilientStepMeta | null | undefined): { chain: string; meta: ResilientStepMeta } | null {
  const m = SELECT2_INDEX_CHAIN_RE.exec(chain.trim());
  const text = meta && meta.textHint ? String(meta.textHint).trim() : '';
  if (!m || !text) return null;
  const quoted = JSON.stringify(text);
  const exactSel = '.select2-results__option:visible:text-is(' + quoted + ')';
  return {
    chain: 'page.locator(' + JSON.stringify(exactSel) + ').first()',
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

/**
 * Rewrites each top-level `await page.<chain>.<method>(<args>);` action call into a call
 * through the `__insightestAction` engine injected by `withResilientActions` below, so every
 * recorded action gets the retry -> secondary-selector -> similarity-fallback behavior instead
 * of failing outright. `steps` is the per-test array of `ResilientStepMeta` captured at record
 * time (via the Phase-2 augmentation pass); absent/null steps degrade gracefully (no secondary
 * selectors or text-hint fallback, but the retry-then-fail behavior still applies).
 */
function instrumentResilientActions(code: string, steps: ResilientStepMeta[] | null | undefined): string {
  let stepIndex = 0;
  return code.replace(ACTION_LINE_RE, (_match, indent: string, chain: string, action: string, args: string) => {
    let stepMeta: ResilientStepMeta = steps && steps[stepIndex] ? steps[stepIndex] : {};
    stepIndex += 1;
    const byText = action === 'click' ? select2ByText(chain, stepMeta) : null;
    if (byText) {
      chain = byText.chain;
      stepMeta = byText.meta;
    }
    const actionLabel = ACTION_LABELS[action] || action;
    const chainLabel = JSON.stringify(chain);
    const metaJson = JSON.stringify(stepMeta);
    return `${indent}await __insightestAction(page, () => ${chain}, ${chainLabel}, (___loc) => ___loc.${action}(${args}), ${JSON.stringify(actionLabel)}, ${metaJson});`;
  });
}

/**
 * Injects the resilient-action engine (retry same selector once, then try recorded secondary
 * selectors ranked by similarity, then a live DOM rescan by text similarity, else fail) and
 * rewrites every recorded action call site to route through it. Mirrors the identical engine
 * in ci-runner/runner.js's writeCombinedSpec -- keep both in sync.
 */
function withResilientActions(code: string, steps: ResilientStepMeta[] | null | undefined): string {
  const instrumented = instrumentResilientActions(normalizeSelect2Options(code), steps);
  const engine =
    `function __insightestSimilarity(a, b) {\n` +
    `  a = String(a || '').toLowerCase().trim();\n` +
    `  b = String(b || '').toLowerCase().trim();\n` +
    `  if (!a || !b) return 0;\n` +
    `  const m = a.length, n = b.length;\n` +
    `  const d = [];\n` +
    `  for (let i = 0; i <= m; i++) d[i] = [i];\n` +
    `  for (let j = 0; j <= n; j++) d[0][j] = j;\n` +
    `  for (let i = 1; i <= m; i++) {\n` +
    `    for (let j = 1; j <= n; j++) {\n` +
    `      d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);\n` +
    `    }\n` +
    `  }\n` +
    `  return 1 - d[m][n] / Math.max(m, n);\n` +
    `}\n\n` +
    `async function __insightestFindBySimilarity(page, textHint, tagHint) {\n` +
    `  if (!textHint) return null;\n` +
    `  return page\n` +
    `    .evaluate(({ textHint, tagHint }) => {\n` +
    `      function similarity(a, b) {\n` +
    `        a = String(a || '').toLowerCase().trim();\n` +
    `        b = String(b || '').toLowerCase().trim();\n` +
    `        if (!a || !b) return 0;\n` +
    `        const m = a.length, n = b.length;\n` +
    `        const d = [];\n` +
    `        for (let i = 0; i <= m; i++) d[i] = [i];\n` +
    `        for (let j = 0; j <= n; j++) d[0][j] = j;\n` +
    `        for (let i = 1; i <= m; i++) {\n` +
    `          for (let j = 1; j <= n; j++) {\n` +
    `            d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);\n` +
    `          }\n` +
    `        }\n` +
    `        return 1 - d[m][n] / Math.max(m, n);\n` +
    `      }\n` +
    `      const selector = tagHint || 'button, a, input, select, textarea, [role], label, [onclick]';\n` +
    `      let best = null;\n` +
    `      for (const el of document.querySelectorAll(selector)) {\n` +
    `        const text = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.getAttribute('value') || '').trim();\n` +
    `        if (!text) continue;\n` +
    `        const score = similarity(text, textHint);\n` +
    `        if (score > 0.55 && (!best || score > best.score)) {\n` +
    `          let sel;\n` +
    `          if (el.id) {\n` +
    `            sel = '#' + CSS.escape(el.id);\n` +
    `          } else {\n` +
    `            const tag = el.tagName.toLowerCase();\n` +
    `            const siblings = Array.from(el.parentElement ? el.parentElement.children : []).filter((s) => s.tagName === el.tagName);\n` +
    `            sel = tag + ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';\n` +
    `          }\n` +
    `          best = { selector: sel, score };\n` +
    `        }\n` +
    `      }\n` +
    `      return best;\n` +
    `    }, { textHint, tagHint })\n` +
    `    .catch(() => null);\n` +
    `}\n\n` +
    `async function __insightestAction(page, primaryBuild, primaryLabel, perform, actionLabel, stepMeta) {\n` +
    `  const betweenActionMs = Number(process.env.INSIGHTEST_BETWEEN_ACTION_MS || 0);\n` +
    `  let lastError;\n` +
    `  for (let attempt = 1; attempt <= 2; attempt++) {\n` +
    `    const prefix = attempt === 1 ? '' : 'Retry ' + attempt + '/3: ';\n` +
    `    console.log('[insightest] ' + prefix + actionLabel + ' ' + primaryLabel);\n` +
    `    try {\n` +
    `      await perform(primaryBuild());\n` +
    `      return;\n` +
    `    } catch (e) {\n` +
    `      lastError = e;\n` +
    `      console.warn('[insightest] Tentativo ' + attempt + '/3 fallito: ' + actionLabel + ' ' + primaryLabel + ' -- ' + (e && e.message ? e.message.split('\\n')[0] : e));\n` +
    `      if (attempt === 1 && betweenActionMs > 0) await new Promise((r) => setTimeout(r, betweenActionMs));\n` +
    `    }\n` +
    `  }\n` +
    `  const secondary = (stepMeta && stepMeta.secondarySelectors) || [];\n` +
    `  const ranked = secondary\n` +
    `    .map((sel) => ({ sel, score: __insightestSimilarity(sel, primaryLabel) }))\n` +
    `    .sort((a, b) => b.score - a.score);\n` +
    `  for (const { sel, score } of ranked) {\n` +
    `    console.log('[insightest] Fallback 3/3 (selettore secondario, similarita ' + score.toFixed(2) + '): ' + actionLabel + ' ' + sel);\n` +
    `    try {\n` +
    `      await perform(page.locator(sel));\n` +
    `      return;\n` +
    `    } catch (e) {\n` +
    `      lastError = e;\n` +
    `    }\n` +
    `  }\n` +
    `  if (ranked.length === 0 && stepMeta && stepMeta.textHint) {\n` +
    `    const best = await __insightestFindBySimilarity(page, stepMeta.textHint, stepMeta.tagHint);\n` +
    `    if (best) {\n` +
    `      console.log('[insightest] Fallback 3/3 (similarita ' + best.score.toFixed(2) + '): ' + actionLabel + ' ' + best.selector);\n` +
    `      try {\n` +
    `        await perform(page.locator(best.selector));\n` +
    `        return;\n` +
    `      } catch (e) {\n` +
    `        lastError = e;\n` +
    `      }\n` +
    `    }\n` +
    `  }\n` +
    `  console.error('[insightest] Azione fallita dopo 3 tentativi: ' + actionLabel + ' ' + primaryLabel);\n` +
    `  throw lastError;\n` +
    `}`;
  return `${engine}\n\n${instrumented}`;
}

// Playwright's JSON report nests specs inside suites, which can themselves be nested
// (e.g. one suite per file, one per describe block), so we walk the tree recursively.
function findFirstSpec(suites: any[] | undefined): any {
  for (const suite of suites ?? []) {
    if (suite.specs?.length) return suite.specs[0];
    const nested = findFirstSpec(suite.suites);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Writes `source` to a throwaway temp directory, runs it with the Playwright test runner,
 * and parses the JSON report. Shared by the plain "rerun locally" path and the
 * capture-during-run path (`runWithCapture`), which only differ in the source's import and
 * a couple of extra env vars. Caller owns cleanup of the returned `workDir`.
 */
async function executeSpec(
  source: string,
  options: PlaywrightRunOptions,
  extraEnv: NodeJS.ProcessEnv = {},
  onLine?: (line: string) => void,
  steps?: ResilientStepMeta[] | null
): Promise<{ status: PlaywrightRunResult['status']; durationMs: number; log: string; workDir: string }> {
  const workDir = makeScratchDir('run-');
  const specFileName = 'local.spec.ts';
  const specPath = path.join(workDir, specFileName);
  const reportPath = path.join(workDir, 'report.json');
  const configPath = path.join(workDir, 'playwright.config.js');
  fs.writeFileSync(specPath, withSmartFill(withResilientActions(source, steps)), 'utf8');
  // Playwright's default 30s per-test timeout counts the *whole* test body, including any
  // dependency test spliced in by the caller and every explicit `waitForTimeout()` from the
  // legacy recording -- both easily blow past 30s on their own, so the budget must scale with
  // what's actually in the generated file instead of being fixed.
  const explicitWaitMs = [...source.matchAll(/waitForTimeout\((\d+)\)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  const actionCount = (source.match(/^\s*await /gm) ?? []).length;
  const slowMoOverheadMs = actionCount * Math.max(0, options.betweenActionMs ?? 0);
  const timeoutMs = Math.max(30000, Math.round((explicitWaitMs + slowMoOverheadMs) * 1.5) + 30000);
  const liveReporterPath = getPaths().liveReporterPath;
  const reportPathForConfig = reportPath.replace(/\\/g, '/');
  // A dedicated config (rather than bare CLI flags) is needed for the inter-action delay
  // (`launchOptions.slowMo` has no CLI/env switch) and to combine the live step reporter with
  // the JSON reporter this function parses below -- `--reporter=json` on the CLI would replace
  // the config's `reporter` array instead of adding to it.
  fs.writeFileSync(
    configPath,
    `module.exports = {\n` +
      `  timeout: ${timeoutMs},\n` +
      `  reporter: [['${liveReporterPath}'], ['json', { outputFile: '${reportPathForConfig}' }]],\n` +
      `  use: { launchOptions: { slowMo: ${Math.max(0, options.betweenActionMs ?? 0)} } },\n` +
      `};\n`,
    'utf8'
  );

  const args = ['test', specFileName, '--config', configPath];
  if (options.headed) args.push('--headed');

  const startedAt = Date.now();
  // Pass a bare filename (not the absolute path): Playwright matches CLI file args
  // against POSIX-normalized relative paths, so an absolute Windows path (backslashes)
  // never matches and the run fails with "No tests found".
  const result = await runProcessAsync(playwrightBin(), args, {
    cwd: workDir,
    env: {
      ...process.env,
      // Same betweenActionMs value drives both Playwright's own slowMo (config above) and
      // the resilient-action engine's retry-wait sleep -- there is no separate "slowMo" knob.
      INSIGHTEST_BETWEEN_ACTION_MS: String(Math.max(0, options.betweenActionMs ?? 0)),
      ...extraEnv,
    },
    onLine,
  });
  const durationMs = Date.now() - startedAt;

  let status: PlaywrightRunResult['status'] = 'error';
  const log = [result.stdout, result.stderr].filter(Boolean).join('\n');

  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    // Playwright's JSON reporter nests specs inside suites (which can themselves be
    // nested for describe blocks), and the per-test verdict is a `status` field with
    // values 'expected' | 'unexpected' | 'flaky' | 'skipped' (there is no `outcome` field).
    const spec = findFirstSpec(report.suites);
    const outcome = spec?.tests?.[0]?.status;
    if (outcome === 'expected' || outcome === 'flaky') status = 'passed';
    else if (outcome === 'unexpected') status = 'failed';
    else status = 'error';
  } catch {
    status = result.status === 0 ? 'passed' : 'error';
  }

  return { status, durationMs, log, workDir };
}

/**
 * Runs a single Playwright test's source locally.
 * This is the "rerun locally" path used from the desktop UI (not the deterministic CI path).
 */
export async function runPlaywrightTest(
  playwrightCode: string,
  options: PlaywrightRunOptions = {},
  dependencyCodes?: string[],
  onLine?: (line: string) => void,
  steps?: ResilientStepMeta[] | null
): Promise<PlaywrightRunResult> {
  // Each ancestor's own steps run first, in the same test/page (oldest ancestor first), so
  // its session (login cookies, storage) carries over -- without ever storing its steps
  // inside this test. `dependencyCodes` is the whole depends_on_test_id chain, not just the
  // immediate predecessor: a predecessor can itself depend on another test.
  const dependencyBodies = (dependencyCodes ?? []).map(extractTestBody).join('\n');
  // Same anchoring as extractTestBody above: must require `async` before the arrow, or this
  // would splice into the first plain arrow callback in the file instead of the test's own.
  const finalSource = dependencyBodies
    ? playwrightCode.replace(/(async\s*\([^)]*\)\s*=>\s*\{)/, `$1\n${dependencyBodies}\n`)
    : playwrightCode;

  const { workDir, ...result } = await executeSpec(finalSource, options, {}, onLine, steps);
  fs.rmSync(workDir, { recursive: true, force: true });
  // Only worth classifying an actual failure; a passed/errored-before-running-anything
  // run has no drift-vs-bug question to answer.
  const healingDetail = result.status === 'failed' ? await explainFailure(result.log) : undefined;
  return { ...result, healingDetail };
}

/**
 * Runs `playwrightCode` with ia-qa-heal's capture instrumentation, recording the live app's
 * DOM into `<projectDir>/.ia-qa/mapping/.capture/` as the test visits it (inert unless
 * IAQA_CAPTURE=1, set here). Used both to build/refresh a project's baseline and, before
 * healing a single failing test, to capture the app's *current* state to diff against it.
 */
async function runWithCapture(
  playwrightCode: string,
  projectDir: string,
  options: PlaywrightRunOptions = {},
  onLine?: (line: string) => void
): Promise<{ status: PlaywrightRunResult['status']; durationMs: number; log: string }> {
  const source = withCaptureImport(playwrightCode);
  // IAQA_CONFIG_DIR is the directory that *holds* `.ia-qa/` (same meaning as `--config`/cwd
  // for the CLI commands below) -- not `.ia-qa/` itself.
  const { workDir, ...result } = await executeSpec(
    source,
    options,
    { IAQA_CAPTURE: '1', IAQA_CONFIG_DIR: projectDir },
    onLine
  );
  fs.rmSync(workDir, { recursive: true, force: true });
  return result;
}

/**
 * Captures every given test with IAQA_CAPTURE=1, then promotes that capture to the project's
 * `.ia-qa/baseline/` -- the reference `healTest` diffs future captures against. Call this once
 * up front (project has no baseline yet) and again whenever the app's UI legitimately changes.
 */
export async function createOrUpdateBaseline(
  projectId: number,
  baseUrl: string,
  tests: { id: number; playwright_code: string }[],
  onLine?: (line: string) => void
): Promise<BaselineResult> {
  const projectDir = ensureIaQaConfig(projectId, baseUrl);
  let capturedCount = 0;
  let failedCount = 0;
  const logs: string[] = [];
  for (const [i, t] of tests.entries()) {
    onLine?.(`▶▶ Cattura test ${i + 1}/${tests.length} (id ${t.id})`);
    const result = await runWithCapture(t.playwright_code, projectDir, {}, onLine);
    if (result.status === 'passed') {
      capturedCount++;
    } else {
      failedCount++;
      logs.push(`Test ${t.id}: ${result.status}\n${result.log}`);
    }
  }
  onLine?.('▶▶ Promuovo la cattura a baseline (ia-qa-heal baseline)');
  const baselineResult = await runProcessAsync(iaQaHealBin(), ['baseline'], { cwd: projectDir });
  logs.push([baselineResult.stdout, baselineResult.stderr].filter(Boolean).join('\n'));
  return { capturedCount, failedCount, log: logs.filter(Boolean).join('\n\n') };
}

export function baselineExists(projectId: number): boolean {
  return hasBaseline(iaQaProjectDir(projectId));
}

/**
 * The real repair loop for one failing test: capture the app's current state, bind this
 * test's own selectors to it (`ingest`), judge drift against the baseline (`diff`), and if
 * every break has a deterministic rewrite (`FIX`), apply it to a scratch copy and re-run that
 * copy to verify it now passes -- never touching the test stored in the backend until the
 * user reviews and applies the proposal from the UI.
 */
export async function healTest(
  projectId: number,
  baseUrl: string,
  testCode: string,
  onLine?: (line: string) => void
): Promise<HealResult> {
  const projectDir = ensureIaQaConfig(projectId, baseUrl);
  if (!hasBaseline(projectDir)) {
    return { status: 'no-baseline', summary: NO_BASELINE_MESSAGE };
  }

  onLine?.('▶▶ Rieseguo il test per catturare lo stato attuale della pagina');
  await runWithCapture(testCode, projectDir, {}, onLine);

  const scratchDir = makeScratchDir('heal-');
  const scratchSpec = path.join(scratchDir, 'local.spec.ts');
  fs.writeFileSync(scratchSpec, testCode, 'utf8');

  try {
    // Binds this test's own selector literals to the contract just captured -- without it,
    // `diff`/`fix` would see the drift on the page but not know this test refers to it.
    onLine?.('▶▶ Analizzo i selettori usati dal test (ia-qa-heal ingest)');
    await runProcessAsync(iaQaHealBin(), ['ingest', scratchSpec], { cwd: projectDir });

    onLine?.('▶▶ Confronto con la baseline (ia-qa-heal diff)');
    const diffResult = await runProcessAsync(iaQaHealBin(), ['diff', '--json'], { cwd: projectDir });
    let verdict: { verdict: 'PASS' | 'FIX' | 'BLOCK' | null; reason?: string } | undefined;
    try {
      // Despite --json, ia-qa-heal still writes informational lines (e.g. "Merged N capture
      // shards...") to stdout *before* the JSON document via plain console.log -- so parse
      // from the first '{' rather than the whole stream.
      const jsonStart = diffResult.stdout.indexOf('{');
      if (jsonStart === -1) throw new Error('no JSON object in output');
      verdict = JSON.parse(diffResult.stdout.slice(jsonStart));
    } catch {
      return {
        status: 'error',
        summary:
          [diffResult.stdout, diffResult.stderr].filter(Boolean).join('\n') ||
          'ia-qa-heal diff non ha prodotto un verdetto leggibile.',
      };
    }

    if (verdict?.verdict === 'PASS') {
      return {
        status: 'unchanged',
        summary: 'I selettori usati da questo test raggiungono ancora i loro elementi: non sembra drift del selettore.',
      };
    }
    if (verdict?.verdict !== 'FIX') {
      return {
        status: verdict?.verdict === 'BLOCK' ? 'blocked' : 'error',
        summary:
          verdict?.verdict === 'BLOCK'
            ? 'Serve una decisione umana: uno o più elementi sono ambigui, spariti, o il selettore ora punta a un elemento diverso. Nessuna riscrittura è stata applicata.'
            : verdict?.reason ?? 'Verdetto non disponibile.',
      };
    }

    // FIX: rewrite the scratch copy (test paths default to what `ingest` just wrote to
    // usage.json, i.e. only our scratchSpec) and read the repaired source back.
    onLine?.('▶▶ Applico la riparazione (ia-qa-heal fix)');
    const fixResult = await runProcessAsync(iaQaHealBin(), ['fix'], { cwd: projectDir });
    const proposedCode = fs.readFileSync(scratchSpec, 'utf8');
    if (proposedCode === testCode) {
      return {
        status: 'error',
        summary:
          [fixResult.stdout, fixResult.stderr].filter(Boolean).join('\n') ||
          'ia-qa-heal ha segnalato FIX ma non ha riscritto il file di test.',
      };
    }

    onLine?.('▶▶ Rieseguo il test riparato per verificare che ora passi');
    const verifyRun = await runPlaywrightTest(proposedCode, {}, undefined, onLine);
    return {
      status: 'healed',
      summary: [fixResult.stdout, fixResult.stderr].filter(Boolean).join('\n'),
      proposedCode,
      verified: verifyRun.status === 'passed',
    };
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

/**
 * Opens Playwright's codegen recorder against startUrl; the user interacts with the
 * launched browser, and closing that browser (or the inspector) ends the recording.
 * Returns the generated test source, or null if nothing was recorded.
 */
export async function recordPlaywrightTest(startUrl: string): Promise<string | null> {
  const workDir = makeScratchDir('codegen-');
  const outputPath = path.join(workDir, 'recorded.spec.ts');
  const scriptPath = path.join(workDir, 'record.js');

  // `playwright codegen` always starts with recording ON; the recorder's "standby" mode (same
  // as clicking the record button off) isn't exposed by the CLI, so drive it from a tiny script.
  fs.writeFileSync(
    scriptPath,
    `const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  await context._enableRecorder({
    language: 'playwright-test',
    launchOptions: { headless: false },
    contextOptions: {},
    mode: 'standby',
    outputFile: ${JSON.stringify(outputPath)},
    handleSIGINT: false,
  });
  const page = await context.newPage();
  await page.goto(${JSON.stringify(startUrl)});
  browser.on('disconnected', () => process.exit(0));
})().catch((e) => { console.error(e); process.exit(1); });
`,
    'utf8'
  );

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: workDir,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.on('error', reject);
    child.on('close', () => resolve());
  });

  const code = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  fs.rmSync(workDir, { recursive: true, force: true });
  return code.trim() ? withRuntimeHelpers(code, startUrl) : null;
}

const RUNTIME_HELPERS = `/** Never hard-fail on Playwright's strict-mode (locator matched >1 element): legacy
 * recordings often produce ambiguous selectors (e.g. a hidden duplicate widget). Take the
 * first match and just log a warning instead. */
async function resolveLocator(locator, label) {
  const count = await locator.count();
  if (count > 1) console.warn(\`[insightest] selector matched \${count} elements, using the first one: \${label}\`);
  else if (count === 0) console.warn(\`[insightest] selector matched 0 elements: \${label}\`);
  return locator.first();
}

const insightestNetworkListeners = new WeakSet();
/** Reports failed HTTP responses (4xx/5xx) without failing the test; guarded so a
 * prepended dependency test's body doesn't attach a second listener on the same page. */
function reportNetworkErrors(page) {
  if (insightestNetworkListeners.has(page)) return;
  insightestNetworkListeners.add(page);
  page.on('response', (response) => {
    if (response.status() >= 400) {
      console.warn(\`[insightest] HTTP \${response.status()} \${response.request().method()} \${response.url()}\`);
    }
  });
}`;

/**
 * Adds what a raw recording lacks: the shared runtime helpers after the import, the
 * `reportNetworkErrors(page)` call at the top of the test body, and the initial `page.goto`
 * (not captured because the recorder starts in standby mode).
 */
function withRuntimeHelpers(code: string, startUrl: string): string {
  if (code.includes('reportNetworkErrors')) return code;
  const importRe = /^import\s*\{[^}]*\}\s*from\s*['"]@playwright\/test['"];?/m;
  const withHelpers = importRe.test(code)
    ? code.replace(importRe, (m) => `${m}\n\n${RUNTIME_HELPERS}`)
    : `import { test, expect } from '@playwright/test';\n\n${RUNTIME_HELPERS}\n\n${code}`;
  const bodyRe = /(test\([^\n]*async\s*\(\{\s*page\s*\}\)\s*=>\s*\{\n?)/;
  const gotoLine = /page\.goto\(/.test(code) ? '' : `  await page.goto(${JSON.stringify(startUrl)});\n`;
  return withHelpers.replace(bodyRe, (m) => `${m}${m.endsWith('\n') ? '' : '\n'}  reportNetworkErrors(page);\n${gotoLine}`);
}

/** N (selectors captured per step) is fixed at record time, baked into the stored steps_json --
 * changing it later requires re-recording/re-augmenting, not a runtime flag. */
export const DEFAULT_SELECTOR_COUNT = 3;

/**
 * Rewrites `code` so every recorded action call is preceded by a call into
 * `__insightestCaptureStep`, which -- right before the real action runs, against the live DOM --
 * grabs up to `n - 1` alternate ("secondary") CSS selectors for the same element plus a short
 * text hint, and appends the result to a Node-side array. Does NOT change what the test itself
 * does (the original action call still runs immediately after, untouched).
 */
function withCaptureInstrumentation(code: string, outputPath: string, n: number): string {
  const re = /^import\s*\{\s*test\s*,\s*expect\s*\}\s*from\s*(['"])([^'"]+)\1;?/m;
  const match = re.exec(code);
  const specifier = match ? match[2] : '@playwright/test';
  const bodyOnly = normalizeSelect2Options(match ? code.replace(re, '') : code);
  const instrumented = bodyOnly.replace(ACTION_LINE_RE, (fullMatch, indent: string, chain: string) => {
    return `${indent}await __insightestCaptureStep(${chain});\n${fullMatch.replace(/^\s*/, indent)}`;
  });
  const outputPathForCode = outputPath.replace(/\\/g, '/');
  const header =
    `import { test, expect } from '${specifier}';\n\n` +
    `const __insightestFs = require('fs');\n` +
    `const __insightestSteps = [];\n` +
    `async function __insightestCaptureStep(locator) {\n` +
    `  try {\n` +
    `    const handle = await locator.first().elementHandle({ timeout: 5000 });\n` +
    `    if (!handle) { __insightestSteps.push({ secondarySelectors: [] }); return; }\n` +
    `    const meta = await handle.evaluate((el, n) => {\n` +
    `      const candidates = [];\n` +
    `      if (el.id) candidates.push('#' + CSS.escape(el.id));\n` +
    `      const testAttr = ['data-testid', 'data-test-id', 'data-test'].find((a) => el.getAttribute(a));\n` +
    `      if (testAttr) candidates.push('[' + testAttr + '=\"' + el.getAttribute(testAttr) + '\"]');\n` +
    `      if (el.getAttribute('name')) candidates.push('[name=\"' + el.getAttribute('name') + '\"]');\n` +
    `      if (el.getAttribute('placeholder')) candidates.push('[placeholder=\"' + el.getAttribute('placeholder') + '\"]');\n` +
    `      const stableClass = Array.from(el.classList || []).find((c) => !/^(?:[a-z]+-)?[0-9a-f]{6,}$/i.test(c) && !/\\d{3,}/.test(c));\n` +
    `      if (stableClass) candidates.push('.' + CSS.escape(stableClass));\n` +
    `      const tag = el.tagName.toLowerCase();\n` +
    `      const siblings = Array.from(el.parentElement ? el.parentElement.children : []).filter((s) => s.tagName === el.tagName);\n` +
    `      candidates.push(tag + ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')');\n` +
    `      const unique = Array.from(new Set(candidates)).slice(0, Math.max(0, n - 1));\n` +
    `      const text = (el.textContent || '').trim().slice(0, 80);\n` +
    `      const textHint = text || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('value') || '';\n` +
    `      return { secondarySelectors: unique, textHint, tagHint: tag };\n` +
    `    }, ${n});\n` +
    `    __insightestSteps.push(meta);\n` +
    `  } catch (e) {\n` +
    `    __insightestSteps.push({ secondarySelectors: [] });\n` +
    `  }\n` +
    `}\n\n` +
    `test.afterAll(async () => {\n` +
    `  __insightestFs.writeFileSync('${outputPathForCode}', JSON.stringify(__insightestSteps), 'utf8');\n` +
    `});\n`;
  return `${header}\n${instrumented}`;
}

/**
 * Replays `playwrightCode`'s recorded action sequence once (headless), capturing up to `n`
 * selectors per step (the primary locator recorded by codegen plus `n - 1` alternates read
 * live from the DOM right before each action) for the resilient-action engine's selector
 * fallback. Best-effort: if the replay itself fails partway (app not reachable, a step no
 * longer matches anything, etc.) whatever was captured up to that point is still returned.
 */
export async function augmentRecordedSteps(
  playwrightCode: string,
  n: number = DEFAULT_SELECTOR_COUNT
): Promise<ResilientStepMeta[]> {
  const workDir = makeScratchDir('augment-');
  const specPath = path.join(workDir, 'augment.spec.ts');
  const outputPath = path.join(workDir, 'steps.json');
  const configPath = path.join(workDir, 'playwright.config.js');
  fs.writeFileSync(specPath, withCaptureInstrumentation(playwrightCode, outputPath, n), 'utf8');
  fs.writeFileSync(configPath, `module.exports = { timeout: 60000 };\n`, 'utf8');
  try {
    await runProcessAsync(playwrightBin(), ['test', 'augment.spec.ts', '--config', configPath], {
      cwd: workDir,
      env: process.env,
    });
  } catch {
    // Best-effort: fall through to reading whatever __insightestSteps managed to write out.
  }
  let steps: ResilientStepMeta[] = [];
  try {
    steps = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } catch {
    steps = [];
  }
  fs.rmSync(workDir, { recursive: true, force: true });
  return steps;
}
