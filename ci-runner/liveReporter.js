// Minimal Playwright reporter: prints each action/assertion live with a tick as it completes,
// plus a pass/fail summary per test -- real-time CI feedback instead of only a JSON dump at
// the end. It also publishes each test's result to the Insightest API the moment that test
// ends (when runner.js provides INSIGHTEST_REPORT_URL/KEY), so results show up progressively.
// Mirrored at backend/public/ci-runner/liveReporter.js; keep both in sync.
'use strict';

const fs = require('fs');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** Same wire format as runner.js's apiRequest (base64 body survives WAFs that strip `"`). */
async function postRun(baseUrl, apiKey, testId, payload) {
    const encodedBody = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const res = await fetch(`${baseUrl}/tests/${testId}/runs`, {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json', 'X-Body-Encoding': 'base64' },
        body: encodedBody,
    });
    if (!res.ok) throw new Error(`API POST /tests/${testId}/runs failed (${res.status})`);
}

class LiveReporter {
    constructor() {
        this.pending = [];
    }

    // Without this, load/compile errors in the generated spec (e.g. one test with invalid code)
    // are swallowed and the run silently reports zero tests.
    onError(error) {
        console.error(`${RED}[insightest] Playwright error: ${error.message || error}${RESET}`);
        if (error.stack) console.error(error.stack);
    }

    onTestBegin(test) {
        console.log(`\n${DIM}▶ ${test.title}${RESET}`);
    }

    onStepEnd(test, result, step) {
        // 'pw:api' (page.goto/click/...) and 'expect' are the actions/assertions a recorded
        // test is actually made of; 'hook'/'fixture'/etc. are internal plumbing noise.
        if (step.category !== 'pw:api' && step.category !== 'expect') return;
        // Select2 option polling emits dozens of Evaluate/Wait steps per action; hide that noise.
        if (!step.error && (step.title === 'Evaluate' || step.title === 'Wait for timeout')) return;
        const tick = step.error ? `${RED}✗${RESET}` : `${GREEN}✓${RESET}`;
        console.log(`    ${tick} ${step.title}`);
    }

    // The resilient-action engine logs which selector it's trying and whether it's on a retry/
    // fallback via plain console.log/warn inside the test -- Playwright buffers that per-test
    // instead of printing it live, so without this hook none of that ever reaches the terminal.
    onStdOut(chunk, test, result) {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
            if (!line.includes('[insightest]')) continue;
            console.log(`      ${DIM}${line.trim()}${RESET}`);
        }
    }

    onStdErr(chunk, test, result) {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
            if (!line.includes('[insightest]')) continue;
            console.log(`      ${RED}${line.trim()}${RESET}`);
        }
    }

    onTestEnd(test, result) {
        const name = test.title.replace(/\s*\(id \d+\)$/, '');
        const outcome =
            result.status === 'passed' ? `${GREEN}succeeded${RESET}` : result.status === 'skipped' ? `${YELLOW}skipped${RESET}` : `${RED}failed${RESET}`;
        console.log(`[insightest] ${name} ${outcome} ${DIM}(${result.duration}ms)${RESET}`);
        // Say WHY it failed: a test that dies before its first step otherwise shows only "failed".
        if (result.status !== 'passed' && result.status !== 'skipped' && result.error && result.error.message) {
            const reason = String(result.error.message).split('\n').slice(0, 6).map((l) => `      ${l}`).join('\n');
            console.log(`${RED}${reason}${RESET}`);
        }
        this.publish(test, result);
    }

    publish(test, result) {
        const baseUrl = process.env.INSIGHTEST_REPORT_URL;
        const apiKey = process.env.INSIGHTEST_REPORT_KEY;
        const idMatch = /\(id (\d+)\)$/.exec(test.title || '');
        if (!baseUrl || !apiKey || !idMatch) return;
        const testId = Number(idMatch[1]);
        const status = result.status === 'passed' ? 'passed' : result.status === 'skipped' ? 'error' : 'failed';
        const stderr = (result.stderr || []).map((c) => c.toString()).join('');
        const log = [(result.stdout || []).map((c) => c.toString()).join(''), stderr, result.error?.message].filter(Boolean).join('\n');
        this.pending.push(
            postRun(baseUrl, apiKey, testId, { status, duration_ms: result.duration ?? 0, log: log || null })
                .then(() => {
                    // Lets runner.js skip re-posting tests already published live.
                    if (process.env.INSIGHTEST_REPORTED_FILE) fs.appendFileSync(process.env.INSIGHTEST_REPORTED_FILE, `${testId}\n`);
                })
                .catch((e) => console.error(`[insightest] Failed to publish result for test ${testId}: ${e.message}`))
        );
    }

    async onEnd() {
        await Promise.all(this.pending);
    }
}

module.exports = LiveReporter;
