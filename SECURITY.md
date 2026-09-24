# Security policy

Please do not open public issues for security vulnerabilities. Report them privately using GitHub's "Report a vulnerability" feature (Security tab) on this repository.

When self-hosting the backend:

- Set unique random values for `jwt_secret` and `api_key_secret` (or `APP_JWT_SECRET` / `APP_API_KEY_SECRET`); the server refuses placeholder secrets in production.
- Do not deploy `backend/public/debug.php` or `health.php` to public environments.
- Restrict `APP_CORS_ORIGINS` to the origins you actually use.
