<?php

namespace App\Middleware;

use App\Auth\ApiKeyService;
use App\Config;
use App\Database;
use App\HttpException;
use App\Request;

/** Requires a valid "X-Api-Key: <key>" header, used by the CI runner script (Azure Pipelines). */
final class ApiKeyMiddleware
{
    public function __invoke(Request $req): void
    {
        $raw = $req->header('x-api-key');
        if (!$raw || strlen($raw) < 16) {
            throw new HttpException('Missing or malformed API key', 401);
        }

        $prefix = substr($raw, 0, 8);
        $pdo = Database::pdo();
        $stmt = $pdo->prepare('SELECT * FROM api_keys WHERE key_prefix = ?');
        $stmt->execute([$prefix]);
        $row = $stmt->fetch();

        $service = new ApiKeyService(Config::get()['api_key_secret']);
        if (!$row || !$service->matches($raw, $row['key_hash'])) {
            throw new HttpException('Invalid API key', 401);
        }
        if ($row['revoked_at']) {
            throw new HttpException('API key revoked', 401);
        }
        if ($row['expires_at'] && $row['expires_at'] < Database::now()) {
            throw new HttpException('API key expired', 401);
        }

        $update = $pdo->prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?');
        $update->execute([Database::now(), $row['id']]);

        $req->apiKey = $row;
    }
}
