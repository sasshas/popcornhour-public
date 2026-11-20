// The Home page's rows, and the "See more" pages that show the same list as a full poster grid.
// Client-safe (no server imports): the slug is what appears in the URL, /browse/<slug>.
export const BROWSE_CATEGORIES = {
  trending: { title: "Trending today", path: "/trending/all/day", mediaType: undefined },
  "popular-movies": { title: "Popular movies", path: "/movie/popular", mediaType: "movie" },
  "popular-tv": { title: "Popular TV shows", path: "/tv/popular", mediaType: "tv" },
  upcoming: { title: "Upcoming in theaters", path: "/movie/upcoming", mediaType: "movie" },
  "top-movies": { title: "Top rated movies", path: "/movie/top_rated", mediaType: "movie" },
  "top-tv": { title: "Top rated TV", path: "/tv/top_rated", mediaType: "tv" },
} as const;

export type BrowseCategory = keyof typeof BROWSE_CATEGORIES;

export const BROWSE_SLUGS = Object.keys(BROWSE_CATEGORIES) as [BrowseCategory, ...BrowseCategory[]];

export function isBrowseCategory(value: string): value is BrowseCategory {
  return Object.prototype.hasOwnProperty.call(BROWSE_CATEGORIES, value);
}

/** TMDB only serves the first 500 pages of any list. */
export const BROWSE_MAX_PAGES = 500;
