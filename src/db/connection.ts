/**
 * PayGuard — Milestone M1: Core Brain
 * M1-T2: SQLite Database Connection & Migration Runner
 *
 * Implements:
 * - Database initialization with WAL mode and foreign key enforcement
 * - Idempotent migration runner tracking schema_migrations
 * - Transaction execution helper with safe BEGIN IMMEDIATE support
 * - Integration with validated configuration from M1-T1
 */

import Database, { type Database as DatabaseInstance } from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfig } from '../config/index.js';
import { MIGRATIONS } from './schema.js';

export type Database = DatabaseInstance;

export interface DatabaseOptions {
  readonly path?: string;
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
  readonly timeout?: number;
  readonly verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void;
}

/**
 * Initializes and configures an embedded SQLite database connection.
 *
 * @param options - Custom connection options or file path. If omitted, uses M1-T1 config.
 * @returns Configured better-sqlite3 Database instance
 */
export function createDatabase(options?: string | DatabaseOptions): DatabaseInstance {
  const dbPath = typeof options === 'string'
    ? options
    : options?.path || getConfig().databasePath;

  const isMemory = dbPath === ':memory:' || dbPath.startsWith('file::memory:');

  if (!isMemory) {
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const dbOptions: Database.Options = typeof options === 'object' ? {
    readonly: options.readonly,
    fileMustExist: options.fileMustExist,
    timeout: options.timeout ?? 5000,
    verbose: options.verbose,
  } : {
    timeout: 5000,
  };

  const db = new Database(dbPath, dbOptions);

  // Enforce foreign key constraints strictly per Plan
  db.pragma('foreign_keys = ON');

  // Use WAL mode for file-backed databases for concurrent readers and atomic write transactions
  if (!isMemory) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }

  return db;
}

/**
 * Executes a migration runner over the database.
 * Ensures the schema_migrations table exists, applies pending migrations
 * in version order inside transactions, and records applied versions.
 *
 * @param db - The database instance
 * @returns Number of newly applied migrations
 */
export function runMigrations(db: DatabaseInstance): number {
  // Ensure schema_migrations exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>;
  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  let appliedCount = 0;

  for (const migration of MIGRATIONS) {
    if (!appliedVersions.has(migration.version)) {
      const applyMigrationTx = db.transaction(() => {
        db.exec(migration.up);
        db.prepare(`
          INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (?, ?, datetime('now'))
        `).run(migration.version, migration.name);
      });

      applyMigrationTx.immediate();
      appliedCount++;
    }
  }

  return appliedCount;
}

/**
 * Runs a callback inside a BEGIN IMMEDIATE transaction to prevent
 * concurrency deadlocks during write operations.
 *
 * @param db - The database instance
 * @param fn - The operations to perform inside the transaction
 * @returns The result of the callback
 */
export function runInTransaction<T>(db: DatabaseInstance, fn: () => T): T {
  const tx = db.transaction(fn);
  return tx.immediate();
}
