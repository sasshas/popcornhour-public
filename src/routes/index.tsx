import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import { getHomeFeed } from "@/lib/tmdb.functions";
import { MediaRail } from "@/components/media/MediaRail";
import { Link } from "@tanstack/react-router";
import { img, titleOf, yearOf } from "@/lib/tmdb";
import { Play, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { isFreshVisit } from "@/lib/nav-action";

const homeQuery = queryOptions({
  queryKey: ["home-feed"],
  queryFn: () => getHomeFeed(),
  staleTime: 1000 * 60 * 10,
});

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Popcornhour — Discover trending movies & TV" },
      { name: "description", content: "Trending today, popular movies, top-rated TV — all in one beautiful place." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(homeQuery),
  component: Home,
  pendingComponent: () => <div className="p-8 text-muted-foreground">Loading…</div>,
  errorComponent: ({ error }) => <div className="p-8"><p className="text-destructive font-medium">Couldn't load feed</p><p className="text-sm text-muted-foreground mt-2">{error instanceof Error ? error.message : String(error)}</p></div>,
});

// Home's rows of posters, top to bottom.
const RAILS = [
  { title: "Trending today", key: "trending", seeMore: "trending" },
  { title: "Popular movies", key: "popularMovies", seeMore: "popular-movies" },
  { title: "Popular TV shows", key: "popularTV", seeMore: "popular-tv" },
  { title: "Upcoming in theaters", key: "upcoming", seeMore: "upcoming" },
  { title: "Top rated movies", key: "topMovies", seeMore: "top-movies" },
  { title: "Top rated TV", key: "topTV", seeMore: "top-tv" },
] as const;
const ALL_DRAWN = RAILS.length - 1;

/**
 * How much of Home to draw. Home has six rows of about 20 posters, too many to draw at once without a pause you can
 * feel on a phone. So, on a phone, a fresh visit (the bottom bar's Home, or the logo) first draws only what fits on
 * the screen: the big picture and the first two rows, five posters each (stage 0). Once the page has faded in
 * (320ms), those two rows are completed (stage 1), then one more row each time the phone is idle, out of sight below.
 * Coming Back, opening the app on Home, or on a computer, everything is drawn at once (stage ALL_DRAWN), so Back
 * returns to the same scroll place and the poster you tapped can shrink back into its card.
 */
function useHomeStage() {
  const [stage, setStage] = useState(() =>
    isFreshVisit() && window.matchMedia("(max-width: 767px)").matches ? 0 : ALL_DRAWN,
  );
  useEffect(() => {
    if (stage >= ALL_DRAWN) return;
    const next = () => setStage((s) => s + 1);
    if (stage === 0) {
      const t = setTimeout(next, 320);
      return () => clearTimeout(t);
    }
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(next, { timeout: 200 });
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(next, 30);
    return () => clearTimeout(t);
  }, [stage]);
  return stage;
}

function Home() {
  const { data } = useSuspenseQuery(homeQuery);
  const stage = useHomeStage();
  const hero = data.trending[0];
  const heroType = hero?.media_type === "tv" ? "tv" : "movie";
  const backdrop = img(hero?.backdrop_path, "w1280");

  return (
    // space-y-5: the hero sits close to the first row on a phone (it used to leave a big empty gap).
    <div className="space-y-5 md:space-y-12 pb-12">
      {/* Hero */}
      {hero && (
        <section className="relative -mx-0 md:-mx-0">
          <div className="relative h-[58vh] min-h-[420px] max-h-[640px] w-full overflow-hidden">
            {backdrop && (
              <img src={backdrop} alt="" className="absolute inset-0 w-full h-full object-cover" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-background via-background/70 to-background/10" />
            <div className="absolute inset-0 bg-gradient-to-r from-background/80 via-background/30 to-transparent" />
            <div className="relative h-full flex items-end">
              <div className="px-4 md:px-10 pb-4 md:pb-14 max-w-2xl space-y-4">
                <p className="text-xs uppercase tracking-[0.2em] text-primary font-semibold">
                  Trending today
                  {yearOf(hero) && <span className="text-muted-foreground"> · {yearOf(hero)}</span>}
                </p>
                <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-balance">{titleOf(hero)}</h1>
                <p className="text-muted-foreground text-sm md:text-base line-clamp-3">{hero.overview}</p>
                <div className="flex gap-3 pt-2">
                  <Link to={heroType === "tv" ? "/tv/$id" : "/movie/$id"} params={{ id: String(hero.id) }} className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90">
                    <Play className="size-4 fill-current" /> Watch details
                  </Link>
                  <Link to={heroType === "tv" ? "/tv/$id" : "/movie/$id"} params={{ id: String(hero.id) }} className="inline-flex items-center gap-2 rounded-full bg-surface px-5 py-2.5 text-sm font-semibold hover:bg-surface-elevated border border-border">
                    <Info className="size-4" /> More info
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      <div className="px-4 md:px-10 space-y-10 md:space-y-12">
        {RAILS.slice(0, stage <= 1 ? 2 : stage + 1).map((r) => (
          <MediaRail key={r.key} title={r.title} items={data[r.key]} seeMore={r.seeMore} limit={stage === 0 ? 5 : undefined} />
        ))}
      </div>
    </div>
  );
}
