<?php

namespace App;

final class Router
{
    /** @var array<int, array{method:string, pattern:string, regex:string, params:array, handler:callable, middleware:array}> */
    private array $routes = [];

    public function add(string $method, string $pattern, callable $handler, array $middleware = []): void
    {
        $paramNames = [];
        $regex = preg_replace_callback('/\{(\w+)\}/', function ($m) use (&$paramNames) {
            $paramNames[] = $m[1];
            return '(?P<' . $m[1] . '>[^/]+)';
        }, $pattern);

        $this->routes[] = [
            'method' => $method,
            'regex' => '#^' . $regex . '$#',
            'params' => $paramNames,
            'handler' => $handler,
            'middleware' => $middleware,
        ];
    }

    public function get(string $pattern, callable $handler, array $middleware = []): void
    {
        $this->add('GET', $pattern, $handler, $middleware);
    }

    public function post(string $pattern, callable $handler, array $middleware = []): void
    {
        $this->add('POST', $pattern, $handler, $middleware);
    }

    public function put(string $pattern, callable $handler, array $middleware = []): void
    {
        $this->add('PUT', $pattern, $handler, $middleware);
    }

    public function delete(string $pattern, callable $handler, array $middleware = []): void
    {
        $this->add('DELETE', $pattern, $handler, $middleware);
    }

    public function dispatch(Request $req): void
    {
        $matchedPath = false;
        foreach ($this->routes as $route) {
            if (!preg_match($route['regex'], $req->path, $matches)) {
                continue;
            }
            $matchedPath = true;
            if ($route['method'] !== $req->method) {
                continue;
            }

            foreach ($route['params'] as $name) {
                $req->params[$name] = $matches[$name];
            }

            try {
                foreach ($route['middleware'] as $middleware) {
                    $middleware($req);
                }
                ($route['handler'])($req);
            } catch (ValidationException $e) {
                Response::error('Validation failed', 422, ['fields' => $e->errors]);
            } catch (HttpException $e) {
                Response::error($e->getMessage(), $e->status);
            }
            return;
        }

        Response::error($matchedPath ? 'Method not allowed' : 'Not found', $matchedPath ? 405 : 404);
    }
}
