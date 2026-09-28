<?php

namespace App\Controllers;

use App\Authz;
use App\Database;
use App\HttpException;
use App\Request;
use App\Response;
use App\Validator;

final class RunController
{
    private const MAX_LOG_LENGTH = 2_000_000;

    /** Runs are capped per test so the DB doesn't grow unbounded; always keep at least 1 passed run as evidence the test ever worked. */
    private const MAX_RUNS_PER_TEST = 7;

    /** CI runs are kept per pipeline execution: only the last N executions of a project stay in the DB. */
    private const MAX_CI_RUNS = 7;

    public static function index(Request $req): void
    {
        $testId = (int) $req->params['testId'];
        $orgId = Authz::orgIdForTest($testId);

        if ($req->user) {
            Authz::requireTestRole($testId, $req->user['id']);
        } elseif (!$req->apiKey || (int) $req->apiKey['org_id'] !== $orgId) {
            throw new HttpException('Forbidden', 403);
        }

        $stmt = Database::pdo()->prepare(
            'SELECT id, status, duration_ms, triggered_by, healed, healing_detail, started_at, finished_at, created_at
             FROM test_runs WHERE test_id = ? ORDER BY created_at DESC LIMIT 100'
        );
        $stmt->execute([$testId]);
        Response::json(['runs' => $stmt->fetchAll()]);
    }

    /**
     * Every CI-triggered run of a project, newest first, WITHOUT logs (they can be huge: fetch one on demand from
     * GET /tests/{id}/runs/{runId}). The desktop groups these rows by run_key into "pipeline runs".
     */
    public static function ciRuns(Request $req): void
    {
        $projectId = (int) $req->params['projectId'];
        Authz::requireProjectRole($projectId, $req->user['id']);

        $stmt = Database::pdo()->prepare(
            "SELECT r.id, r.test_id, t.name AS test_name, t.folder_id, r.status, r.duration_ms, r.run_key,
                    r.started_at, r.finished_at, r.created_at
             FROM test_runs r
             JOIN tests t ON t.id = r.test_id
             WHERE t.project_id = ? AND r.triggered_by = 'ci'
             ORDER BY r.created_at DESC, r.id DESC
             LIMIT 5000"
        );
        $stmt->execute([$projectId]);
        $rows = $stmt->fetchAll();
        // Some PHP/SQLite builds return every column as a string; the client matches ids, so make them real ints.
        foreach ($rows as &$row) {
            $row['id'] = (int) $row['id'];
            $row['test_id'] = (int) $row['test_id'];
            $row['folder_id'] = $row['folder_id'] !== null ? (int) $row['folder_id'] : null;
            $row['duration_ms'] = $row['duration_ms'] !== null ? (int) $row['duration_ms'] : null;
        }
        unset($row);
        Response::json(['runs' => $rows]);
    }

    /** Called by either the desktop app (JWT) or the CI runner (API key) after a Playwright execution. */
    public static function create(Request $req): void
    {
        $testId = (int) $req->params['testId'];
        $orgId = Authz::orgIdForTest($testId);

        $triggeredBy = $req->user ? 'desktop' : 'ci';
        if ($req->user) {
            Authz::requireTestRole($testId, $req->user['id']);
        } elseif (!$req->apiKey || (int) $req->apiKey['org_id'] !== $orgId) {
            throw new HttpException('Forbidden', 403);
        }

        Validator::required($req->body, ['status']);
        if (!Validator::oneOf($req->body['status'], ['passed', 'failed', 'error', 'running'])) {
            throw new HttpException('Invalid status', 422);
        }

        $log = (string) ($req->body['log'] ?? '');
        if (strlen($log) > self::MAX_LOG_LENGTH) {
            $log = substr($log, 0, self::MAX_LOG_LENGTH) . "\n...[truncated]";
        }

        // Groups the runs of one CI pipeline execution (sent by the runner); anything odd is simply ignored.
        $runKey = isset($req->body['run_key']) ? trim((string) $req->body['run_key']) : '';
        $runKey = preg_match('/^[A-Za-z0-9._-]{1,64}$/', $runKey) === 1 ? $runKey : null;

        $pdo = Database::pdo();
        $pdo->prepare(
            'INSERT INTO test_runs (test_id, status, duration_ms, log, screenshot_path, trace_path, triggered_by, healed, healing_detail, started_at, finished_at, run_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            $testId,
            $req->body['status'],
            $req->body['duration_ms'] ?? null,
            $log,
            $req->body['screenshot_path'] ?? null,
            $req->body['trace_path'] ?? null,
            $triggeredBy,
            !empty($req->body['healed']) ? 1 : 0,
            isset($req->body['healing_detail']) ? (string) $req->body['healing_detail'] : null,
            $req->body['started_at'] ?? null,
            $req->body['finished_at'] ?? null,
            $runKey,
        ]);

        $newRunId = (int) $pdo->lastInsertId();
        if ($triggeredBy === 'ci' && $runKey !== null) {
            self::pruneCiRuns($pdo, $testId);
        } else {
            self::pruneRuns($pdo, $testId);
        }

        Response::json(['id' => $newRunId], 201);
    }

    /**
     * Keeps only the MAX_CI_RUNS most recent CI pipeline executions of the project (every result of those runs,
     * whatever the test), and drops everything older. "Most recent" is by each run's newest result, so a run still
     * reporting its results is always among the kept ones.
     */
    private static function pruneCiRuns(\PDO $pdo, int $testId): void
    {
        $projectStmt = $pdo->prepare('SELECT project_id FROM tests WHERE id = ?');
        $projectStmt->execute([$testId]);
        $projectId = (int) $projectStmt->fetchColumn();
        if ($projectId === 0) {
            return;
        }

        $stmt = $pdo->prepare(
            "SELECT r.run_key
             FROM test_runs r JOIN tests t ON t.id = r.test_id
             WHERE t.project_id = ? AND r.triggered_by = 'ci' AND r.run_key IS NOT NULL
             GROUP BY r.run_key
             ORDER BY MAX(r.created_at) DESC, MAX(r.id) DESC"
        );
        $stmt->execute([$projectId]);
        $runKeys = $stmt->fetchAll(\PDO::FETCH_COLUMN);
        if (count($runKeys) < self::MAX_CI_RUNS) {
            return;
        }

        // Results recorded before runs had an id can't be placed among the last N runs: once N identified runs
        // exist, they are older than all of them.
        $pdo->prepare(
            "DELETE FROM test_runs
             WHERE triggered_by = 'ci' AND run_key IS NULL
               AND test_id IN (SELECT id FROM tests WHERE project_id = ?)"
        )->execute([$projectId]);

        $stale = array_slice($runKeys, self::MAX_CI_RUNS);
        if ($stale) {
            $placeholders = implode(',', array_fill(0, count($stale), '?'));
            $pdo->prepare(
                "DELETE FROM test_runs
                 WHERE triggered_by = 'ci' AND run_key IN ($placeholders)
                   AND test_id IN (SELECT id FROM tests WHERE project_id = ?)"
            )->execute(array_merge($stale, [$projectId]));
        }
    }

    /**
     * Per-test cap for everything that is NOT a CI run with an id: desktop runs, and CI rows recorded without one
     * (older runner). Each group is capped on its own, so a burst of local runs never evicts CI history.
     */
    private static function pruneRuns(\PDO $pdo, int $testId): void
    {
        self::pruneScope($pdo, $testId, "triggered_by = 'desktop'");
        self::pruneScope($pdo, $testId, "triggered_by = 'ci' AND run_key IS NULL");
    }

    /** Keeps only the most recent MAX_RUNS_PER_TEST runs of a test within `$scope` (a constant SQL condition), but always preserves at least one passed run if one exists. */
    private static function pruneScope(\PDO $pdo, int $testId, string $scope): void
    {
        $stmt = $pdo->prepare("SELECT id, status FROM test_runs WHERE test_id = ? AND ($scope) ORDER BY created_at DESC, id DESC");
        $stmt->execute([$testId]);
        $rows = $stmt->fetchAll();
        if (count($rows) <= self::MAX_RUNS_PER_TEST) {
            return;
        }

        $keepIds = array_column(array_slice($rows, 0, self::MAX_RUNS_PER_TEST), 'id');
        $hasPassed = false;
        foreach (array_slice($rows, 0, self::MAX_RUNS_PER_TEST) as $row) {
            if ($row['status'] === 'passed') {
                $hasPassed = true;
                break;
            }
        }

        if (!$hasPassed) {
            foreach ($rows as $row) {
                if ($row['status'] === 'passed') {
                    if (!in_array($row['id'], $keepIds, true)) {
                        array_pop($keepIds); // drop the oldest of the kept runs to make room
                        $keepIds[] = $row['id'];
                    }
                    break;
                }
            }
        }

        $placeholders = implode(',', array_fill(0, count($keepIds), '?'));
        // Only ever touches rows inside `$scope`: CI runs that carry an id are governed by pruneCiRuns().
        $delete = $pdo->prepare("DELETE FROM test_runs WHERE test_id = ? AND ($scope) AND id NOT IN ($placeholders)");
        $delete->execute(array_merge([$testId], $keepIds));
    }

    /** Full detail of a single run (including its log), used to feed on-demand healing analysis. */
    public static function show(Request $req): void
    {
        $testId = (int) $req->params['testId'];
        $runId = (int) $req->params['runId'];
        $orgId = Authz::orgIdForTest($testId);

        if ($req->user) {
            Authz::requireTestRole($testId, $req->user['id']);
        } elseif (!$req->apiKey || (int) $req->apiKey['org_id'] !== $orgId) {
            throw new HttpException('Forbidden', 403);
        }

        $stmt = Database::pdo()->prepare('SELECT * FROM test_runs WHERE id = ? AND test_id = ?');
        $stmt->execute([$runId, $testId]);
        $run = $stmt->fetch();
        if (!$run) {
            throw new HttpException('Run not found', 404);
        }
        Response::json($run);
    }

    /** Persists an on-demand healing verdict (e.g. from the desktop app's "Analizza" button) onto an existing run. */
    public static function updateHealing(Request $req): void
    {
        $testId = (int) $req->params['testId'];
        $runId = (int) $req->params['runId'];
        $orgId = Authz::orgIdForTest($testId);

        if ($req->user) {
            Authz::requireTestRole($testId, $req->user['id']);
        } elseif (!$req->apiKey || (int) $req->apiKey['org_id'] !== $orgId) {
            throw new HttpException('Forbidden', 403);
        }

        Validator::required($req->body, ['healing_detail']);
        $stmt = Database::pdo()->prepare('UPDATE test_runs SET healing_detail = ? WHERE id = ? AND test_id = ?');
        $stmt->execute([(string) $req->body['healing_detail'], $runId, $testId]);
        Response::json(['ok' => true]);
    }
}
