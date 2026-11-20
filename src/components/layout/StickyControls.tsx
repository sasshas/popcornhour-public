import type { ReactNode } from "react";
import { useScrollHide } from "@/lib/use-scroll-hide";

/**
 * A page's top toolbar (the Library's Movies / TV, pills, Filter and Sort; a list's Back button, name, ⋮ menu, pills,
 * Filter and Sort). On a phone the block is sticky (md: and up it is just a normal block): see-through glass once the
 * page has scrolled, sliding up out of sight while scrolling down and back the moment you scroll up.
 * It is its own component so that the bar hiding and showing redraws only the bar, not the poster grid below it.
 * `className` sets the spacing inside the block.
 * It sits at the very top of the page, so it is padded down by the phone's status bar (`safe-area-inset-top`).
 */
export function StickyControls({
  children,
  className = "space-y-3 md:space-y-6",
}: {
  children: ReactNode;
  className?: string;
}) {
  const { hidden, scrolled, instant } = useScrollHide();
  return (
    <div
      className={[
        "max-md:sticky max-md:top-0 max-md:z-30 max-md:-mx-4 max-md:px-4 max-md:py-2",
        "max-md:pt-[max(0.5rem,env(safe-area-inset-top))]",
        className,
        "max-md:origin-top",
        // Coming Back to where you had scrolled, the bar is already hidden when the page appears: no fold animation.
        instant ? "max-md:transition-none" : "max-md:transition-[clip-path,opacity,background-color] max-md:duration-[350ms]",
        // Leaving: folds up into its own top edge (the bottom edge rises to the top) while fading. Returning: unfolds
        // back down. (The -4px keeps focus rings from being clipped.)
        hidden
          ? "max-md:pointer-events-none max-md:[clip-path:inset(-4px_-4px_100%_-4px)] max-md:opacity-0 max-md:ease-in"
          : "max-md:[clip-path:inset(-4px)] max-md:opacity-100 max-md:ease-out",
        scrolled ? "max-md:bg-background/30 max-md:backdrop-blur-xl max-md:border-b max-md:border-white/10" : "",
      ].join(" ")}
    >
      {children}
    </div>
  );
}
