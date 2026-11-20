// Which Rotten Tomatoes icon to show for a score. Pure, so both the page and the tests can use it.

export type TomatometerIcon = "certified" | "fresh" | "rotten";
export type PopcornIcon = "verified-hot" | "upright" | "spilled";

/** Below this the critics' verdict is "Rotten" (RT: 60% or more positive reviews is "Fresh"). */
export const FRESH_THRESHOLD = 60;
/** "Certified Fresh" needs a steady 75%+ and a minimum number of reviews (RT: 80 for a wide-release movie). */
export const CERTIFIED_THRESHOLD = 75;
export const CERTIFIED_MIN_REVIEWS = 80;

/**
 * Critics' icon. Certified Fresh is an APPROXIMATION: RT also requires 5 reviews from "top critics",
 * which our data source does not report, and its TV rules differ, so it is only inferred for movies
 * and only when the review count is known.
 */
export function tomatometerIcon(
  score: number,
  reviews: number | null | undefined,
  mediaType: "movie" | "tv" = "movie",
): TomatometerIcon {
  if (score < FRESH_THRESHOLD) return "rotten";
  if (mediaType === "movie" && score >= CERTIFIED_THRESHOLD && (reviews ?? 0) >= CERTIFIED_MIN_REVIEWS) {
    return "certified";
  }
  return "fresh";
}

/** "Verified Hot" needs an audience score of 90%+ with a minimum number of ratings (RT: 500 verified ones). */
export const VERIFIED_HOT_THRESHOLD = 90;
export const VERIFIED_HOT_MIN_RATINGS = 500;

/**
 * Audience ("Popcornmeter") icon: Verified Hot at 90%+ with 500+ ratings, an upright bucket at 60%+, a
 * spilled one below. Verified Hot is an APPROXIMATION: RT counts only "verified" ratings (people who
 * proved they bought a ticket), our data source reports all audience ratings. Needs a known rating count.
 */
export function popcornIcon(score: number, ratings?: number | null): PopcornIcon {
  if (score >= VERIFIED_HOT_THRESHOLD && (ratings ?? 0) >= VERIFIED_HOT_MIN_RATINGS) return "verified-hot";
  return score >= FRESH_THRESHOLD ? "upright" : "spilled";
}
