/**
 * Compiles an Insightest "builder" test (the `await pw.<action>(...)` calls produced/edited via
 * stepModel.ts) into a standalone, plain Playwright test: no PlaywrightBuilder, no retry/selector-fallback/
 * self-healing engine, nothing from the insightest runtime -- just `@playwright/test` calls someone can run
 * with a bare `npx playwright test`.
 *
 * Legacy-format tests (written directly against `page.locator(...)`, since the resilient engine only
 * instruments them at RUN time via a call-site rewrite -- see desktop/electron/runnerCore.ts -- never in
 * storage) need no compilation: `test.playwright_code` already IS plain Playwright and is exported near
 * verbatim by `exportTest()` below.
 *
 * Best-effort translations (behaviourally close, not byte-identical to the engine) are called out in the
 * generated header comment: select2 (a jQuery widget with no native Playwright primitive), DB steps (need
 * the project's own DB client/connection string, which this export never has access to), and dialogs
 * (alert/prompt/confirm -- registered as `page.once('dialog', ...)` right where the step occurs, same as
 * the engine's own timing).
 */
import { parseBuilderTest, primarySelector, type EditableStep } from './stepModel';
import type { TestDetail } from './types';

const q = (v: unknown): string => JSON.stringify(v);
const num = (v: string, fallback: number): number => (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : fallback);
const indent = (s: string): string =>
  s
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');

function actionOptions(step: EditableStep, extraBase?: Record<string, unknown>): Record<string, unknown> | null {
  const opts: Record<string, unknown> = { ...(extraBase ?? {}) };
  if (step.optionsJson?.trim()) {
    try {
      const extra = JSON.parse(step.optionsJson);
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(opts, extra);
    } catch {
      /* malformed JSON: dropped, same as the live run compiler (stepModel.ts's actionOptions) */
    }
  }
  if (step.force) opts.force = true;
  const timeoutMs = Number(step.timeout);
  if (timeoutMs > 0) opts.timeout = timeoutMs;
  return Object.keys(opts).length ? opts : null;
}

const argOrEmpty = (obj: Record<string, unknown> | null): string => (obj ? q(obj) : '');

/** One step -> zero or more vanilla Playwright lines (no leading/trailing indentation or blank lines). */
function vanillaLines(step: EditableStep, priority: readonly string[]): string[] {
  if (!step.enabled) return [];
  if (step.action === 'raw') return step.raw ? [step.raw] : [];

  const lines: string[] = [];
  if (step.waitBeforeMs && num(step.waitBeforeMs, 0) > 0) lines.push(`await page.waitForTimeout(${num(step.waitBeforeMs, 0)});`);

  const sel = q(primarySelector(step, priority));
  const loc = `page.locator(${sel})`;

  const pushAction = (code: string): void => {
    if (!step.skipOnFailure || !['click', 'doubleClick', 'rightClick', 'hover', 'type', 'fill', 'select', 'keydown', 'select2', 'clearInput'].includes(step.action)) {
      lines.push(code);
      return;
    }
    lines.push(`try {\n${indent(code)}\n} catch (e) {\n  console.warn('[step skipped on failure]', e instanceof Error ? e.message : e);\n}`);
  };

  switch (step.action) {
    case 'load':
      pushAction(`await page.goto(${q(step.value)});`);
      break;
    case 'click': {
      const opts = argOrEmpty(actionOptions(step));
      pushAction(`await ${loc}.click(${opts});`);
      break;
    }
    case 'doubleClick': {
      const opts = argOrEmpty(actionOptions(step));
      pushAction(`await ${loc}.dblclick(${opts});`);
      break;
    }
    case 'rightClick': {
      const opts = argOrEmpty(actionOptions(step, { button: 'right' }));
      pushAction(`await ${loc}.click(${opts});`);
      break;
    }
    case 'hover': {
      const opts = argOrEmpty(actionOptions(step));
      pushAction(`await ${loc}.hover(${opts});`);
      break;
    }
    case 'type': {
      const opts = actionOptions(step);
      pushAction(`await ${loc}.pressSequentially(${q(step.value)}${opts ? `, ${q(opts)}` : ''});`);
      break;
    }
    case 'fill': {
      const opts = actionOptions(step);
      pushAction(`await ${loc}.fill(${q(step.value)}${opts ? `, ${q(opts)}` : ''});`);
      break;
    }
    case 'select': {
      const opts = actionOptions(step);
      pushAction(`await ${loc}.selectOption(${q(step.value)}${opts ? `, ${q(opts)}` : ''});`);
      break;
    }
    case 'keydown': {
      const primary = primarySelector(step, priority);
      const opts = actionOptions(step);
      pushAction(primary ? `await ${loc}.press(${q(step.value)}${opts ? `, ${q(opts)}` : ''});` : `await page.keyboard.press(${q(step.value)});`);
      break;
    }
    case 'select2':
      // select2 is a jQuery widget with no native Playwright primitive: open it, then click the visible
      // option matching the recorded text. Re-check this block if the generated test doesn't find the option.
      pushAction(
        [
          `await ${loc}.click();`,
          `await page.locator('.select2-container--open').first().waitFor({ state: 'visible' });`,
          `await page.getByText(${q(step.value)}, { exact: true }).first().click(); // select2: verify this matches the right option`,
        ].join('\n')
      );
      break;
    case 'clearInput':
      pushAction(`await ${loc}.fill('');`);
      break;
    case 'wait':
      lines.push(`await page.waitForTimeout(${num(step.value, 0)});`);
      break;
    case 'resize':
      lines.push(`await page.setViewportSize({ width: ${num(step.value, 1280)}, height: ${num(step.value2, 720)} });`);
      break;
    case 'back':
      lines.push(`await page.goBack();`);
      break;
    case 'forward':
      lines.push(`await page.goForward();`);
      break;
    case 'refresh':
      lines.push(`await page.reload();`);
      break;
    case 'wheel':
      lines.push(`await page.evaluate(([dx, dy]) => window.scrollBy(dx, dy), [${num(step.value, 0)}, ${num(step.value2, 0)}]);`);
      break;
    case 'dragAndDrop': {
      const [sx, sy] = step.value.split(',').map((v) => num(v, 0));
      const [tx, ty] = step.value2.split(',').map((v) => num(v, 0));
      lines.push(`await page.mouse.move(${sx ?? 0}, ${sy ?? 0});`, `await page.mouse.down();`, `await page.mouse.move(${tx ?? 0}, ${ty ?? 0});`, `await page.mouse.up();`);
      break;
    }
    case 'awaitText':
      lines.push(`await page.waitForFunction((t) => document.body.innerText.includes(t), ${q(step.value)});`);
      break;
    case 'awaitNetworkStatus':
      lines.push(`await page.waitForResponse((r) => r.url().includes(${q(step.value)}) && r.status() === ${num(step.value2, 200)});`);
      break;
    case 'fullScreenshot':
      lines.push(`await page.screenshot({ fullPage: true });`);
      break;
    case 'alert':
      lines.push(`page.once('dialog', (d) => d.accept());`);
      break;
    case 'prompt':
      lines.push(`page.once('dialog', (d) => d.accept(${q(step.value)}));`);
      break;
    case 'confirm':
      lines.push(step.value.trim().toLowerCase() === 'false' ? `page.once('dialog', (d) => d.dismiss());` : `page.once('dialog', (d) => d.accept());`);
      break;
    case 'customAction':
      lines.push(`await page.evaluate(() => {\n${indent(step.value)}\n});`);
      break;
    case 'DB':
      // Needs the project's own DB client/connection string, which this export never has access to.
      lines.push(`// TODO: DB step needs manual conversion (requires a DB client + the project's connection string).`, `// Original query (mode: ${step.dbMode ?? 'snapshot'}):`, ...step.value.split('\n').map((l) => `// ${l}`));
      break;
    default:
      break;
  }

  return lines;
}

/** `test.playwright_code` is a builder test when it calls `pw.<action>(...)`; everything else is already plain Playwright. */
function usesBuilder(code: string): boolean {
  return /\bpw\.\w+\(/.test(code);
}

/**
 * Compiles one test (plus its prerequisite chain, oldest first -- same inlining the live runner does, so
 * the exported file is runnable standalone) into a single vanilla `.spec.ts` body.
 */
export function compileTestToVanilla(test: TestDetail, dependencies: TestDetail[], priority: readonly string[]): string {
  const chain = [...dependencies, test];
  const bodies: string[] = [];
  let anyBuilder = false;
  let anyUnsupported = false;

  for (const t of chain) {
    if (usesBuilder(t.playwright_code)) {
      anyBuilder = true;
      const parsed = parseBuilderTest(t.playwright_code, t.steps_json);
      if (!parsed) {
        anyUnsupported = true;
        bodies.push(`// Could not parse "${t.name}" as a builder test; original code kept verbatim below.\n/*\n${t.playwright_code}\n*/`);
        continue;
      }
      const lines = parsed.steps.flatMap((s) => vanillaLines(s, priority));
      bodies.push(`// --- ${t.name} ---`, ...lines);
    } else {
      // Legacy format: already plain Playwright. Pull out the test() body so it can be inlined like a builder step chain.
      const bodyMatch = /async\s*\([^)]*\)\s*=>\s*\{([\s\S]*)\}\s*\)\s*;?\s*$/.exec(t.playwright_code.trim());
      bodies.push(`// --- ${t.name} (already plain Playwright; included verbatim) ---`, bodyMatch ? bodyMatch[1].trim() : t.playwright_code);
    }
  }

  const safeName = test.name.replace(/'/g, "\\'");
  const header = [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `// Exported from Insightest as plain Playwright -- no PlaywrightBuilder, no retry/selector-fallback engine.`,
    anyBuilder ? `// Selectors were resolved using this project's selector priority (${priority.join(', ')}) at export time; they will NOT re-resolve to a fallback if they break.` : null,
    anyUnsupported ? `// One or more steps could not be auto-converted (see comments below) and were kept as original source.` : null,
    `test('${safeName}', async ({ page }) => {`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');

  return `${header}\n${indent(bodies.join('\n'))}\n});\n`;
}

/** Walks `depends_on_test_id` up to its root, oldest ancestor first -- same chain the live runner replays
 * before the test itself (TestDetailScreen's own runLocally does the identical walk inline). */
export async function resolveDependencyChain(test: TestDetail, fetchTest: (id: number) => Promise<TestDetail>): Promise<TestDetail[]> {
  const chain: TestDetail[] = [];
  const visited = new Set<number>([test.id]);
  let nextId = test.depends_on_test_id;
  while (nextId !== null && nextId !== undefined && !visited.has(nextId)) {
    visited.add(nextId);
    const ancestor = await fetchTest(nextId);
    chain.unshift(ancestor);
    nextId = ancestor.depends_on_test_id ?? null;
  }
  return chain;
}

/** A minimal `playwright.config.ts` for the exported project: no insightest-specific reporters/env vars. */
export function vanillaPlaywrightConfig(): string {
  return `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  use: {
    headless: true,
  },
});
`;
}

/** Filesystem-safe file name from a test name (keeps the export readable instead of id-numbered). */
export function slugifyFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'test';
}
