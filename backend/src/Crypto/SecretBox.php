<?php

namespace App\Crypto;

use App\Config;

/** Reversible AES-256-GCM encryption for secrets stored at rest (e.g. projects.db_connection_string).
 * Unlike JwtService/ApiKeyService (one-way HMAC), this is for values the app must read back in plaintext. */
final class SecretBox
{
    private const CIPHER = 'aes-256-gcm';
    private const IV_LENGTH = 12;
    private const TAG_LENGTH = 16;

    private static function key(): string
    {
        // hash() derives a 32-byte binary key regardless of the raw config secret's length/encoding.
        return hash('sha256', (string) Config::get()['db_secret_key'], true);
    }

    public static function encrypt(string $plaintext): string
    {
        $iv = random_bytes(self::IV_LENGTH);
        $tag = '';
        $ciphertext = openssl_encrypt($plaintext, self::CIPHER, self::key(), OPENSSL_RAW_DATA, $iv, $tag, '', self::TAG_LENGTH);
        if ($ciphertext === false) {
            throw new \RuntimeException('SecretBox: encryption failed');
        }
        return base64_encode($iv . $tag . $ciphertext);
    }

    /** Null-safe: returns null for a project with no secret configured. */
    public static function decrypt(?string $stored): ?string
    {
        if ($stored === null || $stored === '') {
            return null;
        }
        $raw = base64_decode($stored, true);
        if ($raw === false || strlen($raw) < self::IV_LENGTH + self::TAG_LENGTH) {
            throw new \RuntimeException('SecretBox: malformed ciphertext');
        }
        $iv = substr($raw, 0, self::IV_LENGTH);
        $tag = substr($raw, self::IV_LENGTH, self::TAG_LENGTH);
        $ciphertext = substr($raw, self::IV_LENGTH + self::TAG_LENGTH);
        $plaintext = openssl_decrypt($ciphertext, self::CIPHER, self::key(), OPENSSL_RAW_DATA, $iv, $tag);
        if ($plaintext === false) {
            throw new \RuntimeException('SecretBox: decryption failed (wrong key or corrupted data)');
        }
        return $plaintext;
    }
}
