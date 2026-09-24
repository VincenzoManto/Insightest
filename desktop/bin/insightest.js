#!/usr/bin/env node
/**
 * Bootstrapper for `npx insightest-desktop`.
 *
 * Every launch (npx or the desktop shortcut it creates):
 *   1. installs the app once into a persistent per-user folder (no reinstall on later runs);
 *   2. checks the npm registry and updates that install when a newer version exists;
 *   3. makes sure a desktop / Start-menu shortcut exists (Windows);
 *   4. starts the app detached, so the terminal is free again.
 * Offline or registry failures never block launching an existing install.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const PKG = 'insightest-desktop';
const APP_NAME = 'Insightest';
const ownRoot = path.resolve(__dirname, '..');

const installDir =
  process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), APP_NAME)
    : path.join(os.homedir(), '.insightest');
const installedRoot = path.join(installDir, 'node_modules', PKG);

const log = (msg) => console.log(`[insightest] ${msg}`);

function readVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${PKG}/latest`,
      { headers: { accept: 'application/json' }, timeout: 4000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).version || null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function npm(args, cwd) {
  return spawnSync('npm', args, { cwd, stdio: 'inherit', shell: true }).status === 0;
}

function install(version) {
  fs.mkdirSync(installDir, { recursive: true });
  const pj = path.join(installDir, 'package.json');
  if (!fs.existsSync(pj)) fs.writeFileSync(pj, JSON.stringify({ name: 'insightest-runtime', private: true }));
  const ok = npm(
    ['install', `${PKG}@${version}`, '--install-strategy=nested', '--no-audit', '--no-fund', '--loglevel=error'],
    installDir,
  );
  if (!ok) return false;
  // The app resolves playwright & co. from <app>/node_modules; if npm hoisted them, install them there.
  if (!fs.existsSync(path.join(installedRoot, 'node_modules', 'playwright-core'))) {
    return npm(['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], installedRoot);
  }
  return true;
}

function ensureShortcuts() {
  if (process.platform !== 'win32') return;
  const marker = path.join(installDir, '.shortcut-target');
  const target = path.join(installedRoot, 'bin', 'insightest.js');
  // Recreate only when missing or when the node/app location changed.
  const icon = path.join(installedRoot, 'bin', 'icon.ico');
  const stamp = `${process.execPath}|${target}|${icon}`;
  try {
    if (fs.readFileSync(marker, 'utf8') === stamp) {
      const desktop = path.join(os.homedir(), 'Desktop', `${APP_NAME}.lnk`);
      const oneDriveDesktop = path.join(process.env.OneDrive || '', 'Desktop', `${APP_NAME}.lnk`);
      if (fs.existsSync(desktop) || fs.existsSync(oneDriveDesktop)) return;
    }
  } catch {
    /* no marker yet */
  }
  const ps = `
$ws = New-Object -ComObject WScript.Shell
$dirs = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'))
foreach ($d in $dirs) {
  $s = $ws.CreateShortcut((Join-Path $d '${APP_NAME}.lnk'))
  $s.TargetPath = $env:IT_NODE
  $s.Arguments = '"' + $env:IT_SCRIPT + '"'
  $s.WorkingDirectory = $env:IT_DIR
  $s.IconLocation = $env:IT_ICON
  $s.WindowStyle = 7
  $s.Description = 'Insightest'
  $s.Save()
}`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    env: { ...process.env, IT_NODE: process.execPath, IT_SCRIPT: target, IT_DIR: installDir, IT_ICON: icon },
    stdio: 'ignore',
  });
  if (r.status === 0) {
    fs.writeFileSync(marker, stamp);
    log('Shortcut created on the Desktop and in the Start menu.');
  }
}

async function main() {
  const installed = readVersion(installedRoot);
  const latest = await fetchLatestVersion();

  if (latest && latest !== installed) {
    log(installed ? `Updating ${installed} -> ${latest} ...` : `Installing ${PKG}@${latest} (first run only) ...`);
    if (!install(latest)) log('Install/update failed.');
  }

  // Fall back to the copy npx itself downloaded if the persistent install is unusable (e.g. offline first run).
  const root = readVersion(installedRoot) ? installedRoot : ownRoot;
  const electronExe = require(require.resolve('electron', { paths: [root, ownRoot] }));

  if (root === installedRoot) ensureShortcuts();

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronExe, [root, ...process.argv.slice(2)], { detached: true, stdio: 'ignore', env });
  child.unref();
  log(`Started ${APP_NAME} ${readVersion(root)}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
