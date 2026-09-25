import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { m } from './messages';

export type AgentName = 'claude' | 'copilot';

const AGENT_BIN: Record<AgentName, string> = {
  claude: 'claude',
  copilot: 'copilot',
};

/**
 * Exact non-interactive flags vary across CLI versions -- these are best-effort defaults for
 * the currently documented "print mode" of each tool; verify against the installed version.
 */
const AGENT_RUN_ARGS: Record<AgentName, (prompt: string) => string[]> = {
  claude: (prompt) => ['-p', prompt, '--permission-mode', 'acceptEdits'],
  copilot: (prompt) => ['-p', prompt],
};

function probe(agent: AgentName): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const child = spawn(AGENT_BIN[agent], ['--version'], { shell: process.platform === 'win32' });
      child.on('error', () => finish(false));
      child.on('close', (code) => finish(code === 0));
      // A CLI hung on its own update-check/login prompt shouldn't block detection forever.
      setTimeout(() => finish(false), 4000);
    } catch {
      finish(false);
    }
  });
}

export async function detectInstalledAgents(): Promise<Record<AgentName, boolean>> {
  const [claude, copilot] = await Promise.all([probe('claude'), probe('copilot')]);
  return { claude, copilot };
}

/** Prompt handed to the external coding-agent CLI: fix the app, never the test itself. */
export function buildRepairPrompt(
  testName: string,
  testCode: string,
  lastRunLog: string | undefined,
  repoPath: string
): string {
  return [
    `Un test end-to-end Playwright chiamato "${testName}" sta fallendo.`,
    `Il repository dell'applicazione testata si trova in questa cartella: ${repoPath}. ` +
      'Esamina il codice sorgente dell\'app (NON il test) e correggi il bug che causa il fallimento del test.',
    '',
    '--- Codice del test Playwright (contesto, non modificarlo) ---',
    testCode,
    lastRunLog ? `\n--- Log dell'ultima esecuzione fallita ---\n${lastRunLog}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface AiTestStatus {
  /** `claude` CLI found on PATH. */
  claude: boolean;
  /** The Insightest MCP server is registered in Claude Code (`claude mcp list`). */
  insightestMcp: boolean;
  /** A Playwright MCP server is registered in Claude Code, so the agent can drive a real browser. */
  playwrightMcp: boolean;
}

function captureOutput(bin: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    const finish = (value: string | null): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      const child = spawn(bin, args, { shell: process.platform === 'win32' });
      child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
      child.on('error', () => finish(null));
      child.on('close', (code) => finish(code === 0 ? out : null));
      setTimeout(() => {
        child.kill();
        finish(null);
      }, timeoutMs);
    } catch {
      finish(null);
    }
  });
}

/** Whether the AI-assisted test authoring/fixing features can be offered: needs Claude Code
 * and the Insightest MCP server registered in it. */
export async function detectAiTestStatus(): Promise<AiTestStatus> {
  const list = await captureOutput(AGENT_BIN.claude, ['mcp', 'list'], 45000);
  if (list === null) {
    return { claude: await probe('claude'), insightestMcp: false, playwrightMcp: false };
  }
  return {
    claude: true,
    insightestMcp: /^\s*insightest\b/im.test(list),
    playwrightMcp: /^\s*(plugin:[\w-]+:)?playwright\b/im.test(list),
  };
}

export interface AiTestRequest {
  mode: 'generate' | 'fix';
  instruction: string;
  testName?: string;
  currentCode?: string;
  lastRunLog?: string;
  baseUrl?: string | null;
  repoPath?: string | null;
  projectId?: number | null;
  /** Unused since the app always injects its own Playwright MCP; kept for the request shape. */
  playwrightMcp: boolean;
}

export interface AiTestResult {
  code: string | null;
  /** Exact name of the prerequisite test (e.g. the login test) the code assumes ran first, if any. */
  dependsOn: string | null;
  log: string;
  exitCode: number | null;
  cancelled: boolean;
}

function buildAiTestPrompt(req: AiTestRequest): string {
  const lines: string[] = [];
  if (req.mode === 'generate') {
    lines.push("Devi scrivere un test end-to-end Playwright per un'applicazione web.");
  } else {
    lines.push(
      `Il test end-to-end Playwright "${req.testName ?? ''}" non funziona più e va CORRETTO (correggi il codice del test, non l'applicazione).`
    );
  }
  if (req.repoPath) {
    lines.push(
      `Il codice sorgente dell'applicazione testata è nella tua cartella di lavoro corrente (${req.repoPath}): leggilo per capire pagine, route e selettori reali.`
    );
  }
  if (req.baseUrl) lines.push(`URL base dell'applicazione: ${req.baseUrl}`);
  lines.push(
    'Hai a disposizione un browser reale tramite il server MCP Playwright (tool mcp__playwright-ai__*): ' +
      "aprilo, naviga l'app, esegui i passaggi del test e verifica che i selettori funzionino davvero " +
      'PRIMA di consegnare il codice. Se il test è da correggere, riproduci il fallimento nel browser e conferma che la versione corretta passa.'
  );
  lines.push('', "--- Richiesta dell'utente ---", req.instruction.trim() || (req.mode === 'fix' ? 'Correggi il test.' : ''));
  if (req.currentCode) lines.push('', '--- Codice attuale del test ---', req.currentCode);
  if (req.lastRunLog) lines.push('', "--- Log dell'ultima esecuzione ---", req.lastRunLog);
  lines.push(
    '',
    '--- Struttura obbligatoria del test (è quella che il nostro runner sa eseguire) ---',
    "1. Il file è SOLO: `import { test, expect } from '@playwright/test';` seguito da UN SOLO `test('nome', async ({ page }) => { ... });` di primo livello.",
    '2. NIENTE test.describe, test.setTimeout, costanti, funzioni di supporto, hook o import aggiuntivi: tutto il corpo sta dentro quel test, con URL scritti per esteso. I timeout lunghi vanno solo sui singoli waitForURL/expect.',
    "3. Un'azione per riga, nella forma `await page.<locator>.<azione>(...)` (click, fill, check, selectOption, press, goto...), poi le verifiche con `await expect(...)`. Selettori stabili (getByRole/getByLabel/getByTestId).",
    req.projectId
      ? `4. INCAPSULAMENTO: il login e gli altri passaggi ripetuti sono già test a sé stanti del progetto ${req.projectId}, collegati come prerequisito ed eseguiti prima nella stessa sessione. ` +
          'Usa i tool MCP insightest (list_tests, get_test) per trovare il test di login/prerequisito adatto e leggerne il codice: NON ripetere i suoi passaggi nel nuovo codice, parti dallo stato in cui lui lascia il browser.'
      : '4. INCAPSULAMENTO: se serve un login, non includerlo: assumi che un test prerequisito lo abbia già fatto.',
    '',
    'Regole: NON modificare alcun file nel repository. ' +
      'La risposta finale deve contenere SOLO il blocco di codice ```typescript e, subito dopo, una riga `DEPENDS_ON: <nome esatto del test prerequisito>` (oppure `DEPENDS_ON: none`). Nessuna spiegazione, nessun commento fuori dal codice.'
  );
  return lines.join('\n');
}

/** Last fenced code block of the agent's answer (the final version, if it iterated). */
function extractCodeBlock(text: string): string | null {
  const blocks = [...text.matchAll(/```(?:typescript|ts|javascript|js)?[ \t]*\r?\n([\s\S]*?)```/g)];
  const last = blocks[blocks.length - 1];
  return last ? last[1].trim() : null;
}

function extractDependsOn(text: string): string | null {
  const m = /^DEPENDS_ON:\s*(.+?)\s*$/im.exec(text);
  if (!m || /^none$/i.test(m[1])) return null;
  return m[1].replace(/^[`"']|[`"']$/g, '');
}

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One-line, human-readable rendering of a stream-json event (what Claude is doing right now). */
function describeStreamEvent(evt: any): string[] {
  const out: string[] = [];
  if (evt?.type === 'assistant') {
    for (const block of evt.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) {
        out.push(`💬 ${truncate(block.text.trim().replace(/\s+/g, ' '), 300)}`);
      } else if (block.type === 'tool_use') {
        const name = String(block.name).replace(/^mcp__/, '').replace(/__/g, ' › ');
        out.push(`🔧 ${name} ${truncate(JSON.stringify(block.input ?? {}), 160)}`);
      }
    }
  } else if (evt?.type === 'user') {
    for (const block of evt.message?.content ?? []) {
      if (block.type === 'tool_result' && block.is_error) out.push(m('⚠️ a tool returned an error'));
    }
  }
  return out;
}

let currentAiChild: ChildProcess | null = null;
let aiCancelled = false;

/** Stops the running "write/fix with Claude" request, killing the whole process tree (on
 * Windows `claude` runs behind a shell, so a plain kill would leave it running). */
export function cancelAiTestRequest(): boolean {
  const child = currentAiChild;
  if (!child?.pid) return false;
  aiCancelled = true;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  } else {
    child.kill('SIGTERM');
  }
  return true;
}

/** Runs Claude Code in print mode (prompt on stdin, streamed JSON events) to write or fix a
 * test and returns the proposed code without touching the repo or the stored test. */
export function runAiTestRequest(req: AiTestRequest, onLine?: (line: string) => void): Promise<AiTestResult> {
  if (currentAiChild) return Promise.reject(new Error(m('A Claude request is already in progress')));
  // Claude always gets a Playwright browser: an app-provided MCP server is injected via
  // --mcp-config (a file, since inline JSON doesn't survive shell quoting on Windows), so this
  // works whether or not the user registered a Playwright MCP themselves.
  const mcpConfigPath = path.join(os.tmpdir(), `insightest-ai-mcp-${process.pid}.json`);
  fs.writeFileSync(
    mcpConfigPath,
    JSON.stringify({ mcpServers: { 'playwright-ai': { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } } }),
    'utf8'
  );
  const allowed = [
    'Read',
    'Grep',
    'Glob',
    'mcp__insightest__get_test',
    'mcp__insightest__get_test_runs',
    'mcp__insightest__list_tests',
    'mcp__playwright-ai',
    'mcp__playwright',
  ];
  const prompt = buildAiTestPrompt(req);
  return new Promise((resolve, reject) => {
    aiCancelled = false;
    const child = spawn(
      AGENT_BIN.claude,
      ['-p', '--output-format', 'stream-json', '--verbose', '--mcp-config', mcpConfigPath, '--allowedTools', allowed.join(',')],
      { cwd: req.repoPath || undefined, shell: process.platform === 'win32', env: process.env }
    );
    currentAiChild = child;
    let log = '';
    let lineBuf = '';
    let finalText = '';
    let assistantText = '';
    const handleLine = (raw: string): void => {
      const line = raw.trim();
      if (!line) return;
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        // Not JSON (a CLI warning etc.): show it as is.
        onLine?.(line);
        return;
      }
      if (evt.type === 'result' && typeof evt.result === 'string') finalText = evt.result;
      if (evt.type === 'assistant') {
        for (const b of evt.message?.content ?? []) if (b.type === 'text') assistantText += `${b.text}\n`;
      }
      for (const described of describeStreamEvent(evt)) onLine?.(described);
    };
    const timer = setTimeout(() => cancelAiTestRequest(), 15 * 60 * 1000);
    const cleanup = (): void => {
      clearTimeout(timer);
      currentAiChild = null;
      fs.rm(mcpConfigPath, { force: true }, () => undefined);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      log += text;
      lineBuf += text;
      const parts = lineBuf.split('\n');
      lineBuf = parts.pop() ?? '';
      parts.forEach(handleLine);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      log += chunk.toString();
      onLine?.(chunk.toString().trim());
    });
    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('close', (code) => {
      handleLine(lineBuf);
      const cancelled = aiCancelled;
      cleanup();
      const answer = finalText || assistantText;
      resolve({
        code: cancelled ? null : extractCodeBlock(answer),
        dependsOn: cancelled ? null : extractDependsOn(answer),
        log,
        exitCode: code,
        cancelled,
      });
    });
    child.stdin?.end(prompt);
  });
}

export function runAgentRepair(
  agent: AgentName,
  repoPath: string,
  prompt: string,
  onLine?: (line: string) => void
): Promise<{ exitCode: number | null; log: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(AGENT_BIN[agent], AGENT_RUN_ARGS[agent](prompt), {
      cwd: repoPath,
      shell: process.platform === 'win32',
      env: process.env,
    });
    let log = '';
    let lineBuf = '';
    const pump = (chunk: Buffer): void => {
      const text = chunk.toString();
      log += text;
      if (onLine) {
        lineBuf += text;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() ?? '';
        for (const line of lines) onLine(line);
      }
    };
    child.stdout?.on('data', pump);
    child.stderr?.on('data', pump);
    child.on('error', reject);
    child.on('close', (code) => {
      if (onLine && lineBuf) onLine(lineBuf);
      resolve({ exitCode: code, log });
    });
  });
}
