/**
 * Minimal i18n. Source strings are English and double as the lookup key, so English needs no
 * catalogue. Every other language is one file in ./locales exporting `Record<string, string>`.
 *
 * To add a language (e.g. Spanish):
 *   1. create src/locales/es.ts (copy it.ts and translate the values);
 *   2. add one entry to LANGUAGES below.
 * Missing keys fall back to English, so a partial catalogue is safe to ship.
 *
 * The locale is resolved once at startup: the user's saved choice, else the OS/browser language,
 * else English. Changing it in the UI reloads the window (see `setLanguage`).
 */
import it from './locales/it';

export type Locale = 'en' | 'it';

export interface LanguageDef {
  code: Locale;
  /** Shown in the language picker, always in the language itself. */
  label: string;
  /** BCP-47 tag for Intl/Date formatting. */
  intl: string;
  /** Catalogue keyed by English source string; omitted for English. */
  messages?: Record<string, string>;
}

export const LANGUAGES: LanguageDef[] = [
  { code: 'en', label: 'English', intl: 'en-US' },
  { code: 'it', label: 'Italiano', intl: 'it-IT', messages: it },
];

const STORAGE_KEY = 'insightest.language';
const findLanguage = (code: string | null | undefined): LanguageDef | undefined =>
  LANGUAGES.find((l) => l.code === code);

function savedLanguage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function detectLanguage(): LanguageDef {
  const saved = findLanguage(savedLanguage());
  if (saved) return saved;
  const langs = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  for (const tag of langs) {
    const base = tag.toLowerCase().split('-')[0];
    const match = findLanguage(base);
    if (match) return match;
  }
  return LANGUAGES[0];
}

const active = detectLanguage();
export const locale: Locale = active.code;

if (typeof document !== 'undefined') document.documentElement.lang = locale;

/** `null` means "follow the OS language". */
export function getLanguagePreference(): Locale | null {
  return findLanguage(savedLanguage())?.code ?? null;
}

/** Persists the choice and reloads so every already-rendered string is re-translated. */
export function setLanguage(code: Locale | null): void {
  try {
    if (code) localStorage.setItem(STORAGE_KEY, code);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage blocked: the choice just won't survive a restart */
  }
  window.location.reload();
}

export function t(key: string, vars?: Record<string, string | number>): string {
  let out = active.messages?.[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}

export function formatDateTime(value: string | number | Date): string {
  return new Date(value).toLocaleString(active.intl, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatDate(value: string | number | Date): string {
  return new Date(value).toLocaleDateString(active.intl, { dateStyle: 'medium' });
}

/** Mon..Sun short weekday names in the active locale. */
export function weekdayLabels(): string[] {
  const fmt = new Intl.DateTimeFormat(active.intl, { weekday: 'short' });
  // 2024-01-01 is a Monday.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
}
