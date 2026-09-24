import React, { useEffect, useState } from 'react';
import { ArrowLeft, Check, Copy } from 'lucide-react';
import { useAuth } from '../state/AuthContext';
import { Brand } from '../components/Brand';
import { formatDateTime, t } from '../i18n';
import type { ApiKey, Organization } from '../types';
import type { McpSetupResult } from '../electron-bridge';

function CommandRow({
  label,
  command,
  copied,
  onCopy,
}: {
  label: string;
  command: string;
  copied: boolean;
  onCopy: () => void;
}): React.ReactElement {
  return (
    <div className="mt-3 min-w-0">
      <div className="eyebrow mb-1">{label}</div>
      <div className="flex items-start gap-2">
        <pre className="codeblock m-0 min-w-0 flex-1 break-all">{command}</pre>
        <button className="secondary" onClick={onCopy}>
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? t('Copied!') : t('Copy')}
        </button>
      </div>
    </div>
  );
}

export function ApiKeysScreen({ org, onBack }: { org: Organization; onBack: () => void }): React.ReactElement {
  const { api, apiBaseUrl, token } = useAuth();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newName, setNewName] = useState('');
  const [justCreatedKey, setJustCreatedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpResult, setMcpResult] = useState<McpSetupResult | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const res = await api.get<{ api_keys: ApiKey[] }>(`/orgs/${org.id}/api-keys`);
      setKeys(res.api_keys);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org.id]);

  async function createKey(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!newName.trim()) return;
    setError(null);
    try {
      const res = await api.post<{ id: number; api_key: string }>(`/orgs/${org.id}/api-keys`, { name: newName });
      setJustCreatedKey(res.api_key);
      setNewName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    }
  }

  async function revokeKey(key: ApiKey): Promise<void> {
    if (!window.confirm(t('Revoke key "{name}"? It will no longer be usable.', { name: key.name }))) return;
    setError(null);
    try {
      await api.delete(`/api-keys/${key.id}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    }
  }

  if (loading) return <div className="content text-ink-muted">{t('Loading API keys…')}</div>;

  const apiKeyPlaceholder = justCreatedKey ?? '<API_KEY>';
  const psCommand = `iwr ${apiBaseUrl}/ci-runner/run.ps1 -OutFile run.ps1; ./run.ps1 --key ${apiKeyPlaceholder}`;
  const shCommand = `curl -fsSL ${apiBaseUrl}/ci-runner/run.sh -o run.sh && chmod +x run.sh && ./run.sh --key ${apiKeyPlaceholder}`;

  async function copyCommand(label: string, command: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCommand(label);
      setTimeout(() => setCopiedCommand((prev) => (prev === label ? null : prev)), 2000);
    } catch {
      setError(t('Could not copy to clipboard'));
    }
  }

  async function setupMcp(): Promise<void> {
    setMcpError(null);
    setMcpResult(null);
    if (!token) {
      setMcpError(t('No active session: please sign in again.'));
      return;
    }
    setMcpBusy(true);
    try {
      setMcpResult(await window.insightest.mcp.setup(apiBaseUrl, token));
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : t('Unknown error'));
    } finally {
      setMcpBusy(false);
    }
  }

  return (
    <div className="h-screen overflow-auto">
      <div className="screen-narrow !max-w-[760px]">
        <div className="mb-8 flex items-center justify-between">
          <Brand />
          <button className="ghost" onClick={onBack}>
            <ArrowLeft size={15} /> {t('Back')}
          </button>
        </div>
        <div className="screen-header">
          <h1 className="screen-title min-w-0 truncate">{t('API keys — {org}', { org: org.name })}</h1>
        </div>
        {error && <div className="error-banner">{error}</div>}
        {justCreatedKey && (
          <div className="card !border-warning/50 !bg-warning/10">
            <strong className="text-sm">{t('New key created — copy it now, it will not be shown again:')}</strong>
            <pre className="codeblock my-3 break-all">{justCreatedKey}</pre>
            <button onClick={() => setJustCreatedKey(null)}>{t('I copied the key')}</button>
          </div>
        )}
        <div className="card">
          <div className="card-title">{t('CI/CD commands')}</div>
          <p className="mt-1 text-[13px] text-ink-muted">
            {t(
              'Paste one of these commands into your pipeline: they always download and run the latest runner. No base URL to configure, just the API key.'
            )}
          </p>
          <CommandRow label={t('PowerShell (Windows)')} command={psCommand} copied={copiedCommand === 'ps'} onCopy={() => copyCommand('ps', psCommand)} />
          <CommandRow label={t('Bash (Linux/macOS)')} command={shCommand} copied={copiedCommand === 'sh'} onCopy={() => copyCommand('sh', shCommand)} />
        </div>
        <div className="card">
          <div className="card-title">{t('AI agents (MCP)')}</div>
          <p className="mb-3 mt-1 text-[13px] text-ink-muted">
            {t(
              'One click connects Claude Code to Insightest (projects, tests, runs, repairs) through the Model Context Protocol. It uses a copy of the current session: it expires together with your login (usually after a few hours), so click again when needed.'
            )}
          </p>
          {mcpError && <div className="error-banner">{mcpError}</div>}
          <button onClick={setupMcp} disabled={mcpBusy}>
            {mcpBusy ? t('Setting up…') : t('Set up Claude Code')}
          </button>
          {mcpResult?.ok && (
            <p className="mt-3 text-[13px] text-good">
              {t('Done: the "insightest" MCP server is registered in Claude Code. Run this again after signing in anew if it stops working.')}
            </p>
          )}
          {mcpResult && !mcpResult.ok && (
            <div className="error-banner mt-3">
              {mcpResult.message === 'claude-not-found'
                ? t('Claude Code not found: install the `claude` CLI and make sure it is on the app PATH.')
                : mcpResult.message || t('Unknown error')}
            </div>
          )}
        </div>

        {keys.map((key) => (
          <div key={key.id} className="list-row">
            <div className="min-w-0">
              <div className="truncate font-semibold text-ink-primary">
                {key.name} <span className="font-mono text-xs font-normal text-ink-muted">{key.key_prefix}…</span>
              </div>
              <div className="text-xs text-ink-muted">
                {key.revoked_at
                  ? t('Revoked on {date}', { date: formatDateTime(key.revoked_at) })
                  : key.last_used_at
                    ? t('Last used: {date}', { date: formatDateTime(key.last_used_at) })
                    : t('Never used')}
              </div>
            </div>
            {!key.revoked_at && (
              <button className="danger" onClick={() => revokeKey(key)}>
                {t('Revoke')}
              </button>
            )}
          </div>
        ))}
        <form onSubmit={createKey} className="mt-5 flex gap-2">
          <input placeholder={t('Key name (e.g. Azure Pipelines)')} value={newName} onChange={(e) => setNewName(e.target.value)} className="min-w-0 flex-1" />
          <button type="submit" disabled={!newName.trim()}>
            {t('Generate')}
          </button>
        </form>
      </div>
    </div>
  );
}
