import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { tvCastQuery, tvQuery } from "@/lib/tv-query";
import { CastPage } from "@/components/media/CastGrid";

// A show's full cast from every season, opened from "See all" beside "Top cast" on its page. (The show page's row
// only has the latest season's regulars.) The name comes from the show's details, usually already here.
export const Route = createFileRoute("/tv/$id_/cast")({
  beforeLoad: ({ params }) => {
    if (!/^[1-9]\d*$/.test(params.id)) throw notFound();
  },
  // A page opened directly waits for the cast on the server; a tap does not wait (the placeholder grid shows).
  loader: ({ context, params }) => {
    const id = Number(params.id);
    if (typeof window === "undefined") {
      return Promise.all([
        context.queryClient.ensureQueryData(tvCastQuery(id)),
        context.queryClient.ensureQueryData(tvQuery(id)),
      ]).then(([cast, show]) => ({ cast, name: show.name }));
    }
    void context.queryClient.prefetchQuery(tvCastQuery(id));
    void context.queryClient.prefetchQuery(tvQuery(id));
    return {
      cast: context.queryClient.getQueryData(tvCastQuery(id).queryKey),
      name: context.queryClient.getQueryData(tvQuery(id).queryKey)?.name,
    };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `Cast${loaderData?.name ? ` · ${loaderData.name}` : ""} — Popcornhour` }],
  }),
  component: TVCastPage,
});

function TVCastPage() {
  const id = Number(Route.useParams().id);
  const known = Route.useLoaderData();
  const { data: cast, isError, refetch } = useQuery({ ...tvCastQuery(id), ...(known.cast ? { initialData: known.cast } : {}) });
  const { data: show } = useQuery(tvQuery(id));
  return <CastPage title={show?.name ?? known.name} cast={cast} isError={isError} onRetry={() => void refetch()} />;
}
