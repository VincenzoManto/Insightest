/**
 * Before healing selectors, compares a test's steps against OTHER tests in the same project to spot steps that
 * similar tests have and this one doesn't -- e.g. a confirmation click or a field fill that a near-identical flow
 * includes right after the same point this test continues from. Detection only: it builds regular HealProposals of
 * kind 'missing-step' (change.insert); nothing is added to the test until the user accepts one in the review panel.
 */
import { SELECTOR_KEYS, type EditableStep, type ParsedBuilderTest } from './stepModel';
import { describeStep, type HealProposal } from './healing';

export interface OtherTest {
  testId: number;
  name: string;
  parsed: ParsedBuilderTest;
}

/** A step's identity across tests: action + its most specific selector (digits blanked out, since ids/positions
 * drift between recordings) or, for `load`, the URL. Steps with nothing to compare on are left out of the sequence. */
function signature(step: EditableStep): string | null {
  if (!step.enabled) return null;
  if (step.action === 'load') return `load:${step.value.replace(/\d+/g, '#')}`;
  if (step.action === 'raw' || step.action === 'wait' || step.action === 'resize') return null;
  const sel = SELECTOR_KEYS.map((k) => step.selectors[k]).find((v) => v && v.trim()) || step.textHint || '';
  if (!sel.trim()) return null;
  return `${step.action}:${sel.toLowerCase().replace(/\d+/g, '#').trim()}`;
}

interface Signed {
  step: EditableStep;
  sig: string;
}

function signed(steps: readonly EditableStep[]): Signed[] {
  return steps.map((step) => ({ step, sig: signature(step) ?? '' })).filter((s): s is Signed => s.sig !== '');
}

/** Shared signatures over the smaller sequence's length, so a short test fully contained in a longer one still
 * counts as a strong match. */
function similarity(a: Signed[], b: Signed[]): number {
  const setB = new Set(b.map((s) => s.sig));
  const shared = a.filter((s) => setB.has(s.sig)).length;
  return shared / Math.max(1, Math.min(a.length, b.length));
}

/** Longest common subsequence of two signature sequences, as the list of matched (indexInA, indexInB) pairs in order. */
function lcsPairs(a: Signed[], b: Signed[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i].sig === b[j].sig ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].sig === b[j].sig) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

export interface MissingStepCandidate {
  /** Step from the OTHER test to propose inserting. */
  step: EditableStep;
  /** Key of the target step it should go right after (null = at the very start). */
  afterStepKey: string | null;
  /** 1-based position it would take in the target, for display. */
  atPosition: number;
  fromTestName: string;
  similarity: number;
}

const MIN_SIMILARITY = 0.45;
const MIN_SHARED = 3;
const MAX_SOURCE_TESTS = 3;

/** Steps present in similar OTHER tests, right after the same point this test reaches, that this test skips. */
export function findMissingSteps(target: readonly EditableStep[], others: readonly OtherTest[]): MissingStepCandidate[] {
  const targetSigned = signed(target);
  if (targetSigned.length < MIN_SHARED) return [];

  const ranked = others
    .map((o) => ({ o, otherSigned: signed(o.parsed.steps) }))
    .map((e) => ({ ...e, sim: similarity(targetSigned, e.otherSigned) }))
    .filter((e) => e.otherSigned.length >= MIN_SHARED && e.sim >= MIN_SIMILARITY)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, MAX_SOURCE_TESTS);

  const out: MissingStepCandidate[] = [];
  // The same missing step surfaced by several similar tests is proposed once (whichever test is closer comes first).
  const seen = new Set<string>();

  for (const { o, otherSigned, sim } of ranked) {
    const pairs = lcsPairs(targetSigned, otherSigned);
    let lastMatchedA = -1;
    let lastB = -1;
    const flush = (fromB: number, toB: number): void => {
      for (let j = fromB; j < toB; j++) {
        const anchorKey = lastMatchedA >= 0 ? targetSigned[lastMatchedA].step.key : null;
        const dedupeKey = `${anchorKey}:${otherSigned[j].sig}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        out.push({
          step: otherSigned[j].step,
          afterStepKey: anchorKey,
          atPosition: lastMatchedA >= 0 ? target.indexOf(targetSigned[lastMatchedA].step) + 2 : 1,
          fromTestName: o.name,
          similarity: sim,
        });
      }
    };
    for (const [ai, bi] of pairs) {
      flush(lastB + 1, bi);
      lastMatchedA = ai;
      lastB = bi;
    }
    flush(lastB + 1, otherSigned.length);
  }
  return out;
}

let proposalCounter = 0;

/** Turns missing-step candidates into reviewable proposals, unchecked by default (adding a step is a bigger change
 * than fixing a selector, so it needs an explicit opt-in). */
export function proposalsFromMissingSteps(testId: number, testName: string, candidates: readonly MissingStepCandidate[]): HealProposal[] {
  return candidates.map((c) => ({
    id: `m${++proposalCounter}`,
    testId,
    testName,
    stepKey: c.afterStepKey ?? '',
    stepNumber: c.atPosition,
    actionLabel: 'Insert step',
    kind: 'missing-step',
    source: 'deterministic',
    strategy: 'similar-test',
    confidence: Math.round(Math.min(0.75, c.similarity) * 100) / 100,
    evidence: `"${c.fromTestName}" has this step at the same point and this test does not`,
    before: '(missing)',
    after: describeStep(c.step),
    change: { clear: [], insert: { afterStepKey: c.afterStepKey, step: c.step } },
    accepted: false,
  }));
}
