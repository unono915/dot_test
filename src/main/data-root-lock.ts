import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const LOCK_FILE_NAME = 'instance.lock';

export class DataRootLockedError extends Error {
  constructor() {
    super('다른 프로그램이 이 데이터 폴더를 사용 중입니다.');
    this.name = 'DataRootLockedError';
  }
}

export interface DataRootLock {
  release(): void;
}

/**
 * Holds an OS-level exclusive SQLite lock on `<dataRoot>/instance.lock` for the life of the
 * process. The OS drops the lock if the process dies, so a crash never leaves a stale lock.
 */
export function acquireDataRootLock(dataRoot: string): DataRootLock {
  fs.mkdirSync(dataRoot, { recursive: true });
  const db = new Database(path.join(dataRoot, LOCK_FILE_NAME), { timeout: 0 });
  try {
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL)');
    // The write acquires the exclusive lock; EXCLUSIVE locking mode keeps it after commit.
    db.transaction(() => {
      db.exec('DELETE FROM holder');
      db.prepare('INSERT INTO holder VALUES (?)').run(process.pid);
    }).immediate();
  } catch (error) {
    db.close();
    if ((error as { code?: string }).code?.startsWith('SQLITE_BUSY') || (error as { code?: string }).code === 'SQLITE_LOCKED') {
      throw new DataRootLockedError();
    }
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      db.close();
    },
  };
}
