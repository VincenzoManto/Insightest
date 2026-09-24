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

export interface InsightestBridge {
  auth: {
    save: (payload: string) => Promise<void>;
    load: () => Promise<string | null>;
    clear: () => Promise<void>;
  };
  playwright: {
    run: (playwrightCode: string, options?: { headed?: boolean; betweenActionMs?: number }, dependencyCodes?: string[], steps?: ResilientStepMeta[] | null) => Promise<RunResult>;
    record: (startUrl: string) => Promise<string | null>;
    augment: (playwrightCode: string) => Promise<ResilientStepMeta[]>;
    heal: (log: string) => Promise<string | null>;
    baseline: (projectId: number, baseUrl: string, tests: { id: number; playwright_code: string }[]) => Promise<BaselineResult>;
    baselineExists: (projectId: number) => Promise<boolean>;
    browserStatus: () => Promise<boolean>;
    installBrowser: () => Promise<{ ok: boolean; output: string }>;
    healRepair: (projectId: number, baseUrl: string, testCode: string) => Promise<HealResult>;
    onProgress: (callback: (line: string) => void) => () => void;
  };
  agent: {
    detect: () => Promise<Record<AgentName, boolean>>;
    runRepair: (agent: AgentName, repoPath: string, prompt: string) => Promise<{ exitCode: number | null; log: string }>;
    aiStatus: () => Promise<AiTestStatus>;
    aiTest: (req: AiTestRequest) => Promise<AiTestResult>;
    aiCancel: () => Promise<boolean>;
  };
  dialog: {
    pickFolder: () => Promise<string | null>;
  };
  mcp: {
    setup: (apiBaseUrl: string, jwt: string) => Promise<McpSetupResult>;
  };
}

declare global {
  interface Window {
    insightest: InsightestBridge;
  }
}

export {};
