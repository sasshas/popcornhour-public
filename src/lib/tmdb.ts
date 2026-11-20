// Client-safe TMDB constants and helpers
export const TMDB_IMG = "https://image.tmdb.org/t/p";

export type ImgSize =
  | "w45" | "w92" | "w154" | "w185" | "w200" | "w300" | "w342" | "w500" | "w780" | "w1280" | "original";

/** TMDB's own "User Score": its 0-10 vote average shown as a whole percent, as on themoviedb.org (7.97 -> 80). */
export function tmdbPercent(voteAverage: number): number {
  return Math.round(voteAverage * 10);
}

export function img(path: string | null | undefined, size: ImgSize = "w500"): string | null {
  if (!path) return null;
  return `${TMDB_IMG}/${size}${path}`;
}

export type MediaType = "movie" | "tv" | "person";

export interface MediaItem {
  id: number;
  media_type?: MediaType;
  title?: string;
  name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  profile_path?: string | null;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  genre_ids?: number[];
}

export interface MovieDetails extends MediaItem {
  runtime?: number;
  imdb_id?: string | null;
  homepage?: string | null;
  genres?: { id: number; name: string }[];
  tagline?: string;
  status?: string;
  /** In US dollars; 0 when TMDB does not know. */
  budget?: number;
  revenue?: number;
  /** The film series this movie is part of, e.g. "Toy Story Collection". */
  belongs_to_collection?: { id: number; name: string } | null;
  /** Two-letter language code of the original version, e.g. "en". */
  original_language?: string;
  production_countries?: { iso_3166_1: string; name: string }[];
  /** The studios behind the film, the main one first. */
  production_companies?: { id: number; name: string; logo_path: string | null }[];
  credits?: { cast: CastMember[]; crew: CrewMember[] };
  videos?: { results: Video[] };
  recommendations?: { results: MediaItem[] };
  reviews?: { results: TmdbReview[] };
  keywords?: { keywords: { id: number; name: string }[] };
}

export interface TmdbReview {
  id: string;
  author: string;
  content: string;
  created_at: string;
  author_details?: { rating?: number | null; avatar_path?: string | null; username?: string };
}

export interface TVDetails extends MediaItem {
  number_of_seasons?: number;
  number_of_episodes?: number;
  episode_run_time?: number[];
  genres?: { id: number; name: string }[];
  tagline?: string;
  status?: string;
  seasons?: Season[];
  credits?: { cast: CastMember[]; crew: CrewMember[] };
  videos?: { results: Video[] };
  recommendations?: { results: MediaItem[] };
  next_episode_to_air?: Episode | null;
  last_episode_to_air?: Episode | null;
  external_ids?: { imdb_id?: string | null; tvdb_id?: number | null };
  homepage?: string | null;
  /** The date of the latest episode shown so far. */
  last_air_date?: string | null;
  /** The people who created the show. */
  created_by?: { id: number; name: string }[];
  /** The channels or streaming services it is made for (HBO, Netflix, ABC...), the main one first. */
  networks?: { id: number; name: string; logo_path: string | null }[];
  /** Two-letter language code of the original version, e.g. "en". */
  original_language?: string;
  /** Two-letter codes of the countries it comes from, e.g. ["US"]. */
  origin_country?: string[];
  reviews?: { results: TmdbReview[] };
}

export interface Season {
  id: number;
  season_number: number;
  name: string;
  overview: string;
  poster_path: string | null;
  air_date: string | null;
  episode_count: number;
}

export interface Episode {
  id: number;
  episode_number: number;
  season_number: number;
  name: string;
  overview: string;
  still_path: string | null;
  air_date: string | null;
  runtime?: number | null;
  vote_average?: number;
}

export interface SeasonDetails {
  id: number;
  season_number: number;
  name: string;
  overview: string;
  poster_path: string | null;
  air_date: string | null;
  episodes: Episode[];
}

/** One episode in full, for its own page. */
export interface EpisodeDetails extends Episode {
  /** The people who made this episode (Director, Writer...). */
  crew?: CrewMember[];
  /** Actors in this episode only. */
  guest_stars?: CastMember[];
  /** The show's regular cast who appear in it, plus the guest stars again. */
  credits?: { cast: CastMember[]; guest_stars: CastMember[]; crew: CrewMember[] };
  external_ids?: { imdb_id?: string | null };
  images?: { stills: { file_path: string }[] };
  vote_count?: number;
}

export interface CastMember {
  id: number;
  name: string;
  character: string;
  profile_path: string | null;
  order: number;
}

export interface CrewMember {
  id: number;
  name: string;
  job: string;
  department: string;
  profile_path: string | null;
}

export interface Video {
  id: string;
  key: string;
  name: string;
  site: string;
  type: string;
  official: boolean;
}

export interface PersonDetails {
  id: number;
  name: string;
  biography: string;
  birthday: string | null;
  deathday: string | null;
  place_of_birth: string | null;
  profile_path: string | null;
  known_for_department: string | null;
  combined_credits?: {
    cast: (MediaItem & { character?: string; episode_count?: number })[];
    crew: (MediaItem & { job?: string; department?: string; episode_count?: number })[];
  };
}

export function titleOf(m: MediaItem): string {
  return m.title || m.name || "Untitled";
}

export function yearOf(m: MediaItem): string {
  const d = m.release_date || m.first_air_date || "";
  return d ? d.slice(0, 4) : "";
}

export function formatRuntime(min?: number | null): string {
  if (!min) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
