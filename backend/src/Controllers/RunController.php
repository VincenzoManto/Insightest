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

        $pdo = Database::pdo();
        $pdo->prepare(
            'INSERT INTO test_runs (test_id, status, duration_ms, log, screenshot_path, trace_path, triggered_by, healed, healing_detail, started_at, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
        ]);

        $newRunId = (int) $pdo->lastInsertId();
        self::pruneRuns($pdo, $testId);

        Response::json(['id' => $newRunId], 201);
    }

    /** Keeps only the most recent MAX_RUNS_PER_TEST runs for a test, but always preserves at least one passed run if one exists. */
    private static function pruneRuns(\PDO $pdo, int $testId): void
    {
        $stmt = $pdo->prepare('SELECT id, status FROM test_runs WHERE test_id = ? ORDER BY created_at DESC, id DESC');
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
        $delete = $pdo->prepare("DELETE FROM test_runs WHERE test_id = ? AND id NOT IN ($placeholders)");
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
