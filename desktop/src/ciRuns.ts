/**
 * CI run recap: turns the flat list of CI test runs (GET /projects/:id/ci-runs) into "pipeline runs".
 * Runs reported by the same runner invocation share a `run_key` (its hash). Older rows have none: those are grouped
 * by time proximity instead (results of one pipeline execution arrive minutes apart, executions hours apart).
 */
import type { CiRunRow, Folder } from './types';

export interface CiRunGroup {
  /** Stable React key. */
  key: string;
  /** The run hash shown to the user; null for groups rebuilt from timestamps. */
  hash: string | null;
  startedAt: string;
  endedAt: string;
  items: CiRunRow[];
  passed: number;
  failed: number;
  other: number;
  durationMs: number;
}

/** A gap larger than this between two consecutive key-less rows starts a new (reconstructed) run. */
const LEGACY_GAP_MS = 20 * 60 * 1000;

const ts = (row: CiRunRow): number => new Date(row.created_at).getTime();

function summarize(key: string, hash: string | null, rows: CiRunRow[]): CiRunGroup {
  // One result per test inside a run (a test can be reported twice, e.g. a rerun): keep the newest.
  const latest = new Map<number, CiRunRow>();
  for (const row of [...rows].sort((a, b) => ts(b) - ts(a) || b.id - a.id)) if (!latest.has(row.test_id)) latest.set(row.test_id, row);
  const items = [...latest.values()].sort((a, b) => rank(a.status) - rank(b.status) || a.test_name.localeCompare(b.test_name));
  const times = items.map(ts);
  return {
    key,
    hash,
    startedAt: new Date(Math.min(...times)).toISOString(),
    endedAt: new Date(Math.max(...times)).toISOString(),
    items,
    ...counts(items),
    durationMs: items.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0),
  };
}

/** Failures first: that is what one opens a run recap for. */
function rank(status: CiRunRow['status']): number {
  return status === 'failed' ? 0 : status === 'error' ? 1 : status === 'running' ? 2 : 3;
}

export function counts(items: CiRunRow[]): { passed: number; failed: number; other: number } {
  let passed = 0;
  let failed = 0;
  let other = 0;
  for (const r of items) {
    if (r.status === 'passed') passed++;
    else if (r.status === 'failed' || r.status === 'error') failed++;
    else other++;
  }
  return { passed, failed, other };
}

/** Newest run first. */
export function groupCiRuns(rows: CiRunRow[]): CiRunGroup[] {
  const byKey = new Map<string, CiRunRow[]>();
  const keyless: CiRunRow[] = [];
  for (const row of rows) {
    if (row.run_key) {
      const list = byKey.get(row.run_key) ?? [];
      list.push(row);
      byKey.set(row.run_key, list);
    } else {
      keyless.push(row);
    }
  }

  const groups: CiRunGroup[] = [...byKey.entries()].map(([key, list]) => summarize(`k:${key}`, key, list));

  const sorted = [...keyless].sort((a, b) => ts(b) - ts(a));
  let current: CiRunRow[] = [];
  const flush = (): void => {
    if (current.length) groups.push(summarize(`t:${current[0].id}`, null, current));
    current = [];
  };
  for (const row of sorted) {
    if (current.length && ts(current[current.length - 1]) - ts(row) > LEGACY_GAP_MS) flush();
    current.push(row);
  }
  flush();

  return groups.sort((a, b) => new Date(b.endedAt).getTime() - new Date(a.endedAt).getTime());
}

/* ------------------------------------------------------------------ search */

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Every word of the query must appear in the test name (any order, case/accent-insensitive), whatever its folder. */
export function matchesQuery(testName: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const name = fold(testName);
  return words.every((w) => name.includes(w));
}

export type StatusFilter = 'all' | 'failed' | 'passed';

/** Applies the search + status filter; groups left empty are dropped, counts are recomputed on what remains. */
export function filterGroups(groups: CiRunGroup[], query: string, status: StatusFilter): CiRunGroup[] {
  if (!query.trim() && status === 'all') return groups;
  const out: CiRunGroup[] = [];
  for (const g of groups) {
    const items = g.items.filter((r) => {
      if (!matchesQuery(r.test_name, query)) return false;
      if (status === 'failed') return r.status === 'failed' || r.status === 'error';
      if (status === 'passed') return r.status === 'passed';
      return true;
    });
    if (items.length) out.push({ ...g, items, ...counts(items), durationMs: items.reduce((s, r) => s + (r.duration_ms ?? 0), 0) });
  }
  return out;
}

/* ------------------------------------------------------------------ display helpers */

export function folderPathOf(folderId: number | null, folders: Folder[]): string {
  if (folderId === null) return '';
  const names: string[] = [];
  let cursor = folders.find((f) => f.id === folderId);
  const seen = new Set<number>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    names.unshift(cursor.name);
    const parentId: number | null = cursor.parent_id;
    cursor = parentId === null ? undefined : folders.find((f) => f.id === parentId);
  }
  return names.join(' / ');
}

export function formatDuration(ms: number): string {
  if (!ms || ms < 1000) return ms > 0 ? `${ms}ms` : '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
