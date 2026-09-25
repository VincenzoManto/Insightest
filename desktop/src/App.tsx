import React, { useState } from 'react';
import { LayoutDashboard, FolderKanban, Building2, LogOut, ChevronsUpDown, Bell } from 'lucide-react';
import { useAuth } from './state/AuthContext';
import { useInvitations } from './state/InvitationsContext';
import { InvitationsScreen } from './pages/InvitationsScreen';
import { AuthScreen } from './pages/AuthScreen';
import { OrgsScreen } from './pages/OrgsScreen';
import { ApiKeysScreen } from './pages/ApiKeysScreen';
import { ProjectsScreen } from './pages/ProjectsScreen';
import { TestsScreen } from './pages/TestsScreen';
import { Brand } from './components/Brand';
import { t } from './i18n';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import type { Organization, Project, SharedProject } from './types';

function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}): React.ReactElement {
  return (
    <button type="button" onClick={onClick} className={`nav-item ${active ? 'active' : ''}`}>
      <span className={active ? 'text-accent' : ''}>{icon}</span>
      {label}
    </button>
  );
}

export function App(): React.ReactElement {
  const { ready, user, logout } = useAuth();
  const [org, setOrg] = useState<Organization | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [managingApiKeysFor, setManagingApiKeysFor] = useState<Organization | null>(null);
  // Set when the open project was reached through a direct project invite (no access to its org's project list).
  const [sharedOnly, setSharedOnly] = useState(false);
  const { invitations, open: invitationsOpen, openInvitations, closeInvitations } = useInvitations();

  if (!ready) return <div className="content text-ink-muted">{t('Loading…')}</div>;
  if (!user) return <AuthScreen />;
  if (invitationsOpen) {
    return <InvitationsScreen onBack={closeInvitations} />;
  }
  if (managingApiKeysFor) {
    return <ApiKeysScreen org={managingApiKeysFor} onBack={() => setManagingApiKeysFor(null)} />;
  }
  if (!org) {
    return (
      <OrgsScreen
        onSelect={setOrg}
        onManageApiKeys={setManagingApiKeysFor}
        onSelectShared={(shared: SharedProject) => {
          setOrg({ id: shared.org_id, name: shared.org_name, role: 'member' });
          setProject(shared);
          setSharedOnly(true);
        }}
      />
    );
  }
  if (!project) return <ProjectsScreen org={org} onBack={() => setOrg(null)} onSelect={setProject} />;

  /** Leaves the open project: back to the org's project list, or to the org list for a directly-shared project. */
  const leaveProject = (): void => {
    setProject(null);
    if (sharedOnly) {
      setOrg(null);
      setSharedOnly(false);
    }
  };

  const displayName = user.name || user.email;
  const initials = (displayName || '?').trim().charAt(0).toUpperCase();

  return (
    <div className="flex h-screen">
      <aside className="flex w-[232px] flex-shrink-0 flex-col bg-sidebar px-3 py-4">
        <div className="px-2 pb-5 pt-1">
          <Brand light />
        </div>

        <button
          type="button"
          onClick={leaveProject}
          title={t('Switch project')}
          className="mb-4 !justify-between !rounded-xl !border-sidebar-border !bg-sidebar-hover !px-3 !py-2.5 !text-left !shadow-none hover:!bg-[#202925]"
        >
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold text-white">{project.name}</span>
            <span className="block truncate text-[11px] font-normal text-sidebar-text">{org.name}</span>
          </span>
          <ChevronsUpDown size={14} className="flex-shrink-0 text-sidebar-text" />
        </button>

        <nav className="flex flex-col gap-0.5">
          <NavItem icon={<LayoutDashboard size={16} />} label={t('Dashboard')} active />
          <NavItem icon={<FolderKanban size={16} />} label={t('Projects')} onClick={leaveProject} />
          <NavItem
            icon={<Building2 size={16} />}
            label={t('Organizations')}
            onClick={() => {
              setProject(null);
              setOrg(null);
              setSharedOnly(false);
            }}
          />
          <button type="button" onClick={openInvitations} className="nav-item">
            <span>
              <Bell size={16} />
            </span>
            {t('Invitations')}
            {invitations.length > 0 && (
              <span className="ml-auto rounded-full bg-accent px-1.5 text-[11px] font-bold text-ink-primary">{invitations.length}</span>
            )}
          </button>
        </nav>

        <div className="flex-1" />

        <div className="mb-2 px-1">
          <LanguageSwitcher dark />
        </div>

        <div className="flex items-center gap-2.5 rounded-xl border border-sidebar-border px-2.5 py-2">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent-300 to-accent-600 text-xs font-bold text-ink-primary">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-white">{displayName}</div>
            {user.name && <div className="truncate text-[11px] text-sidebar-text">{user.email}</div>}
          </div>
          <button
            type="button"
            title={t('Sign out')}
            onClick={() => logout()}
            className="ghost icon sm !text-sidebar-text hover:!bg-sidebar-hover hover:!text-white"
          >
            <LogOut size={14} />
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="content">
          <div className="page">
            <TestsScreen project={project} />
          </div>
        </div>
      </main>
    </div>
  );
}
