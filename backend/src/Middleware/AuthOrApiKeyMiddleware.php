<?php

namespace App\Middleware;

use App\HttpException;
use App\Request;

/** Accepts either a user JWT or a CI API key, for endpoints shared by desktop app and CI runner. */
final class AuthOrApiKeyMiddleware
{
    public function __construct(private AuthMiddleware $auth, private ApiKeyMiddleware $apiKey)
    {
    }

    public function __invoke(Request $req): void
    {
        if ($req->bearerToken()) {
            ($this->auth)($req);
            return;
        }
        if ($req->header('x-api-key')) {
            ($this->apiKey)($req);
            return;
        }
        throw new HttpException('Authentication required', 401);
    }
}
