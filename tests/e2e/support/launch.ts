import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const preloadPath = path.join(repoRoot, 'dist', 'preload', 'index.cjs');

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  env: NodeJS.ProcessEnv;
  close(): Promise<void>;
}

/** Launches the unpackaged app with an isolated synthetic profile directory. */
export async function launchApp(): Promise<LaunchedApp> {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'school-asset-e2e-'));
  const env: NodeJS.ProcessEnv = { ...process.env, SCHOOL_ASSET_DEV_USER_DATA: userDataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [repoRoot], cwd: repoRoot, env: env as Record<string, string> });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return {
    app,
    page,
    userDataDir,
    env,
    async close() {
      await app.close().catch(() => undefined);
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
