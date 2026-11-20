import { createFileRoute, notFound } from "@tanstack/react-router";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { getCollection } from "@/lib/tmdb.functions";
import { PosterCard } from "@/components/media/PosterCard";
import { BackButton } from "@/components/layout/AppShell";

// A film series (e.g. "Toy Story Collection"): its movies in release order. Opened from the Collection pill in a
// movie page's Details row.
const collectionQuery = (id: number) =>
  queryOptions({ queryKey: ["collection", id], queryFn: () => getCollection({ data: { id } }), staleTime: 1000 * 60 * 30 });

export const Route = createFileRoute("/collection/$id")({
  beforeLoad: ({ params }) => {
    if (!/^[1-9]\d*$/.test(params.id)) throw notFound();
  },
  // Returns the series, so a page drawn on the server hands it to the browser with the page. (Only putting it in the
  // server's Query cache left the browser's first draw empty: it did not match the page the server sent.)
  loader: ({ context, params }) => context.queryClient.ensureQueryData(collectionQuery(Number(params.id))),
  head: () => ({ meta: [{ title: "Collection — Popcornhour" }] }),
  component: CollectionPage,
});

function CollectionPage() {
  const id = Number(Route.useParams().id);
  const loaded = Route.useLoaderData();
  const { data, isError, refetch } = useQuery({ ...collectionQuery(id), ...(loaded ? { initialData: loaded } : {}) });

  return (
    <div className="px-4 md:px-10 py-4 md:py-10 space-y-6">
      <div className="flex items-center gap-3">
        <BackButton className="grid size-10 shrink-0 place-items-center rounded-full border border-border bg-surface hover:bg-surface-elevated">
          <ArrowLeft className="size-5" />
        </BackButton>
        <div className="min-w-0">
          <h1 className="text-xl md:text-4xl font-bold tracking-tight truncate">{data?.name ?? ""}</h1>
          {data && (
            <p className="text-sm text-muted-foreground">
              {data.parts.length} {data.parts.length === 1 ? "movie" : "movies"}, in release order
            </p>
          )}
        </div>
      </div>

      {isError && !data ? (
        <div className="space-y-3">
          <p className="text-destructive font-medium">Couldn't load this collection.</p>
          <button onClick={() => refetch()} className="rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-elevated">
            Try again
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-x-3 md:gap-x-4 gap-y-5 md:gap-y-6">
          {(data?.parts ?? []).map((it) => (
            <PosterCard key={it.id} item={it} size="fill" />
          ))}
        </div>
      )}
    </div>
  );
}
