<?php

namespace App\Middleware;

use App\Auth\JwtService;
use App\Config;
use App\Database;
use App\HttpException;
use App\Request;

/** Requires a valid "Authorization: Bearer <jwt>" issued by AuthController::login/register. */
final class AuthMiddleware
{
    public function __invoke(Request $req): void
    {
        $token = $req->bearerToken();
        if (!$token) {
            throw new HttpException('Missing bearer token', 401);
        }

        $config = Config::get();
        $jwt = new JwtService($config['jwt_secret'], $config['jwt_ttl_seconds']);
        $payload = $jwt->verify($token);
        if (!$payload || empty($payload['sub'])) {
            throw new HttpException('Invalid or expired token', 401);
        }

        $stmt = Database::pdo()->prepare('SELECT id, email, name FROM users WHERE id = ?');
        $stmt->execute([$payload['sub']]);
        $user = $stmt->fetch();
        if (!$user) {
            throw new HttpException('User not found', 401);
        }

        $req->user = $user;
    }
}
