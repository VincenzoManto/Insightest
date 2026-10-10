import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Bot, CheckCircle2, ChevronDown, ChevronRight, CircleDot, Loader2, MessageCircleQuestion, RotateCcw, Save, ShieldCheck, Wand2, X, XCircle } from 'lucide-react';
import { useAuth } from '../state/AuthContext';
import type { Project, TestDetail, TestSummary } from '../types';
import { parseSelectorPriority } from './SelectorPriorityEditor';
import { buildSave, healTests, newHealState, verifyTarget, type HealFlowDeps, type HealFlowState, type TargetStatus } from '../healFlow';
import type { HealProposal } from '../healing';
import { t } from '../i18n';

type Phase = 'ready' | 'running' | 'verifying' | 'review' | 'saving' | 'saved';

interface Verification {
  /** Per target: did the fixed version pass a normal run? */
  results: Record<number, { ok: boolean; message?: string }>;
  /** The user changed the selection after verifying: the result no longer describes what would be saved. */
  outdated: boolean;
  running: boolean;
}

const STATE_LABEL: Record<TargetStatus['state'], string> = {
  pending: 'Waiting',
  running: 'Repairing…',
  healed: 'Repaired',
  nochange: 'Nothing to repair',
  unresolved: 'Not fully repaired',
  failed: 'Still failing',
  unsupported: 'Not supported',
};

function StateIcon({ state }: { state: TargetStatus['state'] }): React.ReactElement {
  if (state === 'running') return <Loader2 size={15} className="animate-spin text-accent2" />;
  if (state === 'healed' || state === 'nochange') return <CheckCircle2 size={15} className="text-good" />;
  if (state === 'unresolved') return <AlertTriangle size={15} className="text-warning" />;
  if (state === 'pending') return <CircleDot size={15} className="text-ink-muted" />;
  return <XCircle size={15} className="text-critical" />;
}

function Confidence({ value }: { value: number }): React.ReactElement {
  const pct = Math.round(value * 100);
  const color = pct >= 80 ? '#0ca30c' : pct >= 60 ? '#fab219' : '#d03b3b';
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted" title={t('How sure the healer is that this is the same element')}>
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-gridline">
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </span>
      {pct}%
    </span>
  );
}

const STRATEGY_LABEL: Record<string, string> = {
  'recorded-alternative': 'another recorded selector still works',
  'data-test': 'same data-test',
  id: 'same id',
  'label-for': 'label of the field',
  name: 'same name',
  text: 'same visible text',
  'aria-label': 'same aria-label',
  placeholder: 'same placeholder',
  'xpath-tail': 'end of the recorded path',
  'xpath-anchor': 'inside the same page component',
  similarity: 'similar text',
  wait: 'the element is just slow',
  'closest-option': 'closest option',
  'similar-test': 'found in a similar test',
  ai: 'suggested by Claude',
};

const BACKUP_KEY = 'insightest.healBackups';

/** Keeps the last saved-over versions so a heal can be undone even after the app is closed. */
function rememberBackups(entries: { testId: number; name: string; code: string; steps: string | null }[]): void {
  try {
    const previous = JSON.parse(localStorage.getItem(BACKUP_KEY) ?? '[]') as unknown[];
    const next = [...entries.map((e) => ({ ...e, at: new Date().toISOString() })), ...previous].slice(0, 30);
    localStorage.setItem(BACKUP_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the in-panel undo still works */
  }
}

/**
 * Self-healing review: runs the given tests in heal mode (deterministic fixes found on the live page, then Claude for
 * what is left), shows every proposed change for confirmation, verifies the accepted set with a normal run, and only
 * then saves. Saving can be undone.
 */
export function HealPanel({
  project,
  testIds,
  title,
  onClose,
  onSaved,
}: {
  project: Project;
  testIds: number[];
  title?: string;
  onClose: () => void;
  onSaved?: (testIds: number[]) => void;
}): React.ReactElement {
  const { api } = useAuth();
  const priority = useMemo(() => parseSelectorPriority(project.selector_priority) as string[], [project.selector_priority]);

  const [phase, setPhase] = useState<Phase>('ready');
  const [aiAvailable, setAiAvailable] = useState(false);
  const [useAi, setUseAi] = useState(true);
  const [statuses, setStatuses] = useState<Record<number, TargetStatus>>({});
  const [names, setNames] = useState<Record<number, string>>({});
  const [proposals, setProposals] = useState<HealProposal[]>([]);
  const [lines, setLines] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ testId: number; name: string; code: string; steps: unknown[] | null }[] | null>(null);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

  const stateRef = useRef<HealFlowState>(newHealState());
  const stopRef = useRef(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    window.insightest.agent
      .detect()
      .then((d) => setAiAvailable(!!d.claude))
      .catch(() => setAiAvailable(false));
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  const accepted = proposals.filter((p) => p.accepted);
  const busy = phase === 'running' || phase === 'verifying' || phase === 'saving';

  function makeDeps(): HealFlowDeps {
    return {
      loadTest: (id) => api.get<TestDetail>(`/tests/${id}`),
      run: (code, options, dependencyCodes, steps, dependencySteps) => window.insightest.playwright.run(code, options, dependencyCodes, steps, dependencySteps),
      aiHeal: (req) => window.insightest.agent.aiHeal(req),
      loadProjectTests: async () => {
        const { tests } = await api.get<{ tests: TestSummary[] }>(`/projects/${project.id}/tests`);
        return Promise.all(tests.map((t) => api.get<TestDetail>(`/tests/${t.id}`)));
      },
      useAi: useAi && aiAvailable,
      priority,
      baseUrl: project.base_url,
      repoPath: project.repo_path,
      onLog: (line) => setLines((prev) => [...prev, line]),
      onStatus: (id, status) => setStatuses((prev) => ({ ...prev, [id]: { ...prev[id], ...status } })),
      shouldStop: () => stopRef.current,
    };
  }

  async function start(): Promise<void> {
    stopRef.current = false;
    stateRef.current = newHealState();
    setError(null);
    setLines([]);
    setProposals([]);
    setVerification(null);
    setStatuses(Object.fromEntries(testIds.map((id) => [id, { state: 'pending' } as TargetStatus])));
    setPhase('running');
    const unsubscribe = window.insightest.playwright.onProgress((line) => setLines((prev) => [...prev, line]));
    try {
      const deps = makeDeps();
      const { state } = await healTests(testIds, deps, stateRef.current);
      setNames(Object.fromEntries([...state.originals.entries()].map(([id, o]) => [id, o.detail.name])));
      setProposals(state.proposals.map((p) => ({ ...p })));

      if (state.proposals.length && !stopRef.current) {
        setPhase('verifying');
        await runVerification(state.proposals, deps);
      }
      setPhase('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
      setPhase('review');
    } finally {
      unsubscribe();
    }
  }

  async function runVerification(chosen: readonly HealProposal[], deps: HealFlowDeps = makeDeps()): Promise<void> {
    setVerification({ results: {}, outdated: false, running: true });
    const results: Verification['results'] = {};
    const affected = testIds.filter((id) => chosen.length > 0 && stateRef.current.originals.has(id));
    for (const id of affected) {
      if (stopRef.current) break;
      try {
        results[id] = await verifyTarget(id, chosen, deps, stateRef.current);
      } catch (err) {
        results[id] = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      setVerification({ results: { ...results }, outdated: false, running: true });
    }
    setVerification({ results, outdated: false, running: false });
  }

  async function reverify(): Promise<void> {
    setPhase('verifying');
    const unsubscribe = window.insightest.playwright.onProgress((line) => setLines((prev) => [...prev, line]));
    try {
      await runVerification(accepted);
    } finally {
      unsubscribe();
      setPhase('review');
    }
  }

  function toggle(id: string): void {
    setProposals((prev) => prev.map((p) => (p.id === id ? { ...p, accepted: !p.accepted } : p)));
    setVerification((v) => (v ? { ...v, outdated: true } : v));
  }

  function setAll(value: boolean): void {
    setProposals((prev) => prev.map((p) => ({ ...p, accepted: value })));
    setVerification((v) => (v ? { ...v, outdated: true } : v));
  }

  async function save(): Promise<void> {
    setPhase('saving');
    setError(null);
    const backups: { testId: number; name: string; code: string; steps: string | null }[] = [];
    const undoList: { testId: number; name: string; code: string; steps: unknown[] | null }[] = [];
    try {
      const touched = [...new Set(accepted.map((p) => p.testId))];
      for (const id of touched) {
        const original = stateRef.current.originals.get(id);
        const built = buildSave(id, accepted, stateRef.current, priority);
        if (!original || !built) continue;
        backups.push({ testId: id, name: original.detail.name, code: original.detail.playwright_code, steps: original.detail.steps_json });
        let previousSteps: unknown[] | null = null;
        try {
          previousSteps = original.detail.steps_json ? (JSON.parse(original.detail.steps_json) as unknown[]) : null;
        } catch {
          previousSteps = null;
        }
        undoList.push({ testId: id, name: original.detail.name, code: original.detail.playwright_code, steps: previousSteps });
        await api.put(`/tests/${id}`, { playwright_code: built.code, steps: built.steps });
      }
      rememberBackups(backups);
      setUndo(undoList);
      setPhase('saved');
      onSaved?.(touched);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
      setPhase('review');
    }
  }

  async function undoSave(): Promise<void> {
    if (!undo) return;
    setPhase('saving');
    try {
      for (const u of undo) await api.put(`/tests/${u.testId}`, { playwright_code: u.code, steps: u.steps });
      setUndo(null);
      onSaved?.(undo.map((u) => u.testId));
      setPhase('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
      setPhase('saved');
    }
  }

  const grouped = useMemo(() => {
    const map = new Map<number, HealProposal[]>();
    for (const p of proposals) map.set(p.testId, [...(map.get(p.testId) ?? []), p]);
    return [...map.entries()];
  }, [proposals]);

  const verifiedAll = verification && !verification.running && !verification.outdated && Object.values(verification.results).length > 0 && Object.values(verification.results).every((r) => r.ok);
  const verifiedSome = verification && !verification.running && !verification.outdated && Object.values(verification.results).some((r) => !r.ok);
  const stillBroken = stateRef.current.unresolved;
  const questions = stateRef.current.questions;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-primary/45 p-4 backdrop-blur-[2px]">
      <div className="my-6 w-full max-w-[940px] rounded-2xl border border-gridline bg-surface shadow-2xl" role="dialog" aria-label={t('Auto-heal')}>
        <header className="flex items-start justify-between gap-4 border-b border-gridline px-5 py-4">
          <div>
            <div className="flex items-center gap-2 text-[17px] font-semibold text-ink-primary">
              <Wand2 size={18} className="text-accent" /> {title ?? t('Auto-heal')}
            </div>
            <p className="mt-0.5 text-xs text-ink-muted">
              {t('The failing steps are repaired on the live page, then you confirm what to keep. Nothing is saved before that.')}
            </p>
          </div>
          <button className="secondary icon" onClick={() => (busy ? (stopRef.current = true) : onClose())} title={busy ? t('Stop') : t('Close')}>
            <X size={16} />
          </button>
        </header>

        <div className="flex flex-col gap-4 px-5 py-4">
          {error && <div className="error-banner !mb-0">{error}</div>}

          {phase === 'ready' && (
            <div className="flex flex-col gap-3">
              <div className="rounded-xl bg-page px-4 py-3 text-[13px] text-ink-secondary">
                {t('{n} test(s) will be run against the live application, together with their prerequisite tests.', { n: testIds.length })}
              </div>
              <label className={`flex items-start gap-2.5 text-[13px] ${aiAvailable ? 'text-ink-primary' : 'text-ink-muted'}`}>
                <input type="checkbox" checked={useAi && aiAvailable} disabled={!aiAvailable} onChange={(e) => setUseAi(e.target.checked)} className="mt-0.5 !p-0" />
                <span>
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <Bot size={14} /> {t('Ask Claude about the steps that cannot be repaired automatically')}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-muted">
                    {aiAvailable
                      ? project.repo_path
                        ? t("Claude sees the page at the moment of the failure and the application's source code.")
                        : t('Claude sees the page at the moment of the failure. Set the repo path in the project to let it read the source too.')
                      : t('Claude Code was not found on this machine.')}
                  </span>
                </span>
              </label>
              <div className="flex justify-end gap-2">
                <button className="secondary" onClick={onClose}>
                  {t('Cancel')}
                </button>
                <button onClick={() => void start()}>
                  <Wand2 size={15} /> {t('Start')}
                </button>
              </div>
            </div>
          )}

          {phase !== 'ready' && (
            <div className="flex flex-col gap-1.5">
              {testIds.map((id) => {
                const st = statuses[id] ?? { state: 'pending' as const };
                const v = verification?.results[id];
                return (
                  <div key={id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-gridline px-3 py-2 text-[13px]">
                    <StateIcon state={st.state} />
                    <span className="min-w-0 flex-1 truncate font-medium text-ink-primary">{names[id] ?? `#${id}`}</span>
                    <span className="text-xs text-ink-muted">{t(STATE_LABEL[st.state])}</span>
                    {v && !verification?.outdated && (
                      <span className={`inline-flex items-center gap-1 text-xs ${v.ok ? 'text-good' : 'text-critical'}`} title={v.message}>
                        {v.ok ? <ShieldCheck size={13} /> : <XCircle size={13} />} {v.ok ? t('verified: passes') : t('verification failed')}
                      </span>
                    )}
                    {st.message && st.state !== 'running' && <span className="basis-full pl-7 text-xs text-ink-muted">{st.message}</span>}
                    {v && !v.ok && v.message && !verification?.outdated && <span className="basis-full pl-7 text-xs text-critical">{v.message}</span>}
                  </div>
                );
              })}
            </div>
          )}

          {(phase === 'running' || phase === 'verifying') && (
            <div className="flex items-center gap-2 text-xs text-ink-muted">
              <Loader2 size={13} className="animate-spin" />
              {phase === 'running' ? t('Running the tests and repairing broken steps… this can take a few minutes.') : t('Verifying the repaired tests with a normal run…')}
            </div>
          )}

          {phase !== 'ready' && lines.length > 0 && (
            <div>
              <button type="button" className="ghost sm !px-1" onClick={() => setShowLog((v) => !v)}>
                {showLog ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {t('Run log')} ({lines.length})
              </button>
              {showLog && (
                <pre ref={logRef} className="codeblock mt-1 max-h-56 overflow-auto">
                  {lines.slice(-400).join('\n')}
                </pre>
              )}
            </div>
          )}

          {(phase === 'review' || phase === 'saved' || phase === 'saving') && (
            <>
              {proposals.length === 0 && stillBroken.length === 0 && !error && (
                <div className="rounded-xl bg-page px-4 py-3 text-[13px] text-ink-secondary">
                  {t('No selector needed repair. If a test is still failing, the cause is not a broken selector (application error, data or environment).')}
                </div>
              )}

              {proposals.length > 0 && (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-ink-primary">{t('Proposed changes ({n})', { n: proposals.length })}</div>
                    <div className="flex gap-1.5">
                      <button className="secondary sm" onClick={() => setAll(true)} disabled={busy}>
                        {t('Select all')}
                      </button>
                      <button className="secondary sm" onClick={() => setAll(false)} disabled={busy}>
                        {t('Select none')}
                      </button>
                    </div>
                  </div>

                  {verifiedAll && (
                    <div className="flex items-center gap-2 rounded-xl border border-good/30 bg-good/10 px-3 py-2 text-[13px] text-good">
                      <ShieldCheck size={16} /> {t('Verified: with the selected changes the tests pass in a normal run.')}
                    </div>
                  )}
                  {verifiedSome && (
                    <div className="flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-[13px] text-ink-primary">
                      <AlertTriangle size={16} className="text-warning" /> {t('Not every test passes with these changes yet: review them before saving.')}
                    </div>
                  )}
                  {verification?.outdated && (
                    <div className="flex items-center gap-2 rounded-xl border border-gridline bg-page px-3 py-2 text-[13px] text-ink-secondary">
                      <AlertTriangle size={16} /> {t('The selection changed: verify again to know whether it still passes.')}
                    </div>
                  )}

                  {grouped.map(([testId, list]) => (
                    <div key={testId} className="rounded-xl border border-gridline">
                      <button
                        type="button"
                        onClick={() => setCollapsed((c) => ({ ...c, [testId]: !c[testId] }))}
                        className="!flex !w-full !items-center !justify-start !gap-2 !rounded-none !border-0 !bg-page !px-3 !py-2 !text-left !text-[13px] !font-semibold !shadow-none"
                      >
                        {collapsed[testId] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        <span className="min-w-0 flex-1 truncate">{names[testId] ?? `#${testId}`}</span>
                        <span className="text-xs font-normal text-ink-muted">{t('{n} change(s)', { n: list.length })}</span>
                      </button>
                      {!collapsed[testId] &&
                        list.map((p) => (
                          <label key={p.id} className={`flex cursor-pointer items-start gap-3 border-t border-gridline px-3 py-3 ${p.accepted ? '' : 'opacity-55'}`}>
                            <input type="checkbox" checked={p.accepted} onChange={() => toggle(p.id)} disabled={busy} className="mt-1 !p-0" />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
                                <span className="font-semibold text-ink-primary">
                                  {t('Step')} {p.stepNumber} · {t(p.actionLabel)}
                                </span>
                                <span className="rounded bg-page px-1.5 py-0.5 text-[11px] text-ink-secondary">{t(STRATEGY_LABEL[p.strategy] ?? p.strategy)}</span>
                                {p.source === 'ai' && (
                                  <span className="inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-[11px] text-accent-700">
                                    <Bot size={11} /> AI
                                  </span>
                                )}
                                <Confidence value={p.confidence} />
                              </div>
                              <div className="mt-1.5 flex flex-col gap-1 font-mono text-[11.5px] leading-snug">
                                <div className="break-all rounded bg-critical/5 px-2 py-1 text-critical line-through decoration-critical/40">{p.before || '—'}</div>
                                <div className="flex items-start gap-1.5">
                                  <ArrowRight size={12} className="mt-1 flex-shrink-0 text-ink-muted" />
                                  <div className="min-w-0 flex-1 break-all rounded bg-good/10 px-2 py-1 text-good">{p.after}</div>
                                </div>
                              </div>
                              {p.evidence && <div className="mt-1 text-xs text-ink-muted">{p.evidence}</div>}
                            </div>
                          </label>
                        ))}
                    </div>
                  ))}
                </div>
              )}

              {stillBroken.length > 0 && (
                <div className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-[13px]">
                  <div className="flex items-center gap-2 font-semibold text-ink-primary">
                    <AlertTriangle size={15} className="text-warning" /> {t('{n} step(s) could not be repaired', { n: stillBroken.length })}
                  </div>
                  <ul className="mt-1.5 flex flex-col gap-1 text-xs text-ink-secondary">
                    {stillBroken.map((u) => (
                      <li key={`${u.t}:${u.i}`}>
                        <b>{u.testName}</b> — {t('Step')} {u.stepNumber} ({t(u.actionLabel)}): <span className="break-all font-mono">{u.failed}</span>
                        {u.evidence ? ` — ${u.evidence}` : ''}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-1.5 text-xs text-ink-muted">{t('Fix these by hand in the step editor: the page no longer has anything that resembles them.')}</div>
                </div>
              )}

              {questions.length > 0 && (
                <div className="rounded-xl border border-accent/40 bg-accent/5 px-3 py-2.5 text-[13px]">
                  <div className="flex items-center gap-2 font-semibold text-ink-primary">
                    <MessageCircleQuestion size={15} className="text-accent" /> {t('Claude has {n} question(s) before it can fix the rest', { n: questions.length })}
                  </div>
                  <p className="mt-1 text-xs text-ink-muted">
                    {t("It chose not to guess a selector it couldn't verify. Answer by editing the step yourself (or telling it what changed) and run again.")}
                  </p>
                  <ul className="mt-2 flex flex-col gap-3">
                    {questions.map((q, idx) => (
                      <li key={`${q.testId}:${q.stepKey}:${idx}`} className="flex gap-3 rounded-lg bg-surface px-2.5 py-2">
                        {q.screenshot && <img src={q.screenshot} alt="" className="h-20 w-32 flex-shrink-0 rounded border border-gridline object-cover object-top" />}
                        <div className="min-w-0 flex-1 text-xs text-ink-secondary">
                          <div className="font-semibold text-ink-primary">
                            {q.testName} — {t('Step')} {q.stepNumber} ({t(q.actionLabel)})
                          </div>
                          <div className="mt-0.5">{q.question}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {phase === 'saved' && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-good/30 bg-good/10 px-3 py-2.5 text-[13px] text-good">
              <span className="inline-flex items-center gap-2">
                <CheckCircle2 size={16} /> {t('Saved: {n} test(s) updated.', { n: undo?.length ?? 0 })}
              </span>
              {undo && (
                <button className="secondary sm" onClick={() => void undoSave()}>
                  <RotateCcw size={13} /> {t('Undo')}
                </button>
              )}
            </div>
          )}
        </div>

        {(phase === 'review' || phase === 'saved' || phase === 'saving') && (
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-gridline px-5 py-3">
            <div className="flex gap-2">
              <button className="secondary" onClick={() => void start()} disabled={busy}>
                <RotateCcw size={14} /> {t('Run again')}
              </button>
              {proposals.length > 0 && phase !== 'saved' && (
                <button className="secondary" onClick={() => void reverify()} disabled={busy || accepted.length === 0}>
                  <ShieldCheck size={14} /> {t('Verify selection')}
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button className="secondary" onClick={onClose} disabled={phase === 'saving'}>
                {phase === 'saved' ? t('Close') : t('Discard')}
              </button>
              {proposals.length > 0 && phase !== 'saved' && (
                <button onClick={() => void save()} disabled={busy || accepted.length === 0}>
                  <Save size={15} /> {phase === 'saving' ? t('Saving…') : t('Apply {n} change(s) and save', { n: accepted.length })}
                </button>
              )}
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
