import React from 'react';
import { t } from '../i18n';

const PRIVACY_URL = 'https://www.insightest.app/privacy';
const TERMS_URL = 'https://www.insightest.app/terms';

/**
 * Privacy Policy / Terms of Service links, shown on the login screen and in the sidebar footer.
 * Opened via a real browser navigation (target="_blank"); main.ts routes it to the OS default
 * browser instead of a bare Electron window (see setWindowOpenHandler).
 */
export function LegalLinks({ dark }: { dark?: boolean }): React.ReactElement {
  const linkClass = dark ? 'text-sidebar-text hover:text-white' : 'text-ink-muted hover:text-ink-primary';
  return (
    <div className={`flex items-center justify-center gap-2 text-[11px] ${linkClass}`}>
      <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className={`${linkClass} underline-offset-2 hover:underline`}>
        {t('Privacy Policy')}
      </a>
      <span aria-hidden="true">·</span>
      <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" className={`${linkClass} underline-offset-2 hover:underline`}>
        {t('Terms of Service')}
      </a>
    </div>
  );
}
