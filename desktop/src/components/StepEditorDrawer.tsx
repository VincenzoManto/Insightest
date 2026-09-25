import React, { useState } from 'react';
import { Check, Trash2, X } from 'lucide-react';
import { t } from '../i18n';
import {
  ACTION_LABEL,
  EDITABLE_ACTIONS,
  canCauseNavigation,
  hasSelector,
  valueLabel,
  type EditableStep,
  type SelectorKey,
  type StepAction,
} from '../stepModel';

const SELECTOR_FIELDS: { key: SelectorKey; label: string }[] = [
  { key: 'xpath', label: 'xpath' },
  { key: 'generalSelector', label: 'generalSelector' },
  { key: 'attrSelector', label: 'attrSelector' },
  { key: 'testIdSelector', label: 'testIdSelector' },
  { key: 'id', label: 'id' },
  { key: 'text', label: 'text' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="border-b border-gridline last:border-b-0">
      <div className="bg-page px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">{t(title)}</div>
      <div className="flex flex-col gap-3 px-4 py-3">{children}</div>
    </section>
  );
}

function Check1({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }): React.ReactElement {
  return (
    <label className="flex items-center gap-2 text-[13px] text-ink-secondary" title={hint ? t(hint) : undefined}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="!p-0" />
      {t(label)}
    </label>
  );
}

/**
 * Right-hand panel to edit ONE step of a test: its action, the recorded selectors of the element and
 * how the runner executes it. Edits stay in a local draft until "Apply"; the parent list holds the
 * result and saves the whole test.
 */
export function StepEditorDrawer({
  step,
  index,
  onApply,
  onDelete,
  onClose,
}: {
  step: EditableStep;
  index: number;
  onApply: (step: EditableStep) => void;
  onDelete: () => void;
  onClose: () => void;
}): React.ReactElement {
  const [draft, setDraft] = useState<EditableStep>(step);
  const set = (patch: Partial<EditableStep>): void => setDraft((d) => ({ ...d, ...patch }));
  const setSelector = (key: SelectorKey, value: string): void => setDraft((d) => ({ ...d, selectors: { ...d.selectors, [key]: value } }));

  const isRaw = draft.action === 'raw';
  const withSelector = hasSelector(draft.action);
  const vLabel = valueLabel(draft.action);
  const noSelector = withSelector && draft.action !== 'keydown' && Object.values(draft.selectors).every((v) => !v.trim());

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-primary/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="flex h-full w-full max-w-[480px] flex-col bg-surface shadow-2xl" role="dialog" aria-label={t('Edit step')}>
        <header className="flex items-center justify-between gap-3 border-b border-gridline px-4 py-3">
          <div className="text-sm font-semibold text-ink-primary">
            {t('Step')} {index + 1}
          </div>
          <button className="secondary icon" onClick={onClose} title={t('Close')}>
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isRaw ? (
            <Section title="Code">
              <textarea
                value={draft.raw ?? ''}
                onChange={(e) => set({ raw: e.target.value })}
                rows={4}
                spellCheck={false}
                className="w-full font-mono text-xs"
              />
              <div className="text-xs text-ink-muted">{t('Free code line: kept as written, not editable with the fields below.')}</div>
            </Section>
          ) : (
            <>
              <Section title="Action">
                <select value={draft.action} onChange={(e) => set({ action: e.target.value as StepAction })} className="w-full">
                  {EDITABLE_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {t(ACTION_LABEL[a])}
                    </option>
                  ))}
                </select>
                {vLabel && (
                  <label className="flex flex-col gap-1 text-[13px] font-medium text-ink-secondary">
                    {t(vLabel)}
                    <input value={draft.value} onChange={(e) => set({ value: e.target.value })} className="w-full" />
                  </label>
                )}
                {draft.action === 'resize' && (
                  <label className="flex flex-col gap-1 text-[13px] font-medium text-ink-secondary">
                    {t('Height')}
                    <input value={draft.value2} onChange={(e) => set({ value2: e.target.value })} className="w-full" />
                  </label>
                )}
                {draft.action === 'select2' && (
                  <Check1 label="Pick the option by position (number), not by text" checked={draft.valueIsNumber} onChange={(v) => set({ valueIsNumber: v })} />
                )}
                {canCauseNavigation(draft.action) && (
                  <Check1
                    label="Causes navigation"
                    checked={draft.causesNavigation}
                    onChange={(v) => set({ causesNavigation: v })}
                    hint="After the action, wait for the page to load before the next step"
                  />
                )}
              </Section>

              {withSelector && (
                <Section title="Element">
                  <div className="text-xs text-ink-muted">{t("The runner tries these in the project's selector priority order; the others are fallbacks.")}</div>
                  {SELECTOR_FIELDS.map((f) => (
                    <label key={f.key} className="flex flex-col gap-1 text-[13px] font-medium text-ink-secondary">
                      {f.label}
                      <input
                        value={draft.selectors[f.key]}
                        onChange={(e) => setSelector(f.key, e.target.value)}
                        spellCheck={false}
                        className="w-full font-mono !text-xs"
                        placeholder={f.key === 'xpath' ? '//html/body/…' : f.key === 'id' ? '#id' : f.key === 'text' ? t('visible text') : undefined}
                      />
                    </label>
                  ))}
                  <Check1 label="visible" checked={draft.visible} onChange={(v) => set({ visible: v })} hint="Only match visible elements (adds :visible to the CSS selectors)" />
                  {noSelector && <div className="text-xs text-critical">{t('Fill in at least one selector, or the step cannot run.')}</div>}
                </Section>
              )}
            </>
          )}

          {!isRaw && (
            <Section title="Execution">
              <Check1 label="Enabled" checked={draft.enabled} onChange={(v) => set({ enabled: v })} hint="A disabled step is kept but not executed" />
              {withSelector && (
                <Check1 label="Skip on failure" checked={draft.skipOnFailure} onChange={(v) => set({ skipOnFailure: v })} hint="If the step fails after all retries, carry on with the next one" />
              )}
              {withSelector && (
                <>
                  <label className="flex flex-col gap-1 text-[13px] font-medium text-ink-secondary">
                    {t('Timeout (ms)')}
                    <input
                      type="number"
                      min={0}
                      step={500}
                      value={draft.timeout}
                      onChange={(e) => set({ timeout: e.target.value })}
                      placeholder={t('default (8s → 15s → 20s)')}
                      className="w-full"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[13px] font-medium text-ink-secondary">
                    {t('Wait before (ms)')}
                    <input type="number" min={0} step={100} value={draft.waitBeforeMs} onChange={(e) => set({ waitBeforeMs: e.target.value })} placeholder="0" className="w-full" />
                  </label>
                </>
              )}
            </Section>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-gridline px-4 py-3">
          <button className="danger" onClick={onDelete}>
            <Trash2 size={15} /> {t('Delete step')}
          </button>
          <div className="flex gap-2">
            <button className="secondary" onClick={onClose}>
              {t('Cancel')}
            </button>
            <button onClick={() => onApply(draft)}>
              <Check size={15} /> {t('Apply')}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}
