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

/** Claude always gets a real Playwright browser via an app-provided MCP server, injected via `--mcp-config`
 * (a file, since inline JSON doesn't survive shell quoting on Windows) -- works whether or not the user
 * registered a Playwright MCP themselves. Caller deletes the file once the child process has exited.
 * `outputDir`, when given, is where the MCP server's own screenshot tool saves images (--output-dir): the only
 * way this process can later pick up a screenshot Claude took, since it never sees the tool's raw result. */
function writePlaywrightMcpConfig(outputDir?: string): string {
  const mcpConfigPath = path.join(os.tmpdir(), `insightest-ai-mcp-${process.pid}-${Date.now()}.json`);
  const args = ['-y', '@playwright/mcp@latest', ...(outputDir ? ['--output-dir', outputDir] : [])];
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { 'playwright-ai': { command: 'npx', args } } }), 'utf8');
  return mcpConfigPath;
}

const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** Reads a screenshot Claude saved (by filename, inside the MCP server's --output-dir) and turns it into a
 * data: URI the renderer can show directly in an <img>, with no file path to resolve on its side. Claude can get
 * the filename slightly wrong (extension, stray path); this tries a couple of forgiving variants before giving up. */
function screenshotDataUri(dir: string, filename: string): string | null {
  const base = path.basename(filename.trim());
  const candidates = [base, ...(/\.\w+$/.test(base) ? [] : ['.png', '.jpeg', '.jpg'].map((ext) => base + ext))];
  for (const name of candidates) {
    const full = path.join(dir, name);
    try {
      const data = fs.readFileSync(full);
      const mime = IMAGE_MIME[path.extname(name).toLowerCase()] ?? 'image/png';
      return `data:${mime};base64,${data.toString('base64')}`;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Runs Claude Code in print mode (prompt on stdin, streamed JSON events) to write or fix a
 * test and returns the proposed code without touching the repo or the stored test. */
export function runAiTestRequest(req: AiTestRequest, onLine?: (line: string) => void): Promise<AiTestResult> {
  if (currentAiChild) return Promise.reject(new Error(m('A Claude request is already in progress')));
  const mcpConfigPath = writePlaywrightMcpConfig();
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

/* ------------------------------------------------------------------ AI chat (plan, ask, then write) */

export interface AiChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AiChatRequest {
  /** Prior turns of this conversation (oldest first), not including `instruction`. */
  history: AiChatTurn[];
  /** The user's latest message. */
  instruction: string;
  baseUrl?: string | null;
  repoPath?: string | null;
  projectId?: number | null;
}

export interface AiChatQuestion {
  text: string;
  /** data: URI of a screenshot Claude took to illustrate the question, if any. */
  screenshot?: string | null;
}

export interface AiChatResult {
  /** `question`: Claude needs clarification before it can plan or write the test.
   *  `plan`: Claude proposes a plan and is waiting for confirmation (or changes) before writing code.
   *  `code`: Claude is done and the test is ready. */
  status: 'question' | 'plan' | 'code';
  message?: string;
  questions: AiChatQuestion[];
  plan: string[];
  /** Short descriptive name for the test, set together with `code`. */
  name: string | null;
  code: string | null;
  dependsOn: string | null;
  log: string;
  exitCode: number | null;
  cancelled: boolean;
}

function buildAiChatPrompt(req: AiChatRequest): string {
  const lines: string[] = [
    "Stai aiutando l'utente a scrivere uno o più test end-to-end Playwright per un'applicazione web, in una conversazione a più turni. " +
      "L'utente può chiederti anche molti test diversi nella stessa conversazione (es. \"adesso fammi anche il test del logout\"): trattalo come una nuova richiesta " +
      'e ripeti lo stesso processo (chiarimento → piano → codice) da capo per quel test, tenendo conto di quanto già creato nella conversazione.',
  ];
  if (req.repoPath) lines.push(`Il codice sorgente dell'applicazione testata è nella tua cartella di lavoro corrente (${req.repoPath}): leggilo per capire pagine, route e selettori reali.`);
  if (req.baseUrl) lines.push(`URL base dell'applicazione: ${req.baseUrl}`);
  lines.push(
    'Hai a disposizione un browser reale tramite il server MCP Playwright (tool mcp__playwright-ai__*): usalo per esplorare l\'app, verificare i selettori ' +
      'e, se ti serve mostrare qualcosa all\'utente, scattare uno screenshot (salvalo con un nome breve, es. "shot1.png").'
  );
  lines.push(
    '',
    'Segui questo processo ad ogni turno:',
    "1. Se la richiesta dell'utente è ambigua o ti manca un'informazione che solo lui può darti (quale utente usare, quale flusso esatto, cosa verificare), NON indovinare: rispondi con `status: \"question\"` e una o più domande chiare, eventualmente con uno screenshot a supporto.",
    '2. Se invece hai capito cosa serve ma non hai ancora proposto un piano in questa conversazione (o l\'utente ha appena chiesto una modifica sostanziale), esplora l\'app quanto basta e rispondi con `status: \"plan\"`: un elenco breve e concreto dei passaggi che il test farà. NON scrivere ancora il codice.',
    '3. Solo dopo che l\'utente ha confermato il piano (un messaggio come "ok", "procedi", "va bene", o che non chiede modifiche al piano), verifica i passaggi dal vivo nel browser e rispondi con `status: \"code\"` contenendo il test finale.',
    '',
    '--- Storia della conversazione ---'
  );
  for (const turn of req.history) lines.push(`${turn.role === 'user' ? 'Utente' : 'Tu'}: ${turn.text}`);
  lines.push(`Utente: ${req.instruction.trim()}`);
  lines.push(
    '',
    '--- Struttura obbligatoria del test, quando rispondi con status "code" (è quella che il nostro runner sa eseguire) ---',
    "1. Il file è SOLO: `import { test, expect } from '@playwright/test';` seguito da UN SOLO `test('nome', async ({ page }) => { ... });` di primo livello.",
    '2. NIENTE test.describe, test.setTimeout, costanti, funzioni di supporto, hook o import aggiuntivi: tutto il corpo sta dentro quel test, con URL scritti per esteso.',
    "3. Un'azione per riga, nella forma `await page.<locator>.<azione>(...)`, poi le verifiche con `await expect(...)`. Selettori stabili (getByRole/getByLabel/getByTestId).",
    req.projectId
      ? `4. INCAPSULAMENTO: il login e gli altri passaggi ripetuti sono già test a sé stanti del progetto ${req.projectId}. Usa i tool MCP insightest (list_tests, get_test) per trovare il test di login/prerequisito adatto: NON ripeterne i passaggi, parti dallo stato in cui lascia il browser.`
      : '4. INCAPSULAMENTO: se serve un login, non includerlo: assumi che un test prerequisito lo abbia già fatto.',
    '',
    'Rispondi SEMPRE e SOLO con un blocco ```json nella forma seguente (nessun testo fuori dal blocco):',
    '```json',
    '{"status":"question"|"plan"|"code","message":"breve messaggio per l\'utente","questions":[{"text":"...","screenshot":"shot1.png"}],"plan":["passo 1","passo 2"],"name":"nome breve e descrittivo del test","code":"...codice typescript...","dependsOn":"nome esatto del test prerequisito oppure null"}',
    '```',
    'Lascia vuoti gli array/campi che non servono per lo status scelto (es. con status "plan" lascia `code` e `name` a null). `name` è obbligatorio quando lo status è "code".'
  );
  return lines.join('\n');
}

function parseAiChatAnswer(text: string): Omit<AiChatResult, 'log' | 'exitCode' | 'cancelled'> | null {
  const blocks = [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g)];
  for (const block of blocks.reverse()) {
    try {
      const parsed = JSON.parse(block[1].trim());
      if (!parsed || typeof parsed.status !== 'string') continue;
      const status = parsed.status === 'question' || parsed.status === 'plan' || parsed.status === 'code' ? parsed.status : null;
      if (!status) continue;
      return {
        status,
        message: typeof parsed.message === 'string' ? parsed.message : undefined,
        questions: Array.isArray(parsed.questions)
          ? parsed.questions
              .filter((q: any) => q && typeof q.text === 'string' && q.text.trim())
              .map((q: any) => ({ text: q.text.trim(), screenshot: typeof q.screenshot === 'string' && q.screenshot.trim() ? q.screenshot.trim() : null }))
          : [],
        plan: Array.isArray(parsed.plan) ? parsed.plan.filter((p: any) => typeof p === 'string' && p.trim()) : [],
        name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null,
        code: typeof parsed.code === 'string' && parsed.code.trim() ? parsed.code.trim() : null,
        dependsOn: typeof parsed.dependsOn === 'string' && parsed.dependsOn.trim() && !/^none$/i.test(parsed.dependsOn.trim()) ? parsed.dependsOn.trim() : null,
      };
    } catch {
      /* try the previous block */
    }
  }
  return null;
}

/**
 * One turn of a conversational test-authoring session: Claude either asks a clarifying question
 * (optionally with a screenshot), proposes a plan for confirmation, or, once the plan is confirmed,
 * writes the final test. Each call is a fresh `claude -p` process; the full turn history is replayed
 * in the prompt so the agent has the context of the conversation so far.
 */
export function runAiChat(req: AiChatRequest, onLine?: (line: string) => void): Promise<AiChatResult> {
  if (currentAiChild) return Promise.reject(new Error(m('A Claude request is already in progress')));
  const shotsDir = path.join(os.tmpdir(), `insightest-ai-chat-shots-${process.pid}-${Date.now()}`);
  fs.mkdirSync(shotsDir, { recursive: true });
  const mcpConfigPath = writePlaywrightMcpConfig(shotsDir);
  const allowed = ['Read', 'Grep', 'Glob', 'mcp__insightest__get_test', 'mcp__insightest__get_test_runs', 'mcp__insightest__list_tests', 'mcp__playwright-ai'];
  const prompt = buildAiChatPrompt(req);
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
      fs.rm(shotsDir, { recursive: true, force: true }, () => undefined);
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
      const answer = finalText || assistantText;
      const parsed = cancelled ? null : parseAiChatAnswer(answer);
      cleanup();
      if (!parsed) {
        resolve({
          status: 'question',
          message: cancelled ? undefined : m('Claude did not return a usable answer. See the log below.'),
          questions: [],
          plan: [],
          name: null,
          code: null,
          dependsOn: null,
          log,
          exitCode: code,
          cancelled,
        });
        return;
      }
      resolve({
        ...parsed,
        questions: parsed.questions.map((q) => ({ text: q.text, screenshot: q.screenshot ? screenshotDataUri(shotsDir, q.screenshot) : null })),
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

/* ------------------------------------------------------------------ AI self-healing */

/** A step the deterministic healer could not fix, with what the page looked like at that moment. */
export interface AiHealStep {
  /** Which test of the run (0..n-1 = prerequisites, n = the test itself) and which of its selector-bearing calls. */
  t: number;
  i: number;
  testName: string;
  stepNumber: number;
  /** The step as it is now: action, every recorded selector, value. */
  description: string;
  /** Selector (or option text) that stopped working. */
  failed: string;
  evidence?: string;
  url?: string;
  /** Interactive elements visible on the page (tag, text, data-test, id, name, aria-label...) or the select2 options. */
  snapshot?: { title?: string; elements?: Record<string, string>[]; options?: string[] } | null;
}

export interface AiHealRequest {
  testName: string;
  baseUrl?: string | null;
  /** Local folder of the app's source: lets the AI find the real data-test/id attributes. */
  repoPath?: string | null;
  /** The target's prerequisite chain (oldest first: login, then whatever else it depends on), as Playwright
   * Builder code. The AI's own browser starts with a blank session -- without replaying these first it would
   * land on the login screen instead of the page the failing step actually runs on. */
  prerequisites?: { name: string; code: string }[];
  steps: AiHealStep[];
}

export interface AiHealFix {
  t: number;
  i: number;
  selector?: string | null;
  option?: string | null;
  timeoutMs?: number | null;
  why?: string;
}

/** Raised instead of a fix when Claude genuinely can't tell what the right action is -- the recorded step's
 * intent is ambiguous, the app visibly changed (a whole screen/flow that doesn't match the test anymore), or the
 * test itself looks wrong -- rather than have it guess a selector that merely happens to exist. */
export interface AiHealQuestion {
  t: number;
  i: number;
  question: string;
  /** data: URI of the screenshot Claude took of what it was looking at, if it managed to take one. */
  screenshot?: string | null;
}

export interface AiHealResult {
  fixes: AiHealFix[];
  questions: AiHealQuestion[];
  log: string;
  exitCode: number | null;
  cancelled: boolean;
}

function buildAiHealPrompt(req: AiHealRequest): string {
  const lines: string[] = [
    `Il test end-to-end "${req.testName}" ha dei passaggi che non trovano più il loro elemento nell'applicazione (selettori non più validi). ` +
      'Un sistema deterministico ha già provato a ripararli senza riuscirci.',
    '',
    'Hai carta bianca su come arrivarci: hai un browser reale tramite il server MCP Playwright (tool mcp__playwright-ai__*), usalo liberamente. ' +
      "Per ogni passaggio non risolto apri il browser, naviga all'URL indicato (o a quello base se manca), riproduci lo stato in cui si trovava " +
      "l'applicazione in quel momento (login, click, scelte precedenti -- usa il nome del test e la pagina riportata per capire a che punto del " +
      'flusso siamo) e ISPEZIONA DAL VIVO la pagina reale: non fidarti solo dello snapshot statico qui sotto, che può essere incompleto o riferirsi ' +
      "a un momento leggermente diverso. Prova più selettori nel browser finché non trovi quello che risolve esattamente l'elemento giusto, e solo " +
      "allora includilo nella risposta -- non proporre MAI un selettore che non hai verificato dal vivo sulla pagina reale dell'applicazione.",
  ];
  if (req.repoPath) lines.push(`Il sorgente dell'applicazione è nella tua cartella di lavoro (${req.repoPath}): puoi cercarci gli attributi data-test/id reali con Grep/Read.`);
  if (req.baseUrl) lines.push(`URL base dell'applicazione: ${req.baseUrl}`);
  lines.push(`Nome del test: "${req.testName}".`);
  lines.push('');
  if (req.prerequisites?.length) {
    lines.push(
      'IMPORTANTE: il tuo browser parte da zero (nessun login, nessuno stato). I passaggi sotto sono i test PREREQUISITI di questo test ' +
        '(di solito includono il login) nello stesso ordine in cui li esegue il motore vero -- DEVI rifarli TU STESSO nel tuo browser, uno per uno, ' +
        "PRIMA di andare alla pagina del passaggio da riparare, altrimenti ti troverai bloccato sulla schermata di login o in uno stato sbagliato. " +
        "Sono scritti con una piccola API (`pw.<azione>(selettore, valore, ...)`): interpretala come l'azione equivalente nel tuo browser reale " +
        '(`pw.load(url)` = naviga a quell\'URL, `pw.click(selettore, ...)` = clicca l\'elemento corrispondente, `pw.fill(selettore, valore, ...)` = scrivi quel valore, ecc.).'
    );
    for (const p of req.prerequisites) {
      lines.push(`--- Prerequisito: "${p.name}" ---`, p.code, '');
    }
  }
  for (const s of req.steps) {
    lines.push(`=== Passaggio (t=${s.t}, i=${s.i}) — test "${s.testName}", passo ${s.stepNumber} ===`);
    lines.push(`Come è scritto ora: ${s.description}`);
    lines.push(`Non trova più: ${s.failed}`);
    if (s.evidence) lines.push(`Nota: ${s.evidence}`);
    if (s.url) lines.push(`Pagina: ${s.url}`);
    if (s.snapshot?.options) lines.push(`Opzioni presenti nel menu a tendina:\n${JSON.stringify(s.snapshot.options)}`);
    if (s.snapshot?.elements) lines.push(`Elementi interattivi visibili nella pagina in quel momento:\n${JSON.stringify(s.snapshot.elements)}`);
    lines.push('');
  }
  lines.push(
    '--- Regole ---',
    '1. `selector` è una stringa di selettore Playwright usabile con page.locator(): CSS (es. `[data-test="Salva"]:visible`), oppure `xpath=//...`, oppure `text="Testo esatto"`.',
    '2. Preferisci attributi stabili: data-test, id NON generati (niente id con numeri casuali o prefissi select2-/ng-/mat-), aria-label, testo visibile. Evita xpath posizionali lunghi.',
    '3. Il selettore deve identificare UN SOLO elemento, VERIFICATO dal vivo nel browser: quello che il passaggio voleva usare (stessa azione, stesso scopo).',
    '4. Per un menu a tendina select2 non risolto, se una delle opzioni elencate (o trovate dal vivo aprendo il menu) corrisponde a ciò che il test voleva, restituisci `option` con il testo ESATTO di quell\'opzione (invece di `selector`).',
    '5. `timeoutMs` solo se sei certo che l\'elemento esiste ma compare molto in ritardo.',
    '6. NON INVENTARE un selettore quando non sei sicuro. Se, dopo aver provato dal vivo, non capisci cosa il passaggio dovrebbe fare, o la pagina/flusso che vedi ' +
      "non corrisponde affatto a quanto descritto (l'app è cambiata, uno schermo/flusso intero non c'è più, il test sembra scritto per un'altra versione " +
      "dell'app, o manca un dato/contesto che solo una persona può fornire), FERMATI e CHIEDI invece di indovinare: scatta uno screenshot con lo strumento " +
      "screenshot del browser (salvalo con un nome breve, es. \"q0.png\") e aggiungi una voce in `questions` con una domanda chiara e specifica per l'utente " +
      '(cosa vedi, perché sei bloccato, cosa ti serve sapere) e il nome del file dello screenshot in `screenshot`.',
    '',
    'Rispondi SOLO con un blocco ```json, senza altro testo, in questa forma (puoi includere `fixes`, `questions`, o entrambi -- lascia vuoto l\'array che non ti serve):',
    '```json',
    '{"fixes":[{"t":0,"i":2,"selector":"[data-test=\\"Salva\\"]:visible","option":null,"timeoutMs":null,"why":"breve motivo"}],' +
      '"questions":[{"t":0,"i":5,"question":"La pagina che vedo dopo il login non ha più il pulsante \\"Nuovo\\": il flusso è cambiato?","screenshot":"q0.png"}]}',
    '```'
  );
  return lines.join('\n');
}

export interface AiHealAnswer {
  fixes: AiHealFix[];
  /** `screenshot` here is still the bare filename Claude chose (e.g. "q0.png"): runAiHeal resolves it against the
   * MCP server's output dir and turns it into a data: URI before this reaches the caller. */
  questions: { t: number; i: number; question: string; screenshot: string | null }[];
}

/** Pulls `{fixes, questions}` out of the model's answer: the last ```json block, else the first balanced {...}
 * containing "fixes" or "questions". */
export function parseAiHealAnswer(text: string): AiHealAnswer {
  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g)) candidates.push(m[1]);
  // A bare {...} object is only a fallback for answers without any fenced block (else it would pick the FIRST
  // block's content and let it win over the model's final version).
  if (!candidates.length) {
    const start = Math.max(text.indexOf('{"fixes"'), text.indexOf('{"questions"'));
    if (start >= 0) {
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  for (const raw of candidates.reverse()) {
    try {
      const parsed = JSON.parse(raw.trim());
      if (!parsed || (!Array.isArray(parsed.fixes) && !Array.isArray(parsed.questions))) continue;
      const fixes = (Array.isArray(parsed.fixes) ? parsed.fixes : [])
        .filter((f: any) => f && Number.isInteger(f.t) && Number.isInteger(f.i))
        .map((f: any) => ({
          t: f.t,
          i: f.i,
          selector: typeof f.selector === 'string' ? f.selector : null,
          option: typeof f.option === 'string' ? f.option : null,
          timeoutMs: Number.isFinite(Number(f.timeoutMs)) && Number(f.timeoutMs) > 0 ? Number(f.timeoutMs) : null,
          why: typeof f.why === 'string' ? f.why : undefined,
        }));
      const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
        .filter((q: any) => q && Number.isInteger(q.t) && Number.isInteger(q.i) && typeof q.question === 'string' && q.question.trim())
        .map((q: any) => ({ t: q.t, i: q.i, question: q.question.trim(), screenshot: typeof q.screenshot === 'string' && q.screenshot.trim() ? q.screenshot.trim() : null }));
      return { fixes, questions };
    } catch {
      /* try the next candidate */
    }
  }
  return { fixes: [], questions: [] };
}

/**
 * Asks Claude Code for the selectors the deterministic healer could not find. Unlike a one-shot read of the failure
 * snapshot, it gets a REAL browser (the same injected Playwright MCP as runAiTestRequest) and full autonomy to use
 * it: navigate the app (by name/URL), reproduce the broken step's state and try selectors live until one verifiably
 * works. The answer is still just data (JSON) that the app validates and re-runs: the AI never edits the test or repo.
 */
export function runAiHeal(req: AiHealRequest, onLine?: (line: string) => void): Promise<AiHealResult> {
  if (currentAiChild) return Promise.reject(new Error(m('A Claude request is already in progress')));
  const shotsDir = path.join(os.tmpdir(), `insightest-ai-heal-shots-${process.pid}-${Date.now()}`);
  fs.mkdirSync(shotsDir, { recursive: true });
  const mcpConfigPath = writePlaywrightMcpConfig(shotsDir);
  const allowed = ['Read', 'Grep', 'Glob', 'mcp__playwright-ai'];
  const prompt = buildAiHealPrompt(req);
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
        onLine?.(line);
        return;
      }
      if (evt.type === 'result' && typeof evt.result === 'string') finalText = evt.result;
      if (evt.type === 'assistant') {
        for (const b of evt.message?.content ?? []) if (b.type === 'text') assistantText += `${b.text}\n`;
      }
      for (const described of describeStreamEvent(evt)) onLine?.(described);
    };
    // Driving a real browser round-trips with the agent's exploration, so this needs much more room than the
    // read-only path it replaces -- same ceiling as runAiTestRequest.
    const timer = setTimeout(() => cancelAiTestRequest(), 15 * 60 * 1000);
    const cleanup = (): void => {
      clearTimeout(timer);
      currentAiChild = null;
      fs.rm(mcpConfigPath, { force: true }, () => undefined);
      fs.rm(shotsDir, { recursive: true, force: true }, () => undefined);
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
    child.on('error', (e) => {
      cleanup();
      reject(e);
    });
    child.on('close', (code) => {
      handleLine(lineBuf);
      const cancelled = aiCancelled;
      const answer = finalText || assistantText;
      const { fixes, questions } = cancelled ? { fixes: [], questions: [] } : parseAiHealAnswer(answer);
      const resolved = questions.map((q) => ({ t: q.t, i: q.i, question: q.question, screenshot: q.screenshot ? screenshotDataUri(shotsDir, q.screenshot) : null }));
      cleanup();
      resolve({ fixes, questions: resolved, log, exitCode: code, cancelled });
    });
    onLine?.(m('▶▶ Asking Claude to fix the steps that could not be repaired automatically, with a real browser'));
    child.stdin?.end(prompt);
  });
}
