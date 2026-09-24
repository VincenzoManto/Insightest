<?php

namespace App\Controllers;

use App\Auth\ApiKeyService;
use App\Authz;
use App\Config;
use App\Database;
use App\HttpException;
use App\Request;
use App\Response;
use App\Validator;

final class ApiKeyController
{
    public static function index(Request $req): void
    {
        $orgId = (int) $req->params['orgId'];
        Authz::requireOrgRole($orgId, $req->user['id'], ['owner', 'admin']);

        $stmt = Database::pdo()->prepare(
            'SELECT id, name, key_prefix, expires_at, revoked_at, last_used_at, created_at
             FROM api_keys WHERE org_id = ? ORDER BY created_at DESC'
        );
        $stmt->execute([$orgId]);
        Response::json(['api_keys' => $stmt->fetchAll()]);
    }

    /** Returns the raw key exactly once; only key_prefix + key_hash are persisted. */
    public static function create(Request $req): void
    {
        $orgId = (int) $req->params['orgId'];
        Authz::requireOrgRole($orgId, $req->user['id'], ['owner', 'admin']);

        Validator::required($req->body, ['name']);

        $service = new ApiKeyService(Config::get()['api_key_secret']);
        [$rawKey, $prefix, $hash] = $service->generate();

        $pdo = Database::pdo();
        $pdo->prepare(
            'INSERT INTO api_keys (org_id, name, key_prefix, key_hash, created_by, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)'
        )->execute([
            $orgId,
            $req->body['name'],
            $prefix,
            $hash,
            $req->user['id'],
            $req->body['expires_at'] ?? null,
        ]);

        Response::json([
            'id' => (int) $pdo->lastInsertId(),
            'api_key' => $rawKey,
            'warning' => 'Store this key now, it will not be shown again.',
        ], 201);
    }

    public static function revoke(Request $req): void
    {
        $id = (int) $req->params['id'];
        $pdo = Database::pdo();

        $stmt = $pdo->prepare('SELECT org_id FROM api_keys WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        if (!$row) {
            throw new HttpException('API key not found', 404);
        }
        Authz::requireOrgRole((int) $row['org_id'], $req->user['id'], ['owner', 'admin']);

        $pdo->prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?')->execute([Database::now(), $id]);
        Response::json(['ok' => true]);
    }
}
