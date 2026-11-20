/**
 * What a poster card already knows about its title (name and pictures), noted when the card is tapped, so the
 * movie or show page can show that straight away while its full details are still loading.
 * Browser-only and kept in memory: it is written from click handlers, never while rendering on the server.
 */
export type Peek = { title: string; posterPath: string | null; backdropPath?: string | null };

const peeks = new Map<string, Peek>();
const MAX = 200; // plenty for one sitting; the oldest are dropped past this

export function rememberPeek(mediaType: string | undefined, tmdbId: number | string, peek: Peek) {
  const key = `${mediaType}:${tmdbId}`;
  peeks.delete(key); // re-adding moves it to the newest end
  peeks.set(key, peek);
  if (peeks.size > MAX) peeks.delete(peeks.keys().next().value!);
}

/** The view-transition name shared by a tapped card's poster and the poster on the page it opens (styles.css). */
export const HERO_POSTER = "hero-poster";

function clearHeroNames() {
  for (const el of document.querySelectorAll<HTMLElement>('[style*="view-transition-name"]')) {
    el.style.removeProperty("view-transition-name");
  }
}

/** Gives `el` the animation name, taking it off anything else that has it (only one element on a page may carry it). */
export function nameHeroPoster(el: HTMLElement) {
  clearHeroNames();
  el.style.setProperty("view-transition-name", HERO_POSTER);
}

function historyEntry(): string | undefined {
  return window.history.state?.__TSR_key as string | undefined;
}

/** The card last tapped: which title, which copy of it on the page (a Home title can sit in two rows), on which page visit. */
let lastTapped: { hero: string; nth: number; entry: string | undefined } | null = null;

/**
 * Call from a poster card's click handler with the card element. Names the card's poster box (the element with
 * `data-hero="movie:123"`) for the page-change animation, so the browser grows it into the poster of the page being
 * opened. Only one element on a page may carry the name (two would cancel the whole animation), so anything else that
 * has it gives it up first: a card tapped earlier, or the big poster of the movie page you are on when you tap a
 * "You might also like" card.
 */
export function markHeroPoster(card: HTMLElement) {
  clearHeroNames();
  const box = card.querySelector<HTMLElement>("[data-hero]");
  if (!box) return;
  box.style.setProperty("view-transition-name", HERO_POSTER);
  const hero = box.dataset.hero!;
  const copies = Array.from(document.querySelectorAll<HTMLElement>(`[data-hero="${hero}"]`));
  lastTapped = { hero, nth: copies.indexOf(box), entry: historyEntry() };
}

/**
 * The way back: call when a page has just been drawn, with the path of the page being left. If that was the movie
 * or show opened from the last tapped card, and this is the page visit the card was on, the same card is named
 * again, so the big poster shrinks back into its place in the grid. The name is taken off again once the animation
 * is over, so it cannot get in the way of the next page change.
 */
export function returnHeroPoster(fromPath: string | undefined) {
  if (!lastTapped || !fromPath) return;
  const [type, id] = lastTapped.hero.split(":");
  if (fromPath.replace(/\/$/, "") !== `/${type}/${id}` || historyEntry() !== lastTapped.entry) return;
  const box = document.querySelectorAll<HTMLElement>(`[data-hero="${lastTapped.hero}"]`)[lastTapped.nth];
  if (!box) return;
  clearHeroNames();
  box.style.setProperty("view-transition-name", HERO_POSTER);
  setTimeout(() => box.style.removeProperty("view-transition-name"), 800);
}

export function peekOf(mediaType: string, tmdbId: number | string): Peek | undefined {
  return peeks.get(`${mediaType}:${tmdbId}`);
}
