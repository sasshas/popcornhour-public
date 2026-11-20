import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { img } from "@/lib/tmdb";

/**
 * The poster on a movie or show page, shown big when it is tapped. The picture grows out of the small poster and
 * shrinks back into it on close (tap anywhere, the cross, or Escape). It is open while it is mounted.
 *
 * The grow is a plain transform animation, not a view transition: the small poster already carries the page's
 * `hero-poster` name, and a second element with it would cancel the page animations.
 *
 * The small poster's file (w342, already downloaded) shows at once; the sharp one (w780, or the original on big or
 * sharp screens) fades in over it when it arrives.
 */

const DURATION = 300;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The frame that puts the big poster exactly over the small one. The corner is enlarged by the same amount the
 * box is shrunk, so it looks like the small poster's own rounded corner.
 */
function over(small: HTMLElement, big: HTMLElement): Keyframe {
  const from = small.getBoundingClientRect();
  const to = big.getBoundingClientRect();
  const scale = from.width / to.width;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const radius = parseFloat(getComputedStyle(small).borderRadius) || 0;
  return { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, borderRadius: `${radius / scale}px` };
}

type Props = {
  /** TMDB poster path. Without one, `src` is shown as it is (the Calendar's whentostream pictures). */
  path: string | null;
  src?: string;
  alt: string;
  /** The small poster the big one grows out of and shrinks back into. */
  source: React.RefObject<HTMLElement | null>;
  onClosed: () => void;
};

export function PosterViewer({ path, src, alt, source, onClosed }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [sharp, setSharp] = useState(false);
  const closing = useRef(false);

  // Grow out of the small poster as soon as the big one is on the page (before it is painted, so it is never seen in
  // its final place first). A ref callback, not an effect: Radix puts the popup on the page one render after this
  // component mounts, so an effect would find nothing.
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      box.current = el;
      const small = source.current;
      if (!el || !small) return;
      // React can attach the ref twice (development mode does on purpose); measure the box where it really ends up,
      // not part-way through the first run.
      for (const a of el.getAnimations()) a.cancel();
      small.style.visibility = "hidden"; // it has "lifted off" the page
      if (reducedMotion()) return;
      el.animate([over(small, el), { transform: "none" }], { duration: DURATION, easing: EASE });
      backdrop.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DURATION, easing: "ease-out" });
    },
    [source],
  );

  function close() {
    if (closing.current) return;
    closing.current = true;
    const el = box.current;
    const small = source.current;
    const done = () => {
      if (small) small.style.visibility = "";
      setSharp(false);
      onClosed();
    };
    if (!el || !small || reducedMotion()) return done();
    const back = el.animate([{ transform: "none" }, over(small, el)], { duration: DURATION * 0.85, easing: EASE, fill: "forwards" });
    backdrop.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DURATION * 0.85, easing: "ease-in", fill: "forwards" });
    back.onfinish = done;
    back.oncancel = done;
  }

  // As big as fits: 92% of the width, or 86% of the height at 2:3, whichever is smaller.
  const width = "min(92vw, calc(86dvh * 2 / 3), 780px)";

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay ref={backdrop} className="fixed inset-0 z-50 bg-black/85" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex items-center justify-center outline-none"
          onClick={close}
        >
          <DialogPrimitive.Title className="sr-only">{alt || "Poster"}</DialogPrimitive.Title>
          <div
            ref={attach}
            className="relative aspect-[2/3] overflow-hidden rounded-2xl bg-surface shadow-2xl will-change-transform"
            style={{ width }}
          >
            {path ? (
              <>
                <img src={img(path, "w342")!} alt="" className="absolute inset-0 h-full w-full object-cover" />
                <img
                  src={img(path, "w780")!}
                  srcSet={`${img(path, "w780")} 780w, ${img(path, "original")} 2000w`}
                  sizes="(min-width: 768px) 560px, 92vw"
                  alt={alt}
                  decoding="async"
                  onLoad={() => setSharp(true)}
                  className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${sharp ? "opacity-100" : "opacity-0"}`}
                />
              </>
            ) : (
              src && <img src={src} alt={alt} className="absolute inset-0 h-full w-full object-cover" />
            )}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] grid h-10 w-10 place-items-center rounded-full bg-white/15 text-white cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
