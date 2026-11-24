import { useEffect, useRef } from "react";
import type { RouterHistory } from "@tanstack/react-router";

/**
 * The phone's Back gesture (and the browser's Back button) closes the popup on top instead of leaving the page.
 *
 * Each open popup puts a browser-history entry of its own on top of the page's (same address, the page's state plus
 * `__popup: <depth>`). Back takes that entry off: we see the `popstate` first (our listener is added before the
 * router's), keep it from the router, and close the popup(s) above the entry we landed on. A popup closed
 * any other way (its cross, a tap outside, Escape) takes its entry off again itself, so Back afterwards still goes
 * back a page.
 *
 * The entries are added with History.prototype.pushState, not window.history.pushState, which the router has
 * wrapped: the router is never told about them, so the page is not reloaded, faded or scrolled.
 *
 * An entry can be left behind: when the page changed while its popup was open (a link inside it), or when another
 * popup was opened on top before it closed. Back steps over such entries, so it never seems to do nothing.
 */

const KEY = "__popup";

type Entry = { depth: number; close: () => void };

let stack: Entry[] = [];
// Our own history.back() calls whose popstate has not arrived yet.
let ignorePops = 0;
// The router's place in the history (its __TSR_index) as of its last page change. Its own `location` reads the
// address live, so during a popstate it already shows where we are going, not where we came from.
let routerIndex = 0;

function depthOf(state: unknown): number {
  const d = state && typeof state === "object" ? (state as Record<string, unknown>)[KEY] : undefined;
  return typeof d === "number" ? d : 0;
}

function indexOf(state: unknown): number {
  const i = state && typeof state === "object" ? (state as Record<string, unknown>).__TSR_index : undefined;
  return typeof i === "number" ? i : 0;
}

const isLive = (depth: number) => stack.some((e) => e.depth === depth);

/** Standing on an entry whose popup is gone (and the page under it is the same): step back past it, quietly. */
function stepOverLeftover(): boolean {
  const d = depthOf(window.history.state);
  if (d === 0 || isLive(d)) return false;
  ignorePops++;
  window.history.back();
  return true;
}

function onPopState(e: PopStateEvent) {
  const to = depthOf(window.history.state);
  if (ignorePops > 0) {
    ignorePops--;
    e.stopImmediatePropagation();
    stepOverLeftover();
    return;
  }
  const above = stack.filter((x) => x.depth > to);
  if (above.length) {
    e.stopImmediatePropagation();
    stack = stack.filter((x) => x.depth <= to);
    for (const x of above.reverse()) x.close();
    stepOverLeftover();
    return;
  }
  // A left-over entry reached by going Back from a page opened out of a popup: it has the earlier page's address
  // but sits one step above it, so skip to the page's own entry and let the router take that one as a normal Back.
  if (to > 0 && !isLive(to) && indexOf(window.history.state) < routerIndex) {
    e.stopImmediatePropagation();
    window.history.back();
  }
  // Anything else is the router's.
}

// Listening from the moment this file loads, which is before the router is created (router.tsx imports it): on
// window, popstate listeners run in the order they were added, capture or not, so ours must come first to be able to
// keep a popup's Back from the router.
if (typeof window !== "undefined") window.addEventListener("popstate", onPopState);

/** Called once from router.tsx, in the browser, so we know where the router is in the history. */
export function initBackToClose(history: RouterHistory): void {
  routerIndex = indexOf(history.location.state);
  history.subscribe(() => {
    routerIndex = indexOf(history.location.state);
  });
}

// Popups closed a moment ago whose entry is about to be taken off (see release).
let releasing: { depth: number; timer: ReturnType<typeof setTimeout> }[] = [];

function open(close: () => void): Entry {
  const here = depthOf(window.history.state);
  // A popup that opens just as another closes (one popup leading to the next, or React's development mode starting
  // everything twice) takes over the closing one's entry instead of stacking a new one.
  const handover = releasing.find((r) => r.depth === here && here > 0);
  let depth: number;
  if (handover) {
    clearTimeout(handover.timer);
    releasing = releasing.filter((r) => r !== handover);
    depth = here;
  } else {
    depth = here + 1;
    History.prototype.pushState.call(window.history, { ...(window.history.state ?? {}), [KEY]: depth }, "");
  }
  const entry = { depth, close };
  stack.push(entry);
  return entry;
}

function release(entry: Entry): void {
  if (!stack.includes(entry)) return; // closed by Back: its entry is already gone
  stack = stack.filter((x) => x !== entry);
  // After anything queued with it has run (a page change from a link in the popup is pushed in a microtask): take
  // its entry off, unless a page or another popup now sits on top of it (then Back steps over it later).
  const r = {
    depth: entry.depth,
    timer: setTimeout(() => {
      releasing = releasing.filter((x) => x !== r);
      if (depthOf(window.history.state) === entry.depth && !isLive(entry.depth)) {
        ignorePops++;
        window.history.back();
      }
    }, 0),
  };
  releasing.push(r);
}

/** Closes the top Radix popup (dialog, sheet, menu): they all close on Escape, the top one only. */
export function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

/** While `open`, Back calls `close` instead of leaving the page. */
export function useBackToClose(open_: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open_ || typeof window === "undefined") return;
    const entry = open(() => closeRef.current());
    return () => release(entry);
  }, [open_]);
}

/**
 * Put inside a Radix popup's content (which is only on the page while the popup is open): Back closes it, the way
 * Escape does.
 */
export function BackCloses(): null {
  useBackToClose(true, pressEscape);
  return null;
}
