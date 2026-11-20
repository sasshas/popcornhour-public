import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeftRight, CheckCircle2, Copy, Download, ExternalLink, Link2, Loader2, Unlink, Upload } from "lucide-react";
import { toast } from "sonner";
import { FloatingSheet } from "@/components/ui/floating-sheet";
import { Switch } from "@/components/ui/switch";
import { disconnectTrakt, importFromTrakt } from "@/lib/trakt.functions";
import {
  cancelWetrakrConnect, checkWetrakrConnect, disconnectWetrakr, importFromWetrakr, startWetrakrConnect,
} from "@/lib/wetrakr.functions";
import { getSyncState, setActiveService, setConfirmDeletions, type SyncService } from "@/lib/sync.functions";
import { Row } from "@/components/settings/BackupSection";
import { SyncPreview } from "@/components/settings/SyncPreview";
import { WetrakrCompare } from "@/components/settings/WetrakrCompare";

type ProgressState = {
  running: boolean;
  phase: string;
  current: number;
  total: number;
  done?: boolean;
  summary?: Record<string, number>;
};
type StreamEvent = {
  type: string;
  phase?: string;
  current?: number;
  total?: number;
  summary?: Record<string, number>;
  message?: string;
};

const idle: ProgressState = { running: false, phase: "", current: 0, total: 0 };
const ROWS = "divide-y divide-border/60 rounded-xl border border-border/60 px-4";
const NAME: Record<SyncService, string> = { trakt: "Trakt", wetrakr: "WeTrakr" };

/**
 * Settings -> Sync. "Where your library lives" lists the services the library can come
 * from; the active one is the only one that imports. (Backup has its own page, settings.backup.tsx.)
 */
export function SyncSection() {
  const qc = useQueryClient();
  const fetchState = useServerFn(getSyncState);
  const fetchSetActive = useServerFn(setActiveService);
  const fetchDisconnectTrakt = useServerFn(disconnectTrakt);
  const fetchDisconnectWetrakr = useServerFn(disconnectWetrakr);
  const fetchImportTrakt = useServerFn(importFromTrakt);
  const fetchImportWetrakr = useServerFn(importFromWetrakr);
  const fetchConfirmDeletions = useServerFn(setConfirmDeletions);
  const fetchCancel = useServerFn(cancelWetrakrConnect);

  const { data: state, isLoading } = useQuery({ queryKey: ["sync-state"], queryFn: () => fetchState() });
  const refresh = () => qc.invalidateQueries({ queryKey: ["sync-state"] });
  const active = state?.active ?? null;

  const [importing, setImporting] = useState<ProgressState>(idle);
  const [previewing, setPreviewing] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const busy = importing.running;
  // Every connected service gets the changes made here; the active one is only where Import reads from.
  const connected = (["trakt", "wetrakr"] as SyncService[]).filter((s) => state?.[s].connected);
  const syncNames = connected.map((s) => NAME[s]).join(" and ");
  const waiting = connected
    .filter((s) => (state?.pending[s] ?? 0) > 0)
    .map((s) => `${state?.pending[s]} for ${NAME[s]}`);

  const confirmDeletions = useMutation({
    mutationFn: (on: boolean) => fetchConfirmDeletions({ data: { on } }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });

  const makeActive = useMutation({
    mutationFn: (service: SyncService) => fetchSetActive({ data: { service } }),
    onSuccess: () => {
      setImporting(idle);
      setConfirmDisconnect(false);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const disconnect = useMutation({
    mutationFn: (service: SyncService) => (service === "trakt" ? fetchDisconnectTrakt() : fetchDisconnectWetrakr()),
    onSuccess: (_r, service) => {
      toast.success(`Disconnected from ${NAME[service]}`);
      setConfirmDisconnect(false);
      setImporting(idle); // the rows below now belong to the other service
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function runStream(
    streamFn: () => Promise<AsyncIterable<unknown>>,
    setProgress: (p: ProgressState) => void,
    label: string,
  ) {
    setProgress({ ...idle, running: true, phase: "starting" });
    try {
      let s: ProgressState = { ...idle, running: true };
      for await (const evt of (await streamFn()) as AsyncIterable<StreamEvent>) {
        if (evt.type === "phase") {
          s = { ...s, phase: evt.phase ?? "", current: 0, total: evt.total ?? 0 };
        } else if (evt.type === "progress") {
          s = { ...s, phase: evt.phase ?? s.phase, current: evt.current ?? 0, total: evt.total ?? s.total };
        } else if (evt.type === "done") {
          s = { ...s, running: false, done: true, summary: evt.summary };
          toast.success(`${label} complete`);
        } else if (evt.type === "error") {
          s = { ...s, running: false };
          toast.error(`${label} failed: ${evt.message ?? "unknown"}`);
          refresh();
        }
        setProgress({ ...s });
      }
      qc.invalidateQueries({ queryKey: ["library"] });
      qc.invalidateQueries({ queryKey: ["lists"] });
      qc.invalidateQueries({ queryKey: ["backups"] }); // an import saves a backup first
    } catch (e) {
      setProgress({ ...idle });
      toast.error(`${label} failed: ${e instanceof Error ? e.message : "unknown"}`);
      refresh();
    }
  }

  /** The right-hand side of a service row: Active badge, "Make active", or a Connect button. */
  function status(service: SyncService, connected: boolean, connect: ReactNode) {
    if (isLoading) return null;
    if (!connected) return connect;
    if (active === service) {
      return (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary">
          <CheckCircle2 className="size-3.5" /> Active
        </span>
      );
    }
    return (
      <button
        type="button"
        disabled={busy || makeActive.isPending}
        onClick={() => makeActive.mutate(service)}
        className="shrink-0 rounded-full bg-white/[0.07] px-3 py-1.5 text-xs font-medium hover:bg-white/[0.13] disabled:opacity-50"
      >
        Make active
      </button>
    );
  }

  const CONNECT =
    "inline-flex shrink-0 items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90";
  const wetrakr = state?.wetrakr;

  return (
    <>
      <h3 className="text-sm font-medium">Where your library lives</h3>
      <div className={`mt-2 ${ROWS}`}>
        <div className="flex items-center gap-3 py-3">
          <ServiceLogo letter="T" className="bg-[#ED1C24]/15 text-[#ED1C24]" />
          <ServiceName
            name="Trakt"
            detail={isLoading ? "Checking…" : state?.trakt.connected ? `@${state.trakt.username ?? "connected"}` : "Not connected"}
          />
          {status(
            "trakt",
            !!state?.trakt.connected,
            <a href="/api/public/trakt/start" target="_blank" rel="noopener noreferrer" className={CONNECT}>
              <Link2 className="size-4" /> Connect
            </a>,
          )}
        </div>
        <div className={`flex items-center gap-3 py-3${wetrakr && !wetrakr.configured ? " opacity-60" : ""}`}>
          <ServiceLogo letter="W" className="bg-sky-500/15 text-sky-400" />
          <ServiceName
            name="WeTrakr"
            detail={
              isLoading
                ? "Checking…"
                : wetrakr?.connected
                  ? wetrakr.username ? `@${wetrakr.username}` : "Connected"
                  : wetrakr?.configured
                    ? "Not connected"
                    : "Add your WeTrakr app key on the server to turn this on"
            }
          />
          {wetrakr?.configured &&
            status(
              "wetrakr",
              wetrakr.connected,
              <button type="button" onClick={() => setConnecting(true)} className={CONNECT}>
                <Link2 className="size-4" /> Connect
              </button>,
            )}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">The active one sets your library: Import reads from it. Changes you make here go to every connected service.</p>

      {active && (
        <div className={`mt-4 ${ROWS}`}>
          <div>
            <Row
              icon={importing.running ? <Loader2 className="size-5 animate-spin" /> : <Download className="size-5" />}
              title={`Import from ${NAME[active]}`}
              hint="Bring in watched history, watchlist, ratings and lists. Nothing is removed."
              disabled={busy}
              onClick={() =>
                runStream(active === "trakt" ? fetchImportTrakt : fetchImportWetrakr, setImporting, "Import")
              }
            />
            <Progress state={importing} />
          </div>
          <div>
            <Row
              icon={<Upload className="size-5" />}
              title={`Sync to ${syncNames}`}
              hint={
                waiting.length > 0
                  ? `Waiting: ${waiting.join(", ")}. You see the list before anything is sent.`
                  : "Nothing waiting. Only changes you make in this app are ever sent."
              }
              disabled={busy}
              onClick={() => setPreviewing(true)}
            />
          </div>
          {state?.wetrakr.connected && (
            <div>
              <Row
                icon={<ArrowLeftRight className="size-5" />}
                title="Compare with WeTrakr"
                hint="Everything here against everything on WeTrakr, both ways. You see the list first and can cancel."
                disabled={busy}
                onClick={() => setComparing(true)}
              />
            </div>
          )}
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="pl-9">
              <label htmlFor="confirm-deletions" className="text-sm font-medium">Confirm deletions</label>
              <p className="text-xs text-muted-foreground">
                Removals are only sent when you tick them in the list
              </p>
            </div>
            <Switch
              id="confirm-deletions"
              checked={state?.confirmDeletions ?? true}
              disabled={confirmDeletions.isPending}
              onCheckedChange={(on) => confirmDeletions.mutate(on)}
            />
          </div>
          <div>
            <Row
              icon={<Unlink className="size-5" />}
              title={`Disconnect ${NAME[active]}`}
              hint="Your library stays here. You can connect again later."
              disabled={busy || disconnect.isPending}
              onClick={() => setConfirmDisconnect(true)}
            />
            {confirmDisconnect && (
              <div className="flex gap-2 pb-3 pl-9">
                <button
                  type="button"
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate(active)}
                  className="inline-flex items-center gap-2 rounded-full bg-destructive px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                >
                  {disconnect.isPending && <Loader2 className="size-4 animate-spin" />}
                  Disconnect
                </button>
                <button
                  type="button"
                  disabled={disconnect.isPending}
                  onClick={() => setConfirmDisconnect(false)}
                  className="rounded-full bg-white/[0.07] px-4 py-2 text-sm"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <FloatingSheet
        open={connecting}
        onOpenChange={(open) => {
          setConnecting(open);
          if (!open) void fetchCancel().catch(() => {}); // closed early: forget the code on the server
        }}
        title="Connect WeTrakr"
      >
        {connecting && (
          <WetrakrConnect
            onDone={() => {
              setConnecting(false);
              refresh();
            }}
          />
        )}
      </FloatingSheet>

      <FloatingSheet open={previewing} onOpenChange={setPreviewing} title={syncNames ? `Sync to ${syncNames}` : "Sync"}>
        {previewing && active && <SyncPreview onClose={() => setPreviewing(false)} />}
      </FloatingSheet>

      <FloatingSheet open={comparing} onOpenChange={setComparing} title="Compare with WeTrakr">
        {comparing && <WetrakrCompare onClose={() => setComparing(false)} />}
      </FloatingSheet>

    </>
  );
}

function ServiceLogo({ letter, className }: { letter: string; className: string }) {
  return <div className={`grid size-10 shrink-0 place-items-center rounded-lg font-bold ${className}`}>{letter}</div>;
}

function ServiceName({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-sm font-medium">{name}</div>
      <div className="text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

/**
 * Signing in to WeTrakr with a short code: the app shows a code, you type it in on WeTrakr's own
 * site, and this panel notices when you have approved it. No password is ever typed here.
 */
function WetrakrConnect({ onDone }: { onDone: () => void }) {
  const fetchStart = useServerFn(startWetrakrConnect);
  const fetchCheck = useServerFn(checkWetrakrConnect);
  const [code, setCode] = useState<{ userCode: string; verificationUrl: string; interval: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // Ask for a code once when the panel opens (the ref stops a second request if React mounts this twice).
  const started = useRef<ReturnType<typeof fetchStart> | null>(null);
  useEffect(() => {
    let gone = false;
    (started.current ??= fetchStart())
      .then((r) => {
        if (gone) return;
        if (r.ok) setCode(r);
        else setProblem(r.message);
      })
      .catch(() => !gone && setProblem("Could not reach the server."));
    return () => {
      gone = true;
    };
  }, [fetchStart]);

  // While the code is showing, check every few seconds whether it has been approved.
  useEffect(() => {
    if (!code) return;
    let gone = false;
    const timer = setInterval(async () => {
      const r = await fetchCheck().catch(() => null);
      if (gone || !r || r.state === "pending") return;
      clearInterval(timer);
      if (r.state === "connected") {
        toast.success("WeTrakr connected");
        onDone();
      } else if (r.state === "expired") setProblem("The code ran out of time. Close this and try again.");
      else if (r.state === "denied") setProblem("The sign-in was declined on WeTrakr.");
      else if (r.state === "error") setProblem(r.message);
      else setProblem("The sign-in was cancelled. Close this and try again.");
    }, Math.max(3, code.interval) * 1000);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [code, fetchCheck, onDone]);

  if (problem) return <p className="text-sm text-muted-foreground">{problem}</p>;
  if (!code) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Getting a code…
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Open WeTrakr, type in this code and approve Popcornhour. This panel closes by itself when it is done.
      </p>
      <button
        type="button"
        onClick={() =>
          navigator.clipboard?.writeText(code.userCode).then(
            () => toast.success("Code copied"),
            () => {},
          )
        }
        aria-label="Copy the code"
        className="flex w-full items-center justify-center gap-3 rounded-2xl bg-white/[0.07] py-4"
      >
        <span className="font-mono text-3xl font-bold tracking-[0.2em]">{code.userCode}</span>
        <Copy className="size-5 text-muted-foreground" />
      </button>
      <a
        href={code.verificationUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-medium text-primary-foreground"
      >
        <ExternalLink className="size-4" /> Open {code.verificationUrl.replace(/^https?:\/\//, "")}
      </a>
      <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Waiting for you to approve it on WeTrakr…
      </p>
    </div>
  );
}

/** Progress bar and result line under an Import or Sync row. */
function Progress({ state }: { state: ProgressState }) {
  if (!state.running && !state.done) return null;
  const pct = state.total > 0 ? Math.min(100, Math.round((state.current / state.total) * 100)) : 0;
  return (
    <div className="space-y-1.5 pb-3 pl-9">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="capitalize">{state.done ? "Finished" : state.phase || "starting"}</span>
        <span>{state.running && state.total > 0 ? `${state.current} / ${state.total}` : ""}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-border">
        <div className="h-full bg-primary transition-all" style={{ width: `${state.done ? 100 : pct}%` }} />
      </div>
      {state.done && state.summary && (
        <div className="flex items-start gap-1.5 pt-1 text-xs text-muted-foreground">
          <CheckCircle2 className="mt-px size-3.5 shrink-0 text-emerald-500" />
          <span>{Object.entries(state.summary).map(([k, v]) => `${k}: ${v}`).join(" · ")}</span>
        </div>
      )}
    </div>
  );
}
