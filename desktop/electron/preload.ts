import { contextBridge, ipcRenderer } from 'electron';

export interface RunResult {
  status: 'passed' | 'failed' | 'error';
  durationMs: number;
  log: string;
  healingDetail?: string;
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
  verified?: boolean;
}

export interface AiTestStatus {
  claude: boolean;
  insightestMcp: boolean;
  playwrightMcp: boolean;
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
  playwrightMcp: boolean;
}

export interface AiTestResult {
  code: string | null;
  dependsOn: string | null;
  log: string;
  exitCode: number | null;
  cancelled: boolean;
}

export interface McpSetupResult {
  ok: boolean;
  configPath: string;
  /** 'claude-not-found', or the CLI's own output. */
  message: string;
}

export type AgentName = 'claude' | 'copilot';

export interface ResilientStepMeta {
  secondarySelectors?: string[];
  textHint?: string;
  tagHint?: string;
}

/** Narrow, explicit surface exposed to the renderer (no raw ipcRenderer/fs/node access). */
contextBridge.exposeInMainWorld('insightest', {
  auth: {
    save: (payload: string): Promise<void> => ipcRenderer.invoke('auth:save', payload),
    load: (): Promise<string | null> => ipcRenderer.invoke('auth:load'),
    clear: (): Promise<void> => ipcRenderer.invoke('auth:clear'),
  },
  playwright: {
    run: (playwrightCode: string, options?: { headed?: boolean; betweenActionMs?: number }, dependencyCodes?: string[], steps?: ResilientStepMeta[] | null): Promise<RunResult> =>
      ipcRenderer.invoke('playwright:run', playwrightCode, options, dependencyCodes, steps),
    record: (startUrl: string): Promise<string | null> =>
      ipcRenderer.invoke('playwright:record', startUrl),
    augment: (playwrightCode: string): Promise<ResilientStepMeta[]> =>
      ipcRenderer.invoke('playwright:augment', playwrightCode),
    heal: (log: string): Promise<string | null> => ipcRenderer.invoke('playwright:heal', log),
    baseline: (
      projectId: number,
      baseUrl: string,
      tests: { id: number; playwright_code: string }[]
    ): Promise<BaselineResult> => ipcRenderer.invoke('playwright:baseline', projectId, baseUrl, tests),
    baselineExists: (projectId: number): Promise<boolean> => ipcRenderer.invoke('playwright:baseline-exists', projectId),
    browserStatus: (): Promise<boolean> => ipcRenderer.invoke('browser:status'),
    installBrowser: (): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke('browser:install'),
    healRepair: (projectId: number, baseUrl: string, testCode: string): Promise<HealResult> =>
      ipcRenderer.invoke('playwright:heal-repair', projectId, baseUrl, testCode),
    /** Live step-by-step output from whichever run/baseline/heal-repair call is currently in
     * flight (there's only ever one at a time from the UI). Returns an unsubscribe function. */
    onProgress: (callback: (line: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, line: string): void => callback(line);
      ipcRenderer.on('playwright:progress', listener);
      return () => ipcRenderer.removeListener('playwright:progress', listener);
    },
  },
  agent: {
    detect: (): Promise<Record<AgentName, boolean>> => ipcRenderer.invoke('agent:detect'),
    runRepair: (agent: AgentName, repoPath: string, prompt: string): Promise<{ exitCode: number | null; log: string }> =>
      ipcRenderer.invoke('agent:run-repair', agent, repoPath, prompt),
    aiStatus: (): Promise<AiTestStatus> => ipcRenderer.invoke('agent:ai-status'),
    aiTest: (req: AiTestRequest): Promise<AiTestResult> => ipcRenderer.invoke('agent:ai-test', req),
    aiCancel: (): Promise<boolean> => ipcRenderer.invoke('agent:ai-cancel'),
  },
  dialog: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-folder'),
  },
  mcp: {
    setup: (apiBaseUrl: string, jwt: string): Promise<McpSetupResult> => ipcRenderer.invoke('mcp:setup', apiBaseUrl, jwt),
  },
});
