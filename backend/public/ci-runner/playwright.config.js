// Minimal, deterministic Playwright config for CI runs (no retries/AI healing by default).
// timeout/retries/slowMo are optionally overridden per-invocation via runner.js's CLI flags
// (--timeout, --resilient, --betweenActionMs), passed through as env vars below.
//
// NOTE: mirrors ci-runner/playwright.config.js; served statically from backend/public/ci-runner/.
module.exports = {
    // Generated spec files live in their own temp dir, separate from this config's directory
    // (which only holds node_modules); without this, Playwright's default testDir (the config's
    // own directory) would never see them and silently run zero tests.
    testDir: process.env.INSIGHTEST_TEST_DIR,
    timeout: process.env.PW_TIMEOUT ? Number(process.env.PW_TIMEOUT) : 30_000,
    retries: process.env.PW_RETRIES ? Number(process.env.PW_RETRIES) : 0,
    // 'json' feeds runner.js's own per-test reporting to the backend; 'junit' is what
    // Azure DevOps' PublishTestResults@2 task consumes. Both honor the
    // PLAYWRIGHT_JSON_OUTPUT_NAME / PLAYWRIGHT_JUNIT_OUTPUT_NAME env vars for their output path.
    // './liveReporter.js' prints each step/test live to the console as the run happens.
    reporter: [['./liveReporter.js'], ['json'], ['junit']],
    use: {
        headless: true,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        launchOptions: process.env.PW_SLOWMO ? { slowMo: Number(process.env.PW_SLOWMO) } : {},
    },
};
