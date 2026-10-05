import Database from 'better-sqlite3';
import { BrowserWindow, Menu, app, dialog, ipcMain, session } from 'electron';
import path from 'node:path';
import { handleBundleProtocol, registerBundleScheme } from './bundle-protocol.js';
import { DataRootLockedError, acquireDataRootLock, type DataRootLock } from './data-root-lock.js';
import { IPC_CHANNELS, type AppInfo } from './ipc/contract.js';
import { createIpcRouter } from './ipc/router.js';
import { hardenSession, hardenWebContents } from './security/harden.js';
import { TrustedSenders } from './security/ipc-guard.js';
import { APP_ENTRY_URL } from './security/origin.js';

const APP_TITLE = '학교 정보자산 관리';

// Development/test only: isolate the profile in a synthetic directory. Ignored when packaged.
const devUserData = process.env.SCHOOL_ASSET_DEV_USER_DATA;
if (!app.isPackaged && devUserData) app.setPath('userData', path.resolve(devUserData));

registerBundleScheme();
app.enableSandbox();

const trusted = new TrustedSenders();
let mainWindow: BrowserWindow | null = null;
let dataRootLock: DataRootLock | null = null;

function readSqliteVersion(): string {
  const db = new Database(':memory:');
  try {
    return (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
  } finally {
    db.close();
  }
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: APP_TITLE,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  const id = win.webContents.id;
  trusted.register(id);
  win.webContents.once('destroyed', () => trusted.unregister(id));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  void win.loadURL(APP_ENTRY_URL);
  return win;
}

function registerIpc(appInfo: AppInfo): void {
  const route = createIpcRouter({
    trusted,
    handlers: { [IPC_CHANNELS.getAppInfo]: async () => appInfo },
    onInternalError: (errorId, channel, error) => console.error(`[ipc] ${channel} ${errorId}`, error),
  });
  for (const channel of Object.values(IPC_CHANNELS)) {
    ipcMain.handle(channel, (event, payload: unknown) => route(channel, event, payload));
  }
}

if (!app.requestSingleInstanceLock()) {
  // Another instance owns this profile; it will focus its window.
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));
  app.on('session-created', (ses) => hardenSession(ses));
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => dataRootLock?.release());

  void app.whenReady().then(() => {
    try {
      dataRootLock = acquireDataRootLock(path.join(app.getPath('userData'), 'data'));
    } catch (error) {
      const message = error instanceof DataRootLockedError ? error.message : '데이터 폴더를 열 수 없습니다.';
      dialog.showErrorBox(APP_TITLE, message);
      app.exit(1);
      return;
    }
    hardenSession(session.defaultSession);
    Menu.setApplicationMenu(null);
    handleBundleProtocol(path.join(app.getAppPath(), 'dist', 'renderer'));
    registerIpc({
      name: APP_TITLE,
      version: app.getVersion(),
      electron: process.versions.electron,
      sqlite: readSqliteVersion(),
    });
    mainWindow = createMainWindow();
  }).catch((error: unknown) => {
    console.error('[startup]', error);
    dialog.showErrorBox(APP_TITLE, '프로그램을 시작하지 못했습니다. 다시 실행해 주세요.');
    dataRootLock?.release();
    app.exit(1);
  });
}
