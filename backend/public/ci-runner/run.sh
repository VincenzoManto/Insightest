#!/usr/bin/env bash
# Insightest CI bootstrap for Linux/macOS agents.
# This file is meant to be downloaded fresh on every pipeline run (not checked into your
# repo), so updates to the runner ship automatically. Get the one-liner to paste into your
# pipeline from the Insightest app (API keys screen).
#
# Usage:   curl -fsSL <baseUrl>/ci-runner/run.sh -o run.sh && chmod +x run.sh && ./run.sh --key <API_KEY>
# Optional flags: --url <base-url> (self-hosted only) --timeout <ms> --resilient
#                 --betweenActionMs <ms> --output <path> --navTimeout <ms> --runfailed
set -euo pipefail

# Matches wherever this script itself is hosted; only self-hosted deployments need --url.
DEFAULT_BASE_URL="https://www.insightest.app/app/api"
BASE_URL="$DEFAULT_BASE_URL"
ORIGINAL_DIR="$(pwd)"
PASS_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      BASE_URL="$2"
      shift 2
      ;;
    --output)
      out="$2"
      if [[ "$out" != /* ]]; then
        out="$ORIGINAL_DIR/$out"
      fi
      PASS_ARGS+=(--output "$out")
      shift 2
      ;;
    *)
      PASS_ARGS+=("$1")
      shift
      ;;
  esac
done

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
cd "$WORK_DIR"

for f in runner.js playwright.config.js liveReporter.js package.json; do
  curl -fsSL "$BASE_URL/ci-runner/$f" -o "$f"
done

npm install --no-audit --no-fund
npx playwright install --with-deps chromium

node runner.js --url "$BASE_URL" "${PASS_ARGS[@]}"
