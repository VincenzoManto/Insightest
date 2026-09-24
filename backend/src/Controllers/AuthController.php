<?php

namespace App\Controllers;

use App\Auth\JwtService;
use App\Config;
use App\Database;
use App\HttpException;
use App\Request;
use App\Response;
use App\Validator;

final class AuthController
{
    /** Registers a user and creates a brand-new organization with them as owner. */
    public static function register(Request $req): void
    {
        Validator::required($req->body, ['email', 'password', 'name', 'org_name']);
        $email = trim(strtolower($req->body['email']));
        $password = (string) $req->body['password'];
        $name = trim((string) $req->body['name']);
        $orgName = trim((string) $req->body['org_name']);

        if (!Validator::email($email)) {
            throw new HttpException('Invalid email', 422);
        }
        if (strlen($password) < 10) {
            throw new HttpException('Password must be at least 10 characters', 422);
        }

        $pdo = Database::pdo();
        $existing = $pdo->prepare('SELECT id FROM users WHERE email = ?');
        $existing->execute([$email]);
        if ($existing->fetch()) {
            throw new HttpException('Email already registered', 409);
        }

        $hash = password_hash($password, PASSWORD_DEFAULT);

        $pdo->beginTransaction();
        try {
            $pdo->prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)')
                ->execute([$email, $hash, $name]);
            $userId = (int) $pdo->lastInsertId();

            $pdo->prepare('INSERT INTO organizations (name) VALUES (?)')->execute([$orgName]);
            $orgId = (int) $pdo->lastInsertId();

            $pdo->prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)')
                ->execute([$orgId, $userId, 'owner']);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        self::respondWithToken($userId, $email, $name);
    }

    public static function login(Request $req): void
    {
        Validator::required($req->body, ['email', 'password']);
        $email = trim(strtolower($req->body['email']));
        $password = (string) $req->body['password'];
        $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';

        $config = Config::get();
        $pdo = Database::pdo();

        $window = Database::now();
        $windowStart = gmdate('Y-m-d\TH:i:s.v\Z', time() - $config['login_attempts_window_seconds']);
        $countStmt = $pdo->prepare(
            'SELECT COUNT(*) AS c FROM login_attempts WHERE email = ? AND success = 0 AND created_at > ?'
        );
        $countStmt->execute([$email, $windowStart]);
        if ((int) $countStmt->fetch()['c'] >= $config['max_login_attempts']) {
            throw new HttpException('Too many failed login attempts, try again later', 429);
        }

        $stmt = $pdo->prepare('SELECT * FROM users WHERE email = ?');
        $stmt->execute([$email]);
        $user = $stmt->fetch();

        $ok = $user && password_verify($password, $user['password_hash']);
        $pdo->prepare('INSERT INTO login_attempts (email, ip, success) VALUES (?, ?, ?)')
            ->execute([$email, $ip, $ok ? 1 : 0]);

        if (!$ok) {
            throw new HttpException('Invalid credentials', 401);
        }

        self::respondWithToken((int) $user['id'], $user['email'], $user['name']);
    }

    private static function respondWithToken(int $userId, string $email, string $name): void
    {
        $config = Config::get();
        $jwt = new JwtService($config['jwt_secret'], $config['jwt_ttl_seconds']);
        $token = $jwt->issue(['sub' => $userId]);

        Response::json([
            'token' => $token,
            'user' => ['id' => $userId, 'email' => $email, 'name' => $name],
        ], 200);
    }
}
