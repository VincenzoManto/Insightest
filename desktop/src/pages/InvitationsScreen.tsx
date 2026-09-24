import React, { useState } from 'react';
import { ArrowLeft, Building2, Check, FolderKanban, MailOpen, X } from 'lucide-react';
import { Brand } from '../components/Brand';
import { useInvitations } from '../state/InvitationsContext';
import { formatDateTime, t } from '../i18n';
import type { Invitation } from '../types';

export function InvitationsScreen({ onBack }: { onBack: () => void }): React.ReactElement {
  const { invitations, accept, decline } = useInvitations();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function respond(invitation: Invitation, action: 'accept' | 'decline'): Promise<void> {
    setBusyId(invitation.id);
    setError(null);
    try {
      await (action === 'accept' ? accept(invitation) : decline(invitation));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="h-screen overflow-auto">
      <div className="screen-narrow">
        <div className="mb-8 flex items-center justify-between">
          <Brand />
          <button className="ghost" onClick={onBack}>
            <ArrowLeft size={15} /> {t('Back')}
          </button>
        </div>
        <div className="screen-header">
          <div>
            <h1 className="screen-title">{t('Pending invitations')}</h1>
            <p className="screen-subtitle">{t('Invitations you receive to join organizations and projects appear here.')}</p>
          </div>
        </div>
        {error && <div className="error-banner">{error}</div>}

        {invitations.length === 0 && (
          <div className="card flex flex-col items-center gap-2 !py-10 text-center text-ink-muted">
            <MailOpen size={28} />
            {t('You have no pending invitations.')}
          </div>
        )}

        {invitations.map((invitation) => {
          const isOrg = invitation.type === 'org';
          return (
            <div key={invitation.id} className="list-row">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent-700">
                  {isOrg ? <Building2 size={17} /> : <FolderKanban size={17} />}
                </div>
                <div className="min-w-0">
                  <div className="truncate font-semibold text-ink-primary">
                    {isOrg
                      ? t('Join the organization {name}', { name: invitation.org_name })
                      : t('Join the project {name}', { name: invitation.project_name ?? '' })}
                  </div>
                  <div className="truncate text-xs text-ink-muted">
                    {!isOrg && `${t('in {org}', { org: invitation.org_name })} · `}
                    {t('as {role}', { role: invitation.role === 'admin' ? t('administrator') : t('Member').toLowerCase() })} ·{' '}
                    {t('Invited by {name}', { name: invitation.inviter_name || invitation.inviter_email || '?' })} ·{' '}
                    {formatDateTime(invitation.created_at)}
                  </div>
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1.5">
                <button className="danger" disabled={busyId === invitation.id} onClick={() => respond(invitation, 'decline')}>
                  <X size={14} /> {t('Decline')}
                </button>
                <button disabled={busyId === invitation.id} onClick={() => respond(invitation, 'accept')}>
                  <Check size={14} /> {t('Accept')}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
