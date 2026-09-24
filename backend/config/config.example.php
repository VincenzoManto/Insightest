<?php
// Copy to config.php and fill in real secrets. config.php must never be committed.
declare(strict_types=1);

return [
    // Absolute path outside webroot recommended; on shared hosting keep it under a
    // non-public sibling directory of "public/".
    'db_path' => getenv('APP_DB_PATH') ?: __DIR__ . '/../data/app.sqlite',

    // Generate with: php -r "echo bin2hex(random_bytes(32));"
    'jwt_secret' => getenv('APP_JWT_SECRET') ?: 'CHANGE_ME_TO_A_RANDOM_64_CHAR_HEX_SECRET',
    'jwt_ttl_seconds' => 3600 * 8,

    // Used as HMAC key when hashing API keys (separate from JWT secret).
    'api_key_secret' => getenv('APP_API_KEY_SECRET') ?: 'CHANGE_ME_TO_A_DIFFERENT_RANDOM_SECRET',

    // Comma-separated list of allowed origins for CORS (desktop app uses a custom
    // scheme / no browser origin, so this mainly matters for a future web UI).
    'cors_allowed_origins' => array_filter(explode(',', getenv('APP_CORS_ORIGINS') ?: '')),

    'max_login_attempts' => 10,
    'login_attempts_window_seconds' => 900,
];
