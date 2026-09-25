import React, { useEffect, useState } from 'react';
import {
  Plus,
  Search,
  CheckCircle2,
  XCircle,
  CircleDashed,
  CircleDot,
  ListChecks,
  PlayCircle,
  Folder as FolderIcon,
  FolderPlus,
  ChevronRight,
  Home,
  X,
  Eye,
  Wrench,
  Trash2,
  Lock,
} from 'lucide-react';
import { useAuth } from '../state/AuthContext';
import { t } from '../i18n';
import type { Folder, Project, ProjectStats, TestDetail, TestSummary } from '../types';
import { TestDetailScreen } from './TestDetailScreen';
import { NewTestForm } from './NewTestForm';
import { BrowserSetupCard } from '../components/BrowserSetupCard';

type StatusFilter = 'all' | 'passed' | 'failed' | 'never';
type TriggerFilter = 'all' | 'desktop' | 'ci';

const GOOD = '#0ca30c';
const CRITICAL = '#d03b3b';

function StatTile({
  value,
  label,
  icon,
  tint,
}: {
  value: number | string;
  label: string;
  icon: React.ReactNode;
  tint: string;
}): React.ReactElement {
  return (
    <div className="card !mb-0 flex items-center gap-3.5 !p-4">
      <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${tint}`}>{icon}</div>
      <div className="min-w-0">
        <div className="truncate text-[22px] font-semibold leading-tight tracking-tight text-ink-primary">{value}</div>
        <div className="truncate text-xs text-ink-muted">{label}</div>
      </div>
    </div>
  );
}

function DonutChart({ passed, failed }: { passed: number; failed: number }): React.ReactElement {
  const total = passed + failed;
  const r = 52;
  const circumference = 2 * Math.PI * r;
  const passedFrac = total > 0 ? passed / total : 0;
  const passedLen = passedFrac * circumference;
  const gap = total > 0 ? 2 : 0;

  return (
    <div className="flex flex-wrap items-center gap-6">
      <svg width={120} height={120} viewBox="0 0 128 128" className="flex-shrink-0">
        <circle cx={64} cy={64} r={r} fill="none" stroke="#e4e6e1" strokeWidth={12} />
        {total > 0 && (
          <>
            <circle
              cx={64}
              cy={64}
              r={r}
              fill="none"
              stroke={CRITICAL}
              strokeWidth={12}
              strokeDasharray={`${circumference} ${circumference}`}
              transform="rotate(-90 64 64)"
            >
              <title>{t('Failed: {n}', { n: failed })}</title>
            </circle>
            <circle
              cx={64}
              cy={64}
              r={r}
              fill="none"
              stroke={GOOD}
              strokeWidth={12}
              strokeLinecap="round"
              strokeDasharray={`${Math.max(passedLen - gap, 0)} ${circumference}`}
              transform="rotate(-90 64 64)"
              style={{ transition: 'stroke-dasharray 0.5s ease' }}
            >
              <title>{t('Passed: {n}', { n: passed })}</title>
            </circle>
          </>
        )}
        <text x={64} y={62} textAnchor="middle" fontSize={24} fontWeight={700} fill="#0f1512">
          {total > 0 ? `${Math.round(passedFrac * 100)}%` : '—'}
        </text>
        <text x={64} y={80} textAnchor="middle" fontSize={11} fill="#898781">
          {t('success')}
        </text>
      </svg>
      <div className="flex min-w-[120px] flex-1 flex-col gap-2.5 text-[13px]">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-good" />
          <span className="text-ink-secondary">{t('Passed')}</span>
          <span className="ml-auto font-semibold text-ink-primary">{passed}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-critical" />
          <span className="text-ink-secondary">{t('Failed')}</span>
          <span className="ml-auto font-semibold text-ink-primary">{failed}</span>
        </div>
      </div>
    </div>
  );
}

function TriggerBarChart({ desktop, ci }: { desktop: number; ci: number }): React.ReactElement {
  const max = Math.max(desktop, ci, 1);
  const bars: { label: string; value: number; barClass: string }[] = [
    { label: t('Local / manual'), value: desktop, barClass: 'bg-gradient-to-r from-accent-600 to-accent' },
    { label: t('CI/CD'), value: ci, barClass: 'bg-accent2' },
  ];
  return (
    <div className="flex flex-col gap-4">
      {bars.map((b) => (
        <div key={b.label}>
          <div className="mb-1.5 flex justify-between text-[13px]">
            <span className="text-ink-secondary">{b.label}</span>
            <span className="font-semibold text-ink-primary">{b.value}</span>
          </div>
          <div className="h-2 rounded-full bg-gridline">
            <div
              className={`h-2 rounded-full transition-all duration-500 ${b.barClass}`}
              style={{ width: `${(b.value / max) * 100}%` }}
              title={`${b.label}: ${b.value}`}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Playwright logs interleave step-by-step progress markers with the failure text, so the
 * actual error is rarely the very last line -- pick the first line mentioning "Error" instead
 * of just tailing the log, falling back to the last non-empty line if none matches. */
function extractErrorSnippet(log: string): string {
  const match = /^.*\bError\b.*$/m.exec(log);
  const line = (match ? match[0] : log.trim().split('\n').filter(Boolean).pop() ?? '').trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function StatusBadge({ status }: { status: TestSummary['last_status'] }): React.ReactElement {
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
  if (status === 'failed' || status === 'error') {
    return (
      <span className="badge badge-critical">
        <XCircle size={13} /> {t('Failed')}
      </span>
    );
  }
  return (
    <span className="badge badge-muted">
      <CircleDashed size={13} /> {t('Never run')}
    </span>
  );
}

/** One row of the recursive folder tree sidebar: expand/collapse arrow, name+count, hover-revealed add/delete actions. */
function FolderTreeItem({
  folder,
  depth,
  tests,
  folders,
  currentFolderId,
  expanded,
  onToggleExpand,
  onSelect,
  onCreateChild,
  onDelete,
}: {
  folder: Folder;
  depth: number;
  tests: TestSummary[];
  folders: Folder[];
  currentFolderId: number | null;
  expanded: Set<number>;
  onToggleExpand: (id: number) => void;
  onSelect: (id: number) => void;
  onCreateChild: (parentId: number) => void;
  onDelete: (folder: Folder) => void;
}): React.ReactElement {
  const children = folders.filter((f) => f.parent_id === folder.id);
  const isOpen = expanded.has(folder.id);
  const isActive = currentFolderId === folder.id;

  return (
    <div>
      <div
        className={`group flex items-center gap-0.5 rounded-lg py-0.5 pr-1 text-[13px] ${
          isActive ? 'bg-accent/15 font-semibold text-ink-primary' : 'text-ink-secondary hover:bg-page'
        }`}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        <button
          onClick={() => onToggleExpand(folder.id)}
          className="ghost icon sm !text-ink-muted"
          style={{ visibility: children.length > 0 ? 'visible' : 'hidden' }}
        >
          <ChevronRight size={12} className={`transition-transform ${isOpen ? 'rotate-90' : ''}`} />
        </button>
        <button
          onClick={() => onSelect(folder.id)}
          className="ghost !min-w-0 !flex-1 !justify-start !gap-1.5 !px-1 !py-1 !text-left !text-[13px] !text-inherit hover:!bg-transparent"
        >
          <FolderIcon size={13} className="flex-shrink-0" />
          <span className="truncate">{folder.name}</span>
        </button>
        <div className="hidden flex-shrink-0 items-center gap-0.5 group-hover:flex">
          <button onClick={() => onCreateChild(folder.id)} title={t('New subfolder')} className="ghost icon sm !text-ink-muted hover:!text-ink-primary">
            <FolderPlus size={12} />
          </button>
          <button
            onClick={() => onDelete(folder)}
            title={t('Delete folder (subfolders and tests move back to the root)')}
            className="ghost icon sm !text-ink-muted hover:!text-critical"
          >
            <X size={12} />
          </button>
        </div>
      </div>
      <div className="overflow-y-auto max-h-[70dvh]">
      {isOpen &&
        children.map((child) => (
          <FolderTreeItem
            key={child.id}
            folder={child}
            depth={depth + 1}
            tests={tests}
            folders={folders}
            currentFolderId={currentFolderId}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            onSelect={onSelect}
            onCreateChild={onCreateChild}
            onDelete={onDelete}
          />
        ))}
        </div>
    </div>
  );
}

export function TestsScreen({ project, initialTestId = null }: { project: Project; initialTestId?: number | null }): React.ReactElement {
  const { api } = useAuth();
  const [tests, setTests] = useState<TestSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<number>>(new Set());
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderParentId, setNewFolderParentId] = useState<number | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  // initialTestId: opened straight on a test's detail (e.g. from the CI runs recap).
  const [selectedId, setSelectedId] = useState<number | null>(initialTestId);
  const [creating, setCreating] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [baselineReady, setBaselineReady] = useState<boolean | null>(null);
  const [buildingBaseline, setBuildingBaseline] = useState(false);
  const [baselineMessage, setBaselineMessage] = useState<string | null>(null);

  async function refreshBaselineStatus(): Promise<void> {
    try {
      setBaselineReady(await window.insightest.playwright.baselineExists(project.id));
    } catch {
      setBaselineReady(null);
    }
  }

  /** Captures every CI-eligible test's current DOM and promotes it as the self-healing
   * reference. Requires the project's base URL (set in "Projects"). */
  async function buildBaseline(): Promise<void> {
    if (!project.base_url) {
      setError(t('Set a base URL for the project first (Projects screen) to enable self-healing.'));
      return;
    }
    setBuildingBaseline(true);
    setBaselineMessage(null);
    setError(null);
    try {
      const ciTests = tests.filter((test) => test.include_in_ci);
      const details = await Promise.all(ciTests.map((test) => api.get<TestDetail>(`/tests/${test.id}`)));
      const result = await window.insightest.playwright.baseline(
        project.id,
        project.base_url,
        details.map((d) => ({ id: d.id, playwright_code: d.playwright_code }))
      );
      setBaselineMessage(
        t('Baseline updated: {captured} tests captured', { captured: result.capturedCount }) +
          (result.failedCount > 0 ? t(', {failed} not reached (see log)', { failed: result.failedCount }) : '') +
          '.'
      );
      await refreshBaselineStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Error while building the baseline'));
    } finally {
      setBuildingBaseline(false);
    }
  }

  async function load(): Promise<void> {
    try {
      const [testsRes, statsRes, foldersRes] = await Promise.all([
        api.get<{ tests: TestSummary[] }>(`/projects/${project.id}/tests`),
        api.get<ProjectStats>(`/projects/${project.id}/stats`),
        api.get<{ folders: Folder[] }>(`/projects/${project.id}/folders`),
      ]);
      // The API may still be running an older version that doesn't send `tags`/`include_in_ci` yet; normalize so the UI never has to guard for it.
      setTests(
        testsRes.tests.map((test) => ({
          ...test,
          tags: test.tags ?? [],
          include_in_ci: test.include_in_ci ?? true,
          folder_id: test.folder_id !== null && test.folder_id !== undefined ? Number(test.folder_id) : null,
        }))
      );
      setStats(statsRes);
      // /folders returns id/parent_id as strings while /tests returns folder_id as a number;
      // normalize both to numbers so folder <-> test matching (===) works.
      setFolders(
        foldersRes.folders.map((f) => ({
          ...f,
          id: Number(f.id),
          parent_id: f.parent_id !== null && f.parent_id !== undefined ? Number(f.parent_id) : null,
        }))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    refreshBaselineStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // Keep the tree open along the path down to whichever folder is currently selected.
  useEffect(() => {
    if (currentFolderId === null) return;
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      let cursor = folders.find((f) => f.id === currentFolderId);
      while (cursor) {
        next.add(cursor.id);
        const parentId: number | null = cursor.parent_id;
        cursor = parentId !== null ? folders.find((f) => f.id === parentId) : undefined;
      }
      return next;
    });
  }, [currentFolderId, folders]);

  function toggleExpandFolder(id: number): void {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startCreatingFolder(parentId: number | null): void {
    setNewFolderParentId(parentId);
    setNewFolderName('');
    setCreatingFolder(true);
  }

  async function createFolder(): Promise<void> {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await api.post(`/projects/${project.id}/folders`, { name, parent_id: newFolderParentId });
      if (newFolderParentId !== null) setExpandedFolders((prev) => new Set(prev).add(newFolderParentId!));
      setNewFolderName('');
      setCreatingFolder(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Error while creating the folder'));
    }
  }

  async function deleteFolder(folder: Folder): Promise<void> {
    if (!window.confirm(t('Delete folder "{name}"? Subfolders and tests inside it will move back to the root.', { name: folder.name }))) return;
    try {
      await api.delete(`/folders/${folder.id}`);
      if (currentFolderId === folder.id) setCurrentFolderId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Error while deleting the folder'));
    }
  }

  async function deleteTest(test: TestSummary): Promise<void> {
    if (!window.confirm(t('Permanently delete test "{name}" and its whole run history?', { name: test.name }))) return;
    try {
      await api.delete(`/tests/${test.id}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Error while deleting the test'));
    }
  }

  async function toggleIncludeInCi(test: TestSummary): Promise<void> {
    const next = !test.include_in_ci;
    if (next && test.last_local_status !== 'passed') {
      setError(t('"{name}": to include a test in CI/CD its last local run must be passing (green). Run it locally and try again.', { name: test.name }));
      return;
    }
    try {
      await api.put(`/tests/${test.id}`, { include_in_ci: next });
      setTests((prev) => prev.map((x) => (x.id === test.id ? { ...x, include_in_ci: next } : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Error while updating the test'));
    }
  }

  if (selectedId) {
    return (
      <TestDetailScreen
        testId={selectedId}
        onBack={() => {
          setSelectedId(null);
          load();
        }}
      />
    );
  }

  if (creating) {
    return (
      <NewTestForm
        project={project}
        onCancel={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          load();
        }}
      />
    );
  }

  if (loading) return <div className="text-ink-muted">{t('Loading tests…')}</div>;

  const rootFolders = folders.filter((f) => f.parent_id === null);

  const breadcrumb: Folder[] = [];
  {
    let cursor = currentFolderId;
    while (cursor !== null) {
      const folder = folders.find((f) => f.id === cursor);
      if (!folder) break;
      breadcrumb.unshift(folder);
      cursor = folder.parent_id;
    }
  }

  const filteredTests = tests.filter((test) => {
    if (test.folder_id !== currentFolderId) return false;
    if (statusFilter === 'passed' && test.last_status !== 'passed') return false;
    if (statusFilter === 'failed' && test.last_status !== 'failed' && test.last_status !== 'error') return false;
    if (statusFilter === 'never' && test.last_status !== null) return false;
    if (triggerFilter !== 'all' && test.last_triggered_by !== triggerFilter) return false;
    if (tagFilter !== 'all' && !test.tags.includes(tagFilter)) return false;
    const needle = search.trim().toLowerCase();
    if (needle) {
      const haystack = [test.name, test.notes ?? '', ...test.tags].join(' ').toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  const allTags = Array.from(new Set(tests.flatMap((test) => test.tags))).sort();

  const passedRuns = Number(stats?.by_status.find((s) => s.status === 'passed')?.count ?? 0);
  const failedRuns = stats?.by_status.reduce((sum, s) => (s.status === 'failed' || s.status === 'error' ? sum + Number(s.count) : sum), 0) ?? 0;
  const desktopRuns = Number(stats?.by_trigger.find((x) => x.triggered_by === 'desktop')?.count ?? 0);
  const ciRuns = Number(stats?.by_trigger.find((x) => x.triggered_by === 'ci')?.count ?? 0);
  const totalRuns = stats?.runs_count ?? 0;
  const neverRun = tests.filter((test) => test.last_status === null).length;

  const statusLabels: Record<StatusFilter, string> = { all: t('All'), passed: t('Passed'), failed: t('Failed'), never: t('Never run') };
  const triggerLabels: Record<TriggerFilter, string> = { all: t('All triggers'), desktop: t('Local'), ci: t('CI/CD') };

  return (
    <div className="animate-fade-up">
      <div className="screen-header">
        <div className="min-w-0">
          <h1 className="screen-title">{t('Dashboard')}</h1>
          <div className="screen-subtitle truncate">{project.name}</div>
        </div>
        <button onClick={() => setCreating(true)}>
          <Plus size={16} /> {t('New test')}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatTile
          value={stats?.tests_count ?? tests.length}
          label={t('Registered tests')}
          icon={<ListChecks size={18} className="text-accent-700" />}
          tint="bg-accent/15"
        />
        <StatTile value={totalRuns} label={t('Total runs')} icon={<PlayCircle size={18} className="text-accent2" />} tint="bg-accent2/10" />
        <StatTile value={passedRuns} label={t('Passed runs')} icon={<CheckCircle2 size={18} className="text-good" />} tint="bg-good/10" />
        <StatTile value={failedRuns} label={t('Failed runs')} icon={<XCircle size={18} className="text-critical" />} tint="bg-critical/10" />
        <StatTile value={neverRun} label={t('Tests never run')} icon={<CircleDashed size={18} className="text-ink-muted" />} tint="bg-ink-muted/10" />
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div className="card !mb-0">
          <div className="card-title mb-3">{t('Runs summary')}</div>
          <DonutChart passed={passedRuns} failed={failedRuns} />
        </div>
        <div className="card !mb-0">
          <div className="card-title mb-3">{t('Run sources')}</div>
          <TriggerBarChart desktop={desktopRuns} ci={ciRuns} />
        </div>
        <div className="md:col-span-2 xl:col-span-1 [&>.card]:!mb-0">
          <BrowserSetupCard />
        </div>
        <div className="card !mb-0 md:col-span-2 xl:col-span-1">
          <div className="card-title mb-2 flex items-center gap-1.5">
            <Wrench size={14} /> {t('Self-healing')}
          </div>
          {!project.base_url ? (
            <p className="text-[13px] text-ink-muted">
              {t('Set a base URL for this project (Projects screen) to enable automatic repair of broken selectors.')}
            </p>
          ) : (
            <>
              <p className="text-[13px] text-ink-secondary">
                {baselineReady === null && t('Checking baseline status…')}
                {baselineReady === false && t('No baseline: build the site reference map before a broken test can be repaired.')}
                {baselineReady === true && t('Baseline available: failed tests can be analyzed and repaired.')}
              </p>
              <button className="secondary mt-3" onClick={buildBaseline} disabled={buildingBaseline}>
                {buildingBaseline ? t('Capturing…') : baselineReady ? t('Update baseline') : t('Build baseline now')}
              </button>
              {baselineMessage && <p className="mt-2 text-xs text-ink-muted">{baselineMessage}</p>}
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <div className="card !mb-0">
          <div className="mb-2 flex items-center justify-between">
            <span className="card-title">{t('Folders')}</span>
            <button onClick={() => startCreatingFolder(null)} title={t('New folder at root')} className="ghost icon sm !text-ink-muted hover:!text-ink-primary">
              <FolderPlus size={14} />
            </button>
          </div>

          {creatingFolder && (
            <div className="mb-2 flex flex-col gap-1.5">
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createFolder();
                  if (e.key === 'Escape') setCreatingFolder(false);
                }}
                placeholder={
                  newFolderParentId !== null
                    ? t('Folder name (in {parent})', { parent: folders.find((f) => f.id === newFolderParentId)?.name ?? '' })
                    : t('Folder name (root)')
                }
                className="!py-1 !text-xs"
              />
              <div className="flex gap-1.5">
                <button onClick={createFolder} disabled={!newFolderName.trim()} className="sm flex-1">
                  {t('Create')}
                </button>
                <button className="secondary sm" onClick={() => setCreatingFolder(false)}>
                  {t('Cancel')}
                </button>
              </div>
            </div>
          )}

          <button
            onClick={() => setCurrentFolderId(null)}
            className={`ghost mb-0.5 !w-full !justify-start !gap-1.5 !px-2 !py-1.5 !text-[13px] ${
              currentFolderId === null ? '!bg-accent/15 !font-semibold !text-ink-primary' : ''
            }`}
          >
            <Home size={13} /> {t('All tests')}
            <span className="ml-auto text-ink-muted">{tests.filter((test) => test.folder_id === null).length}</span>
          </button>

          {rootFolders.map((folder) => (
            <FolderTreeItem
              key={folder.id}
              folder={folder}
              depth={0}
              tests={tests}
              folders={folders}
              currentFolderId={currentFolderId}
              expanded={expandedFolders}
              onToggleExpand={toggleExpandFolder}
              onSelect={setCurrentFolderId}
              onCreateChild={startCreatingFolder}
              onDelete={deleteFolder}
            />
          ))}
        </div>

        <div className="card !mb-0">
          {breadcrumb.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-1 text-xs text-ink-muted">
              <button onClick={() => setCurrentFolderId(null)} className="ghost !p-0 !text-xs !text-ink-muted hover:!bg-transparent hover:!text-ink-primary hover:!underline">
                {t('All tests')}
              </button>
              {breadcrumb.map((folder, i) => (
                <React.Fragment key={folder.id}>
                  <ChevronRight size={11} />
                  <button
                    onClick={() => setCurrentFolderId(folder.id)}
                    className={`ghost !p-0 !text-xs hover:!bg-transparent hover:!underline ${
                      i === breadcrumb.length - 1 ? '!font-semibold !text-ink-primary' : '!text-ink-muted hover:!text-ink-primary'
                    }`}
                  >
                    {folder.name}
                  </button>
                </React.Fragment>
              ))}
            </div>
          )}

          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative min-w-[200px] max-w-xs flex-1">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
              <input placeholder={t('Search tests, tags or notes…')} value={search} onChange={(e) => setSearch(e.target.value)} className="w-full !pl-9" />
            </div>
            <div className="flex flex-wrap gap-2">
              <div className="pill-group">
                {(['all', 'passed', 'failed', 'never'] as StatusFilter[]).map((f) => (
                  <button key={f} className={`pill ${statusFilter === f ? 'active' : ''}`} onClick={() => setStatusFilter(f)}>
                    {statusLabels[f]}
                  </button>
                ))}
              </div>
              <div className="pill-group">
                {(['all', 'desktop', 'ci'] as TriggerFilter[]).map((f) => (
                  <button key={f} className={`pill ${triggerFilter === f ? 'active' : ''}`} onClick={() => setTriggerFilter(f)}>
                    {triggerLabels[f]}
                  </button>
                ))}
              </div>
              {allTags.length > 0 && (
                <div className="pill-group flex-wrap">
                  <button className={`pill ${tagFilter === 'all' ? 'active' : ''}`} onClick={() => setTagFilter('all')}>
                    {t('All tags')}
                  </button>
                  {allTags.map((tag) => (
                    <button key={tag} className={`pill ${tagFilter === tag ? 'active' : ''}`} onClick={() => setTagFilter(tag)}>
                      {tag}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {filteredTests.length === 0 ? (
            <p className="py-6 text-center text-ink-muted">{t('No tests match the selected filters.')}</p>
          ) : (
            <table className="data-table table-fixed">
              <colgroup>
                <col />
                <col className="w-[84px]" />
                <col className="w-[72px]" />
                <col className="w-[128px]" />
                <col className="w-[108px]" />
                <col className="w-[84px]" />
              </colgroup>
              <thead>
                <tr>
                  <th>{t('Name')}</th>
                  <th>{t('Source')}</th>
                  <th>{t('Results')}</th>
                  <th>{t('Status')}</th>
                  <th>{t('CI/CD')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredTests.map((test) => (
                  <tr key={test.id}>
                    <td className="min-w-0">
                      <div className="break-words font-semibold text-ink-primary">{test.name}</div>
                      {test.description && <div className="line-clamp-2 break-words text-xs text-ink-muted">{test.description}</div>}
                      {(test.last_status === 'failed' || test.last_status === 'error') && test.last_log && (
                        <div className="mt-1 truncate text-xs text-critical" title={test.last_log}>
                          {extractErrorSnippet(test.last_log)}
                        </div>
                      )}
                      {test.tags.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {test.tags.map((tag) => (
                            <span key={tag} className="tag-chip">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="text-ink-secondary">
                      {test.last_triggered_by === 'ci' ? t('CI/CD') : test.last_triggered_by === 'desktop' ? t('Local') : '—'}
                    </td>
                    <td className="tabular-nums text-ink-secondary">{test.runs_total > 0 ? `${test.runs_passed}/${test.runs_total}` : '—'}</td>
                    <td>
                      <StatusBadge status={test.last_status} />
                    </td>
                    <td>
                      <button
                        className="ghost sm !px-1.5"
                        style={{ color: test.include_in_ci ? '#0a7f0a' : '#898781' }}
                        title={
                          test.include_in_ci
                            ? t('Click to exclude this test from the CI/CD pipeline')
                            : test.last_local_status === 'passed'
                              ? t('Click to include this test in the CI/CD pipeline')
                              : t('Requires a passing (green) local run before it can be included in CI/CD')
                        }
                        onClick={() => toggleIncludeInCi(test)}
                      >
                        {test.include_in_ci ? '● ' + t('Included') : '○ ' + t('Excluded')}
                        {!test.include_in_ci && test.last_local_status !== 'passed' && <Lock size={11} />}
                      </button>
                    </td>
                    <td className="whitespace-nowrap text-right">
                      <div className="inline-flex gap-1">
                        <button className="secondary icon" onClick={() => setSelectedId(test.id)} title={t('Open details')}>
                          <Eye size={15} />
                        </button>
                        <button className="danger icon" onClick={() => deleteTest(test)} title={t('Delete test')}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
