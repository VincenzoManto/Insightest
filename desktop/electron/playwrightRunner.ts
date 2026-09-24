import { app } from 'electron';
import * as path from 'path';
import { initRunnerPaths } from './runnerCore';

// The Electron main process supplies its own paths (app root for node_modules resolution,
// userData for persistent ia-qa-heal state); the standalone MCP server does the same via its
// own entry point. See desktop/electron/runnerCore.ts for the actual (Electron-agnostic) logic.
initRunnerPaths({
  appRoot: app.getAppPath(),
  userDataDir: app.getPath('userData'),
  liveReporterPath: path.join(__dirname, 'liveReporter.js').replace(/\\/g, '/'),
});

export * from './runnerCore';

