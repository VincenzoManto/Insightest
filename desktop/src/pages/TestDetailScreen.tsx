import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Play,
  Pencil,
  Wrench,
  Globe,
  MousePointerClick,
  Type,
  CheckSquare,
  ChevronDown,
  Keyboard,
  Code2,
  Video,
  Tag as TagIcon,
  StickyNote,
  X,
  Plus,
  Save,
  MoreVertical,
  FileText,
  CheckCircle2,
  XCircle,
  CircleDot,
  FolderOpen,
  Hourglass,
} from 'lucide-react';
import { useAuth } from '../state/AuthContext';
import { computeStepStatuses, type StepStatus } from '../stepStatus';
import type { Folder, Project, TestDetail, TestRun, TestRunDetail, TestSummary } from '../types';
import type { AgentName, HealResult, ResilientStepMeta } from '../electron-bridge';
import { AiTestAssistant } from './AiTestAssistant';
import { formatDate, formatDateTime, t, weekdayLabels } from '../i18n';

type RunFilter = 'all' | 'passed' | 'failed' | 'desktop' | 'ci';
type DetailTab = 'history' | 'settings' | 'docs';

/** Renders a folder's full ancestry (e.g. "Regressione / Login") for a flat <select> list. */
function folderPath(folder: Folder, all: Folder[]): string {
  const names: string[] = [folder.name];
  let cursor = folder;
  while (cursor.parent_id !== null) {
    const parent = all.find((f) => f.id === cursor.parent_id);
    if (!parent) break;
    names.unshift(parent.name);
    cursor = parent;
  }
  return names.join(' / ');
}

/* ---------- best-effort parse of the recorded Playwright script into a readable step list ---------- */

interface ParsedStep {
  action: 'load' | 'click' | 'fill' | 'check' | 'select' | 'press' | 'wait' | 'other';
  label: string;
  detail?: string;
  raw: string;
  chain?: string;
}

const ANY_ACTION_METHODS = 'click|fill|dblclick|check|uncheck|selectOption|press|hover|tap|type|setInputFiles|selectText';
const CHAIN_RE = new RegExp(`^await\\s+(page\\.[^;]*?)\\.(${ANY_ACTION_METHODS})\\(`);

function parseSteps(code: string): ParsedStep[] {
  const steps: ParsedStep[] = [];
  for (const rawLine of code.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('import ')) continue;

    const gotoMatch = line.match(/\.goto\(\s*['"`]([^'"`]+)['"`]/);
    if (gotoMatch) {
      steps.push({ action: 'load', label: gotoMatch[1], raw: line });
      continue;
    }

    const waitMatch = line.match(/\.waitForTimeout\(\s*(\d+)/);
    if (waitMatch) {
      steps.push({ action: 'wait', label: `${waitMatch[1]}ms`, raw: line });
      continue;
    }

    const labelMatch =
      line.match(/getByRole\([^,]+,\s*\{\s*name:\s*['"`]([^'"`]+)['"`]/) ||
      line.match(/getByText\(\s*['"`]([^'"`]+)['"`]/) ||
      line.match(/getByLabel\(\s*['"`]([^'"`]+)['"`]/) ||
      line.match(/getByPlaceholder\(\s*['"`]([^'"`]+)['"`]/) ||
      line.match(/getByTestId\(\s*['"`]([^'"`]+)['"`]/) ||
      line.match(/locator\(\s*['"`]([^'"`]+)['"`]/);
    const label = labelMatch?.[1];
    const chain = CHAIN_RE.exec(line)?.[1];

    if (/\.click\(/.test(line)) {
      steps.push({ action: 'click', label: label ?? t('element'), raw: line, chain });
    } else if (/\.fill\(/.test(line)) {
      const valMatch = line.match(/\.fill\([^,]*,\s*['"`]([^'"`]*)['"`]/);
      steps.push({ action: 'fill', label: label ?? t('field'), detail: valMatch?.[1], raw: line, chain });
    } else if (/\.check\(/.test(line)) {
      steps.push({ action: 'check', label: label ?? t('checkbox'), raw: line, chain });
    } else if (/\.selectOption\(/.test(line)) {
      steps.push({ action: 'select', label: label ?? t('select'), raw: line, chain });
    } else if (/\.press\(/.test(line)) {
      const keyMatch = line.match(/\.press\(\s*['"`]([^'"`]+)['"`]/);
      steps.push({ action: 'press', label: keyMatch?.[1] ?? t('key'), raw: line, chain });
    } else if (chain) {
      // dblclick/hover/tap/...: not given a dedicated icon, but they still are steps of the run.
      steps.push({ action: 'other', label: label ?? t('element'), raw: line, chain });
    }
  }
  return steps;
}

/** `steps_json` (a test's per-action secondary-selector metadata captured by the recording
 * augmentation pass) is stored as a JSON string, or null for tests recorded before this
 * feature / with no successfully captured steps. */
function parseStepsJson(stepsJson: string | null | undefined): ResilientStepMeta[] | undefined {
  if (!stepsJson) return undefined;
  try {
    const parsed = JSON.parse(stepsJson);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const STEP_ICON: Record<ParsedStep['action'], React.ReactNode> = {
  load: <Globe size={14} />,
  click: <MousePointerClick size={14} />,
  fill: <Type size={14} />,
  check: <CheckSquare size={14} />,
  select: <ChevronDown size={14} />,
  press: <Keyboard size={14} />,
  wait: <Hourglass size={14} />,
  other: <MoreVertical size={14} />,
};

const STEP_VERB: Record<ParsedStep['action'], string> = {
  load: t('Load'),
  click: t('Click'),
  fill: t('Type'),
  check: t('Check'),
  select: t('Choose'),
  press: t('Press'),
  wait: t('Wait'),
  other: t('Action'),
};

/* ---------- charts ---------- */

function RunStatusDot({ status }: { status: TestRun['status'] }): React.ReactElement {
  if (status === 'passed') return <CheckCircle2 size={13} className="text-good" />;
  if (status === 'running') return <CircleDot size={13} className="text-warning" />;
  return <XCircle size={13} className="text-critical" />;
}

function RunBadge({ status }: { status: TestRun['status'] }): React.ReactElement {
  if (status === 'passed') {
    return (
      <span className="badge badge-good">
        <CheckCircle2 size={13} /> {t('Passed')}
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span className="badge badge-warning">
        <CircleDot size={13} /> {t('Running')}
      </span>
    );
  }
  return (
    <span className="badge badge-critical">
      <XCircle size={13} /> {t('Failed')}
    </span>
  );
}

function statusColor(status: TestRun['status']): string {
  if (status === 'passed') return '#0ca30c';
  if (status === 'running') return '#fab219';
  return '#d03b3b';
}

function LastRunsBarChart({ runs }: { runs: TestRun[] }): React.ReactElement {
  const ordered = [...runs].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()).slice(-35);
  if (ordered.length === 0) {
    return <p className="text-sm text-ink-muted">{t('No runs recorded.')}</p>;
  }
  return (
    <div className="flex h-24 items-end gap-1">
      {ordered.map((run) => (
        <div
          key={run.id}
          title={`${run.status} — ${formatDateTime(run.created_at)}`}
          className="flex-1 rounded-t transition-all"
          style={{ height: '100%', background: statusColor(run.status) }}
        />
      ))}
    </div>
  );
}

const WEEKDAY_LABELS = weekdayLabels();

function WeekHeatmap({ runs }: { runs: TestRun[] }): React.ReactElement {
  const byDay = useMemo(() => {
    const map = new Map<string, TestRun[]>();
    for (const run of runs) {
      const key = new Date(run.created_at).toISOString().slice(0, 10);
      const list = map.get(key) ?? [];
      list.push(run);
      map.set(key, list);
    }
    return map;
  }, [runs]);

  const firstRunDate = useMemo(() => {
    if (runs.length === 0) return null;
    return runs.reduce((min, r) => (r.created_at < min ? r.created_at : min), runs[0].created_at);
  }, [runs]);

  const weeks = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const mondayThisWeek = new Date(today);
    const dow = (today.getDay() + 6) % 7; // 0 = Monday
    mondayThisWeek.setDate(today.getDate() - dow);

    const weekCount = 5;
    const start = new Date(mondayThisWeek);
    start.setDate(start.getDate() - (weekCount - 1) * 7);

    const firstDate = firstRunDate ? new Date(firstRunDate) : today;
    firstDate.setHours(0, 0, 0, 0);

    const grid: { date: Date; key: string; inRange: boolean }[][] = [];
    for (let w = 0; w < weekCount; w++) {
      const row: { date: Date; key: string; inRange: boolean }[] = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(start);
        date.setDate(start.getDate() + w * 7 + d);
        row.push({ date, key: date.toISOString().slice(0, 10), inRange: date >= firstDate && date <= today });
      }
      grid.push(row);
    }
    return grid;
  }, [firstRunDate]);

  return (
    <div>
      <div className="mb-1 grid grid-cols-7 gap-1 text-center text-[11px] text-ink-muted">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        {weeks.map((row, i) => (
          <div key={i} className="grid grid-cols-7 gap-1">
            {row.map((cell) => {
              const dayRuns = byDay.get(cell.key) ?? [];
              if (!cell.inRange && dayRuns.length === 0) {
                return <div key={cell.key} className="aspect-square" />;
              }
              const hasFailed = dayRuns.some((r) => r.status === 'failed' || r.status === 'error');
              const hasPassed = dayRuns.some((r) => r.status === 'passed');
              let bg = 'transparent';
              if (hasFailed && hasPassed) {
                bg = 'linear-gradient(90deg, #0ca30c 50%, #d03b3b 50%)';
              } else if (hasFailed) {
                bg = '#d03b3b';
              } else if (hasPassed) {
                bg = '#0ca30c';
              }
              return (
                <div
                  key={cell.key}
                  title={`${formatDate(cell.date)} — ${t('{n} run(s)', { n: dayRuns.length })}`}
                  className="aspect-square rounded-md border border-gridline"
                  style={{ background: bg }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-4 text-[11px] text-ink-secondary">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-good" /> {t('OK')}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-critical" /> {t('Error')}
        </span>
      </div>
    </div>
  );
}

/* ---------- main screen ---------- */

/** Mirrors electron/agentRepair.ts's prompt shape; kept in the renderer since the actual CLI
 * spawn happens in the main process but the prompt text is assembled from UI-loaded data. */
function buildAgentRepairPrompt(testName: string, testCode: string, lastRunLog: string | undefined, repoPath: string): string {
  return [
    `A Playwright end-to-end test named "${testName}" is failing.`,
    `The tested application's repository is in this folder: ${repoPath}. ` +
      'Inspect the application source code (NOT the test) and fix the bug that makes the test fail.',
    '',
    "--- Playwright test code (context, do not modify it) ---",
    testCode,
    lastRunLog ? `\n--- Log of the last failed run ---\n${lastRunLog}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function TestDetailScreen({ testId, onBack }: { testId: number; onBack: () => void }): React.ReactElement {
  const { api } = useAuth();
  const [test, setTest] = useState<TestDetail | null>(null);
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [lastRunDetail, setLastRunDetail] = useState<TestRunDetail | null>(null);
  const [running, setRunning] = useState(false);
  const [headed, setHeaded] = useState(false);
  const [betweenActionMs, setBetweenActionMs] = useState(400);
  const [lastLog, setLastLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runFilter, setRunFilter] = useState<RunFilter>('all');
  const [tab, setTab] = useState<DetailTab>('history');
  const [showCode, setShowCode] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [otherTests, setOtherTests] = useState<TestSummary[]>([]);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [editCode, setEditCode] = useState('');
  const editCodeRef = useRef<HTMLTextAreaElement>(null);
  const [waitMs, setWaitMs] = useState(1000);
  const [editIncludeInCi, setEditIncludeInCi] = useState(true);
  const [editFolderId, setEditFolderId] = useState<number | null>(null);
  const [editDependsOnTestId, setEditDependsOnTestId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [recordUrl, setRecordUrl] = useState('https://');
  const [recording, setRecording] = useState(false);
  const [healingRunId, setHealingRunId] = useState<number | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [repairingRunId, setRepairingRunId] = useState<number | null>(null);
  const [repairResult, setRepairResult] = useState<HealResult | null>(null);
  const [liveLines, setLiveLines] = useState<string[]>([]);
  const liveLogRef = useRef<HTMLDivElement>(null);
  const [installedAgents, setInstalledAgents] = useState<Record<AgentName, boolean>>({ claude: false, copilot: false });
  const [agentToConfirm, setAgentToConfirm] = useState<{ agent: AgentName; runId: number } | null>(null);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentResult, setAgentResult] = useState<{ exitCode: number | null; log: string } | null>(null);

  useEffect(() => {
    window.insightest.agent.detect().then(setInstalledAgents);
  }, []);

  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [savingTag, setSavingTag] = useState(false);

  async function load(): Promise<void> {
    try {
      const [testRes, runsRes] = await Promise.all([
        api.get<TestDetail>(`/tests/${testId}`),
        api.get<{ runs: TestRun[] }>(`/tests/${testId}/runs`),
      ]);
      // The API may still be running an older version that doesn't send `tags`/`include_in_ci` yet; normalize so the UI never has to guard for it.
      const normalized: TestDetail = {
        ...testRes,
        tags: testRes.tags ?? [],
        include_in_ci: testRes.include_in_ci ?? true,
        folder_id: testRes.folder_id !== null && testRes.folder_id !== undefined ? Number(testRes.folder_id) : null,
        depends_on_test_id:
          testRes.depends_on_test_id !== null && testRes.depends_on_test_id !== undefined ? Number(testRes.depends_on_test_id) : null,
      };
      setTest(normalized);
      setNoteDraft(normalized.notes ?? '');
      setRuns(runsRes.runs);
      // The newest run's log tells which step it stopped on (shown as green/red/grey steps).
      const newest = runsRes.runs.reduce<TestRun | null>((a, r) => (a && a.id > r.id ? a : r), null);
      setLastRunDetail(
        newest ? await api.get<TestRunDetail>(`/tests/${testId}/runs/${newest.id}`).catch(() => null) : null
      );
      const [foldersRes, testsRes, projectRes] = await Promise.all([
        api.get<{ folders: Folder[] }>(`/projects/${testRes.project_id}/folders`),
        api.get<{ tests: TestSummary[] }>(`/projects/${testRes.project_id}/tests`),
        api.get<Project>(`/projects/${testRes.project_id}`),
      ]);
      setProject(projectRes);
      // /folders returns id/parent_id as strings; normalize to numbers to match folder_id comparisons.
      setFolders(
        foldersRes.folders.map((f) => ({
          ...f,
          id: Number(f.id),
          parent_id: f.parent_id !== null && f.parent_id !== undefined ? Number(f.parent_id) : null,
        }))
      );
      setOtherTests(testsRes.tests.filter((t) => t.id !== testId));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testId]);

  useEffect(() => {
    if (liveLogRef.current) liveLogRef.current.scrollTop = liveLogRef.current.scrollHeight;
  }, [liveLines]);

  async function runLocally(): Promise<void> {
    if (!test) return;
    setRunning(true);
    setError(null);
    setLastLog(null);
    setLiveLines([]);
    const unsubscribe = window.insightest.playwright.onProgress((line) => setLiveLines((prev) => [...prev, line]));
    const startedAt = new Date().toISOString();
    try {
      // A test's whole depends_on_test_id chain runs first in the same browser session
      // (oldest ancestor first), without ever being duplicated into this test's own stored
      // code -- a predecessor can itself depend on another test, so this walks the full chain,
      // not just the immediate one.
      const dependencyCodes: string[] = [];
      const visited = new Set<number>([testId]);
      let nextDependsOn = test.depends_on_test_id;
      while (nextDependsOn !== null && !visited.has(nextDependsOn)) {
        visited.add(nextDependsOn);
        const ancestor = await api.get<TestDetail>(`/tests/${nextDependsOn}`);
        dependencyCodes.unshift(ancestor.playwright_code);
        nextDependsOn = ancestor.depends_on_test_id ?? null;
      }
      const result = await window.insightest.playwright.run(
        test.playwright_code,
        { headed, betweenActionMs },
        dependencyCodes,
        parseStepsJson(test.steps_json)
      );
      setLastLog(result.log);
      await api.post(`/tests/${testId}/runs`, {
        status: result.status,
        duration_ms: result.durationMs,
        log: result.log,
        healing_detail: result.healingDetail ?? null,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    } finally {
      unsubscribe();
      setRunning(false);
    }
  }

  function startEdit(): void {
    if (!test) return;
    setError(null);
    setEditName(test.name);
    setEditDescription(test.description ?? '');
    setEditPrompt(test.prompt ?? '');
    setEditCode(test.playwright_code);
    setEditIncludeInCi(test.include_in_ci);
    setEditFolderId(test.folder_id);
    setEditDependsOnTestId(test.depends_on_test_id);
    setEditing(true);
  }

  async function saveEdit(): Promise<void> {
    if (!editName.trim() || !editCode.trim()) {
      setError(t('Name and Playwright code are required'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.put(`/tests/${testId}`, {
        name: editName,
        description: editDescription || null,
        prompt: editPrompt || null,
        playwright_code: editCode,
        // Manual edits invalidate any previously-captured secondary selectors (they're
        // positionally aligned to the action calls the augmentation pass actually saw).
        steps: editCode !== test?.playwright_code ? null : undefined,
        include_in_ci: editIncludeInCi,
        folder_id: editFolderId,
        depends_on_test_id: editDependsOnTestId,
      });
      setEditing(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    } finally {
      setSaving(false);
    }
  }

  async function reRecord(): Promise<void> {
    setError(null);
    setRecording(true);
    try {
      const recorded = await window.insightest.playwright.record(recordUrl);
      if (recorded) {
        setEditCode(recorded);
      } else {
        setError(t('No actions recorded (browser closed without interacting)'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Error while recording'));
    } finally {
      setRecording(false);
    }
  }

  async function saveNote(): Promise<void> {
    setSavingNote(true);
    setError(null);
    try {
      await api.put(`/tests/${testId}`, { notes: noteDraft || null });
      setTest((prev) => (prev ? { ...prev, notes: noteDraft || null } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    } finally {
      setSavingNote(false);
    }
  }

  async function addTag(): Promise<void> {
    const value = tagDraft.trim();
    if (!value || !test || test.tags.includes(value)) {
      setTagDraft('');
      return;
    }
    const nextTags = [...test.tags, value];
    setSavingTag(true);
    try {
      await api.put(`/tests/${testId}`, { tags: nextTags });
      setTest((prev) => (prev ? { ...prev, tags: nextTags } : prev));
      setTagDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    } finally {
      setSavingTag(false);
    }
  }

  async function removeTag(tag: string): Promise<void> {
    if (!test) return;
    const nextTags = test.tags.filter((t) => t !== tag);
    setSavingTag(true);
    try {
      await api.put(`/tests/${testId}`, { tags: nextTags });
      setTest((prev) => (prev ? { ...prev, tags: nextTags } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    } finally {
      setSavingTag(false);
    }
  }

  /** On-demand healing analysis for one already-recorded failed run (doesn't re-run the test). */
  async function analyzeHealing(runId: number): Promise<void> {
    setHealingRunId(runId);
    setError(null);
    try {
      const detail = await api.get<TestRunDetail>(`/tests/${testId}/runs/${runId}`);
      const verdict = await window.insightest.playwright.heal(detail.log ?? '');
      if (verdict) {
        await api.put(`/tests/${testId}/runs/${runId}`, { healing_detail: verdict });
        setRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, healing_detail: verdict } : r)));
      } else {
        setError(t('No verdict returned by the healing engine'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Error while analyzing'));
    } finally {
      setHealingRunId(null);
    }
  }

  /** Actually attempts to repair the test's selectors against the project's self-healing
   * baseline, re-running it live (not just reading a past log). Never touches the stored
   * test until the user reviews the proposal and clicks "Applica riparazione". */
  async function repairTest(runId: number): Promise<void> {
    if (!test || !project) return;
    if (!project.base_url) {
      setError(t('Set a base URL for the project (Projects screen) to enable self-healing.'));
      return;
    }
    setRepairingRunId(runId);
    setRepairResult(null);
    setError(null);
    setLiveLines([]);
    const unsubscribe = window.insightest.playwright.onProgress((line) => setLiveLines((prev) => [...prev, line]));
    try {
      const result = await window.insightest.playwright.healRepair(project.id, project.base_url, test.playwright_code);
      setRepairResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Error while repairing'));
    } finally {
      unsubscribe();
      setRepairingRunId(null);
    }
  }

  async function applyRepair(): Promise<void> {
    if (!repairResult?.proposedCode) return;
    try {
      await api.put(`/tests/${testId}`, { playwright_code: repairResult.proposedCode });
      setRepairResult(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Error while applying the repair'));
    }
  }

  /** Delegates the actual repair to an external coding-agent CLI (Claude Code / GitHub
   * Copilot), spawned with the project's repo as cwd -- it can write/commit to the repo, so
   * this only runs after the user confirms the exact command in the modal below. */
  async function runAgentDelegatedRepair(): Promise<void> {
    if (!test || !project?.repo_path || !agentToConfirm) return;
    const { agent, runId } = agentToConfirm;
    setAgentToConfirm(null);
    setAgentRunning(true);
    setAgentResult(null);
    setError(null);
    setLiveLines([]);
    const unsubscribe = window.insightest.playwright.onProgress((line) => setLiveLines((prev) => [...prev, line]));
    try {
      const runDetail = await api.get<TestRunDetail>(`/tests/${testId}/runs/${runId}`);
      const prompt = buildAgentRepairPrompt(test.name, test.playwright_code, runDetail.log ?? undefined, project.repo_path);
      const result = await window.insightest.agent.runRepair(agent, project.repo_path, prompt);
      setAgentResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Error while running the repair delegated to the agent'));
    } finally {
      unsubscribe();
      setAgentRunning(false);
    }
  }

  /** Inserts an explicit wait step at the textarea's cursor (or at the end), for apps that need a moment before reacting. */
  function insertWaitStep(): void {
    const line = `  await page.waitForTimeout(${waitMs});\n`;
    const el = editCodeRef.current;
    if (!el) {
      setEditCode((prev) => prev + line);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    setEditCode((prev) => prev.slice(0, start) + line + prev.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + line.length;
    });
  }

  if (!test) {
    return (
      <div>
        {error && <div className="error-banner">{error}</div>}
        <div className="text-ink-secondary">{error ? t('Unable to load the test.') : t('Loading test…')}</div>
      </div>
    );
  }

  const totalRuns = runs.length;
  const passedRuns = runs.filter((r) => r.status === 'passed').length;
  const failedRuns = runs.filter((r) => r.status === 'failed' || r.status === 'error').length;
  const desktopRuns = runs.filter((r) => r.triggered_by === 'desktop').length;
  const ciRuns = runs.filter((r) => r.triggered_by === 'ci').length;
  const successRate = totalRuns > 0 ? Math.round((passedRuns / totalRuns) * 100) : null;
  const currentFolder = test.folder_id ? folders.find((f) => f.id === test.folder_id) : undefined;
  const lastLocalRun = [...runs]
    .filter((r) => r.triggered_by === 'desktop')
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  // Opting IN to CI/CD requires a green local run; a test already included stays included even if it later fails.
  const canEnableCi = editIncludeInCi || lastLocalRun?.status === 'passed';

  const filteredRuns = runs
    .filter((r) => {
      if (runFilter === 'passed') return r.status === 'passed';
      if (runFilter === 'failed') return r.status === 'failed' || r.status === 'error';
      if (runFilter === 'desktop') return r.triggered_by === 'desktop';
      if (runFilter === 'ci') return r.triggered_by === 'ci';
      return true;
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const steps = parseSteps(test.playwright_code);
  const stepStatuses: StepStatus[] | null = lastRunDetail
    ? computeStepStatuses(steps, lastRunDetail.log, lastRunDetail.status)
    : null;

  if (editing) {
    return (
      <div className="animate-fade-up mx-auto max-w-[860px]">
        <div className="screen-header">
          <h1 className="screen-title">{t('Edit test')}</h1>
          <div className="flex gap-2">
            <button onClick={saveEdit} disabled={saving}>
              <Save size={16} /> {saving ? t('Saving…') : t('Save')}
            </button>
            <button className="secondary" onClick={() => setEditing(false)}>
              {t('Cancel')}
            </button>
          </div>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="card flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-secondary">
            {t('Name')}
            <input value={editName} onChange={(e) => setEditName(e.target.value)} className="w-full" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-secondary">
            {t('Steps description')}
            <textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={3} className="w-full" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-secondary">
            {t('Descriptive prompt (also used by Jev/browser-use for self-healing)')}
            <textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} rows={3} className="w-full" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-secondary">
            {t('Folder')}
            <select
              value={editFolderId ?? ''}
              onChange={(e) => setEditFolderId(e.target.value ? Number(e.target.value) : null)}
              className="w-full"
            >
              <option value="">{t('(none / root)')}</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {folderPath(f, folders)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-secondary">
            {t('Run first (same session/browser)')}
            <select
              value={editDependsOnTestId ?? ''}
              onChange={(e) => setEditDependsOnTestId(e.target.value ? Number(e.target.value) : null)}
              className="w-full"
            >
              <option value="">{t('(none)')}</option>
              {otherTests.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <span className="text-xs font-normal text-ink-muted">
              {t("If set, the local run first executes the steps of the chosen test (e.g. a login) in the same session, without duplicating them in this test's code.")}
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm font-medium text-ink-secondary">
            <input
              type="checkbox"
              checked={editIncludeInCi}
              disabled={!canEnableCi}
              onChange={(e) => setEditIncludeInCi(e.target.checked)}
              className="!p-0"
            />
            {t('Include in CI/CD runs')}
          </label>
          {!canEnableCi && (
            <p className="-mt-2 text-xs text-ink-muted">
              {t('The last local run must be passing (green) before this test can be included in CI/CD.')}
            </p>
          )}
          <AiTestAssistant
            mode="fix"
            project={project}
            testName={editName}
            currentCode={editCode}
            lastRunLog={lastRunDetail?.log ?? undefined}
            onCode={(code, dependsOn) => {
              setEditCode(code);
              const prerequisite = dependsOn ? otherTests.find((o) => o.name === dependsOn) : undefined;
              if (prerequisite) setEditDependsOnTestId(prerequisite.id);
            }}
          />
          <div className="field">
            {t('Re-record in the browser (Playwright codegen)')}
            <div className="flex gap-2">
              <input value={recordUrl} onChange={(e) => setRecordUrl(e.target.value)} placeholder={t('https://example.com')} className="min-w-0 flex-1" />
              <button type="button" onClick={reRecord} disabled={recording}>
                <Video size={16} /> {recording ? t('Recording…') : t('Record')}
              </button>
            </div>
          </div>
          <div className="field">
            {t('Playwright code')}
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <Hourglass size={13} className="text-ink-muted" />
              <input
                type="number"
                min={0}
                step={100}
                value={waitMs}
                onChange={(e) => setWaitMs(Math.max(0, Number(e.target.value) || 0))}
                className="!w-20 !py-1 !text-xs"
              />
              <span className="text-xs text-ink-muted">ms</span>
              <button type="button" className="secondary sm" onClick={insertWaitStep}>
                <Hourglass size={13} /> {t('Insert wait step')}
              </button>
              <span className="text-xs font-normal text-ink-muted">{t('(inserted at the cursor, useful when the app does not respond right away)')}</span>
            </div>
            <textarea ref={editCodeRef} value={editCode} onChange={(e) => setEditCode(e.target.value)} rows={16} spellCheck={false} className="w-full font-mono text-xs" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-up">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <button className="secondary icon" onClick={onBack} title={t('Back')}>
            <ArrowLeft size={16} />
          </button>
          <div>
            <h1 className="screen-title break-words">{test.name}</h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
              {currentFolder && (
                <span className="inline-flex items-center gap-1">
                  <FolderOpen size={12} /> {folderPath(currentFolder, folders)}
                </span>
              )}
              <span className={test.include_in_ci ? 'text-good' : 'text-ink-muted'}>
                {test.include_in_ci ? '● ' + t('Included in CI/CD') : '○ ' + t('Excluded from CI/CD')}
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
            <input type="checkbox" checked={headed} onChange={(e) => setHeaded(e.target.checked)} className="!p-0" />
            {t('Headed')}
          </label>
          <label className="flex items-center gap-1.5 text-xs text-ink-secondary" title={t('Pause between actions during the local run, so you can follow it by eye')}>
            <Hourglass size={13} />
            <input
              type="number"
              min={0}
              step={100}
              value={betweenActionMs}
              onChange={(e) => setBetweenActionMs(Math.max(0, Number(e.target.value) || 0))}
              className="!w-16 !py-1 !text-xs"
            />
            {t('ms/action')}
          </label>
          <button onClick={runLocally} disabled={running}>
            <Play size={16} /> {running ? t('Running…') : t('Re-run')}
          </button>
          <button className="secondary" onClick={startEdit}>
            <Pencil size={16} /> {t('Edit')}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="card">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-ink-primary">{steps.length > 0 ? t('{n} actions', { n: steps.length }) : t('Test code')}</div>
            {steps.length > 0 && (
              <button className="secondary sm" onClick={() => setShowCode((v) => !v)}>
                <Code2 size={13} /> {showCode ? t('Hide code') : t('Show code')}
              </button>
            )}
          </div>

          {steps.length === 0 || showCode ? (
            <pre className="codeblock m-0 !text-ink-primary">
              {test.playwright_code}
            </pre>
          ) : (
            <div className="flex flex-col">
              {steps.map((step, i) => {
                const status = stepStatuses?.[i];
                const chipClass =
                  status === 'passed'
                    ? 'bg-good/15 text-good'
                    : status === 'failed'
                      ? 'bg-critical/15 text-critical'
                      : status === 'skipped'
                        ? 'bg-page text-ink-muted'
                        : 'bg-accent/15 text-accent-700';
                return (
                <div
                  key={i}
                  title={status === 'passed' ? t('Executed') : status === 'failed' ? t('Failed step') : status === 'skipped' ? t('Not executed') : undefined}
                  className={`flex min-w-0 items-start gap-3 border-b border-gridline py-2.5 last:border-b-0 ${status === 'skipped' ? 'opacity-50' : ''}`}
                >
                  <span className="w-5 flex-shrink-0 pt-1 text-right text-xs text-ink-muted">{i + 1}</span>
                  <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ${chipClass}`}>
                    {STEP_ICON[step.action]}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 pt-0.5">
                    <span className="text-sm font-semibold text-ink-primary">{STEP_VERB[step.action]}</span>
                    <span className="min-w-0 max-w-full break-all rounded-md bg-page px-2 py-0.5 text-xs text-ink-secondary" title={step.label}>
                      {step.label}
                    </span>
                    {step.detail && <span className="min-w-0 max-w-full break-all text-xs text-ink-muted">→ "{step.detail}"</span>}
                  </div>
                  {status === 'failed' && <XCircle size={14} className="mt-1.5 flex-shrink-0 text-critical" />}
                  {status === 'passed' && <CheckCircle2 size={14} className="mt-1.5 flex-shrink-0 text-good" />}
                </div>
                );
              })}
            </div>
          )}

          {(running || repairingRunId !== null || liveLines.length > 0) && (
            <div className="mt-4">
              <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-ink-primary">
                {(running || repairingRunId !== null) && <CircleDot size={13} className="text-accent2" />}
                {running || repairingRunId !== null ? t('Steps in progress') : t('Steps of the last run')}
              </div>
              <div
                ref={liveLogRef}
                className="codeblock max-h-64"
              >
                {liveLines.length > 0 ? liveLines.join('\n') : t('Waiting for the first step…')}
              </div>
            </div>
          )}

          {lastLog && (
            <div className="mt-4">
              <div className="mb-1.5 text-sm font-semibold text-ink-primary">{t('Last local run log')}</div>
              <pre className="codeblock m-0 max-h-64">{lastLog}</pre>
            </div>
          )}
        </div>

        <div className="min-w-0">
          <div className="card">
            <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink-primary">
              <StickyNote size={15} /> {t('Test notes')}
            </div>
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              rows={4}
              placeholder={t('Add a note…')}
              className="w-full"
            />
            {noteDraft !== (test.notes ?? '') && (
              <button className="sm mt-2" onClick={saveNote} disabled={savingNote}>
                <Save size={13} /> {savingNote ? t('Saving…') : t('Save note')}
              </button>
            )}
          </div>
          <div className="card">
            <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink-primary">
              <TagIcon size={15} /> {t('Tags')}
            </div>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {test.tags.map((tag) => (
                <span key={tag} className="badge badge-muted max-w-full break-all">
                  {tag}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    className="ghost !h-3.5 !w-3.5 !rounded-full !p-0"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-1.5">
              <input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTag();
                  }
                }}
                placeholder={t('Add tag…')}
                className="min-w-0 flex-1 !py-1.5"
              />
              <button className="secondary icon" onClick={addTag} disabled={savingTag || !tagDraft.trim()}>
                <Plus size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-5 border-b border-gridline">
        <div className="flex gap-6">
          {(
            [
              { key: 'history', label: t('Test history') },
              { key: 'settings', label: t('Settings') },
              { key: 'docs', label: t('Documentation') },
            ] as { key: DetailTab; label: string }[]
          ).map((tabItem) => (
            <button
              key={tabItem.key}
              onClick={() => setTab(tabItem.key)}
              className="!rounded-none !border-x-0 !border-b-2 !border-t-0 !bg-transparent !px-0 !py-2.5 !text-[13px] !font-semibold !shadow-none hover:!bg-transparent"
              style={{
                borderBottomColor: tab === tabItem.key ? '#00d86f' : 'transparent',
                color: tab === tabItem.key ? '#0f1512' : '#898781',
              }}
            >
              {tabItem.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'history' && (
        <div className="mt-4">
          {totalRuns > 0 && (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="card mb-0 text-center">
                <div className="text-2xl font-bold text-good">{passedRuns}</div>
                <div className="text-xs text-ink-secondary">{t('Passed')}</div>
              </div>
              <div className="card mb-0 text-center">
                <div className="text-2xl font-bold text-critical">{failedRuns}</div>
                <div className="text-xs text-ink-secondary">{t('Failed')}</div>
              </div>
              <div className="card mb-0 text-center">
                <div className="text-2xl font-bold text-ink-primary">{desktopRuns}</div>
                <div className="text-xs text-ink-secondary">{t('Local')}</div>
              </div>
              <div className="card mb-0 text-center">
                <div className="text-2xl font-bold text-ink-primary">{ciRuns}</div>
                <div className="text-xs text-ink-secondary">{t('CI/CD')}</div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="card">
              <div className="mb-3 flex items-center justify-between text-sm font-semibold text-ink-primary">
                <span>{t('Latest runs')}</span>
                {successRate !== null && <span className="badge badge-good">{t('{n}% success', { n: successRate })}</span>}
              </div>
              <LastRunsBarChart runs={runs} />
            </div>
            <div className="card">
              <div className="mb-3 text-sm font-semibold text-ink-primary">{t('Run calendar')}</div>
              <WeekHeatmap runs={runs} />
            </div>
          </div>

          <div className="card mt-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold text-ink-primary">{t('Run history')}</span>
              <div className="pill-group">
                {(['all', 'passed', 'failed', 'desktop', 'ci'] as RunFilter[]).map((f) => (
                  <button key={f} className={`pill ${runFilter === f ? 'active' : ''}`} onClick={() => setRunFilter(f)}>
                    {{ all: t('All'), passed: t('Passed'), failed: t('Failed'), desktop: t('Local'), ci: t('CI/CD') }[f]}
                  </button>
                ))}
              </div>
            </div>
            {filteredRuns.length === 0 && <p className="text-sm text-ink-muted">{t('No runs match the filter.')}</p>}
            <div className="flex flex-col">
              {filteredRuns.map((run) => (
                <div key={run.id} className="border-b border-gridline py-2.5 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <RunStatusDot status={run.status} />
                    <RunBadge status={run.status} />
                    <span className="text-xs text-ink-secondary">{run.triggered_by === 'ci' ? t('CI/CD') : t('Local')}</span>
                    <span className="text-xs text-ink-muted">{run.duration_ms ? `${run.duration_ms}ms` : '—'}</span>
                    <span className="ml-auto text-xs text-ink-muted">{formatDateTime(run.created_at)}</span>
                    {(run.status === 'failed' || run.status === 'error') && (
                      <>
                        <button
                          className="secondary !px-2 !py-1 text-xs"
                          onClick={() => analyzeHealing(run.id)}
                          disabled={healingRunId === run.id}
                        >
                          <Wrench size={12} /> {healingRunId === run.id ? t('Analyzing…') : t('Analyze')}
                        </button>
                        <button
                          className="secondary !px-2 !py-1 text-xs"
                          onClick={() => repairTest(run.id)}
                          disabled={repairingRunId === run.id || !project?.base_url}
                          title={!project?.base_url ? t('Set a base URL for the project to enable self-healing') : undefined}
                        >
                          <Wrench size={12} /> {repairingRunId === run.id ? t('Repairing…') : t('Repair')}
                        </button>
                        {(['claude', 'copilot'] as AgentName[])
                          .filter((a) => installedAgents[a])
                          .map((a) => (
                            <button
                              key={a}
                              className="secondary !px-2 !py-1 text-xs"
                              onClick={() => setAgentToConfirm({ agent: a, runId: run.id })}
                              disabled={agentRunning || !project?.repo_path}
                              title={
                                !project?.repo_path
                                  ? t('Set the local repo path for the project (Projects screen)')
                                  : undefined
                              }
                            >
                              <Wrench size={12} /> {t('Delegate to {agent}', { agent: a === 'claude' ? 'Claude Code' : 'Copilot' })}
                            </button>
                          ))}
                        {agentToConfirm?.runId === run.id && (
                          <div className="modal-overlay" onClick={() => setAgentToConfirm(null)}>
                            <div className="modal" onClick={(e) => e.stopPropagation()}>
                              <p className="text-sm font-semibold text-ink-primary">
                                {t('Run {agent}?', { agent: agentToConfirm.agent === 'claude' ? 'Claude Code' : 'GitHub Copilot' })}
                              </p>
                              <p className="mt-2 text-xs text-ink-secondary">
                                {t('It will run locally in the folder {path} and may modify/commit repository files to fix the bug that makes this test fail.', {
                                  path: project?.repo_path ?? '',
                                })}
                              </p>
                              <div className="mt-3 flex gap-2">
                                <button className="!px-2 !py-1 text-xs" onClick={() => runAgentDelegatedRepair()}>
                                  {t('Confirm and run')}
                                </button>
                                <button className="secondary !px-2 !py-1 text-xs" onClick={() => setAgentToConfirm(null)}>
                                  {t('Cancel')}
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  {run.healing_detail && (
                    <div className="mt-1.5 flex items-start gap-1.5 text-xs text-accent2">
                      <Wrench size={12} className="mt-0.5 flex-shrink-0" />
                      <span className="min-w-0 whitespace-pre-wrap break-words">{run.healing_detail}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {repairResult && (
            <div className="card mt-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-ink-primary">{t('Repair result')}</span>
                <button className="secondary !px-2 !py-1 text-xs" onClick={() => setRepairResult(null)}>
                  <X size={12} /> {t('Close')}
                </button>
              </div>
              <p className="whitespace-pre-wrap break-words text-xs text-ink-secondary">{repairResult.summary}</p>
              {repairResult.status === 'healed' && repairResult.proposedCode && (
                <>
                  <p className="mt-2 text-xs text-ink-muted">
                    {repairResult.verified
                      ? t('✅ The repaired version was re-run and passes.')
                      : t('⚠️ The repaired version has not been verified (yet): re-run it before trusting it.')}
                  </p>
                  <pre
                    className="codeblock mt-2 max-h-64 !text-ink-primary"
                  >
                    {repairResult.proposedCode}
                  </pre>
                  <div className="mt-2 flex gap-2">
                    <button className="!px-2 !py-1 text-xs" onClick={applyRepair}>
                      {t('Apply repair')}
                    </button>
                    <button className="secondary !px-2 !py-1 text-xs" onClick={() => setRepairResult(null)}>
                      {t('Discard')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {agentResult && (
            <div className="card mt-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-ink-primary">{t('Result of the repair delegated to the agent')}</span>
                <button className="secondary !px-2 !py-1 text-xs" onClick={() => setAgentResult(null)}>
                  <X size={12} /> {t('Close')}
                </button>
              </div>
              <p className="text-xs text-ink-muted">
                {t('Exited with code {code}. Review the repository changes with your usual git tool before trusting them; re-run the test to check that it now passes.', {
                  code: agentResult.exitCode ?? '—',
                })}
              </p>
              <pre className="codeblock mt-2 max-h-64">
                {agentResult.log}
              </pre>
            </div>
          )}
        </div>
      )}

      {tab === 'settings' && (
        <div className="mt-4 card">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold text-ink-primary">{t('Test details')}</span>
            <button className="secondary sm" onClick={startEdit}>
              <Pencil size={13} /> {t('Edit')}
            </button>
          </div>
          <dl className="flex flex-col gap-3 text-sm">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{t('Name')}</dt>
              <dd className="m-0 text-ink-primary">{test.name}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{t('Folder')}</dt>
              <dd className="m-0 text-ink-primary">{currentFolder ? folderPath(currentFolder, folders) : '—'}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{t('CI/CD')}</dt>
              <dd className="m-0 text-ink-primary">{test.include_in_ci ? t('Included in CI/CD runs') : t('Excluded from CI/CD runs')}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{t('Steps description')}</dt>
              <dd className="m-0 text-ink-primary">{test.description || '—'}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{t('Created on')}</dt>
              <dd className="m-0 text-ink-primary">{formatDateTime(test.created_at)}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{t('Last updated')}</dt>
              <dd className="m-0 text-ink-primary">{formatDateTime(test.updated_at)}</dd>
            </div>
          </dl>
        </div>
      )}

      {tab === 'docs' && (
        <div className="mt-4 card">
          <div className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink-primary">
            <FileText size={15} /> {t('Documentation')}
          </div>
          {test.prompt ? (
            <p className="whitespace-pre-wrap text-sm text-ink-secondary">{test.prompt}</p>
          ) : (
            <p className="text-sm text-ink-muted">{t('No documentation available for this test.')}</p>
          )}
        </div>
      )}
    </div>
  );
}
