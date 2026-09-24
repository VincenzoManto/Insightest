import type { InsightestBridge } from './electron-bridge';

/** True when running inside Electron (preload exposed the bridge). Evaluated before the web shim installs. */
export const isDesktop = typeof window !== 'undefined' && !!window.insightest;

const AUTH_KEY = 'insightest.auth';
const desktopOnly = (): Promise<never> => Promise.reject(new Error('Disponibile solo nell\'app desktop.'));

// Browser fallback for the Electron preload bridge: auth lives in localStorage, and everything
// that needs the local machine (Playwright, agents, MCP, folder picker) is unavailable.
const webBridge: InsightestBridge = {
  auth: {
    save: async (payload) => {
      try { localStorage.setItem(AUTH_KEY, payload); } catch { /* storage blocked */ }
    },
    load: async () => {
      try { return localStorage.getItem(AUTH_KEY); } catch { return null; }
    },
    clear: async () => {
      try { localStorage.removeItem(AUTH_KEY); } catch { /* storage blocked */ }
    },
  },
  playwright: {
    run: desktopOnly,
    record: desktopOnly,
    augment: desktopOnly,
    heal: desktopOnly,
    baseline: desktopOnly,
    browserStatus: async () => false,
    installBrowser: desktopOnly,
    baselineExists: async () => false,
    healRepair: desktopOnly,
    onProgress: () => () => {},
  },
  agent: {
    detect: async () => ({ claude: false, copilot: false }),
    runRepair: desktopOnly,
    aiStatus: async () => ({ claude: false, insightestMcp: false, playwrightMcp: false }),
    aiTest: desktopOnly,
    aiCancel: async () => false,
  },
  dialog: { pickFolder: async () => null },
  mcp: { setup: desktopOnly },
};

if (!isDesktop) window.insightest = webBridge;
