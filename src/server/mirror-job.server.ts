/**
 * Compare with WeTrakr runs on the server as a job, not as one long request: a phone that goes to
 * sleep (or a closed page) no longer loses it. The page starts a job and then only asks how it is
 * going; opening the screen again picks up the running job, or its finished result.
 *
 * One job per user at a time, kept in memory: a server restart forgets it, and the screen then
 * simply starts a fresh comparison.
 */
import { createBackup } from "./backup.server.ts";
import { buildMirror, runMirror, toPublic, type MirrorChoice, type MirrorItem, type ReadProgress } from "./mirror.server.ts";
import { logError, redactText } from "./redact.server.ts";
import type { Remote } from "./sync-push.server.ts";

export type MirrorJob = {
  kind: "compare" | "apply";
  state: "running" | "done" | "error";
  startedAt: string;
  finishedAt: string | null;
  /** "reading" (WeTrakr, for a comparison) or, for Apply: "backup", "checking", "bringing in", "sending". */
  phase: string;
  /** How far reading WeTrakr has got. */
  read: ReadProgress | null;
  /** Sending: requests done of total. */
  current: number;
  total: number;
  /** A finished comparison. */
  items?: MirrorItem[];
  notes?: string[];
  /** A finished Apply. */
  summary?: Record<string, number>;
  /** What went wrong. An Apply can also finish with problems while some of it went through. */
  problems?: string[];
};

const jobs = new Map<string, MirrorJob>();

export function getMirrorJob(userId: string): MirrorJob | null {
  return jobs.get(userId) ?? null;
}

/** Forget a finished job (the screen's Done). A running one is left alone. */
export function clearMirrorJob(userId: string): void {
  if (jobs.get(userId)?.state !== "running") jobs.delete(userId);
}

function begin(userId: string, kind: MirrorJob["kind"], phase: string): MirrorJob | null {
  if (jobs.get(userId)?.state === "running") return null;
  const job: MirrorJob = {
    kind, state: "running", startedAt: new Date().toISOString(), finishedAt: null, phase, read: null, current: 0, total: 0,
  };
  jobs.set(userId, job);
  return job;
}

function fail(job: MirrorJob, what: string, e: unknown): void {
  logError(`Compare with WeTrakr: ${what} failed`, e);
  job.problems = [...(job.problems ?? []), redactText(e instanceof Error ? e.message : `${what} failed`)];
  job.state = "error";
  job.finishedAt = new Date().toISOString();
}

/** Start comparing, unless something is already running (then that job is returned as it is). */
export function startMirrorCompare(userId: string, connect: () => Promise<Remote>): MirrorJob {
  const job = begin(userId, "compare", "reading");
  if (!job) return jobs.get(userId)!;
  void (async () => {
    try {
      const { entries, notes } = await buildMirror(userId, await connect(), (p) => (job.read = p));
      job.items = entries.map(toPublic);
      job.notes = notes;
      job.state = "done";
      job.finishedAt = new Date().toISOString();
    } catch (e) {
      fail(job, "comparing", e);
    }
  })();
  return job;
}

/** Apply the ticked lines: a backup first, then the same steps as before, reported as they happen. */
export function startMirrorApply(userId: string, connect: () => Promise<Remote>, choices: MirrorChoice[]): MirrorJob {
  const job = begin(userId, "apply", "backup");
  if (!job) return jobs.get(userId)!;
  void (async () => {
    try {
      const remote = await connect();
      await createBackup("before-sync");
      for await (const evt of runMirror(userId, remote, choices, (p) => (job.read = p))) {
        if (evt.type === "phase") {
          job.phase = evt.phase;
          job.current = 0;
          job.total = evt.total;
        } else if (evt.type === "progress") {
          job.current = evt.current;
          job.total = evt.total;
        } else if (evt.type === "done") {
          job.summary = evt.summary;
        } else if (evt.type === "error") {
          job.problems = [...(job.problems ?? []), evt.message];
        }
      }
      job.state = job.problems?.length ? "error" : "done";
      job.finishedAt = new Date().toISOString();
    } catch (e) {
      fail(job, job.phase === "backup" ? "saving a backup first (nothing was changed)" : "applying", e);
    }
  })();
  return job;
}
