import { useEffect, useRef, useState } from "react";
import { scrollRootOf } from "@/lib/scroll-root";

/**
 * True once the element has come near the viewport (and stays true). Lets a long poster grid fetch
 * extra data only for the posters that are actually scrolled to.
 */
export function useInView<T extends Element>(rootMargin = "300px") {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      // root: on a phone the app scrolls inside `.app-root`; on the window's default root the margin is ignored there,
      // so the look-ahead quietly became "only once on screen".
      { root: scrollRootOf(el), rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, rootMargin]);
  return [ref, seen] as const;
}
