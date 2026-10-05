import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { launchApp, preloadPath, repoRoot, type LaunchedApp } from './support/launch';

let launched: LaunchedApp;

test.beforeEach(async () => {
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.close();
});

test('opens a Korean window from the local app://bundle origin with a hardened renderer', async () => {
  const { page, app } = launched;
  expect(page.url()).toBe('app://bundle/index.html');
  await expect(page).toHaveTitle('학교 정보자산 관리');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('학교 정보자산 관리');

  const exposed = await page.evaluate(() => ({
    process: typeof (globalThis as Record<string, unknown>).process,
    require: typeof (globalThis as Record<string, unknown>).require,
    ipcRenderer: typeof (globalThis as Record<string, unknown>).ipcRenderer,
    api: Object.keys((window as unknown as { schoolAsset: object }).schoolAsset).sort(),
    frozen: Object.isFrozen((window as unknown as { schoolAsset: object }).schoolAsset),
  }));
  expect(exposed).toEqual({ process: 'undefined', require: 'undefined', ipcRenderer: 'undefined', api: ['getAppInfo'], frozen: true });

  const prefs = await app.evaluate(({ BrowserWindow }) => {
    // getLastWebPreferences is a runtime API that Electron's typings do not declare.
    const wc = BrowserWindow.getAllWindows()[0]!.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> };
    const p = wc.getLastWebPreferences();
    const webrtc = BrowserWindow.getAllWindows()[0]!.webContents.getWebRTCIPHandlingPolicy();
    return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, webSecurity: p.webSecurity, webviewTag: p.webviewTag, nodeIntegrationInSubFrames: p.nodeIntegrationInSubFrames, webrtc };
  });
  expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, nodeIntegrationInSubFrames: false, webrtc: 'disable_non_proxied_udp' });

  // CSP blocks injected inline script and reports the violation.
  const csp = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective));
    const script = document.createElement('script');
    script.textContent = 'window.__injected = true';
    document.body.append(script);
    await new Promise((r) => setTimeout(r, 100));
    return { ran: (window as unknown as { __injected?: boolean }).__injected === true, violations };
  });
  expect(csp.ran).toBe(false);
  expect(csp.violations).toContain('script-src-elem');
});

test('renders app info obtained through the narrow preload API', async () => {
  const { page } = launched;
  const info = await page.evaluate(() => (window as unknown as { schoolAsset: { getAppInfo(): Promise<unknown> } }).schoolAsset.getAppInfo());
  expect(info).toMatchObject({ ok: true, data: { name: '학교 정보자산 관리', version: '0.1.0', electron: '44.5.1' } });
  // Proves the native SQLite addon loads inside the real Electron main process.
  expect((info as { data: { sqlite: string } }).data.sqlite).toMatch(/^3\.\d+\.\d+$/);
  await expect(page.getByTestId('sqlite-version')).toHaveText((info as { data: { sqlite: string } }).data.sqlite);
  await expect(page.getByTestId('app-version')).toHaveText('0.1.0');
});

test('rejects IPC from an unregistered webContents even with the same preload and origin', async () => {
  const { app } = launched;
  const result = await app.evaluate(async ({ BrowserWindow }, preload) => {
    const w = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await w.loadURL('app://bundle/index.html');
      return await w.webContents.executeJavaScript('window.schoolAsset.getAppInfo()');
    } finally {
      w.destroy();
    }
  }, preloadPath);
  expect(result).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: '허용되지 않은 요청입니다.' } });
});

test('blocks external navigation, new windows and downloads', async () => {
  const { page, app } = launched;
  await app.evaluate(({ session }) => {
    const g = globalThis as unknown as { __downloads: boolean[] };
    g.__downloads = [];
    session.defaultSession.on('will-download', (event) => g.__downloads.push(event.defaultPrevented));
  });

  for (const target of ['https://example.com/', 'file:///C:/Windows/win.ini', 'app://other/index.html']) {
    await page.evaluate((url) => {
      window.location.href = url;
    }, target);
    await page.waitForTimeout(500);
    expect(page.url()).toBe('app://bundle/index.html');
  }

  const opened = await page.evaluate(() => window.open('https://example.com/') === null);
  expect(opened).toBe(true);
  await page.waitForTimeout(300);
  expect(app.windows()).toHaveLength(1);

  await page.evaluate(() => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['합성'], { type: 'text/plain' }));
    a.download = 'synthetic.txt';
    document.body.append(a);
    a.click();
  });
  await page.waitForTimeout(800);
  const downloads = await app.evaluate(() => (globalThis as unknown as { __downloads: boolean[] }).__downloads);
  expect(downloads.length).toBeGreaterThan(0);
  expect(downloads.every((prevented) => prevented)).toBe(true);
});

test('denies permissions and sends no network requests from the renderer', async () => {
  const { page, app } = launched;
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    res.end('x');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/probe`;
  try {
    const outcome = await page.evaluate(async (target) => {
      const fetchFailed = await fetch(target).then(() => false, () => true);
      new Image().src = `${target}?img`;
      navigator.sendBeacon?.(`${target}?beacon`, 'x');
      const notification = await Notification.requestPermission();
      const media = await navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (e: Error) => e.name);
      return { fetchFailed, notification, media };
    }, url);
    expect(outcome.fetchFailed).toBe(true);
    expect(outcome.notification).toBe('denied');
    expect(outcome.media).not.toBe('granted');

    // Independent of the page CSP: even a main-process navigation to the network is cancelled
    // by the session request filter.
    const loadError = await app.evaluate(async ({ BrowserWindow }, target) => {
      const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
      try {
        await w.loadURL(`${target}?main-nav`);
        return null;
      } catch (error) {
        return String((error as Error).message);
      } finally {
        w.destroy();
      }
    }, url);
    expect(loadError).toMatch(/ERR_BLOCKED_BY_CLIENT/);
    await page.waitForTimeout(300);
    expect(hits).toBe(0);
  } finally {
    server.close();
  }
});

test('a second instance with the same profile exits and leaves one window', async () => {
  const { app, env } = launched;
  const electronPath = await app.evaluate(() => process.execPath);
  const second = spawn(electronPath, [repoRoot], { cwd: repoRoot, env, stdio: 'ignore' });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      second.kill();
      reject(new Error('second instance did not exit'));
    }, 20_000);
    second.once('exit', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  expect(code).toBe(0);
  expect(app.windows()).toHaveLength(1);
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()));
  expect(visible).toEqual([true]);
});

test('does not download spell-check dictionaries or other Chromium extras', async () => {
  const { app, page, userDataDir } = launched;
  // Typing Korean text is what triggers dictionary use in a default Chromium profile.
  await page.evaluate(() => {
    const input = document.createElement('textarea');
    input.setAttribute('spellcheck', 'true');
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.type('합성 자료 확인');
  await page.waitForTimeout(5_000);
  const spell = await app.evaluate(({ session }) => ({
    enabled: session.defaultSession.isSpellCheckerEnabled(),
    languages: session.defaultSession.getSpellCheckerLanguages(),
  }));
  expect(spell).toEqual({ enabled: false, languages: [] });
  const dictionaries = await readdir(path.join(userDataDir, 'Dictionaries')).catch(() => []);
  expect(dictionaries).toEqual([]);
});

test('the app:// handler serves only allowlisted files inside the bundle', async () => {
  const { app } = launched;
  // A junction inside the bundle that points at the repository root must not leak files.
  const junction = path.join(repoRoot, 'dist', 'renderer', 'leak');
  await rm(junction, { recursive: true, force: true });
  await symlink(repoRoot, junction, 'junction');
  await mkdir(path.join(repoRoot, 'dist', 'renderer', 'assets'), { recursive: true });
  try {
    const results = await app.evaluate(async ({ net }) => {
      const probe = async (url: string, method = 'GET') => {
        const res = await net.fetch(url, { method }).catch((e: Error) => e);
        if (res instanceof Error) return { status: res.message, csp: false, type: null };
        return { status: res.status, csp: res.headers.get('content-security-policy') !== null, type: res.headers.get('content-type') };
      };
      return {
        index: await probe('app://bundle/index.html'),
        root: await probe('app://bundle/'),
        junction: await probe('app://bundle/leak/package.json'),
        traversal: await probe('app://bundle/assets/%2e%2e/%2e%2e/package.json'),
        disallowedType: await probe('app://bundle/leak/node_modules/electron/dist/electron.exe'),
        post: await probe('app://bundle/index.html', 'POST'),
        otherHost: await probe('app://other/index.html'),
      };
    });
    expect(results.index).toEqual({ status: 200, csp: true, type: 'text/html; charset=utf-8' });
    expect(results.root.status).toBe(200);
    expect(results.junction.status).toBe(404);
    expect(results.traversal.status).toBe(404);
    expect(results.disallowedType.status).toBe(404);
    expect(results.post.status).toBe(405);
    expect(results.otherHost.status).toMatch(/ERR_BLOCKED_BY_CLIENT/);
  } finally {
    await rm(junction, { recursive: true, force: true });
  }
});
