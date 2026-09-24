import React, { useEffect, useState } from 'react';
import { Building2, FolderKanban, KeyRound, LogOut, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { useAuth } from '../state/AuthContext';
import { Brand } from '../components/Brand';
import { InvitationBell } from '../components/InvitationBell';
import { MembersModal } from '../components/MembersModal';
import { t } from '../i18n';
import type { Organization, SharedProject } from '../types';

export function OrgsScreen({
  onSelect,
  onManageApiKeys,
  onSelectShared,
}: {
  onSelect: (org: Organization) => void;
  onManageApiKeys: (org: Organization) => void;
  onSelectShared: (project: SharedProject) => void;
}): React.ReactElement {
  const { api, logout } = useAuth();
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [sharedProjects, setSharedProjects] = useState<SharedProject[]>([]);
  const [membersOf, setMembersOf] = useState<Organization | null>(null);
  const [newOrgName, setNewOrgName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load(): Promise<void> {
    try {
      const res = await api.get<{ organizations: Organization[] }>('/orgs');
      setOrgs(res.organizations);
      const shared = await api.get<{ projects: SharedProject[] }>('/projects/shared').catch(() => ({ projects: [] as SharedProject[] }));
      setSharedProjects(shared.projects);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createOrg(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!newOrgName.trim()) return;
    try {
      await api.post('/orgs', { name: newOrgName });
      setNewOrgName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    }
  }

  function startEdit(org: Organization): void {
    setError(null);
    setEditingId(org.id);
    setEditingName(org.name);
  }

  async function saveEdit(orgId: number): Promise<void> {
    if (!editingName.trim()) return;
    try {
      await api.put(`/orgs/${orgId}`, { name: editingName });
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    }
  }

  async function removeOrg(org: Organization): Promise<void> {
    if (!window.confirm(t('Delete organization "{name}"? This cannot be undone.', { name: org.name }))) return;
    setError(null);
    try {
      await api.delete(`/orgs/${org.id}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    }
  }

  if (loading) return <div className="content text-ink-muted">{t('Loading organizations…')}</div>;

  return (
    <div className="h-screen overflow-auto">
      <div className="screen-narrow">
        <div className="mb-8 flex items-center justify-between">
          <Brand />
          <div className="flex items-center gap-2">
            <InvitationBell />
            <button className="ghost" onClick={() => logout()}>
              <LogOut size={15} /> {t('Sign out')}
            </button>
          </div>
        </div>
        <div className="screen-header">
          <div>
            <h1 className="screen-title">{t('Your organizations')}</h1>
            <p className="screen-subtitle">{t('Choose an organization to continue.')}</p>
          </div>
        </div>
        {error && <div className="error-banner">{error}</div>}

        {orgs.length === 0 && <p className="mb-4 text-sm text-ink-muted">{t('No organizations yet. Create the first one below.')}</p>}
        {orgs.map((org) => (
          <div key={org.id} className="list-row">
            {editingId === org.id ? (
              <input
                autoFocus
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveEdit(org.id);
                  if (e.key === 'Escape') setEditingId(null);
                }}
                className="min-w-0 flex-1"
              />
            ) : (
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent-700">
                  <Building2 size={17} />
                </div>
                <div className="min-w-0">
                  <div className="truncate font-semibold text-ink-primary">{org.name}</div>
                  <div className="text-xs capitalize text-ink-muted">{t(org.role)}</div>
                </div>
              </div>
            )}
            <div className="flex flex-shrink-0 items-center gap-1.5">
              {editingId === org.id ? (
                <>
                  <button onClick={() => saveEdit(org.id)}>{t('Save')}</button>
                  <button className="secondary" onClick={() => setEditingId(null)}>
                    {t('Cancel')}
                  </button>
                </>
              ) : (
                <>
                  <button className="secondary icon" title={t('Members and invitations')} onClick={() => setMembersOf(org)}>
                    <Users size={15} />
                  </button>
                  <button className="secondary icon" title={t('API keys')} onClick={() => onManageApiKeys(org)}>
                    <KeyRound size={15} />
                  </button>
                  {(org.role === 'owner' || org.role === 'admin') && (
                    <button className="secondary icon" title={t('Rename')} onClick={() => startEdit(org)}>
                      <Pencil size={15} />
                    </button>
                  )}
                  {org.role === 'owner' && (
                    <button className="danger icon" title={t('Delete')} onClick={() => removeOrg(org)}>
                      <Trash2 size={15} />
                    </button>
                  )}
                  <button onClick={() => onSelect(org)}>{t('Open')}</button>
                </>
              )}
            </div>
          </div>
        ))}

        {sharedProjects.length > 0 && (
          <div className="mt-8">
            <h2 className="text-base font-semibold">{t('Shared with you')}</h2>
            <p className="mb-3 text-sm text-ink-muted">{t('Projects you were invited to directly.')}</p>
            {sharedProjects.map((project) => (
              <div key={project.id} className="list-row">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-accent2/10 text-accent2">
                    <FolderKanban size={17} />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-ink-primary">{project.name}</div>
                    <div className="truncate text-xs text-ink-muted">{project.org_name}</div>
                  </div>
                </div>
                <button onClick={() => onSelectShared(project)}>{t('Open')}</button>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={createOrg} className="mt-5 flex gap-2">
          <input placeholder={t('New organization')} value={newOrgName} onChange={(e) => setNewOrgName(e.target.value)} className="min-w-0 flex-1" />
          <button type="submit" disabled={!newOrgName.trim()}>
            <Plus size={15} /> {t('Create')}
          </button>
        </form>
      </div>
      {membersOf && (
        <MembersModal
          scope="org"
          id={membersOf.id}
          name={membersOf.name}
          canManage={membersOf.role === 'owner' || membersOf.role === 'admin'}
          onClose={() => setMembersOf(null)}
        />
      )}
    </div>
  );
}
