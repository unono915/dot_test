import Database from 'better-sqlite3';

export type Db = Database.Database;

export interface OpenOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

/** Opens a SQLite file with the product's required safety PRAGMAs. */
export function openDatabase(file: string, options: OpenOptions = {}): Db {
  const db = new Database(file, { readonly: options.readonly ?? false, fileMustExist: options.fileMustExist ?? false, timeout: 5000 });
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = OFF');
  if (!options.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
  }
  return db;
}

export function pragmaSnapshot(db: Db) {
  return {
    foreign_keys: db.pragma('foreign_keys', { simple: true }) as number,
    trusted_schema: db.pragma('trusted_schema', { simple: true }) as number,
    journal_mode: db.pragma('journal_mode', { simple: true }) as string,
    synchronous: db.pragma('synchronous', { simple: true }) as number,
  };
}
