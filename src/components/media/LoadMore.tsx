import { useEffect, useRef } from "react";
import { scrollRootOf } from "@/lib/scroll-root";

/**
 * An invisible marker at the end of the drawn posters; asks for the next page once it is within about two phone
 * screens of view (the Library and a list's page). Give it `key={shownCount}` so it asks again after each page.
 */
export function LoadMore({ onMore }: { onMore: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onMore();
    }, { root: scrollRootOf(el), rootMargin: "1600px 0px" }); // about two phone screens ahead, so a fast flick does not catch up
    io.observe(el);
    return () => io.disconnect();
  }, [onMore]);
  return <div ref={ref} aria-hidden className="h-px" />;
}
