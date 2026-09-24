<?php

namespace App\Controllers;

use App\Authz;
use App\Database;
use App\HttpException;
use App\Request;
use App\Response;
use App\Validator;

final class OrgController
{
    public static function index(Request $req): void
    {
        $stmt = Database::pdo()->prepare(
            'SELECT o.id, o.name, m.role FROM organizations o
             JOIN org_members m ON m.org_id = o.id
             WHERE m.user_id = ?'
        );
        $stmt->execute([$req->user['id']]);
        Response::json(['organizations' => $stmt->fetchAll()]);
    }

    public static function create(Request $req): void
    {
        Validator::required($req->body, ['name']);
        $pdo = Database::pdo();

        $pdo->beginTransaction();
        try {
            $pdo->prepare('INSERT INTO organizations (name) VALUES (?)')->execute([$req->body['name']]);
            $orgId = (int) $pdo->lastInsertId();
            $pdo->prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)')
                ->execute([$orgId, $req->user['id'], 'owner']);
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Response::json(['id' => $orgId, 'name' => $req->body['name'], 'role' => 'owner'], 201);
    }

    public static function update(Request $req): void
    {
        $orgId = (int) $req->params['orgId'];
        Authz::requireOrgRole($orgId, $req->user['id'], ['owner', 'admin']);

        Validator::required($req->body, ['name']);
        Database::pdo()->prepare('UPDATE organizations SET name = ? WHERE id = ?')
            ->execute([$req->body['name'], $orgId]);

        Response::json(['ok' => true]);
    }

    public static function delete(Request $req): void
    {
        $orgId = (int) $req->params['orgId'];
        Authz::requireOrgRole($orgId, $req->user['id'], ['owner']);

        Database::pdo()->prepare('DELETE FROM organizations WHERE id = ?')->execute([$orgId]);
        Response::json(['ok' => true]);
    }

    public static function members(Request $req): void
    {
        $orgId = (int) $req->params['orgId'];
        Authz::requireOrgRole($orgId, $req->user['id']);

        $stmt = Database::pdo()->prepare(
            'SELECT u.id, u.email, u.name, m.role FROM org_members m
             JOIN users u ON u.id = m.user_id
             WHERE m.org_id = ?'
        );
        $stmt->execute([$orgId]);
        Response::json(['members' => $stmt->fetchAll()]);
    }

    public static function addMember(Request $req): void
    {
        $orgId = (int) $req->params['orgId'];
        Authz::requireOrgRole($orgId, $req->user['id'], ['owner', 'admin']);

        Validator::required($req->body, ['email', 'role']);
        $role = $req->body['role'];
        if (!Validator::oneOf($role, ['owner', 'admin', 'member'])) {
            throw new HttpException('Invalid role', 422);
        }

        $pdo = Database::pdo();
        $userStmt = $pdo->prepare('SELECT id FROM users WHERE email = ?');
        $userStmt->execute([trim(strtolower($req->body['email']))]);
        $user = $userStmt->fetch();
        if (!$user) {
            throw new HttpException('No user with that email is registered yet', 404);
        }

        $pdo->prepare(
            'INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)
             ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role'
        )->execute([$orgId, $user['id'], $role]);

        Response::json(['ok' => true], 201);
    }

    /** Removes a member (or lets a member leave). The last owner can never be removed. */
    public static function removeMember(Request $req): void
    {
        $orgId = (int) $req->params['orgId'];
        $userId = (int) $req->params['userId'];
        $isSelf = $userId === (int) $req->user['id'];
        Authz::requireOrgRole($orgId, $req->user['id'], $isSelf ? ['owner', 'admin', 'member'] : ['owner', 'admin']);

        $pdo = Database::pdo();
        $target = $pdo->prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?');
        $target->execute([$orgId, $userId]);
        $row = $target->fetch();
        if (!$row) {
            throw new HttpException('Member not found', 404);
        }
        if ($row['role'] === 'owner') {
            $owners = $pdo->prepare("SELECT COUNT(*) FROM org_members WHERE org_id = ? AND role = 'owner'");
            $owners->execute([$orgId]);
            if ((int) $owners->fetchColumn() <= 1) {
                throw new HttpException('The last owner cannot be removed', 409);
            }
            if (!$isSelf) {
                Authz::requireOrgRole($orgId, $req->user['id'], ['owner']);
            }
        }
        $pdo->prepare('DELETE FROM org_members WHERE org_id = ? AND user_id = ?')->execute([$orgId, $userId]);
        Response::json(['ok' => true]);
    }
}
