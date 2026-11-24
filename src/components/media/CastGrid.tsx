import { Link } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackButton } from "@/components/layout/AppShell";
import { LoadMore } from "@/components/media/LoadMore";
import { markHeroPoster } from "@/lib/peek";
import { img } from "@/lib/tmdb";
import type { CastEntry } from "@/lib/tmdb.functions";

/** The "See all" link beside a movie's or show's "Top cast" heading: opens its full cast page. */
export function SeeAllCast({ type, id }: { type: "movie" | "tv"; id: number }) {
  const className =
    "-mr-1 inline-flex items-center gap-0.5 rounded-full px-2 py-1 text-sm font-medium text-primary hover:bg-primary/10";
  const label = (
    <>
      See all
      <ChevronRight className="size-4" />
    </>
  );
  return type === "movie" ? (
    <Link to="/movie/$id/cast" params={{ id: String(id) }} className={className}>{label}</Link>
  ) : (
    <Link to="/tv/$id/cast" params={{ id: String(id) }} className={className}>{label}</Link>
  );
}

/** People drawn at a time (as the Library's posters): a long-running show can have hundreds. */
const PAGE_SIZE = 30;

/** How many people each visit had drawn, by browser-history entry, so Back from a person scrolls to the same place. */
const drawnByEntry = new Map<string, number>();
const historyEntry = () =>
  typeof window === "undefined" ? undefined : (window.history.state?.__TSR_key as string | undefined);

/**
 * A movie's or show's full cast: a grid of the same cards as the "Top cast" row, each opening the person's page.
 * `cast` is undefined while it loads (a placeholder grid holds the place).
 */
export function CastPage({
  title,
  cast,
  isError,
  onRetry,
}: {
  title: string | undefined;
  cast: CastEntry[] | undefined;
  isError: boolean;
  onRetry: () => void;
}) {
  const entry = useRef<string | undefined>(undefined);
  const [shown, setShown] = useState(() => {
    entry.current = historyEntry();
    return (entry.current && drawnByEntry.get(entry.current)) || PAGE_SIZE;
  });
  useEffect(() => {
    if (entry.current) drawnByEntry.set(entry.current, shown);
  }, [shown]);
  const more = useCallback(() => setShown((n) => n + PAGE_SIZE), []);

  return (
    <div className="px-4 md:px-10 py-4 md:py-10 space-y-6">
      <div className="flex items-center gap-3">
        <BackButton className="grid size-10 shrink-0 place-items-center rounded-full border border-border bg-surface hover:bg-surface-elevated">
          <ArrowLeft className="size-5" />
        </BackButton>
        <div className="min-w-0">
          <h1 className="text-xl md:text-4xl font-bold tracking-tight truncate">Cast</h1>
          {/* Held at one line's height while loading, so the grid does not move down when it arrives. */}
          <p className="min-h-5 text-sm text-muted-foreground truncate">
            {title}
            {title && cast ? " · " : ""}
            {cast ? `${cast.length} ${cast.length === 1 ? "person" : "people"}` : ""}
          </p>
        </div>
      </div>

      {isError && !cast ? (
        <div className="space-y-3">
          <p className="text-destructive font-medium">Couldn't load the cast.</p>
          <button onClick={onRetry} className="rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-elevated">
            Try again
          </button>
        </div>
      ) : cast && cast.length === 0 ? (
        <p className="text-muted-foreground">TMDB has no cast listed.</p>
      ) : (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-x-3 md:gap-x-4 gap-y-5 md:gap-y-6">
            {cast
              ? cast.slice(0, shown).map((c) => <CastCard key={c.id} person={c} />)
              : Array.from({ length: 12 }, (_, i) => (
                  <div key={i} aria-hidden>
                    <div className="aspect-[2/3] rounded-xl bg-surface ring-1 ring-border animate-pulse" />
                    <div className="mt-2 h-3 w-3/4 rounded bg-surface" />
                    <div className="mt-1.5 h-3 w-1/2 rounded bg-surface" />
                  </div>
                ))}
          </div>
          {cast && shown < cast.length && <LoadMore key={shown} onMore={more} />}
        </>
      )}
    </div>
  );
}

function CastCard({ person: c }: { person: CastEntry }) {
  return (
    <Link to="/person/$id" params={{ id: String(c.id) }} className="group min-w-0" onClick={(e) => markHeroPoster(e.currentTarget)}>
      <div data-hero={`person:${c.id}`} className="aspect-[2/3] rounded-xl overflow-hidden bg-surface ring-1 ring-border">
        {c.profile_path ? (
          // The same picture file as the "Top cast" row, so the first ones are already downloaded.
          <img
            src={img(c.profile_path, "w185")!}
            alt={c.name}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full grid place-items-center text-xs text-muted-foreground">No photo</div>
        )}
      </div>
      <p className="mt-2 text-xs md:text-sm font-medium line-clamp-1">{c.name}</p>
      {c.character && <p className="text-xs text-muted-foreground line-clamp-2">{c.character}</p>}
      {c.episodes !== undefined && c.episodes > 0 && (
        <p className="text-[11px] text-muted-foreground/80">
          {c.episodes} {c.episodes === 1 ? "episode" : "episodes"}
        </p>
      )}
    </Link>
  );
}
