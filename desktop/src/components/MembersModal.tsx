import React, { useEffect, useState } from 'react';
import { Mail, UserMinus, X } from 'lucide-react';
import { useAuth } from '../state/AuthContext';
import { t } from '../i18n';
import type { Member, PendingInvitation } from '../types';

/** Members of an organization or project, plus (for administrators) the email-invite form and pending invitations. */
export function MembersModal({
  scope,
  id,
  name,
  canManage,
  onClose,
}: {
  scope: 'org' | 'project';
  id: number;
  name: string;
  canManage: boolean;
  onClose: () => void;
}): React.ReactElement {
  const { api, user } = useAuth();
  const base = scope === 'org' ? `/orgs/${id}` : `/projects/${id}`;
  const [members, setMembers] = useState<Member[]>([]);
  const [pending, setPending] = useState<PendingInvitation[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function load(): Promise<void> {
    try {
      const membersRes = await api.get<{ members: Member[] }>(`${base}/members`);
      setMembers(membersRes.members);
      if (canManage) {
        const invitesRes = await api.get<{ invitations: PendingInvitation[] }>(`${base}/invitations`);
        setPending(invitesRes.invitations);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, id]);

  async function invite(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const target = email.trim();
    if (!target) return;
    setSending(true);
    setError(null);
    setInfo(null);
    try {
      await api.post(`${base}/invitations`, { email: target, role });
      setInfo(t('Invitation sent to {email}', { email: target }));
      setEmail('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    } finally {
      setSending(false);
    }
  }

  async function cancelInvitation(invitation: PendingInvitation): Promise<void> {
    setError(null);
    try {
      await api.delete(`/invitations/${invitation.id}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    }
  }

  async function removeMember(member: Member): Promise<void> {
    if (!window.confirm(t('Remove {name} from {target}?', { name: member.name || member.email, target: name }))) return;
    setError(null);
    try {
      await api.delete(`${base}/members/${member.id}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    }
  }

  const roleLabel = (r: string): string => (r === 'owner' ? t('Owner') : r === 'admin' ? t('Administrator') : t('Member'));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal !max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="min-w-0 break-words text-base font-semibold">{t('Members and invitations — {name}', { name })}</h2>
          <button className="ghost icon sm flex-shrink-0" onClick={onClose} title={t('Close')}>
            <X size={14} />
          </button>
        </div>
        {error && <div className="error-banner">{error}</div>}
        {info && <div className="info-banner">{info}</div>}

        {canManage ? (
          <form onSubmit={invite} className="mb-5">
            <div className="eyebrow mb-1.5">{t('Invite by email')}</div>
            <div className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('Email address')}
                className="min-w-0 flex-1"
              />
              <select value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')} title={t('Role')}>
                <option value="member">{t('Member')}</option>
                <option value="admin">{t('Administrator')}</option>
              </select>
              <button type="submit" disabled={sending || !email.trim()}>
                <Mail size={14} /> {t('Invite')}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-ink-muted">{t('The invitee will see the invitation in the app when signing in with this email.')}</p>
          </form>
        ) : (
          <p className="mb-4 text-xs text-ink-muted">{t('Only administrators can manage members and invitations.')}</p>
        )}

        {pending.length > 0 && (
          <div className="mb-5">
            <div className="eyebrow mb-1.5">{t('Pending invitations')}</div>
            {pending.map((invitation) => (
              <div key={invitation.id} className="flex items-center justify-between gap-3 border-b border-gridline py-2 text-[13px] last:border-b-0">
                <div className="min-w-0">
                  <div className="truncate text-ink-primary">{invitation.email}</div>
                  <div className="text-xs text-ink-muted">
                    {t('Pending')} · {roleLabel(invitation.role)}
                  </div>
                </div>
                <button className="ghost icon sm" title={t('Cancel invitation')} onClick={() => cancelInvitation(invitation)}>
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="eyebrow mb-1.5">{t('Members')}</div>
        <div className="max-h-64 overflow-auto">
          {members.map((member) => (
            <div key={`${member.source ?? 'org'}-${member.id}`} className="flex items-center justify-between gap-3 border-b border-gridline py-2 text-[13px] last:border-b-0">
              <div className="min-w-0">
                <div className="truncate font-medium text-ink-primary">
                  {member.name || member.email} {Number(member.id) === Number(user?.id) && <span className="font-normal text-ink-muted">({t('You')})</span>}
                </div>
                <div className="truncate text-xs text-ink-muted">
                  {member.email} · {roleLabel(member.role)}
                  {member.source === 'org' && ` · ${t('via organization')}`}
                </div>
              </div>
              {canManage && Number(member.id) !== Number(user?.id) && member.source !== 'org' && member.role !== 'owner' && (
                <button className="ghost icon sm" title={t('Remove member')} onClick={() => removeMember(member)}>
                  <UserMinus size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
