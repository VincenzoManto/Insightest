<?php

declare(strict_types=1);

spl_autoload_register(function (string $class): void {
    if (!str_starts_with($class, 'App\\')) {
        return;
    }
    $relative = substr($class, strlen('App\\'));
    $path = __DIR__ . '/../src/' . str_replace('\\', '/', $relative) . '.php';
    if (file_exists($path)) {
        require $path;
    }
});

use App\Config;
use App\Controllers\ApiKeyController;
use App\Controllers\AuthController;
use App\Controllers\FolderController;
use App\Controllers\InvitationController;
use App\Controllers\OrgController;
use App\Controllers\ProjectController;
use App\Controllers\RunController;
use App\Controllers\TestController;
use App\Middleware\ApiKeyMiddleware;
use App\Middleware\AuthMiddleware;
use App\Middleware\AuthOrApiKeyMiddleware;
use App\Request;
use App\Response;
use App\Router;

error_reporting(E_ALL);
ini_set('display_errors', '0'); // never leak stack traces to clients

set_exception_handler(function (\Throwable $e): void {
    error_log($e->getMessage() . "\n" . $e->getTraceAsString());
    Response::error('Internal server error', 500);
});

Config::assertProductionSecrets();

$config = Config::get();
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin && in_array($origin, $config['cors_allowed_origins'], true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Api-Key');
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
}
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$auth = new AuthMiddleware();
$apiKey = new ApiKeyMiddleware();
$authOrApiKey = new AuthOrApiKeyMiddleware($auth, $apiKey);

$router = new Router();

// Routes are relative to wherever this backend/ folder is deployed (Request strips
// the deploy-folder prefix), so no leading "/api" segment here — the deploy path
// itself (e.g. https://example.com/app/api) already plays that role.
$router->post('/auth/register', [AuthController::class, 'register']);
$router->post('/auth/login', [AuthController::class, 'login']);

$router->get('/orgs', [OrgController::class, 'index'], [$auth]);
$router->post('/orgs', [OrgController::class, 'create'], [$auth]);
$router->put('/orgs/{orgId}', [OrgController::class, 'update'], [$auth]);
$router->delete('/orgs/{orgId}', [OrgController::class, 'delete'], [$auth]);
$router->get('/orgs/{orgId}/members', [OrgController::class, 'members'], [$auth]);
$router->delete('/orgs/{orgId}/members/{userId}', [OrgController::class, 'removeMember'], [$auth]);

// Invitations (org- or project-scoped, addressed by email; the invitee accepts/declines in the app).
$router->get('/invitations', [InvitationController::class, 'mine'], [$auth]);
$router->post('/invitations/{id}/accept', [InvitationController::class, 'accept'], [$auth]);
$router->post('/invitations/{id}/decline', [InvitationController::class, 'decline'], [$auth]);
$router->delete('/invitations/{id}', [InvitationController::class, 'revoke'], [$auth]);
$router->get('/orgs/{orgId}/invitations', [InvitationController::class, 'listForOrg'], [$auth]);
$router->post('/orgs/{orgId}/invitations', [InvitationController::class, 'createForOrg'], [$auth]);
$router->get('/projects/{projectId}/invitations', [InvitationController::class, 'listForProject'], [$auth]);
$router->post('/projects/{projectId}/invitations', [InvitationController::class, 'createForProject'], [$auth]);

$router->get('/orgs/{orgId}/projects', [ProjectController::class, 'index'], [$auth]);
$router->post('/orgs/{orgId}/projects', [ProjectController::class, 'create'], [$auth]);
$router->get('/projects/shared', [ProjectController::class, 'shared'], [$auth]);
$router->get('/projects/{projectId}', [ProjectController::class, 'show'], [$auth]);
$router->get('/projects/{projectId}/members', [ProjectController::class, 'members'], [$auth]);
$router->delete('/projects/{projectId}/members/{userId}', [ProjectController::class, 'removeMember'], [$auth]);
$router->put('/projects/{projectId}', [ProjectController::class, 'update'], [$auth]);
$router->delete('/projects/{projectId}', [ProjectController::class, 'delete'], [$auth]);

$router->get('/projects/{projectId}/tests', [TestController::class, 'index'], [$auth]);
$router->post('/projects/{projectId}/tests', [TestController::class, 'create'], [$auth]);
$router->get('/projects/{projectId}/stats', [TestController::class, 'projectStats'], [$auth]);
$router->get('/projects/{projectId}/folders', [FolderController::class, 'index'], [$auth]);
$router->post('/projects/{projectId}/folders', [FolderController::class, 'create'], [$auth]);
$router->put('/folders/{folderId}', [FolderController::class, 'update'], [$auth]);
$router->delete('/folders/{folderId}', [FolderController::class, 'delete'], [$auth]);
$router->get('/tests/{testId}', [TestController::class, 'show'], [$auth]);
$router->put('/tests/{testId}', [TestController::class, 'update'], [$auth]);
$router->delete('/tests/{testId}', [TestController::class, 'delete'], [$auth]);

$router->get('/tests/{testId}/runs', [RunController::class, 'index'], [$authOrApiKey]);
$router->post('/tests/{testId}/runs', [RunController::class, 'create'], [$authOrApiKey]);
$router->get('/tests/{testId}/runs/{runId}', [RunController::class, 'show'], [$authOrApiKey]);
$router->put('/tests/{testId}/runs/{runId}', [RunController::class, 'updateHealing'], [$authOrApiKey]);

$router->get('/orgs/{orgId}/api-keys', [ApiKeyController::class, 'index'], [$auth]);
$router->post('/orgs/{orgId}/api-keys', [ApiKeyController::class, 'create'], [$auth]);
$router->delete('/api-keys/{id}', [ApiKeyController::class, 'revoke'], [$auth]);

// CI runner (Azure Pipelines) fetches its deterministic suite via API key only.
$router->get('/ci/tests', [TestController::class, 'listForCi'], [$apiKey]);

$request = Request::fromGlobals();
$router->dispatch($request);
