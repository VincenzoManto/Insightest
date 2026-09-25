import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, CircleDot, RefreshCw, Search, X, XCircle } from 'lucide-react';
import { useAuth } from '../state/AuthContext';
import type { CiRunRow, Folder, Project } from '../types';
import { counts, filterGroups, folderPathOf, formatDuration, groupCiRuns, type CiRunGroup, type StatusFilter } from '../ciRuns';
import { formatDateTime, t } from '../i18n';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function StatusIcon({ status }: { status: CiRunRow['status'] }): React.ReactElement {
  if (status === 'passed') return <CheckCircle2 size={15} className="flex-shrink-0 text-good" />;
  if (status === 'running') return <CircleDot size={15} className="flex-shrink-0 text-warning" />;
  return <XCircle size={15} className="flex-shrink-0 text-critical" />;
}

/** Green / red / grey proportions of a run. */
function ResultBar({ passed, failed, other }: { passed: number; failed: number; other: number }): React.ReactElement {
  const total = passed + failed + other || 1;
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-gridline">
      <div style={{ width: `${(passed / total) * 100}%`, background: '#0ca30c' }} />
      <div style={{ width: `${(failed / total) * 100}%`, background: '#d03b3b' }} />
      <div style={{ width: `${(other / total) * 100}%`, background: '#fab219' }} />
    </div>
  );
}

function RunHash({ hash }: { hash: string | null }): React.ReactElement {
  if (!hash) {
    return (
      <span className="text-[11px] italic text-ink-muted" title={t('Recorded before runs had an id: grouped by time')}>
        {t('no id')}
      </span>
    );
  }
  return (
    <code
      className="cursor-copy rounded bg-page px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary"
      title={t('Run id (click to copy)')}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(hash).catch(() => undefined);
      }}
    >
      {hash}
    </code>
  );
}

/**
 * Recap of the project's CI runs, one card per pipeline execution (grouped by the runner's run id), plus a search
 * over test names that works across every run and every folder.
 */
export function CiRunsScreen({ project, onOpenTest }: { project: Project; onOpenTest: (testId: number) => void }): React.ReactElement {
  const { api } = useAuth();
  const [rows, setRows] = useState<CiRunRow[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<Record<number, { loading: boolean; text: string }>>({});

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const [runsRes, foldersRes] = await Promise.all([
        api.get<{ runs: CiRunRow[] }>(`/projects/${project.id}/ci-runs`),
        api.get<{ folders: Folder[] }>(`/projects/${project.id}/folders`),
      ]);
      setRows(runsRes.runs);
      // The API can return ids as strings; folder lookups compare numbers.
      setFolders(foldersRes.folders.map((f) => ({ ...f, id: Number(f.id), parent_id: f.parent_id !== null && f.parent_id !== undefined ? Number(f.parent_id) : null })));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const groups = useMemo(() => groupCiRuns(rows), [rows]);
  const visible = useMemo(() => filterGroups(groups, query, status), [groups, query, status]);
  const searching = query.trim() !== '' || status !== 'all';
  const shownResults = visible.reduce((sum, g) => sum + g.items.length, 0);

  async function toggleLog(row: CiRunRow): Promise<void> {
    if (logs[row.id]) {
      setLogs((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      return;
    }
    setLogs((prev) => ({ ...prev, [row.id]: { loading: true, text: '' } }));
    try {
      const run = await api.get<{ log: string | null }>(`/tests/${row.test_id}/runs/${row.id}`);
      const lines = (run.log ?? '').replace(ANSI_RE, '').split('\n');
      setLogs((prev) => ({ ...prev, [row.id]: { loading: false, text: lines.slice(-60).join('\n').trim() || t('(empty log)') } }));
    } catch (err) {
      setLogs((prev) => ({ ...prev, [row.id]: { loading: false, text: err instanceof Error ? err.message : t('Unknown error') } }));
    }
  }

  function renderGroup(group: CiRunGroup, index: number): React.ReactElement {
    // Newest run open by default; while searching every match is shown.
    const isOpen = open[group.key] ?? (searching || index === 0);
    const c = counts(group.items);
    return (
      <div key={group.key} className="card !p-0 overflow-hidden">
        <button type="button" onClick={() => setOpen((prev) => ({ ...prev, [group.key]: !isOpen }))} className="!flex !w-full !flex-col !items-stretch !gap-2.5 !rounded-none !border-0 !bg-transparent !px-4 !py-3.5 !text-left !shadow-none hover:!bg-page">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {isOpen ? <ChevronDown size={15} className="flex-shrink-0 text-ink-muted" /> : <ChevronRight size={15} className="flex-shrink-0 text-ink-muted" />}
            <span className="text-sm font-semibold text-ink-primary">{formatDateTime(group.endedAt)}</span>
            <RunHash hash={group.hash} />
            <span className="ml-auto flex flex-wrap items-center gap-2 text-xs">
              {c.failed > 0 && (
                <span className="badge badge-critical">
                  <XCircle size={12} /> {c.failed}
                </span>
              )}
              <span className="badge badge-good">
                <CheckCircle2 size={12} /> {c.passed}
              </span>
              {c.other > 0 && <span className="badge badge-warning">{c.other}</span>}
              <span className="text-ink-muted">{t('{n} tests', { n: group.items.length })}</span>
              <span className="text-ink-muted">· {formatDuration(group.durationMs)}</span>
            </span>
          </div>
          <ResultBar passed={c.passed} failed={c.failed} other={c.other} />
        </button>

        {isOpen && (
          <div className="border-t border-gridline">
            {group.items.map((r) => {
              const failed = r.status === 'failed' || r.status === 'error';
              const log = logs[r.id];
              const folder = folderPathOf(r.folder_id, folders);
              return (
                <div key={r.id} className="border-b border-gridline px-4 py-2.5 last:border-b-0">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <StatusIcon status={r.status} />
                    <button type="button" onClick={() => onOpenTest(r.test_id)} title={t('Open test')} className="ghost !h-auto !min-w-0 !justify-start !truncate !px-1 !py-0.5 !text-[13px] !font-medium text-ink-primary hover:underline">
                      {r.test_name}
                    </button>
                    {folder && <span className="hidden min-w-0 truncate text-xs text-ink-muted md:inline">{folder}</span>}
                    <span className="ml-auto flex-shrink-0 text-xs text-ink-muted">{formatDuration(r.duration_ms ?? 0)}</span>
                    {failed && (
                      <button type="button" className="secondary sm flex-shrink-0" onClick={() => void toggleLog(r)}>
                        {log ? t('Hide log') : t('Show log')}
                      </button>
                    )}
                  </div>
                  {log && (
                    <pre className="codeblock mt-2 max-h-64 overflow-auto">{log.loading ? t('Loading…') : log.text}</pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="animate-fade-up">
      <div className="screen-header">
        <div>
          <h1 className="screen-title">{t('CI runs')}</h1>
          <p className="screen-subtitle">{t('One card per pipeline execution, with the result of every test in it.')}</p>
        </div>
        <button className="secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> {t('Refresh')}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[260px] flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search a test by name, in any folder…')}
            className="w-full !pl-9 !pr-9"
            autoFocus
          />
          {query && (
            <button type="button" className="ghost icon sm absolute right-1.5 top-1/2 -translate-y-1/2" onClick={() => setQuery('')} title={t('Clear')}>
              <X size={14} />
            </button>
          )}
        </div>
        <div className="flex gap-1.5">
          {(['all', 'failed', 'passed'] as StatusFilter[]).map((s) => (
            <button key={s} type="button" className={status === s ? 'sm' : 'secondary sm'} onClick={() => setStatus(s)}>
              {s === 'all' ? t('All') : s === 'failed' ? t('Failed') : t('Passed')}
            </button>
          ))}
        </div>
      </div>

      {!loading && !error && (
        <div className="mb-3 text-xs text-ink-muted">
          {searching
            ? t('{results} results in {runs} runs', { results: shownResults, runs: visible.length })
            : t('{runs} runs, {results} results', { runs: groups.length, results: rows.length })}
        </div>
      )}

      {loading && rows.length === 0 && <div className="text-ink-secondary">{t('Loading…')}</div>}
      {!loading && !error && groups.length === 0 && <div className="card text-ink-muted">{t('No CI runs recorded yet. They appear here after the pipeline reports its results.')}</div>}
      {!loading && groups.length > 0 && visible.length === 0 && <div className="card text-ink-muted">{t('No test matches the search.')}</div>}

      <div className="flex flex-col gap-3">
        {visible.map((g, i) => renderGroup(g, i))}
      </div>
    </div>
  );
}
