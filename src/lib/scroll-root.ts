/**
 * The box an element actually scrolls inside, for an IntersectionObserver's `root`. On a phone the app scrolls
 * inside `.app-root`, not the window, and an observer left on the default root (the window) loses its `rootMargin`
 * there: the scrolling box clips the element first, so "load when within 900px" quietly becomes "load when on
 * screen". Returns null when the window is what scrolls (desktop), which is the observer's default.
 */
export function scrollRootOf(el: Element): Element | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    if (overflow === "auto" || overflow === "scroll") return p;
  }
  return null;
}
