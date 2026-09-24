<?php

namespace App\Auth;

/** Minimal dependency-free HS256 JWT signer/verifier (no external composer packages needed on shared hosting). */
final class JwtService
{
    public function __construct(private string $secret, private int $ttlSeconds)
    {
    }

    public function issue(array $claims): string
    {
        $header = ['alg' => 'HS256', 'typ' => 'JWT'];
        $now = time();
        $payload = $claims + ['iat' => $now, 'exp' => $now + $this->ttlSeconds];

        $segments = [
            self::b64(json_encode($header)),
            self::b64(json_encode($payload)),
        ];
        $signingInput = implode('.', $segments);
        $signature = hash_hmac('sha256', $signingInput, $this->secret, true);
        $segments[] = self::b64($signature);

        return implode('.', $segments);
    }

    /** Returns the decoded payload, or null if the token is invalid/expired. */
    public function verify(string $token): ?array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            return null;
        }
        [$headerB64, $payloadB64, $sigB64] = $parts;

        $expectedSig = hash_hmac('sha256', $headerB64 . '.' . $payloadB64, $this->secret, true);
        $actualSig = self::b64Decode($sigB64);
        if ($actualSig === false || !hash_equals($expectedSig, $actualSig)) {
            return null;
        }

        $payload = json_decode(self::b64Decode($payloadB64) ?: '', true);
        if (!is_array($payload)) {
            return null;
        }
        if (isset($payload['exp']) && time() >= (int) $payload['exp']) {
            return null;
        }
        return $payload;
    }

    private static function b64(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    private static function b64Decode(string $data): string|false
    {
        $padded = str_pad(strtr($data, '-_', '+/'), strlen($data) % 4 === 0 ? strlen($data) : strlen($data) + (4 - strlen($data) % 4), '=');
        return base64_decode($padded, true);
    }
}
