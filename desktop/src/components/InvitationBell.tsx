import React from 'react';
import { Bell } from 'lucide-react';
import { useInvitations } from '../state/InvitationsContext';
import { t } from '../i18n';

/** Header button that shows how many invitations are waiting and opens the invitations screen. */
export function InvitationBell(): React.ReactElement {
  const { invitations, openInvitations } = useInvitations();
  const count = invitations.length;
  return (
    <button className="secondary icon relative" title={t('Invitations')} onClick={openInvitations}>
      <Bell size={15} />
      {count > 0 && (
        <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-critical px-1 text-[10px] font-bold leading-none text-white">
          {count}
        </span>
      )}
    </button>
  );
}
