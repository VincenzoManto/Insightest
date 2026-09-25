<?php

namespace App;

final class Database
{
    private static ?\PDO $instance = null;

    public static function pdo(): \PDO
    {
        if (self::$instance === null) {
            $config = Config::get();
            $dbPath = $config['db_path'];
            $isNew = !file_exists($dbPath);

            $dir = dirname($dbPath);
            if (!is_dir($dir)) {
                mkdir($dir, 0700, true);
            }

            $pdo = new \PDO('sqlite:' . $dbPath);
            $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            $pdo->setAttribute(\PDO::ATTR_DEFAULT_FETCH_MODE, \PDO::FETCH_ASSOC);
            $pdo->exec('PRAGMA foreign_keys = ON');

            // Self-provisioning: shared hosting often has no shell access to run migrate.php,
            // so create the schema on first request instead. IF NOT EXISTS makes this idempotent.
            $pdo->exec(file_get_contents(__DIR__ . '/../db/schema.sql'));
            if ($isNew) {
                @chmod($dbPath, 0600);
            }

            // CREATE TABLE IF NOT EXISTS above only helps brand-new databases; columns added to
            // schema.sql later still need to be retrofitted onto an already-existing table.
            self::ensureColumn($pdo, 'tests', 'tags', 'TEXT');
            self::ensureColumn($pdo, 'tests', 'notes', 'TEXT');
            self::ensureColumn($pdo, 'tests', 'folder_id', 'INTEGER');
            self::ensureColumn($pdo, 'tests', 'include_in_ci', 'INTEGER NOT NULL DEFAULT 1');
            self::ensureColumn($pdo, 'tests', 'depends_on_test_id', 'INTEGER');
            self::ensureColumn($pdo, 'projects', 'base_url', 'TEXT');
            self::ensureColumn($pdo, 'projects', 'repo_path', 'TEXT');
            self::ensureColumn($pdo, 'projects', 'selector_priority', 'TEXT');

            self::$instance = $pdo;
        }
        return self::$instance;
    }

    /** Adds a column to an existing table if it isn't already there (SQLite has no `ADD COLUMN IF NOT EXISTS`). */
    private static function ensureColumn(\PDO $pdo, string $table, string $column, string $definition): void
    {
        $columns = $pdo->query('PRAGMA table_info(' . $table . ')')->fetchAll();
        foreach ($columns as $col) {
            if ($col['name'] === $column) {
                return;
            }
        }
        $pdo->exec("ALTER TABLE {$table} ADD COLUMN {$column} {$definition}");
    }

    public static function now(): string
    {
        return gmdate('Y-m-d\TH:i:s.v\Z');
    }
}
