<?php

namespace App;

final class Response
{
    /** @return void (always exits; PHP 8.0-compatible, no `never` return type) */
    public static function json(mixed $data, int $status = 200)
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }

    /** @return void (always exits via json()) */
    public static function error(string $message, int $status = 400, array $extra = [])
    {
        self::json(['error' => $message] + $extra, $status);
    }
}
