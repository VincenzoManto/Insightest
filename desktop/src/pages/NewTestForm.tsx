import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Hourglass, Save, Video } from 'lucide-react';
import { useAuth } from '../state/AuthContext';
import { t } from '../i18n';
import type { Project, TestSummary } from '../types';
import { AiTestAssistant } from './AiTestAssistant';

const template = (): string => `import { test, expect } from '@playwright/test';

test('${t('describe the test here').replace(/'/g, "\\'")}', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page).toHaveTitle(/Example/);
});
`;

export function NewTestForm({
  project,
  onCancel,
  onCreated,
}: {
  project: Project;
  onCancel: () => void;
  onCreated: () => void;
}): React.ReactElement {
  const { api } = useAuth();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [code, setCode] = useState(template);
  const [steps, setSteps] = useState<unknown[] | null>(null);
  const codeRef = useRef<HTMLTextAreaElement>(null);
  const [waitMs, setWaitMs] = useState(1000);
  const [recordUrl, setRecordUrl] = useState('https://');
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [otherTests, setOtherTests] = useState<TestSummary[]>([]);
  const [dependsOnTestId, setDependsOnTestId] = useState<number | null>(null);

  useEffect(() => {
    api
      .get<{ tests: TestSummary[] }>(`/projects/${project.id}/tests`)
      .then((res) => setOtherTests(res.tests))
      .catch(() => setOtherTests([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  async function record(): Promise<void> {
    setError(null);
    setRecording(true);
    try {
      const recorded = await window.insightest.playwright.record(recordUrl);
      if (recorded) {
        setCode(recorded);
        setSteps(null);
        // Best-effort: replays the just-recorded actions once (headless) to capture N-1
        // alternate selectors per step for the resilient-action engine's fallback; a failure
        // here (app not reachable a second time, etc.) just means the test is saved without
        // fallback selectors, not that recording itself failed.
        try {
          const augmented = await window.insightest.playwright.augment(recorded);
          setSteps(augmented);
        } catch {
          setSteps(null);
        }
      } else {
        setError(t('No actions recorded (browser closed without interacting)'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Error while recording'));
    } finally {
      setRecording(false);
    }
  }

  /** Inserts an explicit wait step at the textarea's cursor (or at the end), for apps that need a moment before reacting. */
  function insertWaitStep(): void {
    const line = `  await page.waitForTimeout(${waitMs});\n`;
    const el = codeRef.current;
    if (!el) {
      setCode((prev) => prev + line);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    setCode((prev) => prev.slice(0, start) + line + prev.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + line.length;
    });
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !code.trim()) {
      setError(t('Name and Playwright code are required'));
      return;
    }
    setSaving(true);
    try {
      await api.post(`/projects/${project.id}/tests`, {
        name,
        description: description || null,
        prompt: prompt || null,
        playwright_code: code,
        steps: steps || undefined,
        depends_on_test_id: dependsOnTestId,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="animate-fade-up mx-auto max-w-[860px]">
      <div className="screen-header">
        <div className="flex items-center gap-3">
          <button type="button" className="secondary icon" onClick={onCancel} title={t('Back')}>
            <ArrowLeft size={16} />
          </button>
          <h1 className="screen-title">{t('New test')}</h1>
        </div>
        <div className="flex gap-2">
          <button type="button" className="secondary" onClick={onCancel}>
            {t('Cancel')}
          </button>
          <button type="submit" disabled={saving}>
            <Save size={15} /> {saving ? t('Saving…') : t('Save test')}
          </button>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="card flex flex-col gap-4">
        <label className="field">
          {t('Test name')}
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full" />
        </label>
        <label className="field">
          {t('Steps description')}
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="w-full" />
        </label>
        <label className="field">
          {t('Descriptive prompt (also used by Jev/browser-use for self-healing)')}
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} className="w-full" />
        </label>
        <label className="field">
          {t('Run first (same session/browser)')}
          <select value={dependsOnTestId ?? ''} onChange={(e) => setDependsOnTestId(e.target.value ? Number(e.target.value) : null)} className="w-full">
            <option value="">{t('(none)')}</option>
            {otherTests.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <AiTestAssistant
          mode="generate"
          project={project}
          onCode={(generated, dependsOn) => {
            setCode(generated);
            setSteps(null);
            const prerequisite = dependsOn ? otherTests.find((o) => o.name === dependsOn) : undefined;
            if (prerequisite) setDependsOnTestId(prerequisite.id);
          }}
        />
        <div className="field">
          {t('Record a test in the browser (Playwright codegen)')}
          <div className="flex gap-2">
            <input value={recordUrl} onChange={(e) => setRecordUrl(e.target.value)} placeholder={t('https://example.com')} className="min-w-0 flex-1" />
            <button type="button" onClick={record} disabled={recording}>
              <Video size={15} /> {recording ? t('Recording… (close the browser to finish)') : t('Record')}
            </button>
          </div>
        </div>
        <div className="field">
          {t('Playwright code')}
          <div className="flex flex-wrap items-center gap-2">
            <Hourglass size={13} className="text-ink-muted" />
            <input
              type="number"
              min={0}
              step={100}
              value={waitMs}
              onChange={(e) => setWaitMs(Math.max(0, Number(e.target.value) || 0))}
              className="!w-20 !py-1 !text-xs"
            />
            <span className="text-xs text-ink-muted">ms</span>
            <button type="button" className="secondary sm" onClick={insertWaitStep}>
              <Hourglass size={13} /> {t('Insert wait step')}
            </button>
            <span className="text-xs font-normal text-ink-muted">{t('(useful when the app does not respond right away)')}</span>
          </div>
          <textarea
            ref={codeRef}
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              // Manual edits invalidate the recorded steps (they're positionally aligned to
              // the action calls the augmentation pass actually saw), so drop them rather
              // than save fallback selectors for actions that may no longer match.
              setSteps(null);
            }}
            rows={16}
            spellCheck={false}
            className="w-full font-mono text-xs"
          />
        </div>
      </div>
    </form>
  );
}
