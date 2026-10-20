/** Plain-language explanation of where/why a run's log shows it stopped. */
export interface FailureReason {
  /** The last action the resilient engine attempted, e.g. "Click button#submit" (undefined if none was logged). */
  step?: string;
  /** Short, human-readable reason, meant for someone who isn't reading the raw log. */
  reason: string;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ACTION_RE = /\[insightest\]\s+(?:Retry \d\/\d:\s+|Fallback 3\/3[^:]*:\s+)?(Click destro|Click|Fill|Svuota|Doppio click|Check|Uncheck|Seleziona opzione|Premi tasto|Hover|Tap|Digita|Carica file|Seleziona testo|Naviga)\s+(.+)$/gm;

// Ordered most-specific first: the first pattern that matches the log wins.
const CHECKS: { pattern: RegExp; reason: string }[] = [
  { pattern: /element is not enabled/i, reason: 'Il campo/elemento è stato trovato ma è disabilitato.' },
  { pattern: /element is not editable/i, reason: 'Il campo è stato trovato ma non è modificabile (es. in sola lettura).' },
  { pattern: /strict mode violation.*resolved to (\d+) elements/i, reason: 'Il selettore corrisponde a più di un elemento nella pagina: ne servirebbe uno solo, più specifico.' },
  { pattern: /element is not attached to the DOM/i, reason: "L'elemento è stato rimosso dalla pagina mentre il test lo stava usando." },
  { pattern: /element is not stable|intercepts pointer events|element is outside of the viewport/i, reason: "L'elemento è coperto da un altro elemento o non è cliccabile nella posizione attuale." },
  { pattern: /waiting for locator.*to be visible|element is not visible/i, reason: "Nessun elemento con questo selettore è visibile in pagina: potrebbe essere assente, non ancora caricato o nascosto." },
  { pattern: /net::ERR|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED/i, reason: 'Errore di rete: la pagina o una risorsa non è stata raggiunta.' },
  { pattern: /exceeded while waiting for (event|selector)|Timeout \d+ms exceeded/i, reason: "L'operazione è andata in timeout: l'elemento o la pagina non hanno risposto in tempo." },
  { pattern: /Azione fallita dopo 3 tentativi|Navigazione fallita dopo/i, reason: "L'azione non è riuscita dopo 3 tentativi: l'elemento potrebbe essere stato spostato, rinominato o non esistere più." },
];

/**
 * Scans a run's raw log for the known Playwright/engine failure signatures and turns the
 * first match into a plain-language sentence, plus (when available) the last action the
 * resilient engine logged before giving up -- so a non-technical reader can see *where* and
 * roughly *why* a run stopped without reading the log itself.
 */
export function getFailureReason(log: string | null | undefined): FailureReason | null {
  if (!log) return null;
  const clean = log.replace(ANSI_RE, '');

  const actionMatches = [...clean.matchAll(ACTION_RE)];
  const lastAction = actionMatches[actionMatches.length - 1];
  const step = lastAction ? `${lastAction[1]} ${lastAction[2].trim()}` : undefined;

  for (const { pattern, reason } of CHECKS) {
    if (pattern.test(clean)) return { step, reason };
  }

  return step ? { step, reason: 'Il test si è bloccato su questo passaggio, ma la causa esatta non è stata riconosciuta automaticamente.' } : null;
}
