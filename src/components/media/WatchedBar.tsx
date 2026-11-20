import { useEffect, useRef, useState } from "react";

// The poster flies into place when the page opens (0.34s, styles.css: hero-poster). The bar waits for it, so it
// does not grow on a poster that is still moving.
const AFTER_POSTER_MS = 360;
const TRACK_MS = 300;
const FILL_MS = 800;

// Close to the fill's CSS curve, so the number keeps pace with it.
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * "5/8" with a bar, on the bottom of a season's poster. When the page opens the bar draws in from the left and
 * its fill grows, while the number counts up with it. A later change (ticking an episode) slides the
 * fill and counts to the new number. With reduced motion everything is simply shown.
 *
 * `startAt`: when the page opened (performance.now()), so the wait for the poster is measured from then, not from
 * when the watched episodes finished loading.
 */
export function WatchedBar({ watched, total, startAt }: { watched: number; total: number; startAt: number }) {
  const still = reducedMotion();
  const [started, setStarted] = useState(still);
  const [shown, setShown] = useState(still ? watched : 0); // the number on screen while it counts
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // Start once the poster has landed.
  useEffect(() => {
    if (started) return;
    const t = setTimeout(() => setStarted(true), Math.max(0, startAt + AFTER_POSTER_MS - performance.now()));
    return () => clearTimeout(t);
  }, [started, startAt]);

  // Count from what is on screen to the real number, in step with the fill.
  useEffect(() => {
    if (!started) return;
    if (still) {
      setShown(watched);
      return;
    }
    const from = shownRef.current;
    if (from === watched) return;
    const begin = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - begin) / FILL_MS));
      setShown(Math.round(from + (watched - from) * easeOut(t)));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [started, watched, still]);

  const pct = total ? (watched / total) * 100 : 0;
  return (
    <div
      className="bg-gradient-to-t from-black/85 to-transparent px-2 pb-1.5 pt-5 text-left transition-opacity duration-300"
      style={{ opacity: started ? 1 : 0 }}
    >
      <div
        className="h-1 origin-left rounded-full bg-white/25"
        style={{
          transform: `scaleX(${started ? 1 : 0})`,
          transition: still ? undefined : `transform ${TRACK_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        }}
      >
        <div
          className="h-full rounded-full bg-white"
          style={{
            width: `${started ? pct : 0}%`,
            transition: still ? undefined : `width ${FILL_MS}ms cubic-bezier(0.33, 1, 0.68, 1)`,
          }}
        />
      </div>
      <p className="mt-1 text-[11px] font-semibold text-white tabular-nums">
        {shown}/{total}
      </p>
    </div>
  );
}
