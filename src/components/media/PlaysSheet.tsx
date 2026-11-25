import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, ListX, Star, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WatchDialog, type WatchDialogResult } from "@/components/media/WatchDialog";
import { addPlay, listPlays, removeAllPlays, removePlay } from "@/lib/plays.functions";
import { watchedOnAU } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  mediaType: "movie" | "tv";
  tmdbId: number;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  releaseDate?: string | null;
  streamingDate?: string | null;
  fallbackWatchedAt?: string | null;
  fallbackRating?: number | null;
  /** After a play is added or removed: the page refreshes its watched ticks and dates (the server keeps them in step). */
  onChanged?: () => void;
  onAdded?: (res: WatchDialogResult) => void;
};

export function PlaysSheet(props: Props) {
  const qc = useQueryClient();
  const fetchList = useServerFn(listPlays);
  const fetchAdd = useServerFn(addPlay);
  const fetchRemoveAll = useServerFn(removeAllPlays);
  const fetchRemoveOne = useServerFn(removePlay);
  const [addOpen, setAddOpen] = useState(false);

  const keyParts = [
    "plays",
    props.mediaType,
    props.tmdbId,
    props.seasonNumber ?? null,
    props.episodeNumber ?? null,
  ];

  const { data: plays } = useQuery({
    queryKey: keyParts,
    queryFn: () =>
      fetchList({
        data: {
          mediaType: props.mediaType,
          tmdbId: props.tmdbId,
          seasonNumber: props.seasonNumber ?? null,
          episodeNumber: props.episodeNumber ?? null,
        },
      }),
    enabled: props.open,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: keyParts });

  const add = useMutation({
    mutationFn: (res: WatchDialogResult) =>
      fetchAdd({
        data: {
          mediaType: props.mediaType,
          tmdbId: props.tmdbId,
          seasonNumber: props.seasonNumber ?? null,
          episodeNumber: props.episodeNumber ?? null,
          watchedAt: res.watchedAt,
          rating: res.rating,
        },
      }),
    onSuccess: (_d, vars) => {
      invalidate();
      props.onChanged?.();
      props.onAdded?.(vars);
    },
  });

  const removeAll = useMutation({
    mutationFn: () =>
      fetchRemoveAll({
        data: {
          mediaType: props.mediaType,
          tmdbId: props.tmdbId,
          seasonNumber: props.seasonNumber ?? null,
          episodeNumber: props.episodeNumber ?? null,
        },
      }),
    onSuccess: () => {
      invalidate();
      props.onChanged?.();
      props.onOpenChange(false);
    },
  });

  // Removing the last play un-watches the title / episode (the server does it), so the sheet closes.
  const removeOne = useMutation({
    mutationFn: (id: string) => fetchRemoveOne({ data: { id } }),
    onSuccess: () => {
      invalidate();
      props.onChanged?.();
      if (rows.length <= 1) props.onOpenChange(false);
    },
  });
  const busy = add.isPending || removeAll.isPending || removeOne.isPending;
  // A whole show's history lists every episode's plays, so each row says which episode it is.
  const wholeShow = props.mediaType === "tv" && props.episodeNumber == null;

  const rows = plays && plays.length > 0
    ? plays
    : props.fallbackWatchedAt
      ? [{ id: "__fallback__", watched_at: props.fallbackWatchedAt, rating: props.fallbackRating ?? null, season_number: null, episode_number: null }]
      : [];

  return (
    <>
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl">{props.title}</DialogTitle>
          </DialogHeader>

          {rows.length > 0 && (
            <ul className="space-y-1 max-h-60 overflow-y-auto -mx-1 pr-1">
              {rows.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-surface"
                >
                  <div className="min-w-0">
                    <div className="text-sm text-foreground">
                      {wholeShow && p.season_number != null && p.episode_number != null
                        ? `S${p.season_number} · E${p.episode_number} · `
                        : ""}
                      {watchedOnAU(p.watched_at)}
                    </div>
                    {typeof p.rating === "number" && (
                      <div className="text-xs text-muted-foreground inline-flex items-center gap-1 mt-0.5">
                        <Star className="size-3 fill-[var(--gold)] text-[var(--gold)]" />
                        {p.rating}/10
                      </div>
                    )}
                  </div>
                  {/* The stand-in row (a watch with only a date) is removed the way "Remove all plays" does it. A whole
                      show's stand-in has no trash: that would un-watch every episode. */}
                  {(p.id !== "__fallback__" || !wholeShow) && (
                    <button
                      disabled={busy}
                      onClick={() => (p.id === "__fallback__" ? removeAll.mutate() : removeOne.mutate(p.id))}
                      className="text-muted-foreground hover:text-destructive p-1"
                      title="Remove this play"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-1 pt-2 border-t border-border">
            <button
              onClick={() => setAddOpen(true)}
              className="w-full flex items-center gap-3 px-2 py-3 text-left hover:bg-surface rounded-lg transition"
            >
              <Plus className="size-5 text-primary" />
              <span className="text-base">Add a play</span>
            </button>
            <button
              disabled={busy}
              onClick={() => {
                // A whole show: every episode is un-ticked and the show leaves the library, so ask first.
                if (wholeShow && !confirm(`Remove every watched episode of ${props.title}? This can't be undone.`)) return;
                removeAll.mutate();
              }}
              className="w-full flex items-center gap-3 px-2 py-3 text-left hover:bg-surface rounded-lg transition text-destructive"
            >
              <ListX className="size-5" />
              <span className="text-base">Remove all plays</span>
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <WatchDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title={props.title}
        releaseDate={props.releaseDate ?? null}
        streamingDate={props.streamingDate ?? null}
        onValidate={(res) => add.mutate(res)}
      />
    </>
  );
}