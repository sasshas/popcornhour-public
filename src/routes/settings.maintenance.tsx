import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Image as ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { backfillPosters } from "@/lib/posters.functions";
import { SettingsSubpage } from "@/components/settings/SettingsSubpage";

export const Route = createFileRoute("/settings/maintenance")({ component: MaintenancePage });

function MaintenancePage() {
  const qc = useQueryClient();
  const fetchBackfill = useServerFn(backfillPosters);

  const backfillMut = useMutation({
    mutationFn: () => fetchBackfill(),
    onSuccess: (r: { updated: number; total: number }) => {
      toast.success(`Refreshed ${r.updated} of ${r.total} posters`);
      qc.invalidateQueries({ queryKey: ["library"] });
      qc.invalidateQueries({ queryKey: ["lists"] });
      qc.invalidateQueries({ queryKey: ["list"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <SettingsSubpage title="Library maintenance" hint="Fix missing artwork on imported items.">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-sm text-muted-foreground">Looks up posters again for anything that is missing one.</p>
        <button
          onClick={() => backfillMut.mutate()}
          disabled={backfillMut.isPending}
          className="inline-flex items-center gap-2 rounded-full bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {backfillMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <ImageIcon className="size-4" />}
          Refresh posters
        </button>
      </div>
    </SettingsSubpage>
  );
}
