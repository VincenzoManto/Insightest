<?php
// Temporary diagnostic endpoint (no secrets exposed) — safe to delete after debugging deployment issues.
header('Content-Type: application/json; charset=utf-8');
echo json_encode([
    'php_version' => PHP_VERSION,
    'pdo_sqlite' => extension_loaded('pdo_sqlite'),
    'sqlite3' => extension_loaded('sqlite3'),
]);
