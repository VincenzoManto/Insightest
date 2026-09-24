# Insightest

Open-source, self-healing end-to-end testing built on Playwright. Record tests, run them locally or in CI, and let AI repair broken selectors.

## Components

| Folder | Description |
| --- | --- |
| [desktop/](desktop) | Electron + React desktop app to register, manage and re-run E2E tests. Also ships an MCP server ([desktop/mcp-server](desktop/mcp-server)) for agents such as Claude Code. |
| [backend/](backend) | PHP + SQLite REST API (auth, orgs, projects, tests, runs, API keys). |
| [ci-runner/](ci-runner) | Deterministic Playwright runner for CI pipelines (e.g. Azure Pipelines), authenticated with an API key. |
| [scripts/](scripts) | Utilities, e.g. importing tests from a legacy export. |
| [website/](website) | Static landing page. |

## Getting started

### Backend

Requires PHP 8.1+ with the `pdo_sqlite` extension.

```bash
cd backend
cp config/config.example.php config/config.php
# generate two different random secrets and set them in config.php,
# or export APP_JWT_SECRET and APP_API_KEY_SECRET
php db/migrate.php
php -S localhost:8080 -t public
```

Never commit `config/config.php` or any `.sqlite` file (both are git-ignored).

### Desktop app

Requires Node.js 18+.

```bash
cd desktop
npm install
npm run dev
```

### CI runner

```bash
cd ci-runner
npm install
INSIGHTEST_API_URL=https://your-backend/api INSIGHTEST_API_KEY=... node runner.js --output junit.xml
```

See [ci-runner/azure-pipelines.example.yml](ci-runner/azure-pipelines.example.yml) for a pipeline example.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
