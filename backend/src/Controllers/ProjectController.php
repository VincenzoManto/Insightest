<?php

namespace App\Controllers;

use App\Authz;
use App\Database;
use App\HttpException;
use App\Request;
use App\Response;
use App\Validator;

final class ProjectController
{
    private const SELECTOR_KEYS = ['xpath', 'generalSelector', 'text', 'id', 'testIdSelector', 'attrSelector'];

    /** Validated `selector_priority` (JSON-encoded ordered list of selector kinds), or null for "use the default". */
    private static function selectorPriority(array $body): ?string
    {
        $value = $body['selector_priority'] ?? null;
        if ($value === null || $value === '' || $value === []) {
            return null;
        }
        if (is_string($value)) {
            $value = json_decode($value, true);
        }
        if (!is_array($value)) {
            throw new HttpException('selector_priority must be an array of selector kinds', 422);
        }
        $value = array_values(array_unique($value));
        foreach ($value as $key) {
            if (!is_string($key) || !in_array($key, self::SELECTOR_KEYS, true)) {
                throw new HttpException('selector_priority: unknown selector kind (allowed: ' . implode(', ', self::SELECTOR_KEYS) . ')', 422);
            }
        }
        return json_encode($value);
    }

    public static function index(Request $req): void
    {
        $orgId = (int) $req->params['orgId'];
        Authz::requireOrgRole($orgId, $req->user['id']);

        $stmt = Database::pdo()->prepare('SELECT * FROM projects WHERE org_id = ? ORDER BY created_at DESC');
        $stmt->execute([$orgId]);
        Response::json(['projects' => $stmt->fetchAll()]);
    }

    public static function create(Request $req): void
    {
        $orgId = (int) $req->params['orgId'];
        Authz::requireOrgRole($orgId, $req->user['id'], ['owner', 'admin']);

        Validator::required($req->body, ['name']);
        $baseUrl = isset($req->body['base_url']) && $req->body['base_url'] !== '' ? (string) $req->body['base_url'] : null;
        $repoPath = isset($req->body['repo_path']) && $req->body['repo_path'] !== '' ? (string) $req->body['repo_path'] : null;
        $selectorPriority = self::selectorPriority($req->body);
        $pdo = Database::pdo();
        $pdo->prepare('INSERT INTO projects (org_id, name, base_url, repo_path, selector_priority) VALUES (?, ?, ?, ?, ?)')->execute([$orgId, $req->body['name'], $baseUrl, $repoPath, $selectorPriority]);

        Response::json(['id' => (int) $pdo->lastInsertId(), 'org_id' => $orgId, 'name' => $req->body['name'], 'base_url' => $baseUrl, 'repo_path' => $repoPath, 'selector_priority' => $selectorPriority], 201);
    }

    public static function show(Request $req): void
    {
        $projectId = (int) $req->params['projectId'];
        Authz::requireProjectRole($projectId, $req->user['id']);

        $stmt = Database::pdo()->prepare('SELECT * FROM projects WHERE id = ?');
        $stmt->execute([$projectId]);
        $project = $stmt->fetch();
        if (!$project) {
            throw new HttpException('Project not found', 404);
        }
        Response::json($project);
    }

    public static function update(Request $req): void
    {
        $projectId = (int) $req->params['projectId'];
        Authz::requireProjectRole($projectId, $req->user['id'], ['owner', 'admin']);

        Validator::required($req->body, ['name']);
        $baseUrl = isset($req->body['base_url']) && $req->body['base_url'] !== '' ? (string) $req->body['base_url'] : null;
        $repoPath = isset($req->body['repo_path']) && $req->body['repo_path'] !== '' ? (string) $req->body['repo_path'] : null;
        $pdo = Database::pdo();
        $pdo->prepare('UPDATE projects SET name = ?, base_url = ?, repo_path = ? WHERE id = ?')
            ->execute([$req->body['name'], $baseUrl, $repoPath, $projectId]);
        // Only touched when the client sends it, so older clients editing a project don't reset the priority.
        if (array_key_exists('selector_priority', $req->body)) {
            $pdo->prepare('UPDATE projects SET selector_priority = ? WHERE id = ?')
                ->execute([self::selectorPriority($req->body), $projectId]);
        }

        Response::json(['ok' => true]);
    }

    public static function delete(Request $req): void
    {
        $projectId = (int) $req->params['projectId'];
        Authz::requireProjectRole($projectId, $req->user['id'], ['owner', 'admin']);

        Database::pdo()->prepare('DELETE FROM projects WHERE id = ?')->execute([$projectId]);
        Response::json(['ok' => true]);
    }

    /** Projects the user can open only through a direct project invitation (no membership in the parent org). */
    public static function shared(Request $req): void
    {
        $stmt = Database::pdo()->prepare(
            'SELECT p.*, o.name AS org_name, pm.role AS role FROM project_members pm
             JOIN projects p ON p.id = pm.project_id
             JOIN organizations o ON o.id = p.org_id
             WHERE pm.user_id = ?
               AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = p.org_id AND m.user_id = pm.user_id)
             ORDER BY p.created_at DESC'
        );
        $stmt->execute([$req->user['id']]);
        Response::json(['projects' => $stmt->fetchAll()]);
    }

    public static function members(Request $req): void
    {
        $projectId = (int) $req->params['projectId'];
        Authz::requireProjectRole($projectId, $req->user['id']);

        $stmt = Database::pdo()->prepare(
            "SELECT u.id, u.email, u.name, pm.role, 'project' AS source FROM project_members pm
             JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ?
             UNION ALL
             SELECT u.id, u.email, u.name, m.role, 'org' AS source FROM projects p
             JOIN org_members m ON m.org_id = p.org_id
             JOIN users u ON u.id = m.user_id WHERE p.id = ?"
        );
        $stmt->execute([$projectId, $projectId]);
        Response::json(['members' => $stmt->fetchAll()]);
    }

    public static function removeMember(Request $req): void
    {
        $projectId = (int) $req->params['projectId'];
        $userId = (int) $req->params['userId'];
        $isSelf = $userId === (int) $req->user['id'];
        if ($isSelf) {
            Authz::requireProjectRole($projectId, $req->user['id']);
        } else {
            Authz::requireProjectRole($projectId, $req->user['id'], ['owner', 'admin']);
        }
        $stmt = Database::pdo()->prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?');
        $stmt->execute([$projectId, $userId]);
        if ($stmt->rowCount() === 0) {
            throw new HttpException('Member not found', 404);
        }
        Response::json(['ok' => true]);
    }
}
