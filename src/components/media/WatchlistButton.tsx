import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bookmark } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { getLibraryItem, upsertLibraryItem, removeLibraryItem } from "@/lib/library.functions";

type Props = {
  tmdbId: number;
  title: string;
  posterPath?: string | null;
  releaseDate?: string | null;
};

/**
 * A small "Watchlist" toggle for a movie, for places that are not the movie page (the Calendar's popup).
 * Does the same thing as the Watchlist button on the movie page: adds it as "plan to watch", and taking it
 * off keeps the row only if the movie is also watched, favourited or rated.
 */
export function WatchlistButton({ tmdbId, title, posterPath, releaseDate }: Props) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const fetchItem = useServerFn(getLibraryItem);
  const fetchUpsert = useServerFn(upsertLibraryItem);
  const fetchRemove = useServerFn(removeLibraryItem);

  const key = ["library-item", "movie", tmdbId, user?.id ?? null];
  const { data: item } = useQuery({
    queryKey: key,
    queryFn: () => fetchItem({ data: { mediaType: "movie", tmdbId } }),
    enabled: !!user,
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ["library"] });
  };

  const save = useMutation({
    mutationFn: (patch: { status?: "plan_to_watch"; watchlist: boolean }) =>
      fetchUpsert({
        data: {
          mediaType: "movie",
          tmdbId,
          title,
          posterPath: posterPath ?? null,
          backdropPath: null,
          releaseDate: releaseDate ?? null,
          ...patch,
        },
      }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => fetchRemove({ data: { mediaType: "movie", tmdbId } }),
    onSuccess: invalidate,
  });

  if (!user) return null;

  const watched = item?.status === "completed";
  const onWatchlist = item?.watchlist === true || (!watched && item?.status === "plan_to_watch");

  const toggle = () => {
    if (onWatchlist) {
      if (watched || item?.favorite || item?.rating) save.mutate({ watchlist: false });
      else remove.mutate();
      return;
    }
    save.mutate({ watchlist: true, ...(item ? {} : { status: "plan_to_watch" as const }) });
  };

  return (
    <button
      onClick={toggle}
      disabled={save.isPending || remove.isPending}
      aria-pressed={onWatchlist}
      className={[
        "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition disabled:opacity-70",
        onWatchlist
          ? "bg-primary/20 border-primary/50 text-primary"
          : "bg-surface border-border text-foreground hover:border-primary/50",
      ].join(" ")}
    >
      <Bookmark className={`size-4 ${onWatchlist ? "fill-current" : ""}`} />
      {onWatchlist ? "On watchlist" : "Add to watchlist"}
    </button>
  );
}
