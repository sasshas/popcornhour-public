import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, type ReactNode } from "react";
import { Download, Folder, Loader2, RotateCcw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { FloatingSheet } from "@/components/ui/floating-sheet";
import { Switch } from "@/components/ui/switch";
import {
  backupNow, deleteBackup, getBackupState, restoreBackup, updateBackupSettings,
} from "@/lib/backup.functions";

type Backup = { name: string; kind: string; createdAt: string; size: number };

const KIND_LABEL: Record<string, string> = {
  manual: "Manual",
  auto: "Automatic",
  "before-restore": "Before a restore",
  "before-import": "Before an import",
  "before-sync": "Before a sync",
};

function when(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date} at ${time}`;
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Settings -> Backup: automatic local backups, Back up now, and the saved list. */
export function BackupPanel() {
  const qc = useQueryClient();
  const fetchState = useServerFn(getBackupState);
  const fetchUpdate = useServerFn(updateBackupSettings);
  const fetchBackupNow = useServerFn(backupNow);
  const [browsing, setBrowsing] = useState(false);

  const { data } = useQuery({ queryKey: ["backups"], queryFn: () => fetchState() });
  const refresh = () => qc.invalidateQueries({ queryKey: ["backups"] });

  const update = useMutation({
    mutationFn: (s: { auto?: boolean; frequency?: "daily" | "weekly" }) => fetchUpdate({ data: s }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  const backup = useMutation({
    mutationFn: () => fetchBackupNow(),
    onSuccess: () => {
      toast.success("Backup saved");
      refresh();
    },
    onError: (e: Error) => toast.error(`Backup failed: ${e.message}`),
  });

  const settings = data?.settings;
  const backups: Backup[] = data?.backups ?? [];
  const last = backups[0];

  return (
    <div>
      <div className="divide-y divide-border/60 rounded-xl border border-border/60 px-4">
        <div className="py-3">
          <div className="text-sm font-medium">Backup folder</div>
          <p className="break-all text-xs text-muted-foreground">{data?.folder ?? "…"}</p>
        </div>

        <div className="flex items-center justify-between gap-4 py-3">
          <div>
            <label htmlFor="auto-backup" className="text-sm font-medium">Automatic backup</label>
            <p className="text-xs text-muted-foreground">Save a backup to this folder on a schedule</p>
          </div>
          <Switch
            id="auto-backup"
            checked={settings?.auto ?? true}
            disabled={!settings}
            onCheckedChange={(auto) => update.mutate({ auto })}
          />
        </div>

        <button
          type="button"
          disabled={!settings?.auto}
          onClick={() => update.mutate({ frequency: settings?.frequency === "daily" ? "weekly" : "daily" })}
          className="flex w-full items-center justify-between gap-4 py-3 text-left disabled:opacity-50"
        >
          <div>
            <div className="text-sm font-medium">Backup frequency</div>
            <p className="text-xs text-muted-foreground">Keeps the last 7, then one a week for 4 weeks</p>
          </div>
          <span className="text-sm font-medium text-primary">
            {settings?.frequency === "weekly" ? "Weekly" : "Daily"}
          </span>
        </button>

        <Row
          icon={backup.isPending ? <Loader2 className="size-5 animate-spin" /> : <Save className="size-5" />}
          title="Back up now"
          hint={last ? `Last backup: ${when(last.createdAt)} · ${size(last.size)}` : "No backups yet"}
          disabled={backup.isPending}
          onClick={() => backup.mutate()}
        />
        <Row
          icon={<Folder className="size-5" />}
          title="Browse backups"
          hint={`View, restore, download or delete saved backups (${backups.length})`}
          onClick={() => setBrowsing(true)}
        />
      </div>

      <FloatingSheet open={browsing} onOpenChange={setBrowsing} title="Backups">
        <BackupList backups={backups} onChanged={refresh} />
      </FloatingSheet>
    </div>
  );
}

export function Row({
  icon, title, hint, onClick, disabled,
}: { icon: ReactNode; title: string; hint: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-4 py-3 text-left disabled:opacity-60"
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

function BackupList({ backups, onChanged }: { backups: Backup[]; onChanged: () => void }) {
  const qc = useQueryClient();
  const fetchDelete = useServerFn(deleteBackup);
  const fetchRestore = useServerFn(restoreBackup);
  // Restore and Delete both ask first: the row that is being confirmed, and for which action.
  const [confirm, setConfirm] = useState<{ name: string; action: "restore" | "delete" } | null>(null);

  const restore = useMutation({
    mutationFn: (name: string) => fetchRestore({ data: { name } }),
    onSuccess: () => {
      toast.success("Backup restored. Your previous library was saved first.");
      setConfirm(null);
      qc.invalidateQueries(); // every page now shows the restored data
    },
    onError: (e: Error) => toast.error(`Restore failed: ${e.message}`),
  });
  const remove = useMutation({
    mutationFn: (name: string) => fetchDelete({ data: { name } }),
    onSuccess: () => {
      setConfirm(null);
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const busy = restore.isPending || remove.isPending;

  if (backups.length === 0) return <p className="text-sm text-muted-foreground">No backups yet.</p>;

  const ICON = "grid size-9 shrink-0 place-items-center rounded-full bg-white/[0.07] hover:bg-white/[0.13] disabled:opacity-50";
  return (
    <ul className="-mr-2 max-h-[60vh] space-y-2 overflow-y-auto pr-2">
      {backups.map((b) => {
        const asking = confirm?.name === b.name ? confirm.action : null;
        return (
          <li key={b.name} className="rounded-2xl bg-white/[0.07] px-3.5 py-3">
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{when(b.createdAt).replace(" at ", ", ")}</div>
                <div className="text-xs text-muted-foreground">
                  {KIND_LABEL[b.kind] ?? b.kind} · {size(b.size)}
                </div>
              </div>
              <a href={`/api/backups/${b.name}`} download={b.name} aria-label="Download" title="Download" className={ICON}>
                <Download className="size-4" />
              </a>
              <button
                type="button" aria-label="Restore" title="Restore" disabled={busy} className={ICON}
                onClick={() => setConfirm({ name: b.name, action: "restore" })}
              >
                <RotateCcw className="size-4" />
              </button>
              <button
                type="button" aria-label="Delete" title="Delete" disabled={busy} className={ICON}
                onClick={() => setConfirm({ name: b.name, action: "delete" })}
              >
                <Trash2 className="size-4" />
              </button>
            </div>
            {asking && (
              <div className="mt-3 border-t border-white/10 pt-3">
                <p className="text-xs text-muted-foreground">
                  {asking === "restore"
                    ? "Replace your library with this backup? Your library as it is now is saved as a backup first, so you can undo this."
                    : "Delete this backup? This cannot be undone."}
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => (asking === "restore" ? restore.mutate(b.name) : remove.mutate(b.name))}
                    className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium disabled:opacity-60 ${
                      asking === "restore" ? "bg-primary text-primary-foreground" : "bg-destructive text-white"
                    }`}
                  >
                    {busy && <Loader2 className="size-4 animate-spin" />}
                    {asking === "restore" ? "Restore" : "Delete"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirm(null)}
                    className="rounded-full bg-white/[0.07] px-4 py-2 text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
