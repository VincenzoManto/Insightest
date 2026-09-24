import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { t } from '../i18n';
import type { Invitation } from '../types';

const POLL_MS = 30_000;
const SEEN_KEY = 'insightest.notifiedInvitations';

interface InvitationsContextValue {
  invitations: Invitation[];
  refresh: () => Promise<void>;
  accept: (invitation: Invitation) => Promise<void>;
  decline: (invitation: Invitation) => Promise<void>;
  /** Whether the invitations screen is showing (the shell renders it in place of the current screen). */
  open: boolean;
  openInvitations: () => void;
  closeInvitations: () => void;
}

const InvitationsContext = createContext<InvitationsContextValue | null>(null);

function loadSeen(): Set<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as number[]);
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<number>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200)));
  } catch {
    /* storage unavailable: worst case the notification repeats after a restart */
  }
}

function describeTarget(invitation: Invitation): string {
  return invitation.type === 'org'
    ? t('the organization {name}', { name: invitation.org_name })
    : t('the project {name}', { name: invitation.project_name ?? '' });
}

/** Polls the signed-in user's pending invitations, and raises a system notification for each new one. */
export function InvitationsProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { api, user } = useAuth();
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [open, setOpen] = useState(false);
  const seenRef = useRef<Set<number>>(loadSeen());

  const openInvitations = useCallback(() => setOpen(true), []);
  const closeInvitations = useCallback(() => setOpen(false), []);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const res = await api.get<{ invitations: Invitation[] }>('/invitations');
      setInvitations(res.invitations);
      let changed = false;
      for (const invitation of res.invitations) {
        if (seenRef.current.has(invitation.id)) continue;
        seenRef.current.add(invitation.id);
        changed = true;
        try {
          const notification = new Notification(t('New invitation'), {
            body: t('{who} invited you to {target}', {
              who: invitation.inviter_name || invitation.inviter_email || '?',
              target: describeTarget(invitation),
            }),
          });
          notification.onclick = () => {
            window.focus();
            setOpen(true);
          };
        } catch {
          /* notifications unavailable: the in-app badge still shows the invitation */
        }
      }
      if (changed) saveSeen(seenRef.current);
    } catch {
      /* transient network error: keep the last known list and retry on the next tick */
    }
  }, [api, user]);

  useEffect(() => {
    if (!user) {
      setInvitations([]);
      setOpen(false);
      return;
    }
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    const onFocus = (): void => {
      refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [user, refresh]);

  const accept = useCallback(
    async (invitation: Invitation) => {
      await api.post(`/invitations/${invitation.id}/accept`);
      await refresh();
    },
    [api, refresh]
  );

  const decline = useCallback(
    async (invitation: Invitation) => {
      await api.post(`/invitations/${invitation.id}/decline`);
      await refresh();
    },
    [api, refresh]
  );

  const value = useMemo(
    () => ({ invitations, refresh, accept, decline, open, openInvitations, closeInvitations }),
    [invitations, refresh, accept, decline, open, openInvitations, closeInvitations]
  );

  return <InvitationsContext.Provider value={value}>{children}</InvitationsContext.Provider>;
}

export function useInvitations(): InvitationsContextValue {
  const ctx = useContext(InvitationsContext);
  if (!ctx) throw new Error('useInvitations must be used within InvitationsProvider');
  return ctx;
}
