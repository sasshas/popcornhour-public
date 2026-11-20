import { useParams } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { img } from "@/lib/tmdb";
import { HERO_POSTER, peekOf } from "@/lib/peek";
import { PosterViewer } from "./PosterViewer";

/**
 * The pictures at the top of a movie or show page, and the placeholder page shown while its details load.
 * They live together so the placeholder and the real page use exactly the same boxes and the same picture
 * files: when the details arrive nothing moves and the poster does not load twice.
 */

// Movie and show pages share one layout; which one it is only matters for the tapped card's poster and title (peek).
type Layout = "movie" | "tv";

// A little taller on a phone (16:10 instead of 16:9), since the page starts at the very top.
const BACKDROP_BOX = "relative aspect-[16/10] md:aspect-video max-h-[520px] overflow-hidden";
const POSTER_WIDTH = "w-28 md:w-56";
// The width the poster is drawn at, so the browser can pick the smallest file that is still sharp.
const POSTER_SIZES = "(min-width: 768px) 224px, 112px";

/**
 * The poster beside the title. Its box is always 2:3, so the page does not jump when the picture arrives. On a
 * phone the browser picks the 342px file, the same one the poster grids use, so it is usually already downloaded
 * and shows at once; bigger or sharper screens get the 500px one.
 *
 * Tapping it shows the poster big (PosterViewer). The placeholder page passes `still`: same box, nothing to tap.
 * `overlay` is drawn over the bottom of the poster (a season's watched bar).
 */
export function DetailPoster({
  path, alt, layout, still, overlay,
}: { path: string | null | undefined; alt: string; layout: Layout; still?: boolean; overlay?: React.ReactNode }) {
  const button = useRef<HTMLButtonElement>(null);
  const [big, setBig] = useState(false);
  if (!path) return null;
  return (
    <>
      <button
        ref={button}
        type="button"
        disabled={still}
        onClick={() => setBig(true)}
        aria-label={still ? undefined : "Enlarge poster"}
        className={`relative ${POSTER_WIDTH} shrink-0 rounded-2xl ${still ? "" : "cursor-zoom-in"} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
      >
        <img
          // A new picture is a new element, so it always carries the animation name (markHeroPoster may have taken it
          // off the old one).
          key={path}
          src={img(path, "w342")!}
          srcSet={`${img(path, "w342")} 342w, ${img(path, "w500")} 500w`}
          sizes={POSTER_SIZES}
          alt={alt}
          // The poster of the card that was tapped grows into this one when the page opens (see markHeroPoster).
          style={{ viewTransitionName: HERO_POSTER }}
          className="block w-full aspect-[2/3] object-cover bg-surface rounded-2xl ring-1 ring-border shadow-2xl"
        />
        {overlay && <div className="absolute inset-x-0 bottom-0 overflow-hidden rounded-b-2xl">{overlay}</div>}
      </button>
      {/* Beside the button, not in it: clicks inside the viewer would otherwise reach the button and reopen it. */}
      {big && <PosterViewer path={path} alt={alt} source={button} onClosed={() => setBig(false)} />}
    </>
  );
}

/**
 * The wide picture across the top. A phone gets the 780px file instead of the 1280px one (about a third of the
 * download): the picture sits under a fade into the page, so the difference is hard to see. `children` are drawn
 * over it (the fade, the trailer button).
 */
export function DetailBackdrop({ path, children }: { path: string | null | undefined; children?: React.ReactNode }) {
  return (
    <div className={BACKDROP_BOX}>
      {path && (
        <img
          src={img(path, "w1280")!}
          srcSet={`${img(path, "w780")} 780w, ${img(path, "w1280")} 1280w`}
          // Deliberately understated on a phone (60vw, not the true 100vw) so that sharp phone screens take the 780px file.
          sizes="(max-width: 767px) 60vw, 100vw"
          alt=""
          decoding="async"
          fetchPriority="high"
          className="absolute inset-0 w-full h-full object-cover"
        />
      )}
      {children}
    </div>
  );
}

const BAR = "rounded-full bg-surface animate-pulse";

/**
 * Shown the moment a movie or show is tapped, until its details arrive: the same layout as the real page, with the
 * poster and title of the card that was tapped (see `peek`) and grey bars where the rest will be.
 */
export function DetailSkeleton({ layout }: { layout: Layout }) {
  const { id } = useParams({ strict: false }) as { id?: string };
  const peek = id ? peekOf(layout, id) : undefined;
  return (
    <article className="space-y-10 pb-12" aria-busy="true">
      <header className="relative">
        <DetailBackdrop path={peek?.backdropPath}>
          <div className="absolute inset-0 bg-surface/40" />
          <div className="absolute inset-0 bg-gradient-to-t from-background from-0% via-background/55 via-35% to-transparent to-75%" />
        </DetailBackdrop>
        <div className="px-4 md:px-10 -mt-16 md:-mt-32 relative">
          <div className="flex flex-row items-center md:items-start gap-4 md:gap-8">
            {peek?.posterPath ? (
              <DetailPoster path={peek.posterPath} alt="" layout={layout} still />
            ) : (
              <div className={`${POSTER_WIDTH} aspect-[2/3] shrink-0 rounded-2xl bg-surface ring-1 ring-border animate-pulse`} />
            )}
            <div className="min-w-0 flex-1 space-y-3 md:pt-12">
              {peek?.title ? (
                <h1 className="text-xl md:text-5xl font-bold tracking-tight break-words leading-tight">
                  {peek.title}
                </h1>
              ) : (
                <div className={`${BAR} h-7 md:h-12 w-3/4`} />
              )}
              <div className={`${BAR} h-4 w-1/2`} />
              <div className={`${BAR} h-4 w-1/3`} />
            </div>
          </div>
          <div className="mt-4 md:mt-6 space-y-4 md:space-y-6">
            <div className="flex gap-2">
              <div className={`${BAR} h-7 w-20`} />
              <div className={`${BAR} h-7 w-24`} />
              <div className={`${BAR} h-7 w-16`} />
            </div>
            <div className="grid grid-cols-2 gap-3 md:max-w-sm">
              <div className={`${BAR} h-12`} />
              <div className={`${BAR} h-12`} />
            </div>
          </div>
        </div>
      </header>
      <section className="px-4 md:px-10 max-w-4xl space-y-3">
        <div className={`${BAR} h-5 w-28`} />
        <div className={`${BAR} h-4 w-full`} />
        <div className={`${BAR} h-4 w-full`} />
        <div className={`${BAR} h-4 w-2/3`} />
      </section>
      <span className="sr-only">Loading…</span>
    </article>
  );
}
