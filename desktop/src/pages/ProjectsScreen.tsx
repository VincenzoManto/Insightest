import React, { useEffect, useState } from 'react';
import { ArrowLeft, FolderGit2, FolderOpen, Globe, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { useAuth } from '../state/AuthContext';
import { Brand } from '../components/Brand';
import { InvitationBell } from '../components/InvitationBell';
import { MembersModal } from '../components/MembersModal';
import { DEFAULT_SELECTOR_PRIORITY, parseSelectorPriority, SelectorPriorityEditor, type SelectorKind } from '../components/SelectorPriorityEditor';
import { t } from '../i18n';
import type { Organization, Project } from '../types';

function RepoPathInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}): React.ReactElement {
  return (
    <div className="flex gap-2">
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="min-w-0 flex-1" />
      <button
        type="button"
        className="secondary"
        onClick={async () => {
          const picked = await window.insightest.dialog.pickFolder();
          if (picked) onChange(picked);
        }}
      >
        <FolderOpen size={14} /> {t('Browse')}
      </button>
    </div>
  );
}

export function ProjectsScreen({
  org,
  onBack,
  onSelect,
}: {
  org: Organization;
  onBack: () => void;
  onSelect: (project: Project) => void;
}): React.ReactElement {
  const { api } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [membersOf, setMembersOf] = useState<Project | null>(null);
  // Only administrators (org owner/admin) may create, edit and delete projects, and manage their members.
  const isAdmin = org.role === 'owner' || org.role === 'admin';
  const [newName, setNewName] = useState('');
  const [newBaseUrl, setNewBaseUrl] = useState('');
  const [newRepoPath, setNewRepoPath] = useState('');
  const [newSelectorPriority, setNewSelectorPriority] = useState<SelectorKind[]>(DEFAULT_SELECTOR_PRIORITY);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingBaseUrl, setEditingBaseUrl] = useState('');
  const [editingRepoPath, setEditingRepoPath] = useState('');
  const [editingSelectorPriority, setEditingSelectorPriority] = useState<SelectorKind[]>(DEFAULT_SELECTOR_PRIORITY);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load(): Promise<void> {
    try {
      const res = await api.get<{ projects: Project[] }>(`/orgs/${org.id}/projects`);
      setProjects(res.projects);
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

  async function createProject(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      await api.post(`/orgs/${org.id}/projects`, {
        name: newName,
        base_url: newBaseUrl.trim() || null,
        repo_path: newRepoPath.trim() || null,
        selector_priority: newSelectorPriority,
      });
      setNewSelectorPriority(DEFAULT_SELECTOR_PRIORITY);
      setNewName('');
      setNewBaseUrl('');
      setNewRepoPath('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    }
  }

  function startEdit(project: Project): void {
    setError(null);
    setEditingId(project.id);
    setEditingName(project.name);
    setEditingBaseUrl(project.base_url ?? '');
    setEditingRepoPath(project.repo_path ?? '');
    setEditingSelectorPriority(parseSelectorPriority(project.selector_priority));
  }

  async function saveEdit(projectId: number): Promise<void> {
    if (!editingName.trim()) return;
    try {
      await api.put(`/projects/${projectId}`, {
        name: editingName,
        base_url: editingBaseUrl.trim() || null,
        repo_path: editingRepoPath.trim() || null,
        selector_priority: editingSelectorPriority,
      });
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    }
  }

  async function removeProject(project: Project): Promise<void> {
    if (!window.confirm(t('Delete project "{name}"? This cannot be undone.', { name: project.name }))) return;
    setError(null);
    try {
      await api.delete(`/projects/${project.id}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unknown error'));
    }
  }

  if (loading) return <div className="content text-ink-muted">{t('Loading projects…')}</div>;

  return (
    <div className="h-screen overflow-auto">
      <div className="screen-narrow">
        <div className="mb-8 flex items-center justify-between">
          <Brand />
          <div className="flex items-center gap-2">
            <InvitationBell />
            <button className="ghost" onClick={onBack}>
              <ArrowLeft size={15} /> {t('Change organization')}
            </button>
          </div>
        </div>
        <div className="screen-header">
          <div className="min-w-0">
            <h1 className="screen-title truncate">{t('Projects — {org}', { org: org.name })}</h1>
            <p className="screen-subtitle">{t('Pick a project to open its test dashboard.')}</p>
          </div>
        </div>
        {error && <div className="error-banner">{error}</div>}

        {projects.length === 0 && <p className="mb-4 text-sm text-ink-muted">{t('No projects yet. Create the first one below.')}</p>}
        {projects.map((project) =>
          editingId === project.id ? (
            <div key={project.id} className="card flex flex-col gap-2.5">
              <input value={editingName} onChange={(e) => setEditingName(e.target.value)} placeholder={t('Project name')} className="w-full" />
              <input
                value={editingBaseUrl}
                onChange={(e) => setEditingBaseUrl(e.target.value)}
                placeholder={t('Base URL (e.g. https://staging.mysite.com) — used for self-healing')}
                className="w-full"
              />
              <RepoPathInput
                value={editingRepoPath}
                onChange={setEditingRepoPath}
                placeholder={t('Local path of the git repo — used to delegate repairs to an AI agent')}
              />
              <SelectorPriorityEditor value={editingSelectorPriority} onChange={setEditingSelectorPriority} />
              <div className="flex gap-2">
                <button onClick={() => saveEdit(project.id)}>{t('Save')}</button>
                <button className="secondary" onClick={() => setEditingId(null)}>
                  {t('Cancel')}
                </button>
              </div>
            </div>
          ) : (
            <div key={project.id} className="list-row">
              <div className="min-w-0">
                <div className="truncate font-semibold text-ink-primary">{project.name}</div>
                {project.base_url && (
                  <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-ink-muted">
                    <Globe size={12} className="flex-shrink-0" /> <span className="truncate">{project.base_url}</span>
                  </div>
                )}
                {project.repo_path && (
                  <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-ink-muted">
                    <FolderGit2 size={12} className="flex-shrink-0" /> <span className="truncate">{project.repo_path}</span>
                  </div>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center gap-1.5">
                <button className="secondary icon" title={t('Members and invitations')} onClick={() => setMembersOf(project)}>
                  <Users size={15} />
                </button>
                {isAdmin && (
                  <>
                    <button className="secondary icon" title={t('Rename')} onClick={() => startEdit(project)}>
                      <Pencil size={15} />
                    </button>
                    <button className="danger icon" title={t('Delete')} onClick={() => removeProject(project)}>
                      <Trash2 size={15} />
                    </button>
                  </>
                )}
                <button onClick={() => onSelect(project)}>{t('Open')}</button>
              </div>
            </div>
          )
        )}

        {isAdmin && (
        <form onSubmit={createProject} className="card mt-5 flex flex-col gap-2.5">
          <div className="card-title mb-0.5">{t('New project')}</div>
          <input placeholder={t('Project name')} value={newName} onChange={(e) => setNewName(e.target.value)} className="w-full" />
          <input
            placeholder={t('Base URL (optional, e.g. https://staging.mysite.com) — used for self-healing')}
            value={newBaseUrl}
            onChange={(e) => setNewBaseUrl(e.target.value)}
            className="w-full"
          />
          <RepoPathInput
            value={newRepoPath}
            onChange={setNewRepoPath}
            placeholder={t('Local path of the git repo (optional) — used to delegate repairs to an AI agent')}
          />
          <SelectorPriorityEditor value={newSelectorPriority} onChange={setNewSelectorPriority} />
          <button type="submit" disabled={!newName.trim()} className="self-start">
            <Plus size={15} /> {t('Create')}
          </button>
        </form>
        )}
      </div>
      {membersOf && (
        <MembersModal scope="project" id={membersOf.id} name={membersOf.name} canManage={isAdmin} onClose={() => setMembersOf(null)} />
      )}
    </div>
  );
}
