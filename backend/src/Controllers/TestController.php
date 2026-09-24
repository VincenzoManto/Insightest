<?php

namespace App\Controllers;

use App\Authz;
use App\Database;
use App\HttpException;
use App\Request;
use App\Response;
use App\Validator;

final class TestController
{
    private const MAX_CODE_LENGTH = 200_000;

    public static function index(Request $req): void
    {
        $projectId = (int) $req->params['projectId'];
        Authz::requireProjectRole($projectId, $req->user['id']);

        $stmt = Database::pdo()->prepare(
            'SELECT t.id, t.project_id, t.folder_id, t.name, t.description, t.prompt, t.tags, t.notes, t.include_in_ci, t.depends_on_test_id, t.created_at, t.updated_at,
                (SELECT status FROM test_runs r WHERE r.test_id = t.id ORDER BY r.created_at DESC LIMIT 1) AS last_status,
                (SELECT triggered_by FROM test_runs r WHERE r.test_id = t.id ORDER BY r.created_at DESC LIMIT 1) AS last_triggered_by,
                (SELECT status FROM test_runs r WHERE r.test_id = t.id AND r.triggered_by = \'desktop\' ORDER BY r.created_at DESC LIMIT 1) AS last_local_status,
                (SELECT SUBSTR(log, -4000) FROM test_runs r WHERE r.test_id = t.id ORDER BY r.created_at DESC LIMIT 1) AS last_log,
                (SELECT COUNT(*) FROM test_runs r WHERE r.test_id = t.id) AS runs_total,
                (SELECT COUNT(*) FROM test_runs r WHERE r.test_id = t.id AND r.status = \'passed\') AS runs_passed,
                (SELECT COUNT(*) FROM test_runs r WHERE r.test_id = t.id AND r.status IN (\'failed\', \'error\')) AS runs_failed
             FROM tests t WHERE t.project_id = ? ORDER BY t.created_at DESC'
        );
        $stmt->execute([$projectId]);
        $tests = $stmt->fetchAll();
        foreach ($tests as &$test) {
            $test['tags'] = $test['tags'] ? json_decode($test['tags'], true) : [];
            $test['include_in_ci'] = (bool) $test['include_in_ci'];
            $test['folder_id'] = $test['folder_id'] !== null ? (int) $test['folder_id'] : null;
            $test['depends_on_test_id'] = $test['depends_on_test_id'] !== null ? (int) $test['depends_on_test_id'] : null;
        }
        Response::json(['tests' => $tests]);
    }

    /** Aggregate run statistics across every test in a project, for the project-level dashboard. */
    public static function projectStats(Request $req): void
    {
        $projectId = (int) $req->params['projectId'];
        Authz::requireProjectRole($projectId, $req->user['id']);

        $pdo = Database::pdo();

        $byStatus = $pdo->prepare(
            'SELECT r.status, COUNT(*) AS count FROM test_runs r
             JOIN tests t ON t.id = r.test_id
             WHERE t.project_id = ? GROUP BY r.status'
        );
        $byStatus->execute([$projectId]);

        $byTrigger = $pdo->prepare(
            'SELECT r.triggered_by, COUNT(*) AS count FROM test_runs r
             JOIN tests t ON t.id = r.test_id
             WHERE t.project_id = ? GROUP BY r.triggered_by'
        );
        $byTrigger->execute([$projectId]);

        $testsCount = $pdo->prepare('SELECT COUNT(*) AS count FROM tests WHERE project_id = ?');
        $testsCount->execute([$projectId]);

        $runsCount = $pdo->prepare(
            'SELECT COUNT(*) AS count FROM test_runs r JOIN tests t ON t.id = r.test_id WHERE t.project_id = ?'
        );
        $runsCount->execute([$projectId]);

        Response::json([
            'tests_count' => (int) $testsCount->fetch()['count'],
            'runs_count' => (int) $runsCount->fetch()['count'],
            'by_status' => $byStatus->fetchAll(),
            'by_trigger' => $byTrigger->fetchAll(),
        ]);
    }

    public static function create(Request $req): void
    {
        $projectId = (int) $req->params['projectId'];
        Authz::requireProjectRole($projectId, $req->user['id'], ['owner', 'admin', 'member']);

        Validator::required($req->body, ['name', 'playwright_code']);
        $code = (string) $req->body['playwright_code'];
        if (strlen($code) > self::MAX_CODE_LENGTH) {
            throw new HttpException('Test code too large', 413);
        }

        $folderId = isset($req->body['folder_id']) && $req->body['folder_id'] !== null ? (int) $req->body['folder_id'] : null;
        $dependsOnTestId = isset($req->body['depends_on_test_id']) && $req->body['depends_on_test_id'] !== null
            ? (int) $req->body['depends_on_test_id']
            : null;

        $pdo = Database::pdo();
        $now = Database::now();
        $pdo->prepare(
            'INSERT INTO tests (project_id, folder_id, name, description, prompt, playwright_code, steps_json, tags, notes, include_in_ci, depends_on_test_id, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            $projectId,
            $folderId,
            $req->body['name'],
            $req->body['description'] ?? null,
            $req->body['prompt'] ?? null,
            $code,
            isset($req->body['steps']) ? json_encode($req->body['steps']) : null,
            isset($req->body['tags']) ? json_encode(array_values((array) $req->body['tags'])) : null,
            $req->body['notes'] ?? null,
            array_key_exists('include_in_ci', $req->body) && !$req->body['include_in_ci'] ? 0 : 1,
            $dependsOnTestId,
            $req->user['id'],
            $now,
            $now,
        ]);

        Response::json(['id' => (int) $pdo->lastInsertId()], 201);
    }

    public static function show(Request $req): void
    {
        $testId = (int) $req->params['testId'];
        Authz::requireTestRole($testId, $req->user['id']);

        $stmt = Database::pdo()->prepare('SELECT * FROM tests WHERE id = ?');
        $stmt->execute([$testId]);
        $test = $stmt->fetch();
        if (!$test) {
            throw new HttpException('Test not found', 404);
        }
        $test['tags'] = $test['tags'] ? json_decode($test['tags'], true) : [];
        $test['include_in_ci'] = (bool) $test['include_in_ci'];
        $test['folder_id'] = $test['folder_id'] !== null ? (int) $test['folder_id'] : null;
        $test['depends_on_test_id'] = $test['depends_on_test_id'] !== null ? (int) $test['depends_on_test_id'] : null;
        Response::json($test);
    }

    public static function update(Request $req): void
    {
        $testId = (int) $req->params['testId'];
        Authz::requireTestRole($testId, $req->user['id'], ['owner', 'admin', 'member']);

        $pdo = Database::pdo();

        // Only gate the opt-IN transition (excluded -> included): a test already included
        // that later fails a run stays included, so CI/CD coverage never silently shrinks.
        if (array_key_exists('include_in_ci', $req->body) && $req->body['include_in_ci']) {
            $current = $pdo->prepare('SELECT include_in_ci FROM tests WHERE id = ?');
            $current->execute([$testId]);
            $currentTest = $current->fetch();
            if (!$currentTest) {
                throw new HttpException('Test not found', 404);
            }
            if (!$currentTest['include_in_ci']) {
                $lastLocal = $pdo->prepare(
                    "SELECT status FROM test_runs WHERE test_id = ? AND triggered_by = 'desktop' ORDER BY created_at DESC LIMIT 1"
                );
                $lastLocal->execute([$testId]);
                $lastLocalRow = $lastLocal->fetch();
                if (!$lastLocalRow || $lastLocalRow['status'] !== 'passed') {
                    throw new HttpException(
                        "Per includere un test in CI/CD l'ultima esecuzione locale deve essere superata (verde)",
                        422
                    );
                }
            }
        }

        $fields = [];
        $values = [];
        foreach (['name', 'description', 'prompt', 'playwright_code', 'notes'] as $key) {
            if (array_key_exists($key, $req->body)) {
                $fields[] = "$key = ?";
                $values[] = $req->body[$key];
            }
        }
        if (array_key_exists('steps', $req->body)) {
            $fields[] = 'steps_json = ?';
            $values[] = $req->body['steps'] !== null ? json_encode($req->body['steps']) : null;
        }
        if (isset($req->body['tags'])) {
            $fields[] = 'tags = ?';
            $values[] = json_encode(array_values((array) $req->body['tags']));
        }
        if (array_key_exists('include_in_ci', $req->body)) {
            $fields[] = 'include_in_ci = ?';
            $values[] = $req->body['include_in_ci'] ? 1 : 0;
        }
        if (array_key_exists('folder_id', $req->body)) {
            $fields[] = 'folder_id = ?';
            $values[] = $req->body['folder_id'] !== null ? (int) $req->body['folder_id'] : null;
        }
        if (array_key_exists('depends_on_test_id', $req->body)) {
            $fields[] = 'depends_on_test_id = ?';
            $values[] = $req->body['depends_on_test_id'] !== null ? (int) $req->body['depends_on_test_id'] : null;
        }
        if (!$fields) {
            throw new HttpException('No fields to update', 422);
        }
        $fields[] = 'updated_at = ?';
        $values[] = Database::now();
        $values[] = $testId;

        $pdo->prepare('UPDATE tests SET ' . implode(', ', $fields) . ' WHERE id = ?')->execute($values);
        Response::json(['ok' => true]);
    }

    public static function delete(Request $req): void
    {
        $testId = (int) $req->params['testId'];
        Authz::requireTestRole($testId, $req->user['id'], ['owner', 'admin']);

        Database::pdo()->prepare('DELETE FROM tests WHERE id = ?')->execute([$testId]);
        Response::json(['ok' => true]);
    }

    /** Used by the CI runner (API key auth) to fetch the deterministic test suite for its organization; tests opted out of CI/CD via the control panel are excluded.
     * depends_on_test_id and last_ci_status let the runner support --runfailed (rerun only tests whose last CI run failed, plus their prerequisite chain). */
    public static function listForCi(Request $req): void
    {
        $orgId = (int) $req->apiKey['org_id'];
        $stmt = Database::pdo()->prepare(
            'SELECT t.id, t.name, t.playwright_code, t.steps_json, t.depends_on_test_id,
                (SELECT status FROM test_runs r WHERE r.test_id = t.id AND r.triggered_by = \'ci\' ORDER BY r.created_at DESC LIMIT 1) AS last_ci_status
             FROM tests t
             JOIN projects p ON p.id = t.project_id
             WHERE p.org_id = ? AND t.include_in_ci = 1'
        );
        $stmt->execute([$orgId]);
        $tests = $stmt->fetchAll();
        foreach ($tests as &$test) {
            $test['depends_on_test_id'] = $test['depends_on_test_id'] !== null ? (int) $test['depends_on_test_id'] : null;
        }
        Response::json(['tests' => $tests]);
    }
}
