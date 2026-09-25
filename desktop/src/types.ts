export interface User {
  id: number;
  email: string;
  name: string;
}

export interface Organization {
  id: number;
  name: string;
  role: 'owner' | 'admin' | 'member';
}

export interface Project {
  id: number;
  org_id: number;
  name: string;
  base_url: string | null;
  /** Local filesystem path to the app's git repo; used as cwd when delegating repair to an external coding-agent CLI. */
  repo_path: string | null;
  /** JSON array of selector kinds in the order the runner tries them; null = default (xpath, generalSelector, text, id). */
  selector_priority: string | null;
  created_at: string;
}

export interface ApiKey {
  id: number;
  name: string;
  key_prefix: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface TestSummary {
  id: number;
  project_id: number;
  folder_id: number | null;
  name: string;
  description: string | null;
  prompt: string | null;
  tags: string[];
  notes: string | null;
  include_in_ci: boolean;
  depends_on_test_id: number | null;
  created_at: string;
  updated_at: string;
  last_status: 'passed' | 'failed' | 'error' | 'running' | null;
  last_triggered_by: 'desktop' | 'ci' | null;
  last_local_status: 'passed' | 'failed' | 'error' | 'running' | null;
  /** Tail of the most recent run's log (only meaningful when last_status is 'failed'/'error'). */
  last_log: string | null;
  runs_total: number;
  runs_passed: number;
  runs_failed: number;
}

export interface TestDetail extends TestSummary {
  playwright_code: string;
  steps_json: string | null;
}

export interface ProjectStats {
  tests_count: number;
  runs_count: number;
  by_status: { status: string; count: number }[];
  by_trigger: { triggered_by: string; count: number }[];
}

export interface TestRun {
  id: number;
  status: 'passed' | 'failed' | 'error' | 'running';
  duration_ms: number | null;
  triggered_by: 'desktop' | 'ci';
  healed: number;
  healing_detail: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface TestRunDetail extends TestRun {
  test_id: number;
  log: string | null;
}

/** One CI-triggered test run, as listed by GET /projects/:id/ci-runs (no log: fetch it on demand). */
export interface CiRunRow {
  id: number;
  test_id: number;
  test_name: string;
  folder_id: number | null;
  status: 'passed' | 'failed' | 'error' | 'running';
  duration_ms: number | null;
  /** Hash of the pipeline execution that reported it; null on runs recorded before grouping existed. */
  run_key: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface Folder {
  id: number;
  project_id: number;
  parent_id: number | null;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface Invitation {
  id: number;
  type: 'org' | 'project';
  role: 'admin' | 'member';
  created_at: string;
  org_id: number;
  project_id: number | null;
  org_name: string;
  project_name: string | null;
  inviter_name: string | null;
  inviter_email: string | null;
}

export interface PendingInvitation {
  id: number;
  email: string;
  role: 'admin' | 'member';
  created_at: string;
}

export interface Member {
  id: number;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  /** Projects only: whether the access comes from the parent organization or a direct project invite. */
  source?: 'org' | 'project';
}

export interface SharedProject extends Project {
  org_name: string;
  role: 'admin' | 'member';
}
