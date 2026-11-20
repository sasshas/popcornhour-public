import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MIGRATIONS } from "./schema.ts";

/** The app is single-user. Every row belongs to this id. */
export const USER_ID = "me";

const TABLES_WITH_UPDATED_AT = new Set([
  "profiles",
  "library_items",
  "lists",
  "trakt_connections",
  "wetrakr_connections",
  "parents_guide_cache",
]);

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

export function dbPath(): string {
  if (process.env.DB_PATH) return resolve(process.env.DB_PATH);
  return process.env.NODE_ENV === "production"
    ? "/data/app.db"
    : resolve(process.cwd(), "data", "app.db");
}

let _db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (_db) return _db;
  const file = dbPath();
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  _db = db;
  // The daily backup timer starts with the database. Imported lazily: backup.server.ts imports this file.
  void import("./backup.server.ts").then((m) => m.startBackupScheduler()).catch(() => {});
  return db;
}

/** Close the connection so the database file can be replaced (restore). The next getDb() reopens it. */
export function closeDb(): void {
  _db?.close();
  _db = undefined;
}

function migrate(db: Database.Database) {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  const now = nowIso();
  db.prepare(
    `INSERT OR IGNORE INTO profiles (id, user_id, display_name, created_at, updated_at)
     VALUES (?, ?, 'Me', ?, ?)`,
  ).run(newId(), USER_ID, now, now);
}

type Scalar = string | number | boolean | null | undefined;

function bind(v: Scalar): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

const IDENT = /^[a-z_]+$/;
function ident(s: string): string {
  if (!IDENT.test(s)) throw new Error(`Bad identifier: ${s}`);
  return s;
}

/**
 * INSERT ... ON CONFLICT(conflictCols) DO UPDATE, mirroring PostgREST upsert:
 * only the columns present in `row` are written on conflict (undefined values are
 * skipped entirely so column defaults / existing values are kept; null is written).
 * With ignoreDuplicates, an existing row is left untouched.
 * Returns the resulting row (undefined when ignored and a row already existed).
 */
export function upsertRow<T = Record<string, unknown>>(
  table: string,
  row: Record<string, Scalar>,
  conflictCols: string[],
  opts: { ignoreDuplicates?: boolean } = {},
): T | undefined {
  const db = getDb();
  const data: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(row)) if (v !== undefined) data[ident(k)] = v;
  if (!("id" in data) && table !== "parents_guide_cache") data.id = newId();
  const touch = TABLES_WITH_UPDATED_AT.has(table);
  if (touch && !("updated_at" in data)) data.updated_at = nowIso();

  const cols = Object.keys(data);
  const conflict = conflictCols.map(ident);
  const skip = new Set([...conflict, "id", "created_at", "connected_at"]);
  const updateCols = cols.filter((c) => !skip.has(c));

  let sql =
    `INSERT INTO ${ident(table)} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")}) ` +
    `ON CONFLICT(${conflict.join(",")}) `;
  sql +=
    opts.ignoreDuplicates || updateCols.length === 0
      ? "DO NOTHING"
      : `DO UPDATE SET ${updateCols.map((c) => `${c} = excluded.${c}`).join(", ")}`;
  sql += " RETURNING *";
  return db.prepare(sql).get(...cols.map((c) => bind(data[c]))) as T | undefined;
}

/** Run several statements atomically. */
export function transaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}
