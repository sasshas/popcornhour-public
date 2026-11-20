import { Link } from "@tanstack/react-router";
import { Film, Tv } from "lucide-react";
import { img, titleOf, yearOf, type MediaItem } from "@/lib/tmdb";
import { PosterBadges } from "./PosterBadges";
import { useShowTitles } from "@/hooks/use-show-titles";
import { markHeroPoster, rememberPeek } from "@/lib/peek";

/**
 * size "fill" is for grids: the card takes the whole width of its cell instead of a fixed rail width.
 * `note` is an extra line under the year (a person's page: the character played, or the job).
 */
export function PosterCard({ item, size = "md", note }: { item: MediaItem; size?: "sm" | "md" | "lg" | "fill"; note?: string }) {
  const mediaType = item.media_type ?? (item.first_air_date || item.name ? "tv" : "movie");
  const showTitles = useShowTitles("home"); // Settings > Appearance (people always keep their names)
  if (mediaType === "person") {
    return (
      <Link to="/person/$id" params={{ id: String(item.id) }} className={`group block ${size === "fill" ? "w-full" : "w-32"} shrink-0`}>
        <div className="aspect-[2/3] rounded-xl overflow-hidden bg-surface ring-1 ring-border">
          {item.profile_path ? (
            <img src={img(item.profile_path, "w342")!} alt={titleOf(item)} loading="lazy" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
          ) : (
            <div className="w-full h-full grid place-items-center text-muted-foreground text-xs">No image</div>
          )}
        </div>
        <p className="mt-2 text-sm font-medium line-clamp-1">{titleOf(item)}</p>
      </Link>
    );
  }
  const to = mediaType === "tv" ? "/tv/$id" : "/movie/$id";
  const widthCls = size === "fill" ? "w-full" : size === "sm" ? "w-28" : size === "lg" ? "w-44" : "w-36";
  const poster = img(item.poster_path, "w342");
  return (
    <Link
      to={to}
      params={{ id: String(item.id) }}
      className={`group block ${widthCls} shrink-0`}
      // Lets the page being opened show this poster and title at once, while its details load.
      onClick={(e) => {
        rememberPeek(mediaType, item.id, { title: titleOf(item), posterPath: item.poster_path ?? null, backdropPath: item.backdrop_path });
        markHeroPoster(e.currentTarget);
      }}
      title={showTitles ? undefined : titleOf(item)} // tooltip + accessible name when the caption is hidden
      aria-label={showTitles ? undefined : titleOf(item)}
    >
      <div className="relative">
      <div data-hero={`${mediaType}:${item.id}`} className="relative aspect-[2/3] rounded-xl overflow-hidden bg-surface ring-1 ring-border">
        {poster ? (
          <img src={poster} alt={titleOf(item)} loading="lazy" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
        ) : (
          <div className="w-full h-full grid place-items-center text-muted-foreground">
            {mediaType === "tv" ? <Tv className="size-8" /> : <Film className="size-8" />}
          </div>
        )}
        <div className="absolute bottom-2 right-2 rounded-full bg-background/90 p-1 text-muted-foreground">
          {mediaType === "tv" ? <Tv className="size-3" /> : <Film className="size-3" />}
        </div>
      </div>
      <PosterBadges mediaType={mediaType} tmdbId={item.id} score={item.vote_average} />
      </div>
      <div className="mt-2 px-0.5">
        {showTitles && <p className="text-sm font-medium line-clamp-1">{titleOf(item)}</p>}
        {/* With a note under it, an unknown year still takes its line, so the notes in a row line up. */}
        <p className="text-xs text-muted-foreground">{yearOf(item) || (note ? " " : "")}</p>
        {note && <p className="text-xs text-muted-foreground/80 line-clamp-1" title={note}>{note}</p>}
      </div>
    </Link>
  );
}
