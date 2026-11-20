import { createFileRoute, notFound } from "@tanstack/react-router";
import { infiniteQueryOptions, keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { getStudioPage } from "@/lib/tmdb.functions";
import { img, type MediaItem } from "@/lib/tmdb";
import { scrollRootOf } from "@/lib/scroll-root";
import { PosterCard } from "@/components/media/PosterCard";
import { BackButton } from "@/components/layout/AppShell";

// A studio's movies, newest first (or most popular first), 20 a page (the same shape as a Home row's "See more" page). Opened by
// tapping the studio logo on a movie page. The pages stay in the Query cache, so coming Back from a movie shows
// them all again straight away.
type StudioSort = "newest" | "popular";
const SORTS: { value: StudioSort; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "popular", label: "Popular" },
];
const SORT_KEY = "studio:sort"; // the last order picked, remembered on this device

const studioQuery = (id: number, sort: StudioSort = "newest") =>
  infiniteQueryOptions({
    queryKey: ["studio", id, sort],
    queryFn: ({ pageParam }) => getStudioPage({ data: { id, page: pageParam, sort } }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
    staleTime: 1000 * 60 * 30,
  });

export const Route = createFileRoute("/studio/$id")({
  beforeLoad: ({ params }) => {
    if (!/^[1-9]\d*$/.test(params.id)) throw notFound();
  },
  // Returns the first pages, so a page drawn on the server hands them to the browser with the page. (Only putting them
  // in the server's Query cache left the browser's first draw empty: it did not match the page the server sent.)
  loader: ({ context, params }) => context.queryClient.ensureInfiniteQueryData(studioQuery(Number(params.id))),
  head: () => ({ meta: [{ title: "Studio — Popcornhour" }] }),
  component: StudioPage,
});

function StudioPage() {
  const id = Number(Route.useParams().id);
  // Newest first unless "Popular" was picked before. (Read after the page appears: the server cannot see it.)
  const [sort, setSort] = useState<StudioSort>("newest");
  useEffect(() => {
    try {
      if (localStorage.getItem(SORT_KEY) === "popular") setSort("popular");
    } catch {}
  }, []);
  const chooseSort = (s: StudioSort) => {
    setSort(s);
    try {
      localStorage.setItem(SORT_KEY, s);
    } catch {}
  };
  const loaded = Route.useLoaderData(); // the "Newest" pages
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError, isError, refetch } = useInfiniteQuery({
    ...studioQuery(id, sort),
    ...(sort === "newest" && loaded ? { initialData: loaded } : {}),
    placeholderData: keepPreviousData, // the old order stays on screen until the new one arrives
  });
  const first = data?.pages[0];
  const studio = first?.studio;

  // All pages in one list. TMDB lists shift while you read them, so a title can show up on two pages: keep the first.
  const items = useMemo(() => {
    const seen = new Set<number>();
    const out: MediaItem[] = [];
    for (const page of data?.pages ?? []) {
      for (const r of page.results) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          out.push(r);
        }
      }
    }
    return out;
  }, [data]);

  // Loads the next page when the button under the grid is about to scroll into view. (The button also works by
  // hand.) Does not retry on its own after an error, or it would hammer the server.
  const moreButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = moreButton.current;
    if (!el || !hasNextPage || isFetchingNextPage || isFetchNextPageError || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) fetchNextPage();
      },
      { root: scrollRootOf(el), rootMargin: "1600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, items.length, fetchNextPage]);

  return (
    <div className="px-4 md:px-10 py-4 md:py-10 space-y-6">
      <div className="flex items-center gap-3">
        <BackButton className="grid size-10 shrink-0 place-items-center rounded-full border border-border bg-surface hover:bg-surface-elevated">
          <ArrowLeft className="size-5" />
        </BackButton>
        {studio?.logoPath && (
          // On a light plate in its own colours, like the logo on the movie page.
          <div className="inline-flex shrink-0 items-center rounded-lg bg-white/90 px-2 py-1">
            <img src={img(studio.logoPath, "w154")!} alt="" className="h-7 md:h-9 w-auto max-w-[6rem] md:max-w-[9rem] object-contain" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-xl md:text-4xl font-bold tracking-tight truncate">{studio?.name ?? (data ? "Studio" : "")}</h1>
          {first && first.total > 0 && (
            <p className="text-sm text-muted-foreground">
              {first.total.toLocaleString()} {first.total === 1 ? "movie" : "movies"}
            </p>
          )}
        </div>
      </div>

      <div className="inline-flex bg-surface border border-border rounded-full p-1" role="group" aria-label="Order">
        {SORTS.map((s) => (
          <button
            key={s.value}
            onClick={() => chooseSort(s.value)}
            aria-pressed={sort === s.value}
            className={[
              "px-4 py-2 text-sm font-medium rounded-full whitespace-nowrap",
              sort === s.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {s.label}
          </button>
        ))}
      </div>

      {isError && items.length === 0 ? (
        <div className="space-y-3">
          <p className="text-destructive font-medium">Couldn't load this studio.</p>
          <button onClick={() => refetch()} className="rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-elevated">
            Try again
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-x-3 md:gap-x-4 gap-y-5 md:gap-y-6">
            {items.map((it) => (
              <PosterCard key={it.id} item={it} size="fill" />
            ))}
          </div>

          <div className="flex justify-center pt-2 pb-4">
            {hasNextPage ? (
              <button
                ref={moreButton}
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-medium hover:bg-surface-elevated disabled:opacity-70"
              >
                {isFetchingNextPage && <Loader2 className="size-4 animate-spin" />}
                {isFetchNextPageError ? "Couldn't load more. Try again" : isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            ) : data && items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No movies found for this studio.</p>
            ) : (
              items.length > 0 && <p className="text-sm text-muted-foreground">That's everything.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
