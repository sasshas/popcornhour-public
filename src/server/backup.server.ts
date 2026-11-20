/**
 * Local backups of the whole database: one file per backup, in a `backups` folder beside app.db
 * (so on Unraid it sits in the same mapped /data folder).
 *
 *  - A backup is made with SQLite's online backup API, so it is safe while the app is in use,
 *    then opened and checked before it is given its final name. A half-written file never counts.
 *  - Automatic backups run on a timer inside the server (daily or weekly). Old ones are thinned out:
 *    the newest 7, then one per week for 4 more weeks. Other kinds keep their newest 10.
 *  - Restore first takes a "before-restore" backup of the current data, so a restore can be undone.
 *
 * A backup holds everything in the database, including the Trakt connection tokens. Treat the
 * files like the database itself.
 */
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { closeDb, dbPath, getDb } from "./db.ts";
import { logError, logInfo } from "./redact.server.ts";

export const BACKUP_KINDS = ["manual", "auto", "before-restore", "before-import", "before-sync"] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];
export type BackupFrequency = "daily" | "weekly";

export type BackupInfo = { name: string; kind: BackupKind; createdAt: string; size: number };
export type BackupSettings = { auto: boolean; frequency: BackupFrequency };

/** popcornhour-20261115T062000Z-auto.db (the time is UTC). Backups made before the rename start with cinexplore- and still count. Also the only shape a file name may have. */
const NAME = /^(?:popcornhour|cinexplore)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-(manual|auto|before-restore|before-import|before-sync)\.db$/;

const KEEP_AUTO_RECENT = 7;
const KEEP_AUTO_WEEKLY = 4;
const KEEP_OTHER = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_MS: Record<BackupFrequency, number> = { daily: DAY_MS, weekly: 7 * DAY_MS };

export function backupDir(): string {
  return process.env.BACKUP_DIR ? resolve(process.env.BACKUP_DIR) : join(dirname(dbPath()), "backups");
}

function parseName(name: string): { kind: BackupKind; createdAt: string } | null {
  const m = NAME.exec(name);
  if (!m) return null;
  return { kind: m[7] as BackupKind, createdAt: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` };
}

function nameFor(at: Date, kind: BackupKind): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `popcornhour-${stamp}-${kind}.db`;
}

/** Full path of an existing backup. Throws on anything that is not a plain backup file name. */
export function backupPath(name: string): string {
  if (!parseName(name)) throw new Error("Not a backup file name");
  const file = join(backupDir(), name);
  if (!existsSync(file)) throw new Error("That backup no longer exists");
  return file;
}

/** Newest first. */
export function listBackups(): BackupInfo[] {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  const out: BackupInfo[] = [];
  for (const name of readdirSync(dir)) {
    const p = parseName(name);
    if (!p) continue;
    out.push({ name, ...p, size: statSync(join(dir, name)).size });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Opens the file and confirms it is a healthy Popcornhour database. Throws if not. */
function verify(file: string): void {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const check = db.pragma("quick_check", { simple: true });
    if (check !== "ok") throw new Error(`Backup failed its integrity check: ${String(check)}`);
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'library_items'").get();
    if (!table) throw new Error("Backup does not contain a library");
  } finally {
    db.close();
    // Reading a WAL-mode file can leave these beside it.
    for (const ext of ["-wal", "-shm"]) rmSync(file + ext, { force: true });
  }
}

// One backup or restore at a time.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function createBackupNow(kind: BackupKind): Promise<BackupInfo> {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  let at = new Date();
  while (existsSync(join(dir, nameFor(at, kind)))) at = new Date(at.getTime() + 1000);
  const name = nameFor(at, kind);
  const partial = join(dir, `${name}.partial`);
  try {
    await getDb().backup(partial);
    verify(partial);
    renameSync(partial, join(dir, name));
  } catch (e) {
    rmSync(partial, { force: true });
    throw e;
  }
  const info: BackupInfo = { name, ...parseName(name)!, size: statSync(join(dir, name)).size };
  logInfo(`[backup] created ${name} (${info.size} bytes)`);
  prune();
  return info;
}

export function createBackup(kind: BackupKind): Promise<BackupInfo> {
  return serial(() => createBackupNow(kind));
}

/** Which backups to delete, given all of them (newest first). Pure, so it can be tested. */
export function backupsToPrune(all: BackupInfo[]): string[] {
  const drop: string[] = [];
  const autos = all.filter((b) => b.kind === "auto");
  const weeks = new Set<number>();
  autos.forEach((b, i) => {
    if (i < KEEP_AUTO_RECENT) return;
    const week = Math.floor(Date.parse(b.createdAt) / (7 * DAY_MS));
    if (!weeks.has(week) && weeks.size < KEEP_AUTO_WEEKLY) weeks.add(week);
    else drop.push(b.name);
  });
  for (const kind of BACKUP_KINDS) {
    if (kind === "auto") continue;
    all.filter((b) => b.kind === kind).slice(KEEP_OTHER).forEach((b) => drop.push(b.name));
  }
  return drop;
}

function prune(): void {
  for (const name of backupsToPrune(listBackups())) {
    rmSync(join(backupDir(), name), { force: true });
    logInfo(`[backup] pruned ${name}`);
  }
}

export function deleteBackup(name: string): void {
  rmSync(backupPath(name));
  logInfo(`[backup] deleted ${name}`);
}

/**
 * Replace the live database with a backup. The current data is backed up first ("before-restore"),
 * and the backup settings in force now are kept rather than rolled back with the data.
 */
export function restoreBackup(name: string): Promise<{ safety: BackupInfo }> {
  return serial(async () => {
    const source = backupPath(name);
    verify(source);
    const safety = await createBackupNow("before-restore");
    const settings = getBackupSettings();
    const live = dbPath();
    const staged = `${live}.restore`;
    copyFileSync(source, staged);
    closeDb();
    try {
      for (const ext of ["-wal", "-shm"]) rmSync(live + ext, { force: true });
      renameSync(staged, live);
    } finally {
      rmSync(staged, { force: true });
      getDb(); // reopen (and bring an older backup up to the current schema)
    }
    // Changes that were waiting to be sent when that backup was made may have been sent since:
    // forget them rather than risk sending them twice.
    getDb().prepare("DELETE FROM sync_changes").run();
    setBackupSettings(settings);
    logInfo(`[backup] restored ${name} (previous data saved as ${safety.name})`);
    return { safety };
  });
}

// ---------- settings ----------

export function readSetting(key: string): string | undefined {
  const row = getDb().prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function writeSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .run(key, value);
}

export function getBackupSettings(): BackupSettings {
  return {
    auto: readSetting("backup.auto") !== "0", // on unless switched off
    frequency: readSetting("backup.frequency") === "weekly" ? "weekly" : "daily",
  };
}

export function setBackupSettings(s: Partial<BackupSettings>): BackupSettings {
  if (s.auto !== undefined) writeSetting("backup.auto", s.auto ? "1" : "0");
  if (s.frequency !== undefined) writeSetting("backup.frequency", s.frequency);
  return getBackupSettings();
}

// ---------- schedule ----------

/** Makes an automatic backup if one is due. Safe to call often. */
export async function runScheduledBackup(now = Date.now()): Promise<BackupInfo | null> {
  const { auto, frequency } = getBackupSettings();
  if (!auto) return null;
  const last = listBackups().find((b) => b.kind === "auto");
  // A few minutes of slack so a daily backup does not drift later each day.
  if (last && now - Date.parse(last.createdAt) < PERIOD_MS[frequency] - 10 * 60 * 1000) return null;
  return createBackup("auto");
}

const CHECK_EVERY_MS = 30 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;
const g = globalThis as { __popcornhourBackupTimer?: boolean };

/** Starts the timer once per server process (called when the database is first opened). */
export function startBackupScheduler(): void {
  if (g.__popcornhourBackupTimer) return;
  g.__popcornhourBackupTimer = true;
  const tick = () => {
    runScheduledBackup().catch((e) => logError("[backup] automatic backup failed", e));
  };
  setTimeout(tick, FIRST_CHECK_MS).unref();
  setInterval(tick, CHECK_EVERY_MS).unref();
}
