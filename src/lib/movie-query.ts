import { queryOptions } from "@tanstack/react-query";
import { getMovie } from "@/lib/tmdb.functions";

/** A movie's details. Shared by the movie page and its full cast page (which reads the cast from them). */
export const movieQuery = (id: number) =>
  queryOptions({ queryKey: ["movie", id], queryFn: () => getMovie({ data: { id } }), staleTime: 1000 * 60 * 30 });
