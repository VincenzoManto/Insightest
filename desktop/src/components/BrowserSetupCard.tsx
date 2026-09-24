import React, { useEffect, useRef, useState } from 'react';
import { Download, Globe } from 'lucide-react';
import { t } from '../i18n';
import { isDesktop } from '../web-bridge';

/** Optional one-click install of the Chromium build Playwright needs to run tests locally.
 * Purely informational when it is already installed. */
export function BrowserSetupCard(): React.ReactElement | null {
  if (!isDesktop) return null;
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  async function refresh(): Promise<void> {
    try {
      setInstalled(await window.insightest.playwright.browserStatus());
    } catch {
      setInstalled(null);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  async function install(): Promise<void> {
    setInstalling(true);
    setError(null);
    setLines([]);
    const unsubscribe = window.insightest.playwright.onProgress((line) => setLines((prev) => [...prev, line]));
    try {
      const result = await window.insightest.playwright.installBrowser();
      if (!result.ok) setError(result.output.trim().split('\n').slice(-3).join('\n') || t('Unknown error'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    } finally {
      unsubscribe();
      setInstalling(false);
      await refresh();
    }
  }

  return (
    <div className="card">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink-primary">
        <Globe size={14} /> {t('Playwright browser')}
      </div>
      <p className="text-xs text-ink-secondary">
        {installed === null && t('Checking the Playwright browser…')}
        {installed === true && t('Chromium is installed: tests can run on this machine.')}
        {installed === false && t('Chromium is not installed. It is needed to run tests locally; installing is optional if you only want to browse.')}
      </p>
      {installed === false && (
        <button className="secondary !mt-2 !text-xs" onClick={install} disabled={installing}>
          <Download size={13} /> {installing ? t('Installing…') : t('Install Chromium')}
        </button>
      )}
      {error && <div className="error-banner mb-0 mt-2 whitespace-pre-wrap text-xs">{error}</div>}
      {lines.length > 0 && (
        <div ref={logRef} className="codeblock mt-2 max-h-32">
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
