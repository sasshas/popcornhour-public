import { createFileRoute, notFound } from "@tanstack/react-router";
import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { getBrowsePage } from "@/lib/tmdb.functions";
import { BROWSE_CATEGORIES, isBrowseCategory, type BrowseCategory } from "@/lib/browse";
import type { MediaItem } from "@/lib/tmdb";
import { scrollRootOf } from "@/lib/scroll-root";
import { PosterCard } from "@/components/media/PosterCard";
import { BackButton } from "@/components/layout/AppShell";

// One Home row's whole list, 20 titles a page. The pages stay in the Query cache, so coming Back from a
// movie shows them all again straight away (and the scroll position can be restored).
const browseQuery = (category: BrowseCategory) =>
  infiniteQueryOptions({
    queryKey: ["browse", category],
    queryFn: ({ pageParam }) => getBrowsePage({ data: { category, page: pageParam } }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
    staleTime: 1000 * 60 * 30,
  });

export const Route = createFileRoute("/browse/$category")({
  beforeLoad: ({ params }) => {
    if (!isBrowseCategory(params.category)) throw notFound();
  },
  // Returns the first pages, so a page drawn on the server hands them to the browser with the page. (Only putting them
  // in the server's Query cache left the browser's first draw empty: it did not match the page the server sent.)
  loader: ({ context, params }) => context.queryClient.ensureInfiniteQueryData(browseQuery(params.category as BrowseCategory)),
  head: ({ params }) => ({
    meta: [{ title: `${isBrowseCategory(params.category) ? BROWSE_CATEGORIES[params.category].title : "Browse"} — Popcornhour` }],
  }),
  component: BrowsePage,
});

function BrowsePage() {
  const category = Route.useParams().category as BrowseCategory;
  const { title } = BROWSE_CATEGORIES[category];
  const loaded = Route.useLoaderData();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError, isError, refetch } = useInfiniteQuery({
    ...browseQuery(category),
    ...(loaded ? { initialData: loaded } : {}),
  });

  // All pages in one list. TMDB lists shift while you read them, so a title can show up on two pages: keep the first.
  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: MediaItem[] = [];
    for (const page of data?.pages ?? []) {
      for (const r of page.results) {
        const key = `${r.media_type}-${r.id}`;
        if (!seen.has(key)) {
          seen.add(key);
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
        <div className="min-w-0">
          <h1 className="text-2xl md:text-4xl font-bold tracking-tight truncate">{title}</h1>
          {items.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {items.length} titles{hasNextPage ? " so far" : ""}
            </p>
          )}
        </div>
      </div>

      {isError && items.length === 0 ? (
        <div className="space-y-3">
          <p className="text-destructive font-medium">Couldn't load this list.</p>
          <button onClick={() => refetch()} className="rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-elevated">
            Try again
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-x-3 md:gap-x-4 gap-y-5 md:gap-y-6">
            {items.map((it) => (
              <PosterCard key={`${it.media_type}-${it.id}`} item={it} size="fill" />
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
            ) : (
              items.length > 0 && <p className="text-sm text-muted-foreground">That's everything.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
