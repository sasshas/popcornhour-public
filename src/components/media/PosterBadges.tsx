import type { ReactNode } from "react";
import { Bookmark, Check, ListChecks, Play, Star, Users } from "lucide-react";
import { img, tmdbPercent } from "@/lib/tmdb";
import { useInView } from "@/hooks/use-in-view";
import { useLibraryStatus } from "@/hooks/use-library-status";
import { useListMembership } from "@/hooks/use-list-membership";
import { useInterestedMembership } from "@/hooks/use-interested-membership";
import { useProviderBadges } from "@/hooks/use-provider-badges";
import { usePosterScore } from "@/hooks/use-poster-score";
import { tomatometerIcon, type TomatometerIcon } from "@/lib/rotten-tomatoes";
import { TOMATO_ICON, TOMATO_LABEL } from "@/components/media/rt-icons";

const MAX_LOGOS = 2;

// Badges are small circles, a little smaller below the md breakpoint so they fit a phone-sized poster.
const CIRCLE = "size-5 md:size-8 shrink-0 grid place-items-center rounded-full";
const ICON = "size-3 md:size-4";
// Real borders (not box-shadow rings): the image is clipped inside the border, so the edge stays crisp.
const BORDER = "border-[1.5px] md:border-2";
// White outline keeps overlapping logos distinct. Half the width of BORDER: the circle keeps its size,
// so the logo inside gets the freed space (30px on desktop, 18.5px on phones).
const LOGO_RING = "border-[0.75px] md:border border-white";
// The score pill and the top-right group sit a little above the poster's top edge, so a sliver of each pokes out over it.
const TOP = "-top-1 md:-top-1.5";
/** TMDB logo sizes (name, width in px) offered to the browser through srcset. */
const LOGO_SIZES = [["w45", 45], ["w92", 92], ["w154", 154]] as const;

/**
 * The badges on a poster. Put it inside the poster's `relative` box; it covers the poster and ignores
 * clicks, so the poster link still works.
 *
 *   top left     the score pill (Rotten Tomatoes, else IMDb, else nothing)
 *   top right    watched, else watching (a show), else on your watchlist, with "in one of your lists" stacked below it
 *                (two people instead of the list icon when it's on the "<name> is interested" list)
 *   bottom left  streaming services the title is on (subscription, in your region)
 *
 * Streaming services are looked up only once the poster scrolls into view.
 */
export function PosterBadges({
  mediaType,
  tmdbId,
  score,
  showList = true,
  statusOnly = false,
  bottomLeft,
}: {
  /** Something else for the bottom-left corner (the Library's release-date pill): sits just above the streaming logos. */
  bottomLeft?: ReactNode;
  mediaType: string | undefined;
  tmdbId: number | string;
  /** TMDB vote average: shown only when Rotten Tomatoes / IMDb scores cannot be looked up at all. */
  score?: number | null;
  /** Hide the "in a list" badge (on a list's own page every title is in a list). */
  showList?: boolean;
  /** Only the top-right badges (watched / watchlist / in a list): no streaming logos, no score, no lookups. */
  statusOnly?: boolean;
}) {
  const [ref, seen] = useInView<HTMLDivElement>();
  const { data: providers = [] } = useProviderBadges(mediaType, tmdbId, seen && !statusOnly);
  const { watched, watching, watchlist } = useLibraryStatus()(mediaType, tmdbId);
  const inList = useListMembership()(mediaType, tmdbId);
  const listed = showList && inList;
  // On the "<name> is interested" list: the list badge shows two people instead (even if it's on other lists too).
  const interested = useInterestedMembership();
  const forPartner = listed && interested.has(mediaType, tmdbId);

  const logos = providers.slice(0, MAX_LOGOS);
  const extra = providers.length - logos.length;
  // The score pill: Rotten Tomatoes critics' score, else the IMDb rating, else nothing. Only where those cannot be
  // looked up at all (no ratings key on the server, or not a movie/show) does it show the TMDB score instead.
  const kind = mediaType === "movie" || mediaType === "tv" ? mediaType : null;
  const { data: scores } = usePosterScore(mediaType, tmdbId, seen && !statusOnly);
  type Pill =
    | { kind: "rt"; icon: TomatometerIcon; text: string; title: string }
    | { kind: "imdb" | "tmdb"; text: string; title: string };
  let pill: Pill | null = null;
  if (statusOnly) pill = null;
  else if (kind && scores && scores.rt !== null) {
    const icon = tomatometerIcon(scores.rt, scores.rtReviews, kind);
    pill = { kind: "rt", icon, text: `${scores.rt}%`, title: `Rotten Tomatoes: ${scores.rt}% (${TOMATO_LABEL[icon]})` };
  } else if (kind && scores && scores.imdb !== null) {
    pill = { kind: "imdb", text: scores.imdb.toFixed(1), title: `IMDb: ${scores.imdb.toFixed(1)} out of 10` };
  } else if ((!kind || scores === null) && typeof score === "number" && score > 0) {
    pill = { kind: "tmdb", text: `${tmdbPercent(score)}%`, title: `TMDB: ${tmdbPercent(score)}%` };
  }

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0">
      {pill && (
        <div
          className={`pointer-events-auto absolute ${TOP} left-1.5 md:left-2 flex items-center gap-1 bg-background/90 rounded-full px-1.5 md:px-2 py-0.5 text-[10px] md:text-[11px] font-medium`}
          title={pill.title}
        >
          {pill.kind === "rt" ? (
            <img src={TOMATO_ICON[pill.icon]} alt="" className="size-3 md:size-3.5 object-contain" />
          ) : pill.kind === "imdb" ? (
            <span className="rounded-[3px] bg-[#f5c518] px-[3px] text-[8px] md:text-[9px] font-bold leading-[1.35] text-black">IMDb</span>
          ) : (
            <Star className="size-3 fill-[var(--gold)] text-[var(--gold)]" />
          )}
          {pill.text}
        </div>
      )}

      {(logos.length > 0 || bottomLeft) && (
        <div className="absolute bottom-1.5 left-1.5 md:bottom-2 md:left-2 flex flex-col items-start gap-1">
          {bottomLeft && <div className="pointer-events-auto">{bottomLeft}</div>}
          {logos.length > 0 && (
            <div
              className="pointer-events-auto flex items-center -space-x-1.5 md:-space-x-2"
              title={providers.map((p) => p.name).join(", ")}
            >
              {logos.map((p) => (
                // no-glass: keeps the liquid-glass "pill" rule (styles.css) off this circle. It matched by accident and
                // put a backdrop blur, the costliest thing to scroll, behind every logo on every poster.
                <span key={p.id} className={`${CIRCLE} ${LOGO_RING} no-glass overflow-hidden bg-surface`}>
                  {p.logo && (
                    <img
                      src={img(p.logo, "w92")!}
                      // Let the browser pick the smallest logo that still has at least one real pixel per
                      // screen pixel, so a normal monitor is not shrinking a 92px logo down to ~28px.
                      srcSet={LOGO_SIZES.map(([size, w]) => `${img(p.logo, size)} ${w}w`).join(", ")}
                      sizes="(min-width: 768px) 30px, 19px"
                      alt={p.name}
                      loading="lazy"
                      decoding="async"
                      className="size-full object-cover"
                    />
                  )}
                </span>
              ))}
              {extra > 0 && (
                <span className={`${CIRCLE} ${LOGO_RING} bg-background text-[9px] md:text-[10px] font-semibold`}>+{extra}</span>
              )}
            </div>
          )}
        </div>
      )}

      {(watched || watching || watchlist || listed) && (
        // Overlapping like the logos on the left: the watched/watching/watchlist badge sits on top, the list badge peeks out beneath it.
        <div className={`absolute ${TOP} right-1.5 md:right-2 flex items-center`}>
          {watched ? (
            // Green, matching the tick on a show's finished seasons.
            <span className={`${CIRCLE} ${BORDER} border-green-200 relative z-10 bg-green-500 text-white`} title="Watched">
              <Check className={ICON} strokeWidth={3} />
            </span>
          ) : watching ? (
            <span className={`${CIRCLE} ${BORDER} border-blue-200 relative z-10 bg-blue-500 text-white`} title="Watching">
              <Play className={`${ICON} translate-x-[1px] fill-current`} />
            </span>
          ) : watchlist ? (
            <span className={`${CIRCLE} ${BORDER} border-orange-200 relative z-10 bg-[var(--gold)] text-white`} title="On your watchlist">
              <Bookmark className={`${ICON} fill-current`} />
            </span>
          ) : null}
          {listed && (
            <span
              className={`${CIRCLE} bg-violet-500 text-white ${watched || watchlist ? "-ml-1.5 md:-ml-2" : ""}`}
              title={forPartner ? `${interested.name} is interested` : "In one of your lists"}
            >
              {forPartner ? <Users className={ICON} strokeWidth={2.5} /> : <ListChecks className={ICON} />}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
