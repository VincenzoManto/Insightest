/**
 * Main-process i18n (no Electron dependency, so the standalone MCP server can use it too).
 * Same convention as src/i18n.ts: English source strings are the keys, other languages are
 * catalogues below. To add a language, add a catalogue to CATALOGUES and its code to `Locale`.
 * The renderer pushes the user's language here via the `i18n:set-locale` IPC call.
 */
export type Locale = 'en' | 'it';

const it: Record<string, string> = {
  'Analysis unavailable: this self-healing engine needs a "baseline" (a map of the tested site) that is not yet created automatically for Insightest projects. The failure log is still saved below for manual inspection.':
    'Analisi non disponibile: questo motore di self-healing ha bisogno di una "baseline" (una mappa del sito testato) che per ora non viene creata automaticamente per i progetti Insightest. Il log del fallimento resta comunque salvato qui sotto per l\'ispezione manuale.',
  '▶▶ Re-running the test to capture the current state of the page': '▶▶ Rieseguo il test per catturare lo stato attuale della pagina',
  '▶▶ Analyzing the selectors used by the test (ia-qa-heal ingest)': '▶▶ Analizzo i selettori usati dal test (ia-qa-heal ingest)',
  '▶▶ Comparing against the baseline (ia-qa-heal diff)': '▶▶ Confronto con la baseline (ia-qa-heal diff)',
  '▶▶ Applying the repair (ia-qa-heal fix)': '▶▶ Applico la riparazione (ia-qa-heal fix)',
  '▶▶ Re-running the repaired test to check it now passes': '▶▶ Rieseguo il test riparato per verificare che ora passi',
  'ia-qa-heal diff did not produce a readable verdict.': 'ia-qa-heal diff non ha prodotto un verdetto leggibile.',
  "The selectors used by this test still reach their elements: this doesn't look like selector drift.":
    'I selettori usati da questo test raggiungono ancora i loro elementi: non sembra drift del selettore.',
  'A human decision is needed: one or more elements are ambiguous, missing, or the selector now points to a different element. No rewrite was applied.':
    'Serve una decisione umana: uno o più elementi sono ambigui, spariti, o il selettore ora punta a un elemento diverso. Nessuna riscrittura è stata applicata.',
  'Verdict not available.': 'Verdetto non disponibile.',
  'ia-qa-heal reported FIX but did not rewrite the test file.': 'ia-qa-heal ha segnalato FIX ma non ha riscritto il file di test.',
  '⚠️ a tool returned an error': '⚠️ un tool ha restituito un errore',
  'A Claude request is already in progress': 'Una richiesta a Claude è già in corso',
  'MCP config not found in {path}. Generate it from the "AI agents (MCP)" screen of the Insightest desktop app.':
    'Config MCP non trovata in {path}. Generala dalla schermata "Agenti AI (MCP)" dell\'app desktop Insightest.',
  'Test details (including the Playwright code)': 'Dettagli di un test (incluso il codice Playwright)',
  'Runs a Playwright test locally (with its dependency chain) and stores the result':
    'Esegue localmente un test Playwright (con la sua catena di dipendenze) e salva il risultato',
  'Attempts self-healing repair (ia-qa-heal) of a failed test against the project baseline':
    'Tenta la riparazione self-healing (ia-qa-heal) di un test fallito contro la baseline del progetto',
  'The project has no base_url configured: self-healing is disabled.': 'Il progetto non ha un base_url configurato: il self-healing è disabilitato.',
  'No baseline for this project: create it first from the desktop app.': 'Nessuna baseline per questo progetto: crearla prima dalla app desktop.',
  'Applies the repaired code to the stored test (replaces playwright_code)': 'Applica il codice riparato al test memorizzato (sostituisce playwright_code)',
};

const CATALOGUES: Record<Exclude<Locale, 'en'>, Record<string, string>> = { it };

function detect(): Locale {
  const fromEnv = (process.env.INSIGHTEST_LOCALE || '').toLowerCase().slice(0, 2);
  const tag = (fromEnv || Intl.DateTimeFormat().resolvedOptions().locale || 'en').toLowerCase().slice(0, 2);
  return tag in CATALOGUES ? (tag as Locale) : 'en';
}

let current: Locale = detect();

export function setMessagesLocale(locale: string): void {
  current = locale in CATALOGUES ? (locale as Locale) : 'en';
}

/** Translate an English source string; unknown keys and English return the key unchanged. */
export function m(key: string, vars?: Record<string, string | number>): string {
  let out = current === 'en' ? key : CATALOGUES[current][key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}
