import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { returnHeroPoster } from "@/lib/peek";
import { setLastNavAction } from "@/lib/nav-action";

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // On a phone the page scrolls inside this box instead of the window (see AppShell), so a new page has to
    // be scrolled back to the top there. (On a desktop the box never scrolls, so this does nothing.)
    scrollToTopSelectors: ['[data-scroll-restoration-id="app-scroll"]'],
    // Start loading a page as soon as a finger touches (or the pointer hovers) its link, so the data is
    // usually already there by the time the tap lands. The loaders put it in the Query cache (30 min), so
    // nothing is fetched twice and the router's own preload cache is not needed (staleTime 0).
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    // Changing page cross-fades (and a tapped poster grows into the page's poster: see styles.css and peek.ts) in
    // browsers that support view transitions; others change page at once, as before.
    defaultViewTransition: true,
  });

  // Going Back from a movie or show: once the page you return to is drawn (and before the browser animates to it),
  // the card you had tapped is marked so the big poster shrinks back into it. Browser only.
  if (typeof window !== "undefined") {
    router.subscribe("onRendered", (e) => returnHeroPoster(e.fromLocation?.pathname));
    // Remember whether each page change was a fresh visit or Back/Forward (see nav-action.ts; Home uses it).
    router.history.subscribe(({ action }) => setLastNavAction(action.type));
  }

  return router;
};
