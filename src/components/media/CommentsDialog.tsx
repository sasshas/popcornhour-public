import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { EyeOff, Loader2, ThumbsUp } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { formatDateAULong } from "@/lib/utils";
import { getTraktComments } from "@/lib/tmdb.functions";
import type { TmdbReview } from "@/lib/tmdb";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The handful of reviews TMDB has; they come with the movie or show. */
  reviews: TmdbReview[];
  /** Needed to look the comments up on Trakt, where most of them are. */
  imdbId?: string | null;
  mediaType?: "movie" | "tv";
  /** One episode's comments (with the show's IMDb id above). */
  season?: number;
  episode?: number;
};

type Source = Pick<Props, "reviews" | "imdbId" | "mediaType" | "season" | "episode">;

/** One entry in the list, whichever site it came from. */
type Entry = {
  key: string;
  author: string;
  date: string;
  rating: number | null;
  content: string;
  spoiler: boolean;
  source: string;
};

// Trakt lets a writer hide part of a comment: [spoiler]...[/spoiler]. Those parts are left out.
const hideInlineSpoilers = (text: string) => text.replace(/\[spoiler\][\s\S]*?\[\/spoiler\]/gi, "(spoiler hidden)");

/**
 * The comments on a movie, show or episode: Trakt's (most liked first, 20 at a time) followed by TMDB's reviews.
 * `enabled`: only look them up when they are about to be shown.
 */
export function useComments({ reviews, imdbId, mediaType = "movie", season, episode }: Source, enabled: boolean) {
  const trakt = useInfiniteQuery({
    queryKey: ["trakt-comments", mediaType, imdbId, season ?? null, episode ?? null],
    queryFn: ({ pageParam }) =>
      getTraktComments({ data: { imdbId: imdbId!, page: pageParam, mediaType, season, episode } }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last && last.page < last.totalPages ? last.page + 1 : undefined),
    enabled: enabled && !!imdbId,
    staleTime: 1000 * 60 * 30,
  });
  const traktPages = (trakt.data?.pages ?? []).filter((p) => p !== null);
  const traktTotal = traktPages[0]?.total ?? 0;

  const entries: Entry[] = [
    ...traktPages.flatMap((p) =>
      p.comments.map((c) => ({
        key: `trakt-${c.id}`,
        author: c.author,
        date: c.createdAt,
        rating: c.rating,
        content: hideInlineSpoilers(c.content),
        spoiler: c.spoiler,
        source: c.likes > 0 ? `Trakt · ${c.likes} ${c.likes === 1 ? "like" : "likes"}` : "Trakt",
      })),
    ),
    ...reviews.map((r) => ({
      key: `tmdb-${r.id}`,
      author: r.author,
      date: r.created_at,
      rating: typeof r.author_details?.rating === "number" ? r.author_details.rating : null,
      content: r.content,
      spoiler: false,
      source: "TMDB review",
    })),
  ];
  const total = traktTotal + reviews.length;
  const loadingFirst = trakt.isLoading && entries.length === 0;
  return { entries, total, loadingFirst, trakt };
}

/** The popup behind the Comments button on a movie or show page. Looks the comments up once opened. */
export function CommentsDialog({ open, onOpenChange, ...source }: Props) {
  const comments = useComments(source, open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-xl">
            Comments{comments.total > 0 && <span className="ml-2 text-sm font-normal text-muted-foreground">{comments.total.toLocaleString()}</span>}
          </DialogTitle>
        </DialogHeader>
        <CommentsList comments={comments} scroll />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The comments as a list of cards, with "Load more" while Trakt has more. `scroll`: scroll inside the list (in a
 * popup) rather than with the page.
 */
export function CommentsList({ comments, scroll }: { comments: ReturnType<typeof useComments>; scroll?: boolean }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const { entries, loadingFirst, trakt } = comments;
  return (
    <>
        {loadingFirst ? (
          <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No comments yet.</p>
        ) : (
          <ul className={`space-y-3 ${scroll ? "max-h-[60vh] overflow-y-auto pr-1" : ""}`}>
            {entries.map((r) => {
              const isOpen = expanded === r.key;
              const long = r.content.length > 320;
              const hidden = r.spoiler && !revealed.has(r.key);
              return (
                <li key={r.key} className="rounded-xl bg-surface border border-border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{r.author}</p>
                      <p className="text-xs text-muted-foreground">{formatDateAULong(r.date)}</p>
                    </div>
                    {r.rating !== null && (
                      <span className="shrink-0 rounded-md bg-primary/20 text-primary text-xs font-semibold px-2 py-1">
                        {r.rating}/10
                      </span>
                    )}
                  </div>
                  {hidden ? (
                    <button
                      onClick={() => setRevealed((s) => new Set(s).add(r.key))}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      <EyeOff className="size-3.5" /> Contains spoilers. Tap to show
                    </button>
                  ) : (
                    <>
                      <p className="mt-2 text-sm text-muted-foreground whitespace-pre-line break-words">
                        {isOpen || !long ? r.content : `${r.content.slice(0, 320)}…`}
                      </p>
                      {long && (
                        <button
                          onClick={() => setExpanded(isOpen ? null : r.key)}
                          className="mt-1 text-xs font-medium text-primary"
                        >
                          {isOpen ? "Show less" : "Read more"}
                        </button>
                      )}
                    </>
                  )}
                  <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                    <ThumbsUp className="size-3.5" /> {r.source}
                  </div>
                </li>
              );
            })}
            {trakt.hasNextPage && (
              <li className="flex justify-center py-1">
                <button
                  onClick={() => trakt.fetchNextPage()}
                  disabled={trakt.isFetchingNextPage}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-5 py-2 text-sm font-medium hover:bg-surface-elevated disabled:opacity-70"
                >
                  {trakt.isFetchingNextPage && <Loader2 className="size-4 animate-spin" />}
                  {trakt.isFetchingNextPage ? "Loading…" : "Load more"}
                </button>
              </li>
            )}
          </ul>
        )}
    </>
  );
}
