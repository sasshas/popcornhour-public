// Ordered migrations. Index + 1 is the PRAGMA user_version after applying it.
// Append new entries; never edit an applied one.
const NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const MIGRATIONS: string[] = [
  `
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE library_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie','tv')),
  tmdb_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  poster_path TEXT,
  backdrop_path TEXT,
  release_date TEXT,
  status TEXT NOT NULL DEFAULT 'plan_to_watch'
    CHECK (status IN ('watching','completed','plan_to_watch','dropped','on_hold')),
  watchlist INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 10)),
  notes TEXT,
  watched_at TEXT,
  vote_average REAL,
  last_known_seasons INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (user_id, media_type, tmdb_id)
);
CREATE INDEX library_items_user_status_idx ON library_items(user_id, status);

CREATE TABLE episode_progress (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tv_tmdb_id INTEGER NOT NULL,
  season_number INTEGER NOT NULL,
  episode_number INTEGER NOT NULL,
  watched_at TEXT NOT NULL DEFAULT ${NOW},
  rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 10)),
  created_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (user_id, tv_tmdb_id, season_number, episode_number)
);

CREATE TABLE plays (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie','tv')),
  tmdb_id INTEGER NOT NULL,
  season_number INTEGER,
  episode_number INTEGER,
  watched_at TEXT NOT NULL DEFAULT ${NOW},
  rating INTEGER CHECK (rating BETWEEN 1 AND 10),
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX plays_user_media_idx ON plays(user_id, media_type, tmdb_id);
CREATE INDEX plays_episode_idx ON plays(user_id, media_type, tmdb_id, season_number, episode_number);

CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE list_items (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie','tv')),
  tmdb_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  poster_path TEXT,
  backdrop_path TEXT,
  release_date TEXT,
  vote_average REAL,
  position INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (list_id, media_type, tmdb_id)
);
CREATE INDEX list_items_list_id_idx ON list_items(list_id);

CREATE TABLE trakt_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  trakt_user_id TEXT,
  trakt_username TEXT,
  trakt_slug TEXT,
  scope TEXT,
  connected_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE parents_guide_cache (
  imdb_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
`,
  // 2: streaming-service badges on posters. A cache of TMDB /watch/providers, trimmed to the
  // subscription ("flatrate") services of one region per title. Safe to delete; it refills itself.
  `
CREATE TABLE watch_provider_cache (
  media_type TEXT NOT NULL CHECK (media_type IN ('movie','tv')),
  tmdb_id INTEGER NOT NULL,
  region TEXT NOT NULL,
  providers TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (media_type, tmdb_id, region)
);
`,
  // 3: general-purpose cache of small TMDB answers (library scores, movie availability), so the
  // Library does not re-ask TMDB about every title on every visit. Safe to delete; it refills itself.
  `
CREATE TABLE tmdb_cache (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT ${NOW}
);
`,
  // 4: small app-wide settings that belong to the server, not one browser (automatic backup on/off
  // and how often).
  `
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
`,
  // 5: the WeTrakr sign-in (same idea as trakt_connections). Tokens stay on the server.
  `
CREATE TABLE wetrakr_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  username TEXT,
  connected_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
`,
  // 6: changes made inside this app that have not been sent to Trakt / WeTrakr yet. Sync sends
  // only these rows, never the whole library. One row per subject; see sync-changes.server.ts.
  `
CREATE TABLE sync_changes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('watch','unwatch','watchlist','rating')),
  media_type TEXT NOT NULL CHECK (media_type IN ('movie','tv')),
  tmdb_id INTEGER NOT NULL,
  season_number INTEGER,
  episode_number INTEGER,
  title TEXT NOT NULL,
  watched_at TEXT,
  first_watch INTEGER NOT NULL DEFAULT 0,
  value INTEGER,
  prev_value INTEGER,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (user_id, subject)
);
`,
  // 7: changes now wait separately for each connected service (Trakt and WeTrakr both get them),
  // so one service being down or refusing a change does not hold up the other. The table from 6
  // was never deployed with rows in it, so it is simply replaced.
  `
DROP TABLE sync_changes;
CREATE TABLE sync_changes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  service TEXT NOT NULL CHECK (service IN ('trakt','wetrakr')),
  subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('watch','unwatch','watchlist','rating')),
  media_type TEXT NOT NULL CHECK (media_type IN ('movie','tv')),
  tmdb_id INTEGER NOT NULL,
  season_number INTEGER,
  episode_number INTEGER,
  title TEXT NOT NULL,
  watched_at TEXT,
  first_watch INTEGER NOT NULL DEFAULT 0,
  value INTEGER,
  prev_value INTEGER,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (user_id, service, subject)
);
`,
  // 8: more kinds of change are sent: lists (create, rename, delete, items), favourites, a show's
  // Dropped / On hold status, and removing one play. Same table, more columns and kinds.
  `
CREATE TABLE sync_changes_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  service TEXT NOT NULL CHECK (service IN ('trakt','wetrakr')),
  subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('watch','unwatch','unplay','watchlist','rating','favorite','status','list','list_item')),
  media_type TEXT NOT NULL CHECK (media_type IN ('movie','tv')),
  tmdb_id INTEGER NOT NULL,
  season_number INTEGER,
  episode_number INTEGER,
  title TEXT NOT NULL,
  watched_at TEXT,
  first_watch INTEGER NOT NULL DEFAULT 0,
  value INTEGER,
  prev_value INTEGER,
  status TEXT,
  prev_status TEXT,
  list_id TEXT,
  list_name TEXT,
  prev_name TEXT,
  list_description TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (user_id, service, subject)
);
INSERT INTO sync_changes_new
  (id, user_id, service, subject, kind, media_type, tmdb_id, season_number, episode_number, title,
   watched_at, first_watch, value, prev_value, created_at)
SELECT id, user_id, service, subject, kind, media_type, tmdb_id, season_number, episode_number, title,
   watched_at, first_watch, value, prev_value, created_at FROM sync_changes;
DROP TABLE sync_changes;
ALTER TABLE sync_changes_new RENAME TO sync_changes;
`,
  // 9: one-off repair of watched dates left wrong by the old play deletion (fixed in f8c94de). Removing a play
  // never touched the tick's date, and adding a newer play from the watch history never moved it forward.
  //  - An episode with plays gets the date of its latest play. Imports never change an existing episode's date,
  //    so a different one can only be a leftover.
  //  - A watched movie with plays gets its latest play's date only when that is later. A later date with no
  //    play can be a real one from a Trakt import, so it is left alone.
  // Not queued for Sync: the services work the date out from the plays. Nothing else changes.
  `
UPDATE episode_progress SET watched_at = (
  SELECT p.watched_at FROM plays p
  WHERE p.user_id = episode_progress.user_id AND p.media_type = 'tv' AND p.tmdb_id = episode_progress.tv_tmdb_id
    AND p.season_number = episode_progress.season_number AND p.episode_number = episode_progress.episode_number
    AND julianday(p.watched_at) IS NOT NULL
  ORDER BY julianday(p.watched_at) DESC LIMIT 1
)
WHERE julianday(watched_at) IS NOT (
  SELECT MAX(julianday(p.watched_at)) FROM plays p
  WHERE p.user_id = episode_progress.user_id AND p.media_type = 'tv' AND p.tmdb_id = episode_progress.tv_tmdb_id
    AND p.season_number = episode_progress.season_number AND p.episode_number = episode_progress.episode_number
)
AND EXISTS (
  SELECT 1 FROM plays p
  WHERE p.user_id = episode_progress.user_id AND p.media_type = 'tv' AND p.tmdb_id = episode_progress.tv_tmdb_id
    AND p.season_number = episode_progress.season_number AND p.episode_number = episode_progress.episode_number
    AND julianday(p.watched_at) IS NOT NULL
);

UPDATE library_items SET watched_at = (
  SELECT p.watched_at FROM plays p
  WHERE p.user_id = library_items.user_id AND p.media_type = 'movie' AND p.tmdb_id = library_items.tmdb_id
    AND julianday(p.watched_at) IS NOT NULL
  ORDER BY julianday(p.watched_at) DESC LIMIT 1
)
WHERE media_type = 'movie' AND status = 'completed'
AND (
  SELECT MAX(julianday(p.watched_at)) FROM plays p
  WHERE p.user_id = library_items.user_id AND p.media_type = 'movie' AND p.tmdb_id = library_items.tmdb_id
) > COALESCE(julianday(watched_at), 0);
`,
  // 10: release notifications (release-notify.server.ts). `release_notify_seen` holds each watchlist movie the daily
  // check has looked at; `release_notify_events` what it has already told you about (or found already true the first
  // time it saw the movie, with sent = 0), so each notification goes out once. Rows of a movie that leaves the
  // watchlist are removed, so putting it back starts afresh.
  `
CREATE TABLE release_notify_seen (
  tmdb_id INTEGER PRIMARY KEY,
  first_checked_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE release_notify_events (
  tmdb_id INTEGER NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('streaming','digital','cinema')),
  sent INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (tmdb_id, event)
);
`,
];
