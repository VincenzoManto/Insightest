<?php

namespace App\Auth;

final class ApiKeyService
{
    public function __construct(private string $secret)
    {
    }

    /** Returns [rawKey, prefix, hash] for storage; rawKey is shown to the user only once. */
    public function generate(): array
    {
        $raw = bin2hex(random_bytes(24)); // 48 hex chars
        $prefix = substr($raw, 0, 8);
        $hash = $this->hash($raw);
        return [$raw, $prefix, $hash];
    }

    public function hash(string $rawKey): string
    {
        return hash_hmac('sha256', $rawKey, $this->secret);
    }

    public function matches(string $rawKey, string $storedHash): bool
    {
        return hash_equals($storedHash, $this->hash($rawKey));
    }
}
