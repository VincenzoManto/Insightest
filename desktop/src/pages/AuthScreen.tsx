import React, { useState } from 'react';
import { useAuth } from '../state/AuthContext';
import { Brand } from '../components/Brand';
import { t } from '../i18n';

export function AuthScreen(): React.ReactElement {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [apiBaseUrl] = useState('https://www.insightest.app/app/api');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === 'login') {
        await login(apiBaseUrl, email, password);
      } else {
        await register(apiBaseUrl, { email, password, name, org_name: orgName });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="flex min-h-screen items-center justify-center overflow-auto p-6"
      style={{
        background:
          'radial-gradient(900px 500px at 85% -10%, rgba(0,216,111,0.14), transparent 60%), radial-gradient(700px 420px at -5% 105%, rgba(74,58,167,0.08), transparent 55%), #f6f7f5',
      }}
    >
      <div className="w-full max-w-[400px]">
        <div className="mb-7 flex flex-col items-center gap-2 text-center">
          <Brand />
          <p className="text-sm text-ink-muted">{t('Record, manage and re-run end-to-end tests.')}</p>
        </div>
        <form onSubmit={submit} className="card !mb-0 flex flex-col gap-4 !p-6 shadow-card">
          <h2 className="text-lg font-semibold">{mode === 'login' ? t('Sign in to your workspace') : t('Create your account')}</h2>
          {error && <div className="error-banner !mb-0">{error}</div>}
          {mode === 'register' && (
            <>
              <label className="field">
                {t('Name')}
                <input value={name} onChange={(e) => setName(e.target.value)} className="w-full" />
              </label>
              <label className="field">
                {t('Organization name')}
                <input value={orgName} onChange={(e) => setOrgName(e.target.value)} className="w-full" />
              </label>
            </>
          )}
          <label className="field">
            {t('Email')}
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full" autoFocus />
          </label>
          <label className="field">
            {t('Password')}
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full" />
          </label>
          <button type="submit" disabled={loading} className="!py-2.5">
            {mode === 'login' ? t('Sign in') : t('Create account')}
          </button>
          <button type="button" className="ghost" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? t('Create a new account') : t('I already have an account')}
          </button>
        </form>
      </div>
    </div>
  );
}
