import { Link, useCanGoBack, useRouter, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, Home, Search, Library, Calendar, ListChecks, Settings } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useScrollHide } from "@/lib/use-scroll-hide";

const nav = [
  { to: "/", label: "Home", icon: Home },
  { to: "/search", label: "Search", icon: Search },
  { to: "/library", label: "Library", icon: Library },
  { to: "/lists", label: "Lists", icon: ListChecks },
  { to: "/calendar", label: "Calendar", icon: Calendar },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

// The phone's bottom bar: everything except Calendar, which is a pill in the top right corner of the Library on
// a phone. (The desktop sidebar lists all of them.)
const bottomNav = nav.filter((n) => n.to !== "/calendar");

const noSubscribe = () => () => {};

/**
 * Whether there is an earlier page in this app to go Back to. Only the browser knows: the server always draws the
 * "nothing to go back to" version. So a reloaded page is first drawn that way in the browser too (or React finds it
 * does not match the server's page and redraws the whole page), and switches straight after. Pages opened inside the
 * app know at once.
 */
export function useCanGoBackSafe(): boolean {
  const canGoBack = useCanGoBack();
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  return hydrated && canGoBack;
}

/** Goes back in the browser history, or to Home when the page was opened directly (nothing to go back to). */
export function BackButton({ className, children }: { className: string; children: ReactNode }) {
  const router = useRouter();
  const canGoBack = useCanGoBackSafe();
  return canGoBack ? (
    <button type="button" onClick={() => router.history.back()} aria-label="Back" className={className}>
      {children}
    </button>
  ) : (
    <Link to="/" aria-label="Home" className={className}>
      {children}
    </Link>
  );
}

// Where each show's own page sits in this tab's history (the router numbers every entry), so the home button on its
// season and episode pages can step back to it rather than open it again.
const showEntry = new Map<string, number>();
const historyIndex = (router: ReturnType<typeof useRouter>) =>
  (router.history.location.state as { __TSR_index?: number }).__TSR_index;

/**
 * The home button on a season or episode page: back to the show's page. When that page is earlier in this tab's
 * history it steps back to it, as if Back had been pressed enough times, so Back from the show then goes to where
 * the show was opened from (the Library grid, say). Otherwise (an episode opened from a link) it opens the show.
 */
function ShowHomeButton({ id, className }: { id: string; className: string }) {
  const router = useRouter();
  return (
    <Link
      to="/tv/$id"
      params={{ id }}
      aria-label="Back to the show"
      title="Back to the show"
      className={className}
      onClick={(e) => {
        const here = historyIndex(router);
        const at = showEntry.get(id);
        if (typeof here === "number" && typeof at === "number" && at < here) {
          e.preventDefault();
          router.history.go(at - here);
        }
      }}
    >
      <Home className="size-5" />
    </Link>
  );
}

// The round buttons that float over a page's hero image on a phone.
const FLOAT_PILL =
  "float-glass pointer-events-auto transform-gpu will-change-transform grid size-10 place-items-center rounded-full bg-black/45 text-white ring-1 ring-white/15 backdrop-blur-md transition active:scale-95";

export function AppShell({ children }: { children: ReactNode }) {
  const { location } = useRouterState();
  // The phone's top bar slides away while you scroll down and comes back, as see-through glass, the moment you
  // scroll up. A new page always starts with it showing.
  // Coming Back to a page you had scrolled down, it is already hidden when the page appears (`barInstant`).
  const { hidden: barHidden, scrolled, instant: barInstant } = useScrollHide(location.pathname);
  // The menu entry that is lit up. Home also covers the "See more" pages (/browse/...), which belong to it.
  const isActiveAt = (path: string, to: string) =>
    path === to || (to !== "/" && path.startsWith(to)) || (to === "/" && path.startsWith("/browse/"));
  const isActive = (to: string) => isActiveAt(location.pathname, to);
  // The bottom bar's pill moves when the new page appears: one frame after the router has drawn it (`resolvedLocation`,
  // set during the page swap; `location` changes earlier, when the tap is still loading). While the browser draws
  // the new page it shows a still picture of the old one, so a pill that started moving any earlier was mostly done
  // (a jump) by the time anything showed.
  const resolvedPath = useRouterState({ select: (s) => (s.resolvedLocation ?? s.location).pathname });
  const [pillPath, setPillPath] = useState(resolvedPath);
  useEffect(() => {
    const id = requestAnimationFrame(() => setPillPath(resolvedPath));
    return () => cancelAnimationFrame(id);
  }, [resolvedPath]);
  // The Library and the Calendar have no phone top bar of their own from here: each draws its own controls bar.
  const hideMobileHeader = location.pathname.startsWith("/library") || location.pathname.startsWith("/calendar");
  // My Lists, inside a list (/lists, /lists/<id>), every Settings page and Search the phone has no top bar either,
  // and the page moves up into its space.
  const blankMobileHeader = /^\/(lists|settings|search)(\/|$)/.test(location.pathname);
  // On a movie / show / season / person page the phone's bottom menu gets out of the way (the top bar
  // gets a back arrow instead). The desktop sidebar is unaffected.
  const isDetail = /^\/(movie|tv|person)\//.test(location.pathname);
  // Home, a movie, show or person page start with a big backdrop image. On a phone they have no top bar at
  // all: just a Back pill floating over the image on a movie, show or person (nothing on Home), and the page
  // starts at the very top. Season and episode pages too (the show's or the episode's picture).
  const hasHero =
    location.pathname === "/" ||
    /^\/(movie|tv|person)\/[^/]+\/?$/.test(location.pathname) ||
    /^\/tv\/[^/]+\/season\/[^/]+(\/episode\/[^/]+)?\/?$/.test(location.pathname);
  // The show a season or episode page belongs to, for the floating button that goes back to it.
  const showHome = /^\/tv\/([^/]+)\/season\//.exec(location.pathname)?.[1] ?? null;
  // Remember where a show's own page sits in the history, for that button (see ShowHomeButton).
  const router = useRouter();
  const onShowPage = /^\/tv\/([^/]+)\/?$/.exec(location.pathname)?.[1] ?? null;
  useEffect(() => {
    const at = historyIndex(router);
    if (onShowPage && typeof at === "number") showEntry.set(onShowPage, at);
  }, [onShowPage, location.state, router]);
  return (
    // On a phone the page scrolls inside this box (exactly one screen tall) rather than the browser window.
    // Phone browsers hide their toolbar when the window scrolls, which resizes the screen and made the
    // floating bars jump; with the window never scrolling the toolbar stays put and so do the bars.
    // On a desktop none of the max-md rules apply and the window scrolls as normal.
    <div
      data-scroll-restoration-id="app-scroll"
      className="app-root min-h-screen bg-background text-foreground max-md:h-dvh max-md:min-h-0 max-md:overflow-y-auto max-md:overscroll-y-contain"
    >
    {/* Menu + content are centred together (240px menu + 1400px content), so on wide windows the menu
        sits next to the content instead of at the far left edge. */}
    <div className="mx-auto flex min-h-screen w-full max-w-[1640px] max-md:min-h-full">
      {/* Sidebar (desktop) */}
      <aside className="hidden md:flex flex-col w-60 shrink-0 border-r border-border sticky top-0 h-screen px-4 py-6 gap-1">
        <Link to="/" className="flex items-center gap-2 mb-8 px-2">
          <img src="/favicon.svg" alt="" className="size-8" />
          <span className="font-semibold tracking-tight text-lg">Popcornhour</span>
        </Link>
        {nav.map((n) => {
          const active = isActive(n.to);
          return (
            <Link
              key={n.to}
              to={n.to}
              className={[
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-surface",
              ].join(" ")}
            >
              <n.icon className="size-4" />
              {n.label}
            </Link>
          );
        })}
      </aside>

      {/* Mobile: the Back pill floating over the hero image (movie, show). Home has no pills: search is in the
          bottom bar and Calendar is a pill in the top right of the Library. */}
      {hasHero && isDetail && (
        <div className="md:hidden fixed inset-x-0 top-0 z-40 flex items-start justify-between px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pointer-events-none">
          <BackButton className={FLOAT_PILL}>
            <ArrowLeft className="size-5" />
          </BackButton>
          {/* On a season or episode page: straight to the show's own page, however far you have stepped through
              episodes (the user found Back alone confusing there). */}
          {showHome && (
            <ShowHomeButton id={showHome} className={FLOAT_PILL} />
          )}
        </div>
      )}

      {/* Mobile top bar (every other page except the Library) */}
      {!hideMobileHeader && !hasHero && !blankMobileHeader && (
      <header
        data-scrolled={scrolled || undefined}
        className={[
          "md:hidden fixed top-0 inset-x-0 z-40 origin-top border-b",
          barInstant ? "transition-none" : "transition-[clip-path,opacity,background-color] duration-[350ms]",
          // Leaving: folds up into its own top edge (the bottom edge rises to the top) while fading. Returning: unfolds
          // back down.
          barHidden
            ? "pointer-events-none [clip-path:inset(0_0_100%_0)] opacity-0 ease-in"
            : "[clip-path:inset(0)] opacity-100 ease-out",
          // At the top of the page it is the usual solid-ish bar; once you have scrolled it is clear glass.
          scrolled ? "border-white/10 bg-background/30 backdrop-blur-xl" : "border-border bg-background/80 backdrop-blur-md",
        ].join(" ")}
      >
        <div className="flex items-center justify-between px-4 h-14">
          <div className="flex items-center gap-2">
            {isDetail && (
              <BackButton className="-ml-2 size-9 grid place-items-center rounded-full hover:bg-surface">
                <ArrowLeft className="size-5" />
              </BackButton>
            )}
            <Link to="/" className="flex items-center gap-2">
              <img src="/favicon.svg" alt="" className="size-7" />
              <span className="font-semibold tracking-tight">Popcornhour</span>
            </Link>
          </div>
          <Link to="/search" className="size-9 grid place-items-center rounded-full hover:bg-surface">
            <Search className="size-5" />
          </Link>
        </div>
      </header>
      )}

      <main className={`flex-1 min-w-0 md:pt-0 md:pb-0 ${isDetail ? "pb-8" : "pb-36"} ${hideMobileHeader || hasHero || blankMobileHeader ? "pt-0" : "pt-14"}`}>
        {/* Content column: stops pages (and their poster grids) stretching across very wide windows. */}
        <div className="mx-auto w-full max-w-[1400px]">{children}</div>
      </main>

      {/* Mobile bottom nav (hidden on detail pages) */}
      {!isDetail && (
      // A floating rounded bar, inset from the screen edges. The current tab opens into a highlighted pill with its
      // name; the others are icons.
      <nav
        aria-label="Main"
        // transform-gpu / will-change-transform: the bar gets its own graphics layer, so it is not repainted (or nudged)
        // while the page scrolls underneath it and the phone browser's address bar slides away and back.
        // bottom-nav: while switching tabs the bar is lifted out of the page fade and stays put (styles.css).
        className="bottom-nav md:hidden fixed inset-x-3 bottom-[max(2.5rem,env(safe-area-inset-bottom))] z-40 transform-gpu will-change-transform rounded-full border border-white/15 bg-background/90 p-2 shadow-2xl shadow-black/50 backdrop-blur-lg"
      >
        <ul className="flex items-center justify-between">
          {bottomNav.map((n) => {
            const active = isActiveAt(pillPath, n.to);
            return (
              <li key={n.to}>
                {/* The highlighted pill grows open on the new tab while the old one closes (padding, colour and the
                    name's width all ease), so it glides across instead of jumping. The name is always there, just
                    0 wide when not current; on very narrow phones (under 360px) it stays hidden. The "tab" view
                    transition type gives these switches their own page fade (styles.css). */}
                <Link
                  to={n.to}
                  viewTransition={{ types: ["tab"] }}
                  aria-label={n.label}
                  aria-current={isActive(n.to) ? "page" : undefined}
                  className={[
                    "flex h-12 items-center justify-center rounded-full transition-[background-color,color,padding] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                    active ? "bg-primary/20 px-4 text-primary" : "px-3 text-muted-foreground active:bg-white/10",
                  ].join(" ")}
                >
                  <n.icon className="size-6 shrink-0" />
                  <span
                    aria-hidden
                    className={[
                      "grid transition-[grid-template-columns,opacity,margin] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none max-[359px]:hidden",
                      active ? "ml-2 grid-cols-[1fr] opacity-100" : "ml-0 grid-cols-[0fr] opacity-0",
                    ].join(" ")}
                  >
                    <span className="overflow-hidden whitespace-nowrap text-sm font-semibold">{n.label}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      )}
    </div>
    </div>
  );
}
