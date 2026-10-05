import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataRootLockedError, acquireDataRootLock } from '../../src/main/data-root-lock';

const holderScript = `
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], { timeout: 0 });
db.pragma('locking_mode = EXCLUSIVE');
db.exec('CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL)');
db.prepare('INSERT INTO holder VALUES (?)').run(process.pid);
process.stdout.write('held\\n');
setInterval(() => {}, 1000);
`;

function holdInChild(lockFile: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', holderScript, lockFile], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.once('error', reject);
    child.stdout!.once('data', (chunk) => (String(chunk).includes('held') ? resolve(child) : reject(new Error(String(chunk)))));
  });
}

function waitExit(child: ChildProcess) {
  return new Promise<void>((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', () => resolve())));
}

describe('data root lock', () => {
  let dir: string;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'school-asset-lock-'));
  });

  afterEach(async () => {
    for (const c of children.splice(0)) {
      c.kill();
      await waitExit(c);
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('is exclusive within one process and releasable', () => {
    const first = acquireDataRootLock(dir);
    expect(() => acquireDataRootLock(dir)).toThrow(DataRootLockedError);
    first.release();
    const again = acquireDataRootLock(dir);
    again.release();
  });

  it('refuses a data root held by another process', async () => {
    const child = await holdInChild(path.join(dir, 'instance.lock'));
    children.push(child);
    expect(() => acquireDataRootLock(dir)).toThrow(DataRootLockedError);
  });

  it('becomes available again after the holder process is killed (crash release)', async () => {
    const child = await holdInChild(path.join(dir, 'instance.lock'));
    child.kill('SIGKILL');
    await waitExit(child);
    const lock = acquireDataRootLock(dir);
    lock.release();
  });

  it('holds the lock until released, blocking the other process', async () => {
    const lock = acquireDataRootLock(dir);
    const probe = spawn(
      process.execPath,
      [
        '-e',
        `const D=require('better-sqlite3');const db=new D(process.argv[1],{timeout:0});` +
          `try{db.pragma('locking_mode = EXCLUSIVE');db.exec('BEGIN EXCLUSIVE');process.exit(0)}catch(e){process.exit(e.code==='SQLITE_BUSY'?3:4)}`,
        path.join(dir, 'instance.lock'),
      ],
      { stdio: 'inherit' },
    );
    const code = await new Promise<number | null>((resolve) => probe.once('exit', resolve));
    lock.release();
    expect(code).toBe(3);
  });
});
