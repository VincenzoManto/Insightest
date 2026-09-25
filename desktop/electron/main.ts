import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { resolveNodeModule } from './runnerCore';
import { setMessagesLocale } from './messages';
import {
  runPlaywrightTest,
  recordPlaywrightTest,
  augmentRecordedSteps,
  explainFailure,
  createOrUpdateBaseline,
  baselineExists,
  healTest,
  type ResilientStepMeta,
} from './playwrightRunner';
import {
  detectInstalledAgents,
  runAgentRepair,
  detectAiTestStatus,
  runAiTestRequest,
  cancelAiTestRequest,
  type AgentName,
  type AiTestRequest,
} from './agentRepair';

// Without these, any exception thrown outside an IPC handler's promise chain (a stray
// bug in a `.on(...)` callback, a bad require, etc.) takes down the whole Electron
// process -- main window included -- with no dialog and no way to recover except relaunch.
process.on('uncaughtException', (error) => {
  console.error('[insightest] uncaught exception in main process', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[insightest] unhandled rejection in main process', reason);
});

// Set only by `npm run dev` once the Vite dev server is up; otherwise load the built bundle.
const devServerUrl = process.env.ELECTRON_RENDERER_URL;
const authFilePath = path.join(app.getPath('userData'), 'auth.enc');

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f6f7f5',
 /*    autoHideMenuBar: true, */
    title: 'Insightest',
    icon: path.join(__dirname, 'icon.png'),
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // A renderer crash (out-of-memory, GPU crash, etc.) otherwise leaves a permanently
  // blank/frozen window with no indication anything went wrong; reload it automatically.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[insightest] renderer process gone', details);
    if (!win.isDestroyed()) win.reload();
  });
  win.webContents.on('unresponsive', () => {
    console.error('[insightest] renderer became unresponsive');
  });

  if (devServerUrl) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

/** Persists the JWT/API config encrypted at rest via the OS keychain (safeStorage). */
ipcMain.handle('auth:save', (_event, payload: string) => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS secure storage is not available on this machine');
  }
  fs.writeFileSync(authFilePath, safeStorage.encryptString(payload));
});

ipcMain.handle('auth:load', () => {
  if (!fs.existsSync(authFilePath)) return null;
  const encrypted = fs.readFileSync(authFilePath);
  return safeStorage.decryptString(encrypted);
});

ipcMain.handle('auth:clear', () => {
  if (fs.existsSync(authFilePath)) fs.unlinkSync(authFilePath);
});

ipcMain.handle('playwright:run', async (event, playwrightCode: string, options?: { headed?: boolean; betweenActionMs?: number; selectorPriority?: string[] }, dependencyCodes?: string[], steps?: ResilientStepMeta[] | null, dependencySteps?: (ResilientStepMeta[] | null)[]) => {
  return runPlaywrightTest(playwrightCode, options, dependencyCodes, (line) => event.sender.send('playwright:progress', line), steps, dependencySteps);
});

ipcMain.handle('playwright:record', async (_event, startUrl: string) => {
  return recordPlaywrightTest(startUrl);
});

ipcMain.handle('playwright:augment', async (_event, playwrightCode: string) => {
  return augmentRecordedSteps(playwrightCode);
});

ipcMain.handle('playwright:heal', async (_event, log: string) => {
  return (await explainFailure(log)) ?? null;
});

ipcMain.handle(
  'playwright:baseline',
  async (event, projectId: number, baseUrl: string, tests: { id: number; playwright_code: string }[]) => {
    return createOrUpdateBaseline(projectId, baseUrl, tests, (line) => event.sender.send('playwright:progress', line));
  }
);

ipcMain.handle('playwright:baseline-exists', async (_event, projectId: number) => {
  return baselineExists(projectId);
});

ipcMain.handle('playwright:heal-repair', async (event, projectId: number, baseUrl: string, testCode: string) => {
  return healTest(projectId, baseUrl, testCode, (line) => event.sender.send('playwright:progress', line));
});

ipcMain.handle('agent:detect', async () => {
  return detectInstalledAgents();
});

ipcMain.handle('agent:run-repair', async (event, agent: AgentName, repoPath: string, prompt: string) => {
  return runAgentRepair(agent, repoPath, prompt, (line) => event.sender.send('playwright:progress', line));
});

ipcMain.handle('agent:ai-status', async () => {
  return detectAiTestStatus();
});

ipcMain.handle('agent:ai-test', async (event, req: AiTestRequest) => {
  return runAiTestRequest(req, (line) => event.sender.send('playwright:progress', line));
});

ipcMain.handle('agent:ai-cancel', () => {
  return cancelAiTestRequest();
});

/** Whether the Chromium build Playwright drives is present on this machine. */
ipcMain.handle('browser:status', () => {
  try {
    const { chromium } = require('playwright-core') as typeof import('playwright-core');
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
});

/** Downloads Chromium via playwright-core's own CLI, run under this app's binary in Node mode:
 * no npx, npm or system Node needed on the user's machine. */
ipcMain.handle('browser:install', (event) => {
  return new Promise<{ ok: boolean; output: string }>((resolve) => {
    const cli = resolveNodeModule(app.getAppPath(), path.join('playwright-core', 'cli.js'));
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let output = '';
    const pump = (chunk: Buffer): void => {
      const text = chunk.toString();
      output += text;
      // Progress bars redraw with \r; treat both as line breaks for the live panel.
      for (const line of text.split(/[\r\n]+/)) if (line.trim()) event.sender.send('playwright:progress', line);
    };
    child.stdout?.on('data', pump);
    child.stderr?.on('data', pump);
    child.on('error', (err) => resolve({ ok: false, output: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, output }));
  });
});

ipcMain.handle('i18n:set-locale', (_event, locale: string) => {
  setMessagesLocale(locale);
});

ipcMain.handle('dialog:pick-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

// Compiled alongside this file, so it ships inside the app (asar included) with its dependencies.
const mcpServerEntryPath = path.join(__dirname, 'mcpServer.js');

function runCli(command: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    // On Windows `claude` may be a .cmd shim, which needs a shell; quote every argument since
    // shell mode joins them into one command line (paths often contain spaces).
    const win = process.platform === 'win32';
    const child = win
      ? spawn([command, ...args.map((a) => `"${a}"`)].join(' '), { shell: true })
      : spawn(command, args);
    let output = '';
    child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** One-click MCP setup: writes the JWT/apiBaseUrl the MCP server reads at startup, then
 * (re)registers the server in Claude Code at user scope so it is visible from any folder. The
 * server is launched through this app's own binary in Node mode (ELECTRON_RUN_AS_NODE), so it
 * needs neither a separate Node install nor files outside the packaged app. The JWT expires
 * after the backend's configured TTL (8h by default): clicking the button again refreshes it. */
ipcMain.handle('mcp:setup', async (_event, apiBaseUrl: string, jwt: string) => {
  const configPath = path.join(app.getPath('userData'), 'mcp-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ apiBaseUrl, jwt }, null, 2), 'utf8');

  const probe = await runCli('claude', ['--version']).catch(() => null);
  if (!probe || probe.code !== 0) {
    return { ok: false, configPath, message: 'claude-not-found' };
  }
  await runCli('claude', ['mcp', 'remove', 'insightest', '--scope', 'user']).catch(() => null);
  const add = await runCli('claude', [
    'mcp',
    'add',
    'insightest',
    '--scope',
    'user',
    '-e',
    'ELECTRON_RUN_AS_NODE=1',
    '-e',
    `INSIGHTEST_MCP_CONFIG=${configPath}`,
    '-e',
    `INSIGHTEST_USER_DATA_DIR=${app.getPath('userData')}`,
    '--',
    process.execPath,
    mcpServerEntryPath,
  ]).catch((err: Error) => ({ code: -1, output: err.message }));
  return { ok: add.code === 0, configPath, message: add.output.trim() };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
