/**
 * Minimal i18n. Source strings are English and double as the lookup key; Italian is used
 * when the OS/browser language is Italian, English otherwise. The locale is resolved once
 * at startup (changing the OS language requires an app restart, which is what users expect).
 */

export type Locale = 'en' | 'it';

function detectLocale(): Locale {
  const langs = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  return (langs[0] ?? 'en').toLowerCase().startsWith('it') ? 'it' : 'en';
}

export const locale: Locale = detectLocale();

if (typeof document !== 'undefined') document.documentElement.lang = locale;

const IT: Record<string, string> = {
  // generic
  Cancel: 'Annulla',
  Save: 'Salva',
  Create: 'Crea',
  Open: 'Apri',
  Delete: 'Elimina',
  Rename: 'Rinomina',
  Close: 'Chiudi',
  Back: 'Indietro',
  Copy: 'Copia',
  'Copied!': 'Copiato!',
  Browse: 'Sfoglia',
  Edit: 'Modifica',
  'Unknown error': 'Errore sconosciuto',
  'Loading…': 'Caricamento…',
  'Something went wrong': 'Si è verificato un errore imprevisto',
  'Try again': 'Riprova',

  // shell
  Dashboard: 'Dashboard',
  Projects: 'Progetti',
  Organizations: 'Organizzazioni',
  'Sign out': 'Esci',
  'Switch project': 'Cambia progetto',
  'Test automation': 'Test automation',

  // auth
  'Sign in to your workspace': 'Accedi al tuo workspace',
  'Create your account': 'Crea il tuo account',
  'Organization name': 'Nome organizzazione',
  Email: 'Email',
  Password: 'Password',
  'Sign in': 'Accedi',
  'Create account': 'Registrati',
  'Create a new account': 'Crea nuovo account',
  'I already have an account': 'Ho già un account',
  'Record, manage and re-run end-to-end tests.': 'Registra, gestisci e riesegui test end-to-end.',

  // orgs
  'Your organizations': 'Le tue organizzazioni',
  'Choose an organization to continue.': 'Scegli un’organizzazione per continuare.',
  'New organization': 'Nuova organizzazione',
  'API keys': 'API key',
  'Delete organization "{name}"? This cannot be undone.': 'Eliminare l\'organizzazione "{name}"? L\'operazione non è reversibile.',
  'Loading organizations…': 'Caricamento organizzazioni…',
  owner: 'proprietario',
  admin: 'admin',
  member: 'membro',

  // projects
  'Projects — {org}': 'Progetti — {org}',
  'Pick a project to open its test dashboard.': 'Scegli un progetto per aprire la sua dashboard.',
  'Change organization': 'Cambia organizzazione',
  'New project': 'Nuovo progetto',
  'Project name': 'Nome progetto',
  'Base URL (optional, e.g. https://staging.mysite.com) — used for self-healing':
    'URL base (opzionale, es. https://staging.miosito.it) — usato per il self-healing',
  'Base URL (e.g. https://staging.mysite.com) — used for self-healing': 'URL base (es. https://staging.miosito.it) — usato per il self-healing',
  'Local path of the git repo (optional) — used to delegate repairs to an AI agent':
    'Percorso locale del repo git (opzionale) — usato per delegare la riparazione a un agente AI',
  'Local path of the git repo — used to delegate repairs to an AI agent':
    'Percorso locale del repo git — usato per delegare la riparazione a un agente AI',
  'Delete project "{name}"? This cannot be undone.': 'Eliminare il progetto "{name}"? L\'operazione non è reversibile.',
  'Loading projects…': 'Caricamento progetti…',
  'No projects yet. Create the first one below.': 'Ancora nessun progetto. Crea il primo qui sotto.',
  'No organizations yet. Create the first one below.': 'Ancora nessuna organizzazione. Crea la prima qui sotto.',

  // api keys
  'API keys — {org}': 'API key — {org}',
  'New key created — copy it now, it will not be shown again:': 'Nuova chiave creata — copiala ora, non sarà più mostrata:',
  'I copied the key': 'Ho copiato la chiave',
  'CI/CD commands': 'Comandi CI/CD',
  'Paste one of these commands into your pipeline: they always download and run the latest runner. No base URL to configure, just the API key.':
    'Incolla uno di questi comandi nella tua pipeline: scaricano ed eseguono sempre l\'ultima versione del runner, non serve configurare alcun base URL, basta la API key.',
  'PowerShell (Windows)': 'PowerShell (Windows)',
  'Bash (Linux/macOS)': 'Bash (Linux/macOS)',
  'AI agents (MCP)': 'Agenti AI (MCP)',
  'Export a local configuration that lets agents such as Claude Code or GitHub Copilot CLI control Insightest (projects, tests, runs, repairs) through the Model Context Protocol. It uses a copy of the current session: it expires together with your login (usually after a few hours) and must be regenerated here when needed.':
    'Esporta una configurazione locale che permette ad agenti come Claude Code o GitHub Copilot CLI di controllare Insightest (progetti, test, esecuzioni, riparazioni) tramite il Model Context Protocol. La configurazione usa una copia della sessione corrente: scade insieme al login (di norma dopo alcune ore) e va rigenerata da qui quando serve.',
  'Set up Claude Code': 'Configura Claude Code',
  'Stopped. Nothing was changed.': 'Interrotto. Non è stato modificato nulla.',
  Stop: 'Interrompi',
  'Playwright browser': 'Browser Playwright',
  'Checking the Playwright browser…': 'Verifica del browser Playwright…',
  'Chromium is installed: tests can run on this machine.': 'Chromium è installato: i test possono girare su questa macchina.',
  'Chromium is not installed. It is needed to run tests locally; installing is optional if you only want to browse.': "Chromium non è installato. Serve per eseguire i test in locale; l'installazione è facoltativa se devi solo consultare.",
  'Install Chromium': 'Installa Chromium',
  'Installing…': 'Installazione…',
  'Claude activity': 'Attività di Claude',
  'Setting up…': 'Configurazione in corso…',
  'Done: the "insightest" MCP server is registered in Claude Code. Run this again after signing in anew if it stops working.': 'Fatto: il server MCP "insightest" è registrato in Claude Code. Se smette di funzionare, premi di nuovo il pulsante dopo aver rifatto il login.',
  'One click connects Claude Code to Insightest (projects, tests, runs, repairs) through the Model Context Protocol. It uses a copy of the current session: it expires together with your login (usually after a few hours), so click again when needed.': 'Un clic collega Claude Code a Insightest (progetti, test, esecuzioni, riparazioni) tramite il Model Context Protocol. Usa una copia della sessione corrente: scade insieme al login (di solito dopo qualche ora), quindi premi di nuovo quando serve.',
  'Configuration file': 'File di configurazione',
  'Registration command for Claude Code': 'Comando di registrazione per Claude Code',
  'For GitHub Copilot CLI or other MCP clients, use the same Node entry point ({path}) following your client\'s registration syntax.':
    'Per GitHub Copilot CLI o altri client MCP, usa lo stesso eseguibile Node ({path}) seguendo la sintassi di registrazione del client scelto.',
  'Revoked on {date}': 'Revocata il {date}',
  'Last used: {date}': 'Ultimo utilizzo: {date}',
  'Never used': 'Mai utilizzata',
  Revoke: 'Revoca',
  'Revoke key "{name}"? It will no longer be usable.': 'Revocare la chiave "{name}"? Non sarà più utilizzabile.',
  'Key name (e.g. Azure Pipelines)': 'Nome chiave (es. Azure Pipelines)',
  Generate: 'Genera',
  'Loading API keys…': 'Caricamento API key…',
  'Could not copy to clipboard': 'Impossibile copiare negli appunti',
  'No active session: please sign in again.': 'Nessuna sessione attiva: effettua di nuovo il login.',

  // dashboard
  'New test': 'Nuovo test',
  'Registered tests': 'Test registrati',
  'Total runs': 'Esecuzioni totali',
  'Passed runs': 'Esecuzioni superate',
  'Failed runs': 'Esecuzioni fallite',
  'Tests never run': 'Test mai eseguiti',
  'Never run': 'Mai eseguito',
  Folders: 'Cartelle',
  'New folder at root': 'Nuova cartella nella radice',
  'New subfolder': 'Nuova sottocartella',
  'Delete folder (subfolders and tests move back to the root)': 'Elimina cartella (sottocartelle e test tornano alla radice)',
  'Folder name': 'Nome cartella',
  'Folder name (in {parent})': 'Nome cartella (in {parent})',
  'Folder name (root)': 'Nome cartella (radice)',
  'All tests': 'Tutti i test',
  'Search tests, tags or notes…': 'Cerca test, tag o note…',
  All: 'Tutti',
  Passed: 'Superato',
  Failed: 'Fallito',
  'All triggers': 'Tutte',
  Local: 'Locale',
  'CI/CD': 'CI/CD',
  'All tags': 'Tutti i tag',
  'No tests match the selected filters.': 'Nessun test corrisponde ai filtri selezionati.',
  Name: 'Nome',
  Source: 'Origine',
  Results: 'Esiti',
  Status: 'Stato',
  Running: 'In corso',
  Included: 'Incluso',
  Excluded: 'Escluso',
  'Click to exclude this test from the CI/CD pipeline': 'Clic per escludere questo test dalla pipeline CI/CD',
  'Click to include this test in the CI/CD pipeline': 'Clic per includere questo test nella pipeline CI/CD',
  'Requires a passing (green) local run before it can be included in CI/CD':
    'Richiede un\'ultima esecuzione locale superata (verde) prima di poter essere incluso in CI/CD',
  'Open details': 'Apri dettaglio',
  'Delete test': 'Elimina test',
  'Self-healing': 'Self-healing',
  'Set a base URL for this project (Projects screen) to enable automatic repair of broken selectors.':
    'Imposta un URL base per questo progetto (schermata Progetti) per abilitare la riparazione automatica dei selettori rotti.',
  'Checking baseline status…': 'Verifica stato baseline…',
  'No baseline: build the site reference map before a broken test can be repaired.':
    'Nessuna baseline: crea la mappa di riferimento del sito prima di poter riparare un test rotto.',
  'Baseline available: failed tests can be analyzed and repaired.': 'Baseline presente: i test falliti possono essere analizzati e riparati.',
  'Capturing…': 'Cattura in corso…',
  'Update baseline': 'Aggiorna baseline',
  'Build baseline now': 'Crea baseline ora',
  'Runs summary': 'Recap esecuzioni',
  'Run sources': 'Origine esecuzioni',
  'Local / manual': 'Locale / manuale',
  success: 'successo',
  'Failed: {n}': 'Falliti: {n}',
  'Passed: {n}': 'Superati: {n}',
  'Set a base URL for the project first (Projects screen) to enable self-healing.':
    'Imposta prima un URL base per il progetto (schermata Progetti) per abilitare il self-healing.',
  'Baseline updated: {captured} tests captured': 'Baseline aggiornata: {captured} test catturati',
  ', {failed} not reached (see log)': ', {failed} non raggiunti (vedi log)',
  'Error while building the baseline': 'Errore durante la creazione della baseline',
  'Error while creating the folder': 'Errore durante la creazione della cartella',
  'Error while deleting the folder': "Errore durante l'eliminazione della cartella",
  'Error while deleting the test': "Errore durante l'eliminazione del test",
  'Error while updating the test': "Errore durante l'aggiornamento del test",
  'Delete folder "{name}"? Subfolders and tests inside it will move back to the root.':
    'Eliminare la cartella "{name}"? Le sottocartelle e i test contenuti torneranno alla radice.',
  'Permanently delete test "{name}" and its whole run history?':
    'Eliminare definitivamente il test "{name}" e tutto il suo storico di esecuzioni?',
  '"{name}": to include a test in CI/CD its last local run must be passing (green). Run it locally and try again.':
    '"{name}": per includere un test in CI/CD l\'ultima esecuzione locale deve essere superata (verde). Esegui il test in locale e riprova.',
  'Loading tests…': 'Caricamento test…',

  // new test form
  'describe the test here': 'descrivi qui il test',
  'Test name': 'Nome del test',
  'Steps description': 'Descrizione passaggi',
  'Descriptive prompt (also used by Jev/browser-use for self-healing)': 'Prompt descrittivo (usato anche da Jev/browser-use in caso di self-healing)',
  'Record a test in the browser (Playwright codegen)': 'Registra un test nel browser (Playwright codegen)',
  'Recording… (close the browser to finish)': 'Registrazione in corso… (chiudi il browser per terminare)',
  Record: 'Registra',
  'Recording…': 'Registrazione…',
  'Playwright code': 'Codice Playwright',
  'Insert wait step': 'Inserisci punto di attesa',
  '(useful when the app does not respond right away)': "(utile se l'app non risponde subito)",
  '(inserted at the cursor, useful when the app does not respond right away)':
    "(inserito nel punto del cursore, utile se l'app non risponde subito)",
  'Save test': 'Salva test',
  'Saving…': 'Salvataggio…',
  'Name and Playwright code are required': 'Nome e codice Playwright sono obbligatori',
  'No actions recorded (browser closed without interacting)': 'Nessuna azione registrata (browser chiuso senza interagire)',
  'Error while recording': 'Errore durante la registrazione',
  'https://example.com': 'https://esempio.com',

  // AI assistant
  'Generate the test with Claude': 'Genera il test con Claude',
  'Checking Claude Code and the MCP server…': 'Verifica di Claude Code e del server MCP in corso…',
  'Claude Code not found: install the `claude` CLI and make sure it is on the app PATH.': "Claude Code non trovato: installa la CLI `claude` e assicurati che sia nel PATH dell'app.",
  'The "insightest" MCP server is not registered in Claude Code: generate the command from the "API Keys" screen (AI agents (MCP)), run it, then reopen this screen.': 'Server MCP "insightest" non registrato in Claude Code: genera il comando dalla schermata "API Keys" (Agenti AI (MCP)) ed eseguilo, poi riapri questa schermata.',
  'Fix the test with Claude': 'Correggi il test con Claude',
  'Describe what the test should verify: the agent knows the project code':
    "Descrivi cosa deve verificare il test: l'agente conosce il codice del progetto",
  'Describe what is not working (optional): the agent receives the current code and the last run log':
    "Descrivi cosa non funziona (opzionale): l'agente riceve il codice attuale e il log dell'ultima esecuzione",
  ' (no repo_path set on the project: it will not be able to read the code)':
    ' (nessun repo_path impostato nel progetto: non potrà leggere il codice)',
  ' and uses a real Playwright browser to try the app and verify the test.': " e usa un browser Playwright reale per provare l'app e verificare il test.",
  'E.g. Log in with a valid user and check that the dashboard appears': 'Es. Fai login con un utente valido e verifica che compaia la dashboard',
  'E.g. The "Sign in" button changed its label, update the selectors': 'Es. Il pulsante "Accedi" ha cambiato etichetta, aggiorna i selettori',
  'Claude is working…': 'Claude al lavoro…',
  Fix: 'Correggi',
  'Describe the test to generate.': 'Descrivi il test da generare.',
  'Proposed code inserted in the editor: review it, run it, then save.': "Codice proposto inserito nell'editor: controllalo, eseguilo e poi salva.",
  'The agent returned no code (exit {code}). See the log below.': "L'agente non ha restituito codice (uscita {code}). Vedi il log qui sotto.",
  'Error while running the agent': "Errore durante l'esecuzione dell'agente",

  // test detail
  'Edit test': 'Modifica test',
  Description: 'Descrizione',
  Folder: 'Cartella',
  '(none / root)': '(nessuna / radice)',
  'Run first (same session/browser)': 'Esegui prima (stessa sessione/browser)',
  '(none)': '(nessuno)',
  'If set, the local run first executes the steps of the chosen test (e.g. a login) in the same session, without duplicating them in this test\'s code.':
    "Se impostato, l'esecuzione locale lancia prima i passaggi del test scelto (es. un login), nella stessa sessione, senza duplicarli nel codice di questo test.",
  'Include in CI/CD runs': 'Includi nelle esecuzioni CI/CD',
  'The last local run must be passing (green) before this test can be included in CI/CD.':
    "L'ultima esecuzione locale deve essere superata (verde) prima di poter includere questo test in CI/CD.",
  'Re-record in the browser (Playwright codegen)': 'Ri-registra nel browser (Playwright codegen)',
  'Included in CI/CD': 'Incluso in CI/CD',
  'Excluded from CI/CD': 'Escluso da CI/CD',
  'Pause between actions during the local run, so you can follow it by eye': "Pausa tra un'azione e l'altra durante l'esecuzione locale, per poterla seguire a occhio",
  'ms/action': 'ms/azione',
  Headed: 'Headful',
  'Re-run': 'Rirunna',
  'Running…': 'Esecuzione…',
  '{n} actions': '{n} azioni',
  'Test code': 'Codice del test',
  'Hide code': 'Nascondi codice',
  'Show code': 'Mostra codice',
  Executed: 'Eseguita',
  'Failed step': 'Fallita',
  'Not executed': 'Non eseguita',
  'Steps in progress': 'Passaggi in corso',
  'Steps of the last run': "Passaggi dell'ultima esecuzione",
  'Waiting for the first step…': 'In attesa del primo passaggio...',
  'Last local run log': 'Log ultima esecuzione locale',
  'Test notes': 'Note del test',
  'Add a note…': 'Aggiungi una nota...',
  'Save note': 'Salva nota',
  Tags: 'Tag',
  'Add tag…': 'Aggiungi tag...',
  'Test history': 'Storico test',
  Settings: 'Impostazioni',
  Documentation: 'Documentazione',
  'Latest runs': 'Ultime esecuzioni',
  'No runs recorded.': 'Nessuna esecuzione registrata.',
  '{n}% success': '{n}% successo',
  'Run calendar': 'Calendario esecuzioni',
  'Run history': 'Storico run',
  'No runs match the filter.': 'Nessuna esecuzione corrisponde al filtro.',
  Analyze: 'Analizza',
  'Analyzing…': 'Analisi...',
  Repair: 'Ripara',
  'Repairing…': 'Riparazione...',
  'Set a base URL for the project to enable self-healing': 'Imposta un URL base per il progetto per abilitare il self-healing',
  'Set the local repo path for the project (Projects screen)': 'Imposta il percorso locale del repo per il progetto (schermata Progetti)',
  'Delegate to {agent}': 'Delega a {agent}',
  'Run {agent}?': "Confermi l'esecuzione di {agent}?",
  'It will run locally in the folder {path} and may modify/commit repository files to fix the bug that makes this test fail.':
    'Verrà eseguito localmente nella cartella {path} e potrà modificare/committare file del repository per correggere il bug che fa fallire questo test.',
  'Confirm and run': 'Conferma ed esegui',
  'Repair result': 'Esito riparazione',
  '✅ The repaired version was re-run and passes.': '✅ La versione riparata è stata rieseguita e passa.',
  '⚠️ The repaired version has not been verified (yet): re-run it before trusting it.':
    '⚠️ La versione riparata non è stata (ancora) verificata: rieseguila prima di fidarti.',
  'Apply repair': 'Applica riparazione',
  Discard: 'Scarta',
  'Result of the repair delegated to the agent': "Esito riparazione delegata all'agente",
  'Exited with code {code}. Review the repository changes with your usual git tool before trusting them; re-run the test to check that it now passes.':
    'Uscito con codice {code}. Rivedi le modifiche al repository con il tuo strumento git abituale prima di fidartene; rilancia il test per verificare che ora passi.',
  'Test details': 'Dettagli test',
  'Created on': 'Creato il',
  'Last updated': 'Ultimo aggiornamento',
  'Included in CI/CD runs': 'Incluso nelle esecuzioni CI/CD',
  'Excluded from CI/CD runs': 'Escluso dalle esecuzioni CI/CD',
  'No documentation available for this test.': 'Nessuna documentazione disponibile per questo test.',
  'Unable to load the test.': 'Impossibile caricare il test.',
  'Loading test…': 'Caricamento test...',
  'No verdict returned by the healing engine': 'Nessun verdetto restituito dal motore di healing',
  'Error while analyzing': "Errore durante l'analisi di healing",
  'Error while repairing': 'Errore durante la riparazione',
  'Error while applying the repair': "Errore durante l'applicazione della riparazione",
  'Error while running the repair delegated to the agent': "Errore durante la riparazione delegata all'agente",
  'Set a base URL for the project (Projects screen) to enable self-healing.':
    'Imposta un URL base per il progetto (schermata "Progetti") per abilitare il self-healing.',
  '{n} run(s)': '{n} esecuzioni',
  '{date} — {n} runs': '{date} — {n} esecuzioni',
  '{date} — 1 run': '{date} — 1 esecuzione',
  OK: 'OK',
  Error: 'Errore',


  // members & invitations
  Invitations: 'Inviti',
  'Pending invitations': 'Inviti in sospeso',
  'You have no pending invitations.': 'Non hai inviti in sospeso.',
  'Invitations you receive to join organizations and projects appear here.': 'Gli inviti a unirti a organizzazioni e progetti compaiono qui.',
  Accept: 'Accetta',
  Decline: 'Rifiuta',
  'Invited by {name}': 'Invitato da {name}',
  'Join the organization {name}': "Unisciti all'organizzazione {name}",
  'Join the project {name}': 'Unisciti al progetto {name}',
  'in {org}': 'in {org}',
  'as {role}': 'come {role}',
  'New invitation': 'Nuovo invito',
  '{who} invited you to {target}': '{who} ti ha invitato a {target}',
  'the organization {name}': "l'organizzazione {name}",
  'the project {name}': 'il progetto {name}',
  'Members and invitations': 'Membri e inviti',
  Members: 'Membri',
  'Invite by email': 'Invita via email',
  'Email address': 'Indirizzo email',
  Invite: 'Invita',
  'Invitation sent to {email}': 'Invito inviato a {email}',
  'Pending': 'In sospeso',
  'Cancel invitation': 'Annulla invito',
  'Remove member': 'Rimuovi membro',
  'Remove {name} from {target}?': 'Rimuovere {name} da {target}?',
  'via organization': 'tramite organizzazione',
  'You': 'Tu',
  'Shared with you': 'Condivisi con te',
  'Projects you were invited to directly.': 'Progetti a cui sei stato invitato direttamente.',
  'Only administrators can manage members and invitations.': 'Solo gli amministratori possono gestire membri e inviti.',
  'The invitee will see the invitation in the app when signing in with this email.': "L'invitato vedrà l'invito nell'app accedendo con questa email.",
  administrator: 'amministratore',
  Owner: 'Proprietario',
  Administrator: 'Amministratore',
  Member: 'Membro',
  Role: 'Ruolo',
  'Members and invitations — {name}': 'Membri e inviti — {name}',

  // step verbs / labels
  Load: 'Carica',
  Click: 'Clic',
  Type: 'Scrivi',
  Check: 'Seleziona',
  Choose: 'Scegli',
  Press: 'Premi',
  Wait: 'Attendi',
  Action: 'Azione',
  element: 'elemento',
  field: 'campo',
  checkbox: 'checkbox',
  select: 'select',
  key: 'tasto',
};

export function t(key: string, vars?: Record<string, string | number>): string {
  let out = locale === 'it' ? (IT[key] ?? key) : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}

export function formatDateTime(value: string | number | Date): string {
  return new Date(value).toLocaleString(locale === 'it' ? 'it-IT' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatDate(value: string | number | Date): string {
  return new Date(value).toLocaleDateString(locale === 'it' ? 'it-IT' : 'en-US', { dateStyle: 'medium' });
}

/** Mon..Sun short weekday names in the active locale. */
export function weekdayLabels(): string[] {
  const fmt = new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-US', { weekday: 'short' });
  // 2024-01-01 is a Monday.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
}
