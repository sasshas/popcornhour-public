import type { MovieDetails, TVDetails } from "@/lib/tmdb";
import markG from "@/assets/classification/au-g.png";
import markPG from "@/assets/classification/au-pg.png";
import markM from "@/assets/classification/au-m.png";
import markMA15 from "@/assets/classification/au-ma15.png";
import markR18 from "@/assets/classification/au-r18.png";
import markX18 from "@/assets/classification/au-x18.png";
import markCTC from "@/assets/classification/au-ctc.png";

type ReleaseDatesResults = {
  results?: { iso_3166_1: string; release_dates: { certification?: string }[] }[];
};
type ContentRatingsResults = {
  results?: { iso_3166_1: string; rating?: string }[];
};

export function getAuCertification(
  m: (MovieDetails | TVDetails) & { release_dates?: ReleaseDatesResults; content_ratings?: ContentRatingsResults },
): string | null {
  // Movies: release_dates
  const rd = m.release_dates?.results?.find((r) => r.iso_3166_1 === "AU");
  if (rd) {
    const cert = rd.release_dates.map((x) => x.certification).find((c) => c && c.trim());
    if (cert) return normalize(cert.trim());
  }
  // TV: content_ratings
  const cr = m.content_ratings?.results?.find((r) => r.iso_3166_1 === "AU");
  if (cr?.rating) return normalize(cr.rating.trim());
  return null;
}

function normalize(c: string): string {
  // TMDB returns e.g. "MA15+", "R18+", "M", "PG", "G", "X18+", "RC", "CTC", and sometimes with a space
  // ("MA 15+", "R 18+"), so spaces are dropped before matching.
  return c.toUpperCase().replace(/\s+/g, "");
}

// The official Australian Classification marks, as published by classification.gov.au.
const MARKS: Record<string, string> = {
  G: markG,
  PG: markPG,
  M: markM,
  "MA15+": markMA15,
  "R18+": markR18,
  "X18+": markX18,
  CTC: markCTC, // "Check the Classification"
};

// Anything without an official image (e.g. "RC", Refused Classification) keeps a plain text badge.
const FALLBACK = "bg-zinc-700 text-white";

export function AuRatingBadge({ rating }: { rating: string | null | undefined }) {
  if (!rating) return null;
  const mark = MARKS[rating];
  const label = `Australian Classification: ${rating}`;
  if (mark) {
    return <img src={mark} alt={label} title={label} className="size-8 md:size-10 shrink-0" />;
  }
  return (
    <span
      title={label}
      className={`inline-flex items-center justify-center rounded-md px-2 py-0.5 text-[11px] font-bold tracking-wide ${FALLBACK}`}
    >
      {rating}
    </span>
  );
}
