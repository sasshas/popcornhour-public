/**
 * What makes a movie "Upcoming", shared by the Library's Upcoming pill and a list's Upcoming pill so the two always
 * agree. Upcoming means it cannot be watched at home yet (not streaming, rentable or buyable in the US) AND it is new:
 * an old movie that simply is not on any US service (a 1997 film, say) is not upcoming.
 */

/** A movie's US availability, as `getMoviesAvailability` answers it. */
export type Availability = { available: boolean; digitalDate: string | null; cinemaDate: string | null };

/** Today's date on this device as YYYY-MM-DD (local time, not UTC, so it matches the day you see). */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * `releaseDate`: what is known of the movie's release, a full date or just the year ("2026"); "new" means this year
 * or last year, or no date at all (not released yet).
 * `cinemaCounts`: Filters > "Released means" (Anywhere = on): a movie that has opened in cinemas counts as out.
 *
 * A US digital (home) date decides on its own: still ahead = upcoming; today or past = out, even when no service is
 * listed yet. The services come from TMDB, which copies JustWatch's list with a delay of up to a day or so, so a film
 * out at home today can show no service for a while; it is not kept on Upcoming for that. "Today" is this device's day,
 * as the movie page's "Streaming from <date>" line.
 */
export function isUpcomingMovie(
  a: Availability | undefined,
  releaseDate: string | null | undefined,
  cinemaCounts: boolean,
): boolean {
  if (!a || a.available) return false;
  if (cinemaCounts && a.cinemaDate && Date.parse(a.cinemaDate) <= Date.now()) return false;
  if (a.digitalDate) return a.digitalDate.slice(0, 10) > todayLocal();
  const year = parseInt((releaseDate ?? "").slice(0, 4), 10);
  return Number.isNaN(year) || year >= new Date().getFullYear() - 1;
}

/**
 * The two date sorts of Upcoming and the first pill:
 *   "streaming"  when it can be watched at home: movies with a streaming (digital) date first, in that order, then
 *                the ones with only a cinema date, in cinema-date order, then those with no date at all.
 *   "cinema"     when it opens in cinemas; movies with no cinema date go last.
 * A show (lists only) uses its first air date for both.
 *
 * Filters > "Released means" (Anywhere = on) decides which one a pill offers, since only one of the two dates means
 * anything there (`upcomingDateSort`, `firstPillDateSort`):
 *   off (default)  Upcoming = can't watch at home yet, so it goes by Streaming date (soonest first); the first pill
 *                  (Library Unwatched, a list's Released) = can watch at home, so Streaming date too (newest first).
 *   on             a movie in cinemas counts as out, so Upcoming = not out anywhere yet: Cinema date (soonest first);
 *                  the first pill holds cinema movies too: Release date, which goes by the cinema date (newest first).
 */
export type UpcomingSort = "streaming" | "cinema";

/** The one date sort Upcoming offers. */
export const upcomingDateSort = (cinemaCounts: boolean): UpcomingSort => (cinemaCounts ? "cinema" : "streaming");
/** The one date sort the first pill offers ("release" = Release date). */
export const firstPillDateSort = (cinemaCounts: boolean): "streaming" | "release" =>
  cinemaCounts ? "release" : "streaming";

/** A full date ("2026-12-18"), or a year alone as the last day of that year, so it sorts after that year's dated ones. */
const norm = (d: string | null | undefined): string | null =>
  !d ? null : /^\d{4}$/.test(d) ? `${d}-12-31` : d.slice(0, 10);

export type UpcomingDates = { streaming: string | null; cinema: string | null };

/**
 * A movie's two dates for sorting: the US digital date, and the US cinema date. A movie with no cinema release (straight
 * to streaming) sorts by its digital date under Cinema date too, the same date its poster pill shows; with neither,
 * the release date known.
 */
export function upcomingDates(a: Availability | undefined, releaseDate: string | null | undefined): UpcomingDates {
  return { streaming: norm(a?.digitalDate), cinema: norm(a?.cinemaDate ?? a?.digitalDate ?? releaseDate) };
}

/** A show's dates for sorting: its first air date for both. */
export function airDates(firstAirDate: string | null | undefined): UpcomingDates {
  const d = norm(firstAirDate);
  return { streaming: d, cinema: d };
}

/**
 * Orders two titles by the chosen date. `dir` 1 = soonest first. Titles without the date go after those with it,
 * whichever way round, so the end of the list is always the least known.
 */
export function compareUpcoming(x: UpcomingDates, y: UpcomingDates, by: UpcomingSort, dir: 1 | -1): number {
  if (by === "streaming") {
    const group = (d: UpcomingDates) => (d.streaming ? 0 : d.cinema ? 1 : 2);
    const gx = group(x);
    const gy = group(y);
    if (gx !== gy) return gx - gy;
    if (gx === 2) return 0;
    const kx = (gx === 0 ? x.streaming : x.cinema)!;
    const ky = (gy === 0 ? y.streaming : y.cinema)!;
    return dir * kx.localeCompare(ky);
  }
  if (!x.cinema || !y.cinema) return x.cinema ? -1 : y.cinema ? 1 : 0;
  return dir * x.cinema.localeCompare(y.cinema);
}

/**
 * The badge on an Upcoming movie's poster, going by the date the pill sorts by.
 *   "streaming": the streaming (home) date once there is one. Without one: "In cinemas" when it has already opened
 *                there (a past date would look like a mistake on Upcoming), else the cinema date still ahead.
 *   "cinema":    the cinema date; with none, the streaming date (a movie going straight to streaming).
 */
export function upcomingBadge(
  a: Availability | undefined,
  by: UpcomingSort,
): { date: string; kind: "digital" | "cinema" | "in-cinemas" } | null {
  if (by === "cinema") {
    if (a?.cinemaDate) return { date: a.cinemaDate, kind: "cinema" };
    if (a?.digitalDate) return { date: a.digitalDate, kind: "digital" };
    return null;
  }
  if (a?.digitalDate) return { date: a.digitalDate, kind: "digital" };
  if (a?.cinemaDate) {
    return { date: a.cinemaDate, kind: Date.parse(a.cinemaDate) <= Date.now() ? "in-cinemas" : "cinema" };
  }
  return null;
}
