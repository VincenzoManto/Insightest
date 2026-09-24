# Insightest CI bootstrap for Windows agents.
# This file is meant to be downloaded fresh on every pipeline run (not checked into your
# repo), so updates to the runner ship automatically. Get the one-liner to paste into your
# pipeline from the Insightest app (API keys screen).
#
# Usage:   iwr <baseUrl>/ci-runner/run.ps1 -OutFile run.ps1; ./run.ps1 --key <API_KEY>
# Optional flags: --url <base-url> (self-hosted only) --timeout <ms> --resilient
#                 --betweenActionMs <ms> --output <path> --navTimeout <ms> --runfailed
$ErrorActionPreference = "Stop"

# Matches wherever this script itself is hosted; only self-hosted deployments need --url.
$DefaultBaseUrl = "https://www.insightest.app/app/api"

$baseUrl = $DefaultBaseUrl
$passArgs = New-Object System.Collections.Generic.List[string]
$originalDir = (Get-Location).Path

for ($i = 0; $i -lt $args.Count; $i++) {
    if ($args[$i] -eq '--url') {
        $baseUrl = $args[$i + 1]
        $i++
    } elseif ($args[$i] -eq '--output') {
        $out = $args[$i + 1]
        if (-not [System.IO.Path]::IsPathRooted($out)) {
            $out = Join-Path $originalDir $out
        }
        $passArgs.Add('--output')
        $passArgs.Add($out)
        $i++
    } else {
        $passArgs.Add($args[$i])
    }
}

$workDir = Join-Path $env:TEMP ("insightest-ci-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $workDir | Out-Null

try {
    Set-Location $workDir
    foreach ($file in @('runner.js', 'playwright.config.js', 'liveReporter.js', 'package.json')) {
        Invoke-WebRequest -Uri "$baseUrl/ci-runner/$file" -OutFile $file
    }

    npm install --no-audit --no-fund
    npx playwright install --with-deps chromium

    node runner.js --url $baseUrl @passArgs
    $exitCode = $LASTEXITCODE
} finally {
    Set-Location $originalDir
    Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
}

exit $exitCode
