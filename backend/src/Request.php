<?php

namespace App;

final class Request
{
    public string $method;
    public string $path;
    public array $query;
    public array $body;
    public array $headers;
    public array $params = [];

    /** Set by AuthMiddleware/ApiKeyMiddleware after successful authentication. */
    public ?array $user = null;
    public ?array $apiKey = null;

    public static function fromGlobals(): self
    {
        $req = new self();
        $req->method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

        $uri = $_SERVER['REQUEST_URI'] ?? '/';
        $path = parse_url($uri, PHP_URL_PATH) ?: '/';
        $path = self::stripBasePath($path);
        $req->path = rtrim($path, '/') ?: '/';

        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $req->query = $query;

        $req->headers = self::readHeaders();

        $raw = file_get_contents('php://input') ?: '';
        // Some hosting WAFs strip raw `"` characters from POST bodies, corrupting JSON;
        // clients that hit this work around it by base64-encoding the body.
        if (strtolower($req->headers['x-body-encoding'] ?? '') === 'base64') {
            $decodedRaw = base64_decode($raw, true);
            if ($decodedRaw !== false) {
                $raw = $decodedRaw;
            }
        }
        $decoded = [];
        if ($raw !== '' && str_contains($req->headers['content-type'] ?? '', 'application/json')) {
            $decoded = json_decode($raw, true);
            if (!is_array($decoded)) {
                $decoded = [];
            }
        }
        $req->body = $decoded;

        return $req;
    }

    /**
     * Deployments may live in a subfolder (e.g. https://example.com/app/api on shared hosting).
     * Routes are registered as "/api/...", so strip the folder containing public/index.php
     * (derived from SCRIPT_NAME, not user input) from the incoming request path.
     */
    private static function stripBasePath(string $path): string
    {
        $scriptName = $_SERVER['SCRIPT_NAME'] ?? '';
        // SCRIPT_NAME is typically ".../<deployFolder>/public/index.php" -> take two dirname() calls.
        $basePath = rtrim(dirname(dirname($scriptName)), '/');
        if ($basePath !== '' && $basePath !== '.' && str_starts_with($path, $basePath)) {
            $path = substr($path, strlen($basePath));
        }
        return $path === '' ? '/' : $path;
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    public function bearerToken(): ?string
    {
        $auth = $this->header('authorization');
        if ($auth && preg_match('/^Bearer\s+(.+)$/i', $auth, $m)) {
            return $m[1];
        }
        return null;
    }

    private static function readHeaders(): array
    {
        $headers = [];
        if (function_exists('getallheaders')) {
            foreach (getallheaders() as $key => $value) {
                $headers[strtolower($key)] = $value;
            }
            return $headers;
        }
        foreach ($_SERVER as $key => $value) {
            if (str_starts_with($key, 'HTTP_')) {
                $name = str_replace('_', '-', strtolower(substr($key, 5)));
                $headers[$name] = $value;
            }
        }
        if (isset($_SERVER['CONTENT_TYPE'])) {
            $headers['content-type'] = $_SERVER['CONTENT_TYPE'];
        }
        // Some SAPIs only expose the Authorization header via these fallbacks.
        if (!isset($headers['authorization'])) {
            $auth = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? $_SERVER['HTTP_AUTHORIZATION'] ?? null;
            if ($auth) {
                $headers['authorization'] = $auth;
            }
        }
        return $headers;
    }
}
