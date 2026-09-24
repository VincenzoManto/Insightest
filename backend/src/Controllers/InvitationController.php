<?php

namespace App\Controllers;

use App\Authz;
use App\Database;
use App\HttpException;
use App\Request;
use App\Response;
use App\Validator;

/**
 * Invitations to an organization or a single project, addressed by email. The invitee sees them
 * (pending) as soon as they sign in with that email and can accept or decline; nothing is granted
 * until then.
 */
final class InvitationController
{
    private const INVITE_ROLES = ['admin', 'member'];

    /** Pending invitations addressed to the signed-in user's email. */
    public static function mine(Request $req): void
    {
        $stmt = Database::pdo()->prepare(
            'SELECT i.id, i.type, i.role, i.created_at, i.org_id, i.project_id,
                    o.name AS org_name, p.name AS project_name,
                    u.name AS inviter_name, u.email AS inviter_email
             FROM invitations i
             JOIN organizations o ON o.id = i.org_id
             LEFT JOIN projects p ON p.id = i.project_id
             LEFT JOIN users u ON u.id = i.invited_by
             WHERE i.email = ? AND i.status = \'pending\'
             ORDER BY i.id DESC'
        );
        $stmt->execute([strtolower($req->user['email'])]);
        Response::json(['invitations' => $stmt->fetchAll()]);
    }

    public static function listForOrg(Request $req): void
    {
        $orgId = (int) $req->params['orgId'];
        Authz::requireOrgRole($orgId, $req->user['id'], ['owner', 'admin']);
        Response::json(['invitations' => self::pendingFor('org', $orgId)]);
    }

    public static function listForProject(Request $req): void
    {
        $projectId = (int) $req->params['projectId'];
        Authz::requireProjectRole($projectId, $req->user['id'], ['owner', 'admin']);
        Response::json(['invitations' => self::pendingFor('project', $projectId)]);
    }

    public static function createForOrg(Request $req): void
    {
        $orgId = (int) $req->params['orgId'];
        Authz::requireOrgRole($orgId, $req->user['id'], ['owner', 'admin']);
        [$email, $role] = self::validatedInput($req);

        $pdo = Database::pdo();
        $member = $pdo->prepare('SELECT 1 FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ?');
        $member->execute([$orgId, $email]);
        if ($member->fetch()) {
            throw new HttpException('That user is already a member of this organization', 409);
        }

        self::insert('org', $orgId, null, $email, $role, (int) $req->user['id']);
    }

    public static function createForProject(Request $req): void
    {
        $projectId = (int) $req->params['projectId'];
        Authz::requireProjectRole($projectId, $req->user['id'], ['owner', 'admin']);
        [$email, $role] = self::validatedInput($req);
        $orgId = Authz::orgIdForProject($projectId);

        $pdo = Database::pdo();
        $user = $pdo->prepare('SELECT id FROM users WHERE email = ?');
        $user->execute([$email]);
        $existing = $user->fetch();
        if ($existing && Authz::projectRole($projectId, (int) $existing['id']) !== null) {
            throw new HttpException('That user already has access to this project', 409);
        }

        self::insert('project', $orgId, $projectId, $email, $role, (int) $req->user['id']);
    }

    public static function revoke(Request $req): void
    {
        $invitation = self::load((int) $req->params['id']);
        if ($invitation['type'] === 'org') {
            Authz::requireOrgRole((int) $invitation['org_id'], $req->user['id'], ['owner', 'admin']);
        } else {
            Authz::requireProjectRole((int) $invitation['project_id'], $req->user['id'], ['owner', 'admin']);
        }
        if ($invitation['status'] !== 'pending') {
            throw new HttpException('Invitation is no longer pending', 409);
        }
        self::close((int) $invitation['id'], 'revoked');
        Response::json(['ok' => true]);
    }

    public static function accept(Request $req): void
    {
        $invitation = self::loadOwnPending($req);
        $pdo = Database::pdo();
        $userId = (int) $req->user['id'];

        $pdo->beginTransaction();
        try {
            if ($invitation['type'] === 'org') {
                $pdo->prepare('INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)')
                    ->execute([(int) $invitation['org_id'], $userId, $invitation['role']]);
            } elseif (Authz::projectRole((int) $invitation['project_id'], $userId) === null) {
                $pdo->prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)')
                    ->execute([(int) $invitation['project_id'], $userId, $invitation['role']]);
            }
            self::close((int) $invitation['id'], 'accepted');
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Response::json(['ok' => true, 'type' => $invitation['type'], 'org_id' => (int) $invitation['org_id'], 'project_id' => $invitation['project_id'] !== null ? (int) $invitation['project_id'] : null]);
    }

    public static function decline(Request $req): void
    {
        $invitation = self::loadOwnPending($req);
        self::close((int) $invitation['id'], 'declined');
        Response::json(['ok' => true]);
    }

    /** @return array{0: string, 1: string} normalized email and validated role */
    private static function validatedInput(Request $req): array
    {
        Validator::required($req->body, ['email', 'role']);
        $email = trim(strtolower((string) $req->body['email']));
        if (!Validator::email($email)) {
            throw new HttpException('Invalid email', 422);
        }
        if ($email === strtolower($req->user['email'])) {
            throw new HttpException('You cannot invite yourself', 422);
        }
        $role = $req->body['role'];
        if (!Validator::oneOf($role, self::INVITE_ROLES)) {
            throw new HttpException('Invalid role', 422);
        }
        return [$email, $role];
    }

    private static function insert(string $type, int $orgId, ?int $projectId, string $email, string $role, int $invitedBy): void
    {
        $pdo = Database::pdo();
        $dup = $pdo->prepare(
            'SELECT 1 FROM invitations WHERE type = ? AND org_id = ? AND COALESCE(project_id, 0) = ? AND email = ? AND status = \'pending\''
        );
        $dup->execute([$type, $orgId, $projectId ?? 0, $email]);
        if ($dup->fetch()) {
            throw new HttpException('An invitation for that email is already pending', 409);
        }
        $pdo->prepare('INSERT INTO invitations (type, org_id, project_id, email, role, invited_by) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([$type, $orgId, $projectId, $email, $role, $invitedBy]);
        Response::json(['id' => (int) $pdo->lastInsertId(), 'email' => $email, 'role' => $role], 201);
    }

    private static function pendingFor(string $type, int $targetId): array
    {
        $column = $type === 'org' ? 'i.org_id' : 'i.project_id';
        $stmt = Database::pdo()->prepare(
            "SELECT i.id, i.email, i.role, i.created_at FROM invitations i
             WHERE i.type = ? AND {$column} = ? AND i.status = 'pending' ORDER BY i.id DESC"
        );
        $stmt->execute([$type, $targetId]);
        return $stmt->fetchAll();
    }

    private static function load(int $id): array
    {
        $stmt = Database::pdo()->prepare('SELECT * FROM invitations WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        if (!$row) {
            throw new HttpException('Invitation not found', 404);
        }
        return $row;
    }

    private static function loadOwnPending(Request $req): array
    {
        $invitation = self::load((int) $req->params['id']);
        // Same 404 for "not yours" as for "doesn't exist" so ids can't be probed.
        if (strtolower($invitation['email']) !== strtolower($req->user['email'])) {
            throw new HttpException('Invitation not found', 404);
        }
        if ($invitation['status'] !== 'pending') {
            throw new HttpException('Invitation is no longer pending', 409);
        }
        return $invitation;
    }

    private static function close(int $id, string $status): void
    {
        Database::pdo()->prepare('UPDATE invitations SET status = ?, responded_at = ? WHERE id = ?')
            ->execute([$status, Database::now(), $id]);
    }
}
