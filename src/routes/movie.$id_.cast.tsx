import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { movieQuery } from "@/lib/movie-query";
import { CastPage } from "@/components/media/CastGrid";

// A movie's full cast, opened from "See all" beside "Top cast" on its page. The cast comes with the movie's details,
// which are usually already here from that page, so it draws at once.
export const Route = createFileRoute("/movie/$id_/cast")({
  beforeLoad: ({ params }) => {
    if (!/^[1-9]\d*$/.test(params.id)) throw notFound();
  },
  // As the movie page: a page opened directly waits for the details on the server; a tap does not wait.
  loader: ({ context, params }) => {
    const query = movieQuery(Number(params.id));
    if (typeof window === "undefined") return context.queryClient.ensureQueryData(query);
    void context.queryClient.prefetchQuery(query);
    return context.queryClient.getQueryData(query.queryKey);
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `Cast${loaderData?.title ? ` · ${loaderData.title}` : ""} — Popcornhour` }],
  }),
  component: MovieCastPage,
});

function MovieCastPage() {
  const id = Number(Route.useParams().id);
  const known = Route.useLoaderData();
  const { data: m, isError, refetch } = useQuery({ ...movieQuery(id), ...(known ? { initialData: known } : {}) });
  const cast = m?.credits?.cast.map((c) => ({ id: c.id, name: c.name, profile_path: c.profile_path, character: c.character }));
  return <CastPage title={m?.title} cast={m ? (cast ?? []) : undefined} isError={isError} onRetry={() => void refetch()} />;
}
