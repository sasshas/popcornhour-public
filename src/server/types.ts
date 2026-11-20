export type MediaKind = "movie" | "tv";
export type LibraryStatus = "watching" | "completed" | "plan_to_watch" | "dropped" | "on_hold";

export interface LibraryItem {
  id: string;
  user_id: string;
  media_type: MediaKind;
  tmdb_id: number;
  title: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string | null;
  status: LibraryStatus;
  watchlist: boolean;
  favorite: boolean;
  rating: number | null;
  notes: string | null;
  watched_at: string | null;
  /** Only set by listLibraryItems: a movie's watched_at, or a show's latest watched episode. */
  last_watched_at?: string | null;
  vote_average: number | null;
  last_known_seasons: number;
  created_at: string;
  updated_at: string;
}

export interface EpisodeProgressRow {
  season_number: number;
  episode_number: number;
  watched_at: string;
  rating: number | null;
}

export interface Profile {
  id: string;
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListItemRow {
  id: string;
  list_id: string;
  user_id: string;
  media_type: MediaKind;
  tmdb_id: number;
  title: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string | null;
  vote_average: number | null;
  position: number;
  added_at: string;
}

export interface PlayRow {
  id: string;
  user_id: string;
  media_type: MediaKind;
  tmdb_id: number;
  season_number: number | null;
  episode_number: number | null;
  watched_at: string;
  rating: number | null;
  created_at: string;
}

export interface TraktConnectionRow {
  id: string;
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  trakt_user_id: string | null;
  trakt_username: string | null;
  trakt_slug: string | null;
  scope: string | null;
  connected_at: string;
  updated_at: string;
}
