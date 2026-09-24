import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiClient } from '../api/client';
import type { User } from '../types';

interface StoredAuth {
  token: string;
  user: User;
  apiBaseUrl: string;
}

interface AuthContextValue {
  ready: boolean;
  user: User | null;
  apiBaseUrl: string;
  token: string | null;
  api: ApiClient;
  login: (apiBaseUrl: string, email: string, password: string) => Promise<void>;
  register: (apiBaseUrl: string, payload: { email: string; password: string; name: string; org_name: string }) => Promise<void>;
  logout: () => Promise<void>;
}

const DEFAULT_API_BASE_URL = 'https://www.insightest.app/app/api';

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API_BASE_URL);

  useEffect(() => {
    window.insightest.auth.load().then((raw) => {
      if (raw) {
        const stored = JSON.parse(raw) as StoredAuth;
        setToken(stored.token);
        setUser(stored.user);
        setApiBaseUrl(stored.apiBaseUrl);
      }
      setReady(true);
    });
  }, []);

  const api = useMemo(() => new ApiClient(apiBaseUrl, () => token), [apiBaseUrl, token]);

  const persist = useCallback(async (next: StoredAuth) => {
    await window.insightest.auth.save(JSON.stringify(next));
    setToken(next.token);
    setUser(next.user);
    setApiBaseUrl(next.apiBaseUrl);
  }, []);

  const login = useCallback(
    async (baseUrl: string, email: string, password: string) => {
      const client = new ApiClient(baseUrl, () => null);
      const res = await client.post<{ token: string; user: User }>('/auth/login', { email, password });
      await persist({ token: res.token, user: res.user, apiBaseUrl: baseUrl });
    },
    [persist]
  );

  const register = useCallback(
    async (baseUrl: string, payload: { email: string; password: string; name: string; org_name: string }) => {
      const client = new ApiClient(baseUrl, () => null);
      const res = await client.post<{ token: string; user: User }>('/auth/register', payload);
      await persist({ token: res.token, user: res.user, apiBaseUrl: baseUrl });
    },
    [persist]
  );

  const logout = useCallback(async () => {
    await window.insightest.auth.clear();
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ ready, user, apiBaseUrl, token, api, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
