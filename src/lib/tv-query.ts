import { queryOptions } from "@tanstack/react-query";
import { getEpisode, getSeason, getTV } from "@/lib/tmdb.functions";

/** A show's details. Shared by the show page and its season and episode pages (which use its backdrop and name). */
export const tvQuery = (id: number) =>
  queryOptions({ queryKey: ["tv", id], queryFn: () => getTV({ data: { id } }), staleTime: 1000 * 60 * 30 });

/** A season and its episodes. The episode page uses it too, to draw the tapped episode at once. */
export const seasonQuery = (id: number, sn: number) =>
  queryOptions({
    queryKey: ["season", id, sn],
    queryFn: () => getSeason({ data: { id, seasonNumber: sn } }),
    staleTime: 1000 * 60 * 30,
  });

/** One episode in full (cast, crew, IMDb id, stills). */
export const episodeQuery = (id: number, sn: number, ep: number) =>
  queryOptions({
    queryKey: ["episode", id, sn, ep],
    queryFn: () => getEpisode({ data: { id, seasonNumber: sn, episodeNumber: ep } }),
    staleTime: 1000 * 60 * 30,
  });
