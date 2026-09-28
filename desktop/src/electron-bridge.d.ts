/** A step the engine's heal mode fixed (or could not fix) during a run. Mirrors HealEvent in electron/runnerCore.ts. */
export interface HealEvent {
  /** Test of the run: 0..n-1 = prerequisites (oldest first), n = the test itself. */
  t: number;
  /** i-th selector-bearing call of that test (index into its steps_json). */
  i: number;
  kind: 'selector' | 'timing' | 'value' | 'unresolved';
  action: string;
  failed: string;
  failedAll?: string[];
  selector?: string;
  option?: string;
  timeoutMs?: number;
  strategy?: string;
  confidence?: number;
  matches?: number;
  evidence?: string;
  url?: string;
  snapshot?: { title?: string; elements?: Record<string, string>[]; options?: string[] } | null;
}

export interface RunResult {
  status: 'passed' | 'failed' | 'error';
  durationMs: number;
  log: string;
  healingDetail?: string;
  /** Present on runs made with `heal: true`. */
  healEvents?: HealEvent[];
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

/** A step the deterministic healer could not fix, sent to the AI with the page snapshot taken at the failure. */
export interface AiHealStep {
  t: number;
  i: number;
  testName: string;
  stepNumber: number;
  description: string;
  failed: string;
  evidence?: string;
  url?: string;
  snapshot?: { title?: string; elements?: Record<string, string>[]; options?: string[] } | null;
}

export interface AiHealRequest {
  testName: string;
  baseUrl?: string | null;
  repoPath?: string | null;
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

export interface AiHealResult {
  fixes: AiHealFix[];
  log: string;
  exitCode: number | null;
  cancelled: boolean;
}

export interface InsightestBridge {
  auth: {
    save: (payload: string) => Promise<void>;
    load: () => Promise<string | null>;
    clear: () => Promise<void>;
  };
  playwright: {
    run: (playwrightCode: string, options?: { headed?: boolean; betweenActionMs?: number; selectorPriority?: string[]; heal?: boolean }, dependencyCodes?: string[], steps?: ResilientStepMeta[] | null, dependencySteps?: (ResilientStepMeta[] | null)[]) => Promise<RunResult>;
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
    aiHeal: (req: AiHealRequest) => Promise<AiHealResult>;
    aiCancel: () => Promise<boolean>;
  };
  i18n: {
    setLocale: (locale: string) => Promise<void>;
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
