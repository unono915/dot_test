// Toolchain-only smoke. Synthetic temporary data; no product API or test hook.
const { app, BrowserWindow } = require('electron');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'school-asset-electron-probe-'));
app.setPath('userData', root);
app.setPath('sessionData', path.join(root, 'session'));
app.whenReady().then(async () => {
  const db = new Database(path.join(root, 'probe.sqlite'));
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = OFF');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.exec('CREATE TABLE smoke (value TEXT NOT NULL)');
  db.prepare('INSERT INTO smoke VALUES (?)').run('합성 검증');
  await db.backup(path.join(root, 'backup.sqlite'));
  const backup = new Database(path.join(root, 'backup.sqlite'), { readonly: true });
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await window.loadURL('data:text/html,<meta charset="utf-8"><title>도구 검증</title><p>합성 검증</p>');
  const renderer = await window.webContents.executeJavaScript(
    '({text:document.querySelector("p").textContent,node:typeof process,require:typeof require})',
  );
  const report = {
    electron: process.versions.electron,
    node: process.versions.node,
    sqlite: db.prepare('SELECT sqlite_version() AS version, sqlite_source_id() AS source_id').get(),
    pragmas: {
      foreign_keys: db.pragma('foreign_keys', { simple: true }),
      trusted_schema: db.pragma('trusted_schema', { simple: true }),
      journal_mode: db.pragma('journal_mode', { simple: true }),
      synchronous: db.pragma('synchronous', { simple: true }),
    },
    backup: backup.prepare('SELECT value FROM smoke').get(),
    renderer,
    webPreferences: window.webContents.getLastWebPreferences(),
  };
  console.log(JSON.stringify(report));
  backup.close();
  db.close();
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
