import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, Square } from 'lucide-react';
import type { AiTestStatus } from '../electron-bridge';
import { t } from '../i18n';
import type { Project } from '../types';

/** Lets the user hand a natural-language instruction to Claude Code (which can read the project's
 * repo and drive Playwright) to write a new test or fix an existing one. Rendered only when the
 * `claude` CLI and the Insightest MCP server are both available. The proposed code is returned
 * via `onCode` for the parent to put in its editor -- nothing is saved until the user saves. */
export function AiTestAssistant({
  mode,
  project,
  testName,
  currentCode,
  lastRunLog,
  onCode,
}: {
  mode: 'generate' | 'fix';
  project: Project | null;
  testName?: string;
  currentCode?: string;
  lastRunLog?: string;
  /** `dependsOn` is the exact name of the prerequisite test the code assumes ran first, if any. */
  onCode: (code: string, dependsOn: string | null) => void;
}): React.ReactElement | null {
  const [status, setStatus] = useState<AiTestStatus | null>(null);
  const [instruction, setInstruction] = useState('');
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.insightest.agent.aiStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  const ready = !!status?.claude && !!status.insightestMcp;
  const unavailableReason = !status
    ? t('Checking Claude Code and the MCP server…')
    : !status.claude
      ? t('Claude Code not found: install the `claude` CLI and make sure it is on the app PATH.')
      : !status.insightestMcp
        ? t('The "insightest" MCP server is not registered in Claude Code: generate the command from the "API Keys" screen (AI agents (MCP)), run it, then reopen this screen.')
        : null;

  async function run(): Promise<void> {
    if (!status || !ready) return;
    if (mode === 'generate' && !instruction.trim()) {
      setError(t('Describe the test to generate.'));
      return;
    }
    setRunning(true);
    setError(null);
    setMessage(null);
    setLines([]);
    const unsubscribe = window.insightest.playwright.onProgress((line) => setLines((prev) => [...prev, line]));
    try {
      const result = await window.insightest.agent.aiTest({
        mode,
        instruction,
        testName,
        currentCode: mode === 'fix' ? currentCode : undefined,
        lastRunLog: mode === 'fix' ? lastRunLog : undefined,
        baseUrl: project?.base_url ?? null,
        repoPath: project?.repo_path ?? null,
        projectId: project?.id ?? null,
        playwrightMcp: status.playwrightMcp,
      });
      if (result.cancelled) {
        setMessage(t('Stopped. Nothing was changed.'));
      } else if (result.code) {
        onCode(result.code, result.dependsOn);
        setMessage(t('Proposed code inserted in the editor: review it, run it, then save.'));
      } else {
        setError(t('The agent returned no code (exit {code}). See the log below.', { code: result.exitCode ?? '—' }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Error while running the agent'));
    } finally {
      unsubscribe();
      setRunning(false);
    }
  }

  return (
    <div className="rounded-xl border border-accent-600/30 bg-gradient-to-br from-accent/10 to-transparent p-4">
      <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-ink-primary">
        <Sparkles size={14} className="text-accent-700" /> {mode === 'generate' ? t('Generate the test with Claude') : t('Fix the test with Claude')}
      </div>
      {unavailableReason && <p className="mb-2 text-xs text-critical">{unavailableReason}</p>}
      <p className="mb-2.5 text-xs text-ink-muted">
        {mode === 'generate'
          ? t('Describe what the test should verify: the agent knows the project code')
          : t('Describe what is not working (optional): the agent receives the current code and the last run log')}
        {project?.repo_path ? ` (${project.repo_path})` : t(' (no repo_path set on the project: it will not be able to read the code)')}
        {t(' and uses a real Playwright browser to try the app and verify the test.')}
      </p>
      <textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        rows={3}
        disabled={running || !ready}
        placeholder={
          mode === 'generate'
            ? t('E.g. Log in with a valid user and check that the dashboard appears')
            : t('E.g. The "Sign in" button changed its label, update the selectors')
        }
        className="mb-2 w-full"
      />
      <div className="flex gap-2">
        <button type="button" onClick={run} disabled={running || !ready}>
          <Sparkles size={14} /> {running ? t('Claude is working…') : mode === 'generate' ? t('Generate') : t('Fix')}
        </button>
        {running && (
          <button type="button" className="danger" onClick={() => window.insightest.agent.aiCancel()}>
            <Square size={13} /> {t('Stop')}
          </button>
        )}
      </div>
      {error && <div className="error-banner mb-0 mt-2">{error}</div>}
      {message && <p className="mt-2 text-xs text-good">{message}</p>}
      {lines.length > 0 && <div className="eyebrow mb-1 mt-3">{t('Claude activity')}</div>}
      {lines.length > 0 && (
        <div ref={logRef} className="codeblock mt-2 max-h-48">
          {lines.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
