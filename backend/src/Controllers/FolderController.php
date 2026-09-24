<?php

namespace App\Controllers;

use App\Authz;
use App\Database;
use App\HttpException;
use App\Request;
use App\Response;
use App\Validator;

/** CRUD for the test-organization folder tree (project-scoped, arbitrary depth via parent_id). */
final class FolderController
{
    public static function index(Request $req): void
    {
        $projectId = (int) $req->params['projectId'];
        Authz::requireProjectRole($projectId, $req->user['id']);

        $stmt = Database::pdo()->prepare(
            'SELECT id, project_id, parent_id, name, created_at, updated_at FROM folders WHERE project_id = ? ORDER BY name'
        );
        $stmt->execute([$projectId]);
        Response::json(['folders' => $stmt->fetchAll()]);
    }

    public static function create(Request $req): void
    {
        $projectId = (int) $req->params['projectId'];
        Authz::requireProjectRole($projectId, $req->user['id'], ['owner', 'admin', 'member']);

        Validator::required($req->body, ['name']);
        $parentId = self::validatedParentId($req->body['parent_id'] ?? null, $projectId);

        $pdo = Database::pdo();
        $now = Database::now();
        $pdo->prepare(
            'INSERT INTO folders (project_id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        )->execute([$projectId, $parentId, (string) $req->body['name'], $now, $now]);

        Response::json(['id' => (int) $pdo->lastInsertId()], 201);
    }

    public static function update(Request $req): void
    {
        [$folder] = self::loadFolder($req);
        Authz::requireProjectRole((int) $folder['project_id'], $req->user['id'], ['owner', 'admin', 'member']);

        $fields = [];
        $values = [];
        if (array_key_exists('name', $req->body)) {
            $fields[] = 'name = ?';
            $values[] = (string) $req->body['name'];
        }
        if (array_key_exists('parent_id', $req->body)) {
            $parentId = self::validatedParentId($req->body['parent_id'], (int) $folder['project_id'], (int) $folder['id']);
            $fields[] = 'parent_id = ?';
            $values[] = $parentId;
        }
        if (!$fields) {
            throw new HttpException('No fields to update', 422);
        }
        $fields[] = 'updated_at = ?';
        $values[] = Database::now();
        $values[] = (int) $folder['id'];

        Database::pdo()->prepare('UPDATE folders SET ' . implode(', ', $fields) . ' WHERE id = ?')->execute($values);
        Response::json(['ok' => true]);
    }

    /** Deletes a folder; child folders and tests are detached to the root (folder_id/parent_id = NULL), never cascade-deleted. */
    public static function delete(Request $req): void
    {
        [$folder] = self::loadFolder($req);
        Authz::requireProjectRole((int) $folder['project_id'], $req->user['id'], ['owner', 'admin']);

        $pdo = Database::pdo();
        $pdo->prepare('UPDATE folders SET parent_id = NULL WHERE parent_id = ?')->execute([$folder['id']]);
        $pdo->prepare('UPDATE tests SET folder_id = NULL WHERE folder_id = ?')->execute([$folder['id']]);
        $pdo->prepare('DELETE FROM folders WHERE id = ?')->execute([$folder['id']]);
        Response::json(['ok' => true]);
    }

    /** @return array{0: array, 1: int} */
    private static function loadFolder(Request $req): array
    {
        $folderId = (int) $req->params['folderId'];
        $stmt = Database::pdo()->prepare('SELECT * FROM folders WHERE id = ?');
        $stmt->execute([$folderId]);
        $folder = $stmt->fetch();
        if (!$folder) {
            throw new HttpException('Folder not found', 404);
        }
        return [$folder, Authz::orgIdForProject((int) $folder['project_id'])];
    }

    /** Rejects a parent that belongs to a different project, doesn't exist, or would create a cycle. */
    private static function validatedParentId(mixed $parentId, int $projectId, ?int $selfId = null): ?int
    {
        if ($parentId === null || $parentId === '') {
            return null;
        }
        $parentId = (int) $parentId;
        if ($selfId !== null && $parentId === $selfId) {
            throw new HttpException('A folder cannot be its own parent', 422);
        }
        $pdo = Database::pdo();
        $stmt = $pdo->prepare('SELECT id, project_id, parent_id FROM folders WHERE id = ?');
        $stmt->execute([$parentId]);
        $parent = $stmt->fetch();
        if (!$parent || (int) $parent['project_id'] !== $projectId) {
            throw new HttpException('Invalid parent folder', 422);
        }
        if ($selfId !== null) {
            // Walk up from the proposed parent to make sure `selfId` isn't one of its ancestors.
            $cursor = $parent;
            while ($cursor['parent_id'] !== null) {
                if ((int) $cursor['parent_id'] === $selfId) {
                    throw new HttpException('Cannot move a folder inside its own descendant', 422);
                }
                $stmt->execute([(int) $cursor['parent_id']]);
                $cursor = $stmt->fetch();
                if (!$cursor) {
                    break;
                }
            }
        }
        return $parentId;
    }
}
