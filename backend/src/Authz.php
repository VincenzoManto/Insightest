<?php

namespace App;

/** Centralized org/project/test membership + role checks (avoids ad-hoc SQL scattered in controllers). */
final class Authz
{
    public static function requireOrgRole(int $orgId, int $userId, array $roles = ['owner', 'admin', 'member']): array
    {
        $stmt = Database::pdo()->prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?');
        $stmt->execute([$orgId, $userId]);
        $member = $stmt->fetch();
        if (!$member || !in_array($member['role'], $roles, true)) {
            throw new HttpException('Forbidden', 403);
        }
        return $member;
    }

    /**
     * Effective role on a project: the user's organization role if they belong to the org,
     * otherwise their direct project role (admin|member) if they were invited to just this project.
     * "owner"/"admin" are the administrator roles allowed to delete/manage a project.
     */
    public static function requireProjectRole(int $projectId, int $userId, array $roles = ['owner', 'admin', 'member']): string
    {
        $role = self::projectRole($projectId, $userId);
        if ($role === null || !in_array($role, $roles, true)) {
            throw new HttpException('Forbidden', 403);
        }
        return $role;
    }

    public static function requireTestRole(int $testId, int $userId, array $roles = ['owner', 'admin', 'member']): string
    {
        $stmt = Database::pdo()->prepare('SELECT project_id FROM tests WHERE id = ?');
        $stmt->execute([$testId]);
        $row = $stmt->fetch();
        if (!$row) {
            throw new HttpException('Test not found', 404);
        }
        return self::requireProjectRole((int) $row['project_id'], $userId, $roles);
    }

    public static function projectRole(int $projectId, int $userId): ?string
    {
        $pdo = Database::pdo();
        $stmt = $pdo->prepare(
            'SELECT m.role FROM projects p JOIN org_members m ON m.org_id = p.org_id AND m.user_id = ? WHERE p.id = ?'
        );
        $stmt->execute([$userId, $projectId]);
        $row = $stmt->fetch();
        if ($row) {
            return $row['role'];
        }
        $stmt = $pdo->prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?');
        $stmt->execute([$projectId, $userId]);
        $row = $stmt->fetch();
        if ($row) {
            return $row['role'];
        }
        // Distinguish "project doesn't exist" from "no access".
        $exists = $pdo->prepare('SELECT 1 FROM projects WHERE id = ?');
        $exists->execute([$projectId]);
        if (!$exists->fetch()) {
            throw new HttpException('Project not found', 404);
        }
        return null;
    }

    public static function orgIdForProject(int $projectId): int
    {
        $stmt = Database::pdo()->prepare('SELECT org_id FROM projects WHERE id = ?');
        $stmt->execute([$projectId]);
        $row = $stmt->fetch();
        if (!$row) {
            throw new HttpException('Project not found', 404);
        }
        return (int) $row['org_id'];
    }

    public static function orgIdForTest(int $testId): int
    {
        $stmt = Database::pdo()->prepare(
            'SELECT p.org_id AS org_id FROM tests t JOIN projects p ON p.id = t.project_id WHERE t.id = ?'
        );
        $stmt->execute([$testId]);
        $row = $stmt->fetch();
        if (!$row) {
            throw new HttpException('Test not found', 404);
        }
        return (int) $row['org_id'];
    }
}
