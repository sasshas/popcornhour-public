import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/** Where the app scrolls on a phone (see AppShell): a box one screen tall, not the browser window. */
export const APP_SCROLL_SELECTOR = '[data-scroll-restoration-id="app-scroll"]';

/**
 * Drives a bar that slides away while you scroll down and comes back the moment you scroll up.
 *  - hidden:   true while scrolling down (and some way down the page)
 *  - scrolled: true once the page has moved at all, so the bar can switch to its see-through glass look
 *  - instant:  true when the bar was hidden because the app put the page back where you had scrolled to (coming
 *              Back), before you touched it. The bar must then be hidden with NO animation (drop its transition),
 *              so it is simply not there when the page appears instead of showing briefly and folding away.
 *  - hold(ms, hide?): show the bar now (or hide it, with hide = true) and keep it that way for that long whatever the
 *              page does (for a scroll the page does by itself, like jumping to a date)
 * Pass the page's path (or any key) as `resetKey` so a new page starts with the bar showing.
 * Only meaningful on a phone: on a desktop the box never scrolls, so both stay false.
 */
export function useScrollHide(resetKey?: string) {
  const [hidden, setHidden] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [instant, setInstant] = useState(false);
  const holdUntil = useRef(0);

  const hold = useCallback((ms: number, hide = false) => {
    holdUntil.current = Date.now() + ms;
    setHidden(hide);
  }, []);

  useEffect(() => {
    setHidden(false);
    setScrolled(false);
    setInstant(false);
    const box = document.querySelector<HTMLElement>(APP_SCROLL_SELECTOR);
    if (!box) return;
    let last = box.scrollTop;
    // Until the person touches the page, any scroll is the app's own doing: on coming Back, the router putting
    // the page back where it was. That lands with the bar already hidden, not showing and then folding away.
    let settling = true;
    const onScroll = () => {
      const y = box.scrollTop;
      const dy = y - last;
      last = y;
      if (settling && y >= 56 && Date.now() >= holdUntil.current) {
        // flushSync: drawn in this same frame, before the page is first shown at its restored position.
        flushSync(() => {
          setScrolled(true);
          setInstant(true);
          setHidden(true);
        });
        return;
      }
      setScrolled(y > 8);
      if (Date.now() < holdUntil.current) return;
      if (y < 56) setHidden(false);
      else if (dy > 4) setHidden(true);
      else if (dy < -4) setHidden(false);
    };
    // A hold ends as soon as the person touches or scrolls the page themselves, so nothing the page does by itself
    // afterwards (a late-loading picture nudging the scroll position) can flip the bar.
    const release = () => {
      if (settling) {
        settling = false;
        setInstant(false); // from here the bar animates as usual
      }
      if (holdUntil.current === 0) return;
      holdUntil.current = 0;
      last = box.scrollTop;
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    box.addEventListener("touchstart", release, { passive: true });
    box.addEventListener("wheel", release, { passive: true });
    return () => {
      box.removeEventListener("scroll", onScroll);
      box.removeEventListener("touchstart", release);
      box.removeEventListener("wheel", release);
    };
  }, [resetKey]);

  return { hidden, scrolled, instant, hold };
}
