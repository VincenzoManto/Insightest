import React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { t } from '../i18n';

export const SELECTOR_KINDS = ['xpath', 'generalSelector', 'text', 'id', 'testIdSelector', 'attrSelector'] as const;
export type SelectorKind = (typeof SELECTOR_KINDS)[number];
export const DEFAULT_SELECTOR_PRIORITY: SelectorKind[] = ['xpath', 'generalSelector', 'text', 'id'];

const LABELS: Record<SelectorKind, string> = {
  xpath: 'XPath',
  generalSelector: 'General selector (CSS)',
  text: 'Text',
  id: 'Id',
  testIdSelector: 'Test id (data-test…)',
  attrSelector: 'Attributes',
};

/** Parses the API's JSON-encoded `selector_priority` (null/invalid = default). */
export function parseSelectorPriority(raw: string | null | undefined): SelectorKind[] {
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (Array.isArray(v)) {
      const keys = v.filter((k): k is SelectorKind => (SELECTOR_KINDS as readonly string[]).includes(k));
      if (keys.length) return keys;
    }
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_SELECTOR_PRIORITY;
}

/** Ordered list of the selector kinds the runner tries, first to last; unchecked kinds are never used. */
export function SelectorPriorityEditor({
  value,
  onChange,
}: {
  value: SelectorKind[];
  onChange: (value: SelectorKind[]) => void;
}): React.ReactElement {
  const disabled = SELECTOR_KINDS.filter((k) => !value.includes(k));

  function move(index: number, delta: number): void {
    const next = [...value];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs text-ink-muted">
        {t('Selector priority — the runner tries these recorded selectors in this order')}
      </div>
      {value.map((kind, i) => (
        <div key={kind} className="flex items-center gap-2 text-sm">
          <span className="w-5 text-ink-muted">{i + 1}.</span>
          <input
            type="checkbox"
            checked
            disabled={value.length === 1}
            onChange={() => onChange(value.filter((k) => k !== kind))}
            title={t('Use this selector')}
          />
          <span className="min-w-0 flex-1 truncate">{t(LABELS[kind])}</span>
          <button type="button" className="secondary icon" disabled={i === 0} onClick={() => move(i, -1)}>
            <ChevronUp size={14} />
          </button>
          <button type="button" className="secondary icon" disabled={i === value.length - 1} onClick={() => move(i, 1)}>
            <ChevronDown size={14} />
          </button>
        </div>
      ))}
      {disabled.map((kind) => (
        <div key={kind} className="flex items-center gap-2 text-sm text-ink-muted">
          <span className="w-5" />
          <input type="checkbox" checked={false} onChange={() => onChange([...value, kind])} title={t('Use this selector')} />
          <span className="min-w-0 flex-1 truncate">{t(LABELS[kind])}</span>
        </div>
      ))}
    </div>
  );
}
