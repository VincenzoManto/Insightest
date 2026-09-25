#!/usr/bin/env node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ZodRawShape } from 'zod';
import { initRunnerPaths, runPlaywrightTest, healTest, baselineExists } from './runnerCore';
import { m } from './messages';

/**
 * Standalone MCP server, launched by an MCP-compatible client (Claude Code, etc.) via a plain
 * stdio command -- works independently of whether the Insightest desktop app window is open.
 * It talks to the same backend API as the desktop app, and runs Playwright/ia-qa-heal itself.
 */

interface McpConfig {
  apiBaseUrl: string;
  /** Short-lived user JWT copied from the desktop app (same auth as its own UI); regenerate
   * from the app's "Agenti AI (MCP)" screen when it expires (see backend jwt_ttl_seconds). */
  jwt: string;
}

/** Mirrors Electron's own userData path algorithm for the app name "insightest-desktop", so
 * ia-qa-heal baseline state is shared between the desktop app and MCP-triggered repairs. */
function defaultUserDataDir(): string {
  // The desktop app passes its real userData path when registering this server, which stays
  // correct for a packaged build whose product name differs from the dev app name below.
  if (process.env.INSIGHTEST_USER_DATA_DIR) return process.env.INSIGHTEST_USER_DATA_DIR;
  const appName = 'insightest-desktop';
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
}

function loadConfig(): McpConfig {
  const configPath = process.env.INSIGHTEST_MCP_CONFIG || path.join(defaultUserDataDir(), 'mcp-config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(
      m('MCP config not found in {path}. Generate it from the "AI agents (MCP)" screen of the Insightest desktop app.', { path: configPath })
    );
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!parsed.apiBaseUrl || !parsed.jwt) {
    throw new Error(`Config MCP in ${configPath} incompleta: servono "apiBaseUrl" e "jwt".`);
  }
  return parsed;
}

function base64EncodeUtf8(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64');
}

class Api {
  constructor(private baseUrl: string, private jwt: string) {}

  private async request<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
    const jsonBody = body !== undefined ? JSON.stringify(body) : undefined;
    const encodedBody = jsonBody !== undefined ? base64EncodeUtf8(jsonBody) : undefined;
    const res = await fetch(`${this.baseUrl}${urlPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(encodedBody !== undefined ? { 'X-Body-Encoding': 'base64' } : {}),
        Authorization: `Bearer ${this.jwt}`,
      },
      body: encodedBody,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status} on ${method} ${urlPath}`);
    return data as T;
  }

  get<T>(urlPath: string): Promise<T> {
    return this.request<T>('GET', urlPath);
  }
  post<T>(urlPath: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', urlPath, body);
  }
  put<T>(urlPath: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', urlPath, body);
  }
}

interface TestRecord {
  id: number;
  project_id: number;
  name: string;
  playwright_code: string;
  steps_json?: string | null;
  depends_on_test_id: number | null;
}

interface ProjectRecord {
  id: number;
  org_id: number;
  name: string;
  base_url: string | null;
  repo_path: string | null;
}

/** Walks the depends_on_test_id chain (oldest ancestor first), same as the desktop UI's local-run path. */
function parseSteps(json: string | null | undefined): any[] | null {
  try {
    const v = json ? JSON.parse(json) : null;
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function resolveDependencyCodes(api: Api, test: TestRecord): Promise<{ codes: string[]; steps: (any[] | null)[] }> {
  const codes: string[] = [];
  const steps: (any[] | null)[] = [];
  const visited = new Set<number>([test.id]);
  let nextId = test.depends_on_test_id;
  while (nextId !== null && !visited.has(nextId)) {
    visited.add(nextId);
    const ancestor = await api.get<TestRecord>(`/tests/${nextId}`);
    codes.unshift(ancestor.playwright_code);
    steps.unshift(parseSteps(ancestor.steps_json));
    nextId = ancestor.depends_on_test_id ?? null;
  }
  return { codes, steps };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const api = new Api(config.apiBaseUrl, config.jwt);

  // Compiled next to the rest of the Electron main code (dist-electron/), so the app root --
  // whose node_modules resolves @playwright/test and ia-qa-heal -- is one level up, in dev and
  // inside app.asar alike (this script runs under Electron's own binary in node mode).
  const appRoot = path.resolve(__dirname, '..');
  initRunnerPaths({
    appRoot,
    userDataDir: defaultUserDataDir(),
    liveReporterPath: path.join(__dirname, 'liveReporter.js').replace(/\\/g, '/'),
  });

  const server = new McpServer({ name: 'insightest', version: '0.1.0' });
  // `server.tool` has a heavily-overloaded generic signature that makes the TypeScript checker
  // blow its recursion budget (TS2589) once enough distinct call shapes appear in one file.
  // Handler argument types are already annotated explicitly at each call site below, so
  // registering through an `any`-typed alias is safe and keeps compilation fast and reliable.
  const registerTool: any = server.tool.bind(server);

  registerTool('list_orgs', 'Elenca le organizzazioni Insightest accessibili all\'utente', {}, async () => {
    const data = await api.get('/orgs');
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  });

  const listProjectsShape: ZodRawShape = { org_id: z.number() };
  registerTool('list_projects', 'Elenca i progetti di una organizzazione', listProjectsShape, async (args: { org_id: number }) => {
    const data = await api.get(`/orgs/${args.org_id}/projects`);
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  });

  const projectIdShape: ZodRawShape = { project_id: z.number() };

  registerTool('get_project', 'Dettagli di un progetto (incluso repo_path e base_url)', projectIdShape, async (args: { project_id: number }) => {
    const data = await api.get(`/projects/${args.project_id}`);
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  });

  registerTool('list_folders', 'Elenca le cartelle di un progetto', projectIdShape, async (args: { project_id: number }) => {
    const data = await api.get(`/projects/${args.project_id}/folders`);
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  });

  registerTool('list_tests', 'Elenca i test di un progetto', projectIdShape, async (args: { project_id: number }) => {
    const data = await api.get(`/projects/${args.project_id}/tests`);
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  });

  const testIdShape: ZodRawShape = { test_id: z.number() };

  registerTool('get_test', m('Test details (including the Playwright code)'), testIdShape, async (args: { test_id: number }) => {
    const data = await api.get(`/tests/${args.test_id}`);
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  });

  registerTool('get_test_runs', 'Storico delle esecuzioni di un test', testIdShape, async (args: { test_id: number }) => {
    const data = await api.get(`/tests/${args.test_id}/runs`);
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  });

  const runTestShape: ZodRawShape = {
    test_id: z.number(),
    headed: z.boolean().optional(),
    betweenActionMs: z.number().optional(),
  };
  registerTool(
    'run_test',
    m('Runs a Playwright test locally (with its dependency chain) and stores the result'),
    runTestShape,
    async (args: { test_id: number; headed?: boolean; betweenActionMs?: number }) => {
      const testId = args.test_id;
      const test = await api.get<TestRecord>(`/tests/${testId}`);
      const dependencies = await resolveDependencyCodes(api, test);
      const project = await api.get<ProjectRecord & { selector_priority?: string | null }>(`/projects/${test.project_id}`).catch(() => null);
      let selectorPriority: string[] | undefined;
      try {
        const parsed = project?.selector_priority ? JSON.parse(project.selector_priority) : null;
        if (Array.isArray(parsed) && parsed.length) selectorPriority = parsed.filter((k) => typeof k === 'string');
      } catch {
        /* default priority */
      }
      const startedAt = new Date().toISOString();
      const result = await runPlaywrightTest(
        test.playwright_code,
        { headed: args.headed, betweenActionMs: args.betweenActionMs, selectorPriority },
        dependencies.codes,
        undefined,
        parseSteps(test.steps_json),
        dependencies.steps
      );
      await api.post(`/tests/${testId}/runs`, {
        status: result.status,
        duration_ms: result.durationMs,
        log: result.log,
        healing_detail: result.healingDetail ?? null,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  registerTool(
    'trigger_repair',
    m('Attempts self-healing repair (ia-qa-heal) of a failed test against the project baseline'),
    testIdShape,
    async (args: { test_id: number }) => {
      const testId = args.test_id;
      const test = await api.get<TestRecord>(`/tests/${testId}`);
      const project = await api.get<ProjectRecord>(`/projects/${test.project_id}`);
      if (!project.base_url) {
        return {
          content: [{ type: 'text', text: m('The project has no base_url configured: self-healing is disabled.') }],
        };
      }
      if (!baselineExists(project.id)) {
        return { content: [{ type: 'text', text: m('No baseline for this project: create it first from the desktop app.') }] };
      }
      const result = await healTest(project.id, project.base_url, test.playwright_code);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  const applyRepairShape: ZodRawShape = { test_id: z.number(), proposed_code: z.string() };
  registerTool(
    'apply_repair',
    m('Applies the repaired code to the stored test (replaces playwright_code)'),
    applyRepairShape,
    async (args: { test_id: number; proposed_code: string }) => {
      await api.put(`/tests/${args.test_id}`, { playwright_code: args.proposed_code });
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[insightest-mcp] fatal error', err);
  process.exit(1);
});
