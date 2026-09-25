<?php
// CLI migration runner: php db/migrate.php
declare(strict_types=1);

$config = require __DIR__ . '/../config/config.php';
$dbPath = $config['db_path'];

$dir = dirname($dbPath);
if (!is_dir($dir)) {
    mkdir($dir, 0700, true);
}

$pdo = new PDO('sqlite:' . $dbPath);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

$schema = file_get_contents(__DIR__ . '/schema.sql');
$pdo->exec($schema);

// CREATE TABLE IF NOT EXISTS above only helps brand-new databases; retrofit columns
// added to schema.sql after the table already existed on a prior deploy.
foreach ([
    ['tests', 'tags', 'TEXT'],
    ['tests', 'notes', 'TEXT'],
    ['tests', 'folder_id', 'INTEGER'],
    ['tests', 'include_in_ci', 'INTEGER NOT NULL DEFAULT 1'],
    ['tests', 'depends_on_test_id', 'INTEGER'],
    ['projects', 'base_url', 'TEXT'],
    ['projects', 'repo_path', 'TEXT'],
    ['projects', 'selector_priority', 'TEXT'],
] as [$table, $column, $definition]) {
    $existing = array_column($pdo->query('PRAGMA table_info(' . $table . ')')->fetchAll(), 'name');
    if (!in_array($column, $existing, true)) {
        $pdo->exec("ALTER TABLE {$table} ADD COLUMN {$column} {$definition}");
    }
}

@chmod($dbPath, 0600);

echo "Migration completed: {$dbPath}\n";
