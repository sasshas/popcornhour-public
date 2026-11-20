import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { PosterCard } from "./PosterCard";
import type { MediaItem } from "@/lib/tmdb";
import type { BrowseCategory } from "@/lib/browse";

/**
 * A horizontally scrolling row of posters. `seeMore` adds a "See more" link to that list's full grid page.
 * `limit` draws only the first few posters (Home uses it to appear faster; the rest are added a moment later).
 */
export function MediaRail({
  title,
  items,
  size,
  seeMore,
  limit,
}: {
  title: string;
  items: MediaItem[];
  size?: "sm" | "md" | "lg";
  seeMore?: BrowseCategory;
  limit?: number;
}) {
  if (!items?.length) return null;
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between px-1">
        <h2 className="text-lg md:text-xl font-semibold tracking-tight">{title}</h2>
        {seeMore && (
          <Link
            to="/browse/$category"
            params={{ category: seeMore }}
            className="-mr-1 inline-flex items-center gap-0.5 rounded-full px-2 py-1 text-sm font-medium text-primary hover:bg-primary/10"
          >
            See more
            <ChevronRight className="size-4" />
          </Link>
        )}
      </div>
      <div className="flex gap-3 md:gap-4 overflow-x-auto scrollbar-none -mx-4 px-4 md:-mx-6 md:px-6 pt-2 -mt-2 pb-1">
        {(limit === undefined ? items : items.slice(0, limit)).map((it) => (
          <PosterCard key={`${it.media_type ?? "x"}-${it.id}`} item={it} size={size} />
        ))}
      </div>
    </section>
  );
}
