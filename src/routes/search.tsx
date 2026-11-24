import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { searchMulti } from "@/lib/tmdb.functions";
import { PosterCard } from "@/components/media/PosterCard";
import { Search as SearchIcon } from "lucide-react";

// The search is kept in the address (?q=), so Back from a result comes back to the same search, with the results
// drawn at once from the Query cache (and the scroll place restored). The Search tab opens a new, empty search.
type SearchParams = { q?: string };

export const Route = createFileRoute("/search")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    q: typeof s.q === "string" && s.q.trim() ? s.q.slice(0, 200) : undefined,
  }),
  head: () => ({ meta: [{ title: "Search — Popcornhour" }, { name: "description", content: "Search movies, TV shows, and people." }] }),
  component: SearchPage,
});

function SearchPage() {
  const { q: kept = "" } = Route.useSearch();
  const navigate = useNavigate({ from: "/search" });
  const [q, setQ] = useState(kept);
  const [debounced, setDebounced] = useState(kept.trim());
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  // Write the search into the address as it settles. Replace, not push: typing must not add a Back step per word.
  // viewTransition false: the page stays the same, so the page-change fade must not play.
  useEffect(() => {
    if (debounced === kept.trim()) return;
    void navigate({ search: { q: debounced || undefined }, replace: true, resetScroll: false, viewTransition: false });
  }, [debounced, kept, navigate]);

  const { data, isFetching } = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => searchMulti({ data: { query: debounced } }),
    enabled: debounced.length > 0,
    staleTime: 1000 * 60 * 5,
  });

  return (
    // No phone top bar on Search: the page starts at the top, clear of the notch.
    <div className="px-4 md:px-10 pt-[max(1rem,env(safe-area-inset-top))] pb-6 md:py-10 space-y-6">
      <div>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Search</h1>
        <p className="text-muted-foreground text-sm mt-1">Movies, TV shows, and people</p>
      </div>
      <label className="relative block max-w-2xl">
        <SearchIcon className="absolute left-4 top-1/2 -translate-y-1/2 size-5 text-muted-foreground" />
        <input
          // Only a new search puts the cursor in the box: coming Back to results must not pop the keyboard up.
          autoFocus={!kept}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Try 'Dune', 'Severance', 'Florence Pugh'…"
          className="w-full h-14 pl-12 pr-4 rounded-2xl bg-surface border border-border focus:border-primary outline-none ring-0 focus:ring-2 focus:ring-primary/30 text-base transition"
        />
      </label>

      {debounced && (
        <div className="text-sm text-muted-foreground">
          {isFetching ? "Searching…" : data ? `${data.length} result${data.length === 1 ? "" : "s"}` : null}
        </div>
      )}

      {data && data.length > 0 && (
        // 3 wide on a phone, the same grid as the Library and the "See more" pages.
        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-x-3 md:gap-x-4 gap-y-5 md:gap-y-6">
          {data.map((it) => (
            <PosterCard key={`${it.media_type}-${it.id}`} item={it} size="fill" />
          ))}
        </div>
      )}

      {!debounced && (
        <div className="text-muted-foreground text-sm">Start typing to search.</div>
      )}
    </div>
  );
}
