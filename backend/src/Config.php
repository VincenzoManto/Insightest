<?php

namespace App;

final class Config
{
    private static ?array $config = null;

    public static function get(): array
    {
        if (self::$config === null) {
            $path = __DIR__ . '/../config/config.php';
            if (!file_exists($path)) {
                // Fall back to the example so the app doesn't hard-crash in dev,
                // but this must never happen in production (secrets differ).
                $path = __DIR__ . '/../config/config.example.php';
            }
            self::$config = require $path;
        }
        return self::$config;
    }

    /** Refuses to boot with the secrets shipped in config.example.php (copy-without-editing footgun). */
    public static function assertProductionSecrets(): void
    {
        $config = self::get();
        $usesPlaceholder = $config['jwt_secret'] === 'CHANGE_ME_TO_A_RANDOM_64_CHAR_HEX_SECRET'
            || $config['api_key_secret'] === 'CHANGE_ME_TO_A_DIFFERENT_RANDOM_SECRET';
        if ($usesPlaceholder) {
            throw new \RuntimeException(
                'config/config.php is missing or still uses placeholder secrets. ' .
                'Copy config/config.example.php to config/config.php and set real random secrets.'
            );
        }
    }
}
