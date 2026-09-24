@echo off
REM Insightest CI bootstrap for cmd/bat pipeline steps on Windows.
REM Downloads a fresh run.ps1 (which does the real work: fetch runner.js, install deps,
REM execute) and delegates to it, so pipeline behavior always tracks the current backend.
REM
REM Usage:   curl -fsSL <baseUrl>/ci-runner/run.cmd -o run.cmd ^&^& run.cmd --key <API_KEY>
REM Optional flags: --url <base-url> (self-hosted only) --timeout <ms> --resilient
REM                 --betweenActionMs <ms> --output <path> --navTimeout <ms> --runfailed
setlocal

set "DEFAULT_BASE_URL=https://www.insightest.app/app/api"
set "BASE_URL=%DEFAULT_BASE_URL%"

REM Scan args for an explicit --url override, without consuming/reordering the rest.
setlocal enabledelayedexpansion
set "FOUND_URL=%BASE_URL%"
set "PREV="
for %%A in (%*) do (
  if /I "!PREV!"=="--url" set "FOUND_URL=%%~A"
  set "PREV=%%~A"
)
endlocal & set "BASE_URL=%FOUND_URL%"

set "BOOTSTRAP=%TEMP%\insightest-run-%RANDOM%.ps1"
curl -fsSL "%BASE_URL%/ci-runner/run.ps1" -o "%BOOTSTRAP%" || exit /b 1

powershell -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP%" %*
set "EXIT_CODE=%ERRORLEVEL%"
del /f /q "%BOOTSTRAP%" >nul 2>&1
exit /b %EXIT_CODE%
