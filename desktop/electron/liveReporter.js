// Minimal Playwright reporter: prints each action/assertion live with a tick as it completes,
// plus a pass/fail summary per test -- same idea as ci-runner/liveReporter.js (mirrored here,
// not required, because desktop runs go through electron/playwrightRunner.js instead of
// ci-runner/runner.js and need the file resolvable from this project's own node_modules).
// Undecorated (no ANSI colors): its stdout is parsed line-by-line and shown in the desktop UI,
// not a terminal.
'use strict';

class LiveReporter {
  onTestBegin(test) {
    console.log(`▶ ${test.title}`);
  }

  onStepBegin(test, result, step) {
    if (step.category !== 'pw:api' && step.category !== 'expect') return;
    console.log(`  … ${step.title}`);
  }

  onStepEnd(test, result, step) {
    if (step.category !== 'pw:api' && step.category !== 'expect') return;
    const tick = step.error ? '✗' : '✓';
    console.log(`  ${tick} ${step.title}${step.error ? ` -- ${step.error.message?.split('\n')[0] ?? ''}` : ''}`);
  }

  // Playwright buffers the test's own console output per test; forward the resilient engine's
  // `[insightest] ...` lines so they land in the run log (used to tell which step a run stopped on).
  onStdOut(chunk) {
    for (const line of chunk.toString().split('\n')) if (line.includes('[insightest]')) console.log(line.trim());
  }

  onStdErr(chunk) {
    for (const line of chunk.toString().split('\n')) if (line.includes('[insightest]')) console.log(line.trim());
  }

  onTestEnd(test, result) {
    const tick = result.status === 'passed' ? '✓' : '✗';
    console.log(`${tick} ${test.title} (${result.duration}ms)`);
  }
}

module.exports = LiveReporter;
