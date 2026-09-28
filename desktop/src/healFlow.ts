/**
 * The self-healing flow, without any UI: for each test to repair it loads the test and its prerequisites, runs it in
 * HEAL mode (the engine fixes broken steps on the fly and reports them), turns the reports into proposals, asks the AI
 * about what could not be fixed, and finally VERIFIES the fixed versions with a normal run. It never saves anything:
 * saving happens only when the user confirms (components/HealPanel.tsx).
 */
import type { AiHealRequest, AiHealResult, ResilientStepMeta, RunResult } from './electron-bridge';
import type { TestDetail } from './types';
import { parseBuilderTest, serializeBuilderTest, type ParsedBuilderTest } from './stepModel';
import { applyProposals, applyToTests, eventsFromAiFixes, proposalsFromEvents, type HealProposal, type HealTest, type UnresolvedStep } from './healing';

export type TargetState = 'pending' | 'running' | 'healed' | 'nochange' | 'unresolved' | 'failed' | 'unsupported';

export interface TargetStatus {
  state: TargetState;
  message?: string;
  /** Result of the verification run on the fixed version (null = not verified yet / nothing to verify). */
  verified?: boolean | null;
  verifyMessage?: string;
}

export interface HealFlowDeps {
  loadTest: (testId: number) => Promise<TestDetail>;
  run: (
    code: string,
    options: { heal?: boolean; selectorPriority?: string[] },
    dependencyCodes: string[],
    steps: ResilientStepMeta[] | null,
    dependencySteps: (ResilientStepMeta[] | null)[]
  ) => Promise<RunResult>;
  aiHeal?: (req: AiHealRequest) => Promise<AiHealResult>;
  useAi: boolean;
  priority: string[];
  baseUrl?: string | null;
  repoPath?: string | null;
  onLog: (line: string) => void;
  onStatus: (testId: number, status: TargetStatus) => void;
  shouldStop: () => boolean;
}

/** A test as first loaded: its saved code/steps (for undo and for re-applying the accepted proposals) and its parse. */
export interface HealOriginal {
  detail: TestDetail;
  parsed: ParsedBuilderTest;
}

export interface HealFlowState {
  originals: Map<number, HealOriginal>;
  /** Working copies used by the runs: every proposal made so far is already applied to them. */
  drafts: Map<number, ParsedBuilderTest>;
  proposals: HealProposal[];
  /** Steps nobody could repair (the run stopped there). */
  unresolved: UnresolvedStep[];
}

export function newHealState(): HealFlowState {
  return { originals: new Map(), drafts: new Map(), proposals: [], unresolved: [] };
}

const MAX_AI_ROUNDS = 2;

/** Loads a test and its whole prerequisite chain (oldest first), registering each in the state once. */
async function loadChain(testId: number, deps: HealFlowDeps, state: HealFlowState): Promise<number[] | string> {
  const chain: number[] = [];
  const visited = new Set<number>();
  let next: number | null = testId;
  while (next !== null && !visited.has(next)) {
    visited.add(next);
    let original = state.originals.get(next);
    if (!original) {
      const detail = await deps.loadTest(next);
      const parsed = parseBuilderTest(detail.playwright_code, detail.steps_json);
      if (!parsed) return `"${detail.name}" (id ${detail.id}) uses the older recording format`;
      original = { detail, parsed };
      state.originals.set(next, original);
      state.drafts.set(next, parsed);
    }
    chain.unshift(next);
    next = original.detail.depends_on_test_id ?? null;
  }
  return chain;
}

function healTestsOf(chain: number[], state: HealFlowState): HealTest[] {
  return chain.map((id) => ({ testId: id, name: state.originals.get(id)!.detail.name, draft: state.drafts.get(id)! }));
}

/** Runs `chain` (prerequisites first, the target last) from the current drafts. */
async function runChain(chain: number[], state: HealFlowState, deps: HealFlowDeps, heal: boolean): Promise<RunResult> {
  const serialized = chain.map((id) => serializeBuilderTest(state.drafts.get(id)!, deps.priority));
  const main = serialized[serialized.length - 1];
  const before = serialized.slice(0, -1);
  return deps.run(
    main.code,
    { heal, selectorPriority: deps.priority },
    before.map((s) => s.code),
    main.steps as ResilientStepMeta[] | null,
    before.map((s) => s.steps as ResilientStepMeta[] | null)
  );
}

/** Heals one target (with its prerequisites). Returns its final state; proposals accumulate in `state`. */
async function healTarget(testId: number, deps: HealFlowDeps, state: HealFlowState): Promise<TargetStatus> {
  const loaded = await loadChain(testId, deps, state);
  if (typeof loaded === 'string') return { state: 'unsupported', message: loaded };
  const chain = loaded;
  const target = state.originals.get(testId)!.detail;
  const proposalsBefore = state.proposals.length;

  let aiRounds = 0;
  let last: RunResult | null = null;
  for (let round = 0; round < 1 + MAX_AI_ROUNDS; round++) {
    if (deps.shouldStop()) return { state: 'failed', message: 'stopped' };
    deps.onLog(`▶▶ ${target.name}${round ? ` (round ${round + 1})` : ''}`);
    last = await runChain(chain, state, deps, true);

    const tests = healTestsOf(chain, state);
    const { proposals, unresolved } = proposalsFromEvents(last.healEvents ?? [], tests, deps.priority);
    if (proposals.length) {
      state.proposals.push(...proposals);
      for (const t of applyToTests(tests, proposals)) state.drafts.set(t.testId, t.draft);
    }
    // Whatever this run reports replaces what was known about the tests it ran (a prerequisite fixed now is no longer broken).
    state.unresolved = state.unresolved.filter((u) => !chain.includes(u.testId)).concat(unresolved);
    if (!unresolved.length) break; // passed, or failed for a reason no selector change can fix (app bug, network...)

    if (!deps.useAi || !deps.aiHeal || aiRounds >= MAX_AI_ROUNDS) break;
    aiRounds++;
    const ai = await deps.aiHeal({
      testName: target.name,
      baseUrl: deps.baseUrl,
      repoPath: deps.repoPath,
      steps: unresolved.map((u) => ({ t: u.t, i: u.i, testName: u.testName, stepNumber: u.stepNumber, description: u.description, failed: u.failed, evidence: u.evidence, url: u.url, snapshot: u.snapshot })),
    });
    const events = eventsFromAiFixes(ai.fixes, unresolved);
    if (!events.length) {
      deps.onLog('   the AI had no reliable fix for the remaining steps');
      break;
    }
    const current = healTestsOf(chain, state);
    const fromAi = proposalsFromEvents(events, current, deps.priority, 'ai');
    if (!fromAi.proposals.length) break;
    state.proposals.push(...fromAi.proposals);
    for (const t of applyToTests(current, fromAi.proposals)) state.drafts.set(t.testId, t.draft);
    // Loop: run again in heal mode so the steps AFTER the repaired one are checked (and healed) too.
  }

  const made = state.proposals.slice(proposalsBefore).length;
  const stillBroken = state.unresolved.some((u) => u.testId === testId || chain.includes(u.testId));
  if (last && last.status === 'passed' && !stillBroken) return { state: made ? 'healed' : 'nochange' };
  if (stillBroken) return { state: 'unresolved', message: `${state.unresolved.length} step(s) could not be repaired` };
  return { state: 'failed', message: 'the run still fails for a reason that is not a selector change' };
}

/** Heals every target in order; prerequisites shared by several targets are repaired once (drafts are shared). */
export async function healTests(targetIds: number[], deps: HealFlowDeps, state: HealFlowState = newHealState()): Promise<{ state: HealFlowState; statuses: Map<number, TargetStatus> }> {
  const statuses = new Map<number, TargetStatus>();
  for (const id of targetIds) {
    if (deps.shouldStop()) break;
    deps.onStatus(id, { state: 'running' });
    let status: TargetStatus;
    try {
      status = await healTarget(id, deps, state);
    } catch (err) {
      status = { state: 'failed', message: err instanceof Error ? err.message : String(err) };
    }
    statuses.set(id, status);
    deps.onStatus(id, status);
  }
  return { state, statuses };
}

/**
 * Verification: a NORMAL run (no heal mode) of `target` with only the accepted proposals applied, on top of the saved
 * versions. True = the tests pass with exactly those changes.
 */
export async function verifyTarget(testId: number, accepted: readonly HealProposal[], deps: HealFlowDeps, state: HealFlowState): Promise<{ ok: boolean; message?: string }> {
  const loaded = await loadChain(testId, deps, state);
  if (typeof loaded === 'string') return { ok: false, message: loaded };
  const chain = loaded;
  const trial: HealFlowState = {
    ...state,
    drafts: new Map(chain.map((id) => [id, applyProposals(state.originals.get(id)!.parsed, accepted.filter((p) => p.testId === id))] as const)),
  };
  const res = await runChain(chain, trial, deps, false);
  if (res.status === 'passed') return { ok: true };
  const reason = res.log
    .split('\n')
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter((l) => /Error|Azione fallita|Timeout/.test(l))
    .slice(-2)
    .join(' · ');
  return { ok: false, message: reason || res.status };
}

/** The code/steps to save for `testId`: its original with only the accepted proposals applied. */
export function buildSave(testId: number, accepted: readonly HealProposal[], state: HealFlowState, priority: readonly string[]): { code: string; steps: unknown[] | null } | null {
  const original = state.originals.get(testId);
  const mine = accepted.filter((p) => p.testId === testId);
  if (!original || !mine.length) return null;
  return serializeBuilderTest(applyProposals(original.parsed, mine), priority);
}
