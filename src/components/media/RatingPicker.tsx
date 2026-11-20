import { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";

/** What each score means, shown under the number ("5" = "Average"). Index 0 is "no rating yet". */
export const RATING_WORDS = [
  "Tap a star", "Unwatchable", "Terrible", "Bad", "Poor", "Average", "Decent", "Good", "Great", "Excellent", "Masterpiece",
] as const;

type Props = {
  value: number | null;
  onChange: (value: number | null) => void;
  /** Tapping the current score again clears it (the Watched popup). */
  allowClear?: boolean;
  /** Colour of the filled stars and the number: gold (Watched popup) or the app colour (Rate popup). */
  tone?: "gold" | "primary";
};

/**
 * Ten stars with the score above them: a big number that rolls through the numbers like a dial when it changes, and
 * what the score means under it, rolling with it. Stars fill one after another. On a phone a finger can slide across
 * the stars to pick a score; on a computer hovering previews it. Reduced motion: no rolling, no stagger.
 */
export function RatingPicker({ value, onChange, allowClear = false, tone = "primary" }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;

  // The score drawn last time, so the stars fill (or empty) in order from there.
  const prev = useRef(shown);
  useEffect(() => { prev.current = shown; }, [shown]);
  const from = prev.current;

  const stars = useRef<(HTMLButtonElement | null)[]>([]);
  const drag = useRef<{ start: number; moved: boolean; changed: boolean } | null>(null);

  /** The star under a finger or the mouse: the first whose right edge is past x (1 left of the row, 10 right of it). */
  const starAt = (x: number) => {
    for (let i = 0; i < stars.current.length; i++) {
      const r = stars.current[i]?.getBoundingClientRect();
      if (r && x <= r.right) return i + 1;
    }
    return 10;
  };

  const fill = tone === "gold" ? "fill-[var(--gold)] text-[var(--gold)]" : "fill-primary text-primary";
  const number = tone === "gold" ? "text-[var(--gold)]" : "text-primary";

  return (
    <div className="select-none">
      <div className="flex flex-col items-center" aria-live="polite">
        {/* The number stays centred over the stars; "/10" hangs just after it (1ch = one digit, as the digits are
            all one width) and slides along when the score becomes 10. */}
        <div className="relative text-5xl font-bold tabular-nums leading-none">
          <Dial index={shown} className={`w-[2.2ch] ${shown ? number : "text-muted-foreground"}`}>
            {["–", ...Array.from({ length: 10 }, (_, i) => String(i + 1))]}
          </Dial>
          <span
            className="absolute bottom-[0.2em] transition-[left] duration-300 motion-reduce:transition-none"
            style={{ left: `calc(50% + ${shown === 10 ? 1 : 0.5}ch + 0.08em)` }}
          >
            <span className="text-base font-normal text-muted-foreground">/10</span>
          </span>
        </div>
        <Dial index={shown} className="mt-1.5 text-sm font-medium text-muted-foreground w-40">
          {RATING_WORDS}
        </Dial>
      </div>

      <div
        className="mt-3 flex items-center justify-center gap-1 touch-pan-y"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const n = starAt(e.clientX);
          drag.current = { start: n, moved: false, changed: n !== value };
          e.currentTarget.setPointerCapture(e.pointerId);
          if (n !== value) onChange(n);
        }}
        onPointerMove={(e) => {
          const n = starAt(e.clientX);
          const d = drag.current;
          if (!d) {
            if (e.pointerType === "mouse") setHover(n);
            return;
          }
          if (n !== d.start) d.moved = true;
          if (n !== value) onChange(n);
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          // A plain tap on the score already picked clears it.
          if (d && !d.moved && !d.changed && allowClear) onChange(null);
        }}
        onPointerCancel={() => { drag.current = null; }}
        onPointerLeave={(e) => { if (e.pointerType === "mouse") setHover(null); }}
      >
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
          const active = shown >= n;
          // Stars that change state go one after another, from the old score towards the new one.
          const delay = shown > from && n > from && n <= shown ? (n - from - 1) * 25
            : shown < from && n > shown && n <= from ? (from - n) * 25
            : 0;
          return (
            <button
              key={n}
              ref={(el) => { stars.current[n - 1] = el; }}
              type="button"
              aria-label={`${n} out of 10, ${RATING_WORDS[n]}`}
              aria-pressed={value === n}
              // Taps and drags are handled by the row; this is for the keyboard (Enter / Space give detail 0).
              onClick={(e) => { if (e.detail === 0) onChange(allowClear && value === n ? null : n); }}
              className="p-0.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Star
                // A new key on the picked star replays its little "pop".
                key={n === shown ? `pop-${shown}` : "still"}
                style={{ transitionDelay: `${delay}ms` }}
                className={[
                  "size-6 transition-[color,fill] duration-150 motion-reduce:transition-none motion-reduce:!delay-0",
                  active ? fill : "text-muted-foreground",
                  n === shown ? "motion-safe:animate-[cx-star-pop_0.32s_ease-out]" : "",
                ].join(" ")}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A one-line window onto a column of items that slides to `index`, so a change rolls past the ones in between like
 * a dial. Every item is drawn in the column, so the window keeps the width given to it.
 */
function Dial({ index, children, className }: { index: number; children: readonly string[]; className?: string }) {
  return (
    <span className={`relative inline-block h-[1.15em] overflow-hidden text-center leading-[1.15] ${className ?? ""}`}>
      <span
        className="absolute inset-x-0 top-0 flex flex-col transition-transform duration-500 ease-[cubic-bezier(0.2,0.9,0.25,1.15)] motion-reduce:transition-none"
        style={{ transform: `translateY(${-index * 1.15}em)` }}
        aria-hidden
      >
        {children.map((c, i) => <span key={i} className="h-[1.15em] whitespace-nowrap">{c}</span>)}
      </span>
      <span className="sr-only">{children[index]}</span>
    </span>
  );
}
