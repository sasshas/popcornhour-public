import { useCallback, useRef, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/** How far down (px) a flick has to pull the panel to close it, or how fast (px per ms) it has to be moving. */
const CLOSE_DISTANCE = 90;
const CLOSE_SPEED = 0.5;

/** The nearest element between `from` and `stop` that scrolls up and down (the panel's own scrolling body). */
function scrollerOf(from: EventTarget | null, stop: HTMLElement): HTMLElement | null {
  for (let el = from instanceof HTMLElement ? from : null; el && el !== stop; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
  }
  return null;
}

/**
 * Flick the panel down to close it (touch only). The panel follows the finger once a drag clearly goes downwards
 * and, when it started inside the scrolling body, only while that body is at its top (otherwise it scrolls as
 * usual). Let go far or fast enough and it closes, carrying on from where the finger left it; otherwise it springs
 * back. The backdrop lightens as the panel goes down. Native listeners, because the move has to be able to stop the
 * page scrolling (React's touch listeners are passive).
 */
function useSwipeToClose(enabled: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  const detach = useRef<(() => void) | null>(null);

  return useCallback((el: HTMLElement | null) => {
    detach.current?.();
    detach.current = null;
    if (!el || !enabled) return;

    const overlay = () => el.previousElementSibling as HTMLElement | null;
    let startX = 0, startY = 0, lastY = 0, lastT = 0, speed = 0;
    let decided = false, dragging = false, scroller: HTMLElement | null = null;

    const reset = (animate: boolean) => {
      const o = overlay();
      el.style.transition = animate ? "transform 0.28s cubic-bezier(0.22, 1, 0.36, 1)" : "";
      el.style.transform = "";
      if (o) {
        o.style.transition = animate ? "opacity 0.28s ease-out" : "";
        o.style.opacity = "";
      }
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { decided = true; dragging = false; return; }
      const t = e.touches[0];
      startX = t.clientX; startY = lastY = t.clientY; lastT = e.timeStamp; speed = 0;
      decided = false; dragging = false;
      scroller = scrollerOf(e.target, el);
    };
    const onMove = (e: TouchEvent) => {
      if (decided && !dragging) return;
      const t = e.touches[0];
      const dy = t.clientY - startY;
      if (!decided) {
        const dx = t.clientX - startX;
        if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
        decided = true;
        dragging = dy > 0 && Math.abs(dy) > Math.abs(dx) && (!scroller || scroller.scrollTop <= 0);
        if (!dragging) return;
        el.style.transition = "none";
        const o = overlay();
        if (o) o.style.transition = "none";
      }
      e.preventDefault(); // the page (and the panel's body) stay still while the panel is being pulled
      const dt = e.timeStamp - lastT;
      // Smoothed, as single steps between touch events are uneven.
      if (dt > 0) speed = 0.6 * ((t.clientY - lastY) / dt) + 0.4 * speed;
      lastY = t.clientY; lastT = e.timeStamp;
      const y = Math.max(0, dy);
      el.style.transform = `translateY(${y}px)`;
      const o = overlay();
      if (o) o.style.opacity = String(Math.max(0, 1 - y / (el.offsetHeight || 1)));
    };
    const onEnd = (e: TouchEvent) => {
      if (!dragging) return;
      dragging = false;
      const dy = lastY - startY;
      if (e.timeStamp - lastT > 100) speed = 0; // the finger stopped before letting go: not a flick
      if (dy > CLOSE_DISTANCE || (speed > CLOSE_SPEED && dy > 20)) closeRef.current();
      else reset(true);
    };
    const onCancel = () => {
      if (dragging) reset(true);
      dragging = false;
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onCancel);
    detach.current = () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onCancel);
    };
  }, [enabled]);
}

/**
 * A frosted, rounded panel over a lighter blurred backdrop. On a phone it floats near the bottom, inset
 * from the screen edges, with a grab handle; on larger screens it is a centred panel.
 * Used for the Links and Rotten Tomatoes popups, and the Calendar's movie details.
 *
 * `slides`: the caller opens and closes it inside a browser view transition (see the Calendar), which slides the
 * panel up from the bottom and back down (styles.css, "sheet"). Its own fade is then switched off, so the two do
 * not play on top of each other and the panel is gone the moment it is closed.
 *
 * `swipeToClose`: flick the panel down with a finger to close it (see useSwipeToClose). With `slides`, the close
 * slide carries on from where the finger let go.
 */
export function FloatingSheet({
  open, onOpenChange, title, children, slides, action, swipeToClose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  slides?: boolean;
  /** Shown at the right end of the title's line (the Library's Filters puts "Clear all" there). */
  action?: ReactNode;
  swipeToClose?: boolean;
}) {
  const swipeRef = useSwipeToClose(!!swipeToClose, () => onOpenChange(false));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={swipeRef}
        overlayClassName={`bg-black/40 backdrop-blur-sm ${slides ? "animate-none!" : ""}`}
        style={slides ? { animation: "none", viewTransitionName: "sheet" } : undefined}
        className="glass-sheet left-3 right-3 top-auto bottom-3 w-auto max-w-none translate-x-0 translate-y-0 gap-0 rounded-[28px] p-5 pt-3 shadow-2xl data-[state=open]:slide-in-from-bottom-6 sm:left-1/2 sm:right-auto sm:top-1/2 sm:bottom-auto sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[28px] sm:data-[state=open]:slide-in-from-bottom-0"
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-white/25 sm:hidden" aria-hidden />
        {action ? (
          <div className="mb-4 flex items-center justify-between gap-3">
            <DialogTitle className="text-2xl font-bold tracking-tight">{title}</DialogTitle>
            {/* pr-7: clear of the dialog's close cross in the top-right corner. */}
            <div className="pr-7">{action}</div>
          </div>
        ) : (
          <DialogTitle className="mb-4 text-2xl font-bold tracking-tight">{title}</DialogTitle>
        )}
        {children}
      </DialogContent>
    </Dialog>
  );
}
