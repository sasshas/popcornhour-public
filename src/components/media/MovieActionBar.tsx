import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  Ban, Bookmark, Check, ChevronDown, Clock, Heart, History, Hourglass, Link2, MessageSquare, Pause, Play, RotateCw, Star, Trash2,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { getLibraryItem, listLibrary, upsertLibraryItem, removeLibraryItem } from "@/lib/library.functions";
import { addPlay, listPlays } from "@/lib/plays.functions";
import { getMoviesAvailability } from "@/lib/tmdb.functions";
import { WatchDialog, type WatchDialogResult } from "@/components/media/WatchDialog";
import { PlaysSheet } from "@/components/media/PlaysSheet";
import { RateDialog } from "@/components/media/RateDialog";
import { CommentsDialog } from "@/components/media/CommentsDialog";
import { LinksDialog } from "@/components/media/LinksDialog";
import { AddToListButton } from "@/components/media/AddToListButton";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatDateTimeAU } from "@/lib/utils";
import type { TmdbReview } from "@/lib/tmdb";

type Props = {
  /** Movie unless told otherwise. A show gets a status menu (Watching, Watched, Paused, Dropped) in place of
   *  the Watched / Rewatch button; everything else is the same. */
  mediaType?: "movie" | "tv";
  /** A show that is still airing (more episodes coming): its Watched status reads "Waiting", as WeTrakr calls it. */
  airing?: boolean;
  tmdbId: number;
  title: string;
  posterPath?: string | null;
  backdropPath?: string | null;
  releaseDate?: string | null;
  imdbId?: string | null;
  homepage?: string | null;
  reviews?: TmdbReview[];
};

type LibraryRows = Awaited<ReturnType<typeof listLibrary>>;
type Status = "plan_to_watch" | "watching" | "completed" | "on_hold" | "dropped";

// A show's statuses in its menu. (The watchlist has its own button.)
const SHOW_STATUSES = [
  { value: "watching", label: "Watching", icon: Play },
  { value: "completed", label: "Watched", icon: Check },
  { value: "on_hold", label: "Paused", icon: Pause },
  { value: "dropped", label: "Dropped", icon: Ban },
] as const;

/** The buttons under a movie's or show's title: Watchlist, Watched (or a show's status), and the round ones. */
export function MovieActionBar(props: Props) {
  const mediaType = props.mediaType ?? "movie";
  const isShow = mediaType === "tv";
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fetchItem = useServerFn(getLibraryItem);
  const fetchUpsert = useServerFn(upsertLibraryItem);
  const fetchRemove = useServerFn(removeLibraryItem);
  const fetchAddPlay = useServerFn(addPlay);
  const fetchPlays = useServerFn(listPlays);

  const [watchOpen, setWatchOpen] = useState(false);
  const [playsOpen, setPlaysOpen] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);

  const key = ["library-item", mediaType, props.tmdbId, user?.id ?? null];
  const { data: item } = useQuery({
    queryKey: key,
    queryFn: () => fetchItem({ data: { mediaType, tmdbId: props.tmdbId } }),
    // Until the answer arrives, use this title's row from the Library list if that is already loaded, so the buttons
    // start in the right state and nothing appears a moment later and pushes the page down.
    placeholderData: () =>
      qc.getQueryData<LibraryRows>(["library", user?.id])?.find((r) => r.media_type === mediaType && r.tmdb_id === props.tmdbId),
    enabled: !!user,
  });

  // A movie's watches, for the "last watched (2 plays)" line. A show's watches are its episodes', shown on its
  // season pages, so none are looked up here.
  const playsKey = ["plays", mediaType, props.tmdbId, null, null];
  const { data: plays } = useQuery({
    queryKey: playsKey,
    queryFn: () => fetchPlays({ data: { mediaType, tmdbId: props.tmdbId } }),
    enabled: !!user && !isShow,
  });

  // A movie's US digital release date, for the Watched popup's "Streaming date" pill. The same request (and key) the
  // Library makes for one movie, kept 6 hours on the server.
  const fetchAvail = useServerFn(getMoviesAvailability);
  const { data: avail } = useQuery({
    queryKey: ["movie-availability", [props.tmdbId]],
    queryFn: () => fetchAvail({ data: { ids: [props.tmdbId] } }),
    enabled: !!user && !isShow,
    staleTime: 60 * 60 * 1000,
  });
  const streamingDate = avail?.[0]?.digitalDate ?? null;

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ["library"] });
    qc.invalidateQueries({ queryKey: playsKey });
  };

  const save = useMutation({
    mutationFn: (patch: {
      status?: Status;
      watchlist?: boolean;
      favorite?: boolean;
      rating?: number | null;
      watchedAt?: string | null;
    }) =>
      fetchUpsert({
        data: {
          mediaType,
          tmdbId: props.tmdbId,
          title: props.title,
          posterPath: props.posterPath ?? null,
          backdropPath: props.backdropPath ?? null,
          releaseDate: props.releaseDate ?? null,
          ...patch,
        },
      }),
    onSuccess: invalidateAll,
  });

  const remove = useMutation({
    mutationFn: () => fetchRemove({ data: { mediaType, tmdbId: props.tmdbId } }),
    onSuccess: invalidateAll,
  });

  if (loading) return null;

  if (!user) {
    return (
      <button
        onClick={() => navigate({ to: "/login" })}
        className="inline-flex items-center gap-2 rounded-full bg-surface border border-border px-4 py-2 text-sm font-medium hover:border-primary/60"
      >
        <Bookmark className="size-4" /> Sign in to track
      </button>
    );
  }

  const watched = item?.status === "completed";
  const onWatchlist = item?.watchlist === true || (!watched && item?.status === "plan_to_watch");
  const playCount = plays?.length ?? (watched ? 1 : 0);
  const lastWatched = plays?.[0]?.watched_at ?? item?.watched_at ?? null;

  // A show in the library always has a status; one other than "watchlist" (Watching, Paused...) keeps it there.
  const showStatus = isShow && item && item.status !== "plan_to_watch" ? item.status : null;

  const toggleWatchlist = () => {
    if (onWatchlist) {
      // Keep the row (and watch history) if it's watched, favourited or rated. A show keeps it while it has
      // another status.
      if (isShow ? !!showStatus : watched || item?.favorite || item?.rating) {
        save.mutate({ watchlist: false });
      } else {
        remove.mutate();
      }
      return;
    }
    save.mutate({ watchlist: true, ...(item ? {} : { status: "plan_to_watch" as const }) });
  };

  const commitPlay = (res: WatchDialogResult) => {
    // The title's date is its latest watch: a rewatch logged with an earlier date adds a play but leaves it alone.
    const isLatest = !watched || !lastWatched || Date.parse(res.watchedAt) >= Date.parse(lastWatched);
    save.mutate({ status: "completed", rating: res.rating, ...(isLatest ? { watchedAt: res.watchedAt } : {}) });
    fetchAddPlay({
      data: { mediaType, tmdbId: props.tmdbId, watchedAt: res.watchedAt, rating: res.rating },
    })
      .then(invalidateAll)
      .catch(() => {});
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={toggleWatchlist}
          className={[
            "h-12 rounded-full inline-flex items-center justify-center gap-2 text-sm font-medium border transition",
            onWatchlist
              ? "bg-primary/20 border-primary/50 text-primary"
              : "bg-surface border-border text-foreground hover:border-primary/50",
          ].join(" ")}
        >
          <Bookmark className={`size-4 ${onWatchlist ? "fill-current" : ""}`} />
          Watchlist
        </button>

        {isShow ? (
          <ShowStatusMenu
            status={showStatus}
            airing={!!props.airing}
            onPick={(value) => {
              // Watched asks when (and the rating), as for a movie; once watched it opens the watch history.
              if (value === "completed") (watched ? setPlaysOpen : setWatchOpen)(true);
              else if (value !== showStatus) save.mutate({ status: value });
            }}
            onRemove={item ? () => remove.mutate() : undefined}
          />
        ) : watched ? (
          <button
            onClick={() => setWatchOpen(true)}
            className="h-12 rounded-full inline-flex items-center justify-center gap-2 text-sm font-medium border border-border bg-surface text-foreground hover:border-primary/50 transition"
          >
            <RotateCw className="size-4" /> Rewatch
          </button>
        ) : (
          <button
            onClick={() => setWatchOpen(true)}
            className="h-12 rounded-full inline-flex items-center justify-center gap-2 text-sm font-medium border border-border bg-surface text-foreground hover:border-primary/50 transition"
          >
            <Check className="size-4" /> Watched
          </button>
        )}
      </div>

      {watched && !isShow && (
        <div className="flex justify-center">
          <button
            onClick={() => setPlaysOpen(true)}
            className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground underline underline-offset-4 decoration-border"
          >
            <Clock className="size-3.5" />
            {lastWatched ? formatDateTimeAU(lastWatched) : "Watched"}
            {playCount > 0 && ` (${playCount} play${playCount === 1 ? "" : "s"})`}
          </button>
        </div>
      )}

      {/* Phone: the row spans the full width (like the Watchlist/Rewatch buttons above it) and each 56px circle
          sits in the middle of its cell, so the gaps are equal on both sides at any phone width. Capping the
          width (max-w-sm) on a phone left the row stuck to the left on screens wider than 384px. Desktop keeps
          the capped, left-aligned row. */}
      <div className="grid grid-cols-5 gap-2 justify-items-center md:max-w-sm md:justify-items-start">
        <CircleAction
          label="Favourite"
          active={!!item?.favorite}
          onClick={() => save.mutate({ favorite: !item?.favorite })}
        >
          <Heart className={`size-5 ${item?.favorite ? "fill-current" : ""}`} />
        </CircleAction>

        <CircleAction
          label={item?.rating ? `Your rating ${item.rating}/10` : "Rate"}
          active={!!item?.rating}
          onClick={() => setRateOpen(true)}
        >
          {item?.rating ? (
            <span className="text-sm font-semibold">{item.rating}</span>
          ) : (
            <Star className="size-5" />
          )}
        </CircleAction>

        <AddToListButton
          variant="icon"
          mediaType={mediaType}
          tmdbId={props.tmdbId}
          title={props.title}
          posterPath={props.posterPath ?? null}
          backdropPath={props.backdropPath ?? null}
          releaseDate={props.releaseDate ?? null}
        />

        <CircleAction label="Comments" onClick={() => setCommentsOpen(true)}>
          <MessageSquare className="size-5" />
        </CircleAction>

        <CircleAction label="Links" onClick={() => setLinksOpen(true)}>
          <Link2 className="size-5" />
        </CircleAction>
      </div>

      <WatchDialog
        open={watchOpen}
        onOpenChange={setWatchOpen}
        title={props.title}
        initialRating={item?.rating ?? null}
        releaseDate={props.releaseDate ?? null}
        streamingDate={streamingDate}
        onValidate={commitPlay}
      />
      <PlaysSheet
        open={playsOpen}
        onOpenChange={setPlaysOpen}
        title={props.title}
        mediaType={mediaType}
        tmdbId={props.tmdbId}
        releaseDate={props.releaseDate ?? null}
        streamingDate={streamingDate}
        fallbackWatchedAt={item?.watched_at ?? null}
        fallbackRating={item?.rating ?? null}
        onChanged={() => {
          invalidateAll();
          // A show's history is its episodes': their ticks live on the season pages.
          if (isShow) qc.invalidateQueries({ queryKey: ["episode-progress", props.tmdbId] });
        }}
      />
      <RateDialog
        open={rateOpen}
        onOpenChange={setRateOpen}
        title={props.title}
        value={item?.rating ?? null}
        onSubmit={(v) => save.mutate({ rating: v })}
      />
      <CommentsDialog
        open={commentsOpen}
        onOpenChange={setCommentsOpen}
        reviews={props.reviews ?? []}
        imdbId={props.imdbId ?? null}
        mediaType={mediaType}
      />
      <LinksDialog
        open={linksOpen}
        onOpenChange={setLinksOpen}
        title={props.title}
        tmdbId={props.tmdbId}
        imdbId={props.imdbId ?? null}
        homepage={props.homepage ?? null}
        year={props.releaseDate?.slice(0, 4) || null}
        mediaType={mediaType}
      />
    </div>
  );
}

/**
 * A show's second big button: its status (Watching, Watched, Paused, Dropped), picked from a menu, which also
 * removes the show from the library. Tinted like the Watchlist button once a status is set. For a show still airing,
 * Watched is called "Waiting" (caught up, waiting for new episodes), as on WeTrakr; it is the same status here, and
 * a new season moves it back to Watching by itself.
 */
function ShowStatusMenu({
  status, airing, onPick, onRemove,
}: {
  status: Status | null;
  airing: boolean;
  onPick: (value: (typeof SHOW_STATUSES)[number]["value"]) => void;
  onRemove?: () => void;
}) {
  const statuses = SHOW_STATUSES.map((s) =>
    airing && s.value === "completed" ? { ...s, label: "Waiting", icon: Hourglass } : s,
  );
  const current = statuses.find((s) => s.value === status);
  const Icon = current?.icon ?? Play;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={[
            "h-12 rounded-full inline-flex items-center justify-center gap-2 text-sm font-medium border transition",
            current
              ? "bg-primary/20 border-primary/50 text-primary"
              : "bg-surface border-border text-foreground hover:border-primary/50",
          ].join(" ")}
        >
          <Icon className="size-4" />
          {current?.label ?? "Status"}
          <ChevronDown className="size-4 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[11rem]">
        {statuses.map((s) => {
          const active = s.value === status;
          // Once watched, the same item opens the watch history.
          const history = s.value === "completed" && active;
          const ItemIcon = history ? History : s.icon;
          return (
            <DropdownMenuItem key={s.value} onClick={() => onPick(s.value)} className={active ? "text-primary" : ""}>
              <ItemIcon className="size-4" />
              {history ? "Watch history" : s.label}
              {active && !history && <Check className="ml-auto size-4" />}
            </DropdownMenuItem>
          );
        })}
        {onRemove && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onRemove} className="text-destructive focus:text-destructive">
              <Trash2 className="size-4" />
              Remove from library
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CircleAction({
  children, label, onClick, active,
}: {
  children: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={[
        "aspect-square w-full max-w-14 grid place-items-center rounded-full border transition",
        active
          ? "bg-primary/20 border-primary/50 text-primary"
          : "bg-surface border-border text-muted-foreground hover:text-foreground hover:border-primary/40",
      ].join(" ")}
    >
      {children}
    </button>
  );
}