import { Globe } from 'lucide-react';
import { LANGUAGES, getLanguagePreference, setLanguage, t, type Locale } from '../i18n';

/** Language picker. "Automatic" follows the OS language; picking a language reloads the window. */
export function LanguageSwitcher({ dark }: { dark?: boolean }): JSX.Element {
  const pref = getLanguagePreference();
  return (
    <label
      title={t('Language')}
      className={`flex items-center gap-2 text-[12px] ${dark ? 'text-sidebar-text' : 'text-ink-secondary'}`}
    >
      <Globe size={14} className="flex-shrink-0" />
      <select
        aria-label={t('Language')}
        value={pref ?? 'auto'}
        onChange={(e) => setLanguage(e.target.value === 'auto' ? null : (e.target.value as Locale))}
        className={`min-w-0 flex-1 cursor-pointer rounded-md border px-1.5 py-1 text-[12px] ${
          dark ? '!border-sidebar-border !bg-sidebar-hover !text-white' : ''
        }`}
      >
        <option value="auto">{t('Automatic')}</option>
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
