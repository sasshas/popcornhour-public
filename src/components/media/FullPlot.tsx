import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BookOpen, EyeOff, X } from "lucide-react";
import { useRef, useState } from "react";
import { getFullPlots, type FullPlots } from "@/lib/plot.functions";
import { BackCloses } from "@/lib/back-to-close";

// Films whose plot was revealed, with when (per browser). For a day after "Show the plot", that film's popup opens
// straight on the plot; other films still ask.
const REVEALED_KEY = "cx:plotRevealed";
const REVEAL_FOR_MS = 24 * 60 * 60 * 1000;

function readRevealed(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(REVEALED_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function revealedRecently(tmdbId: number): boolean {
  const at = readRevealed()[tmdbId];
  return typeof at === "number" && Date.now() - at < REVEAL_FOR_MS;
}

function rememberRevealed(tmdbId: number) {
  const now = Date.now();
  // Expired films are dropped on the way, so the list stays short.
  const kept = Object.fromEntries(Object.entries(readRevealed()).filter(([, at]) => now - at < REVEAL_FOR_MS));
  try {
    localStorage.setItem(REVEALED_KEY, JSON.stringify({ ...kept, [tmdbId]: now }));
  } catch {
    // private mode or storage blocked: it just asks again next time
  }
}

type Source = keyof FullPlots;
const SOURCES: { key: Source; label: string }[] = [
  { key: "imdb", label: "IMDb" },
  { key: "wikipedia", label: "Wikipedia" },
];

/**
 * The "Full plot" button beside a movie's Overview heading, and the full-screen popup it opens with the plot. It
 * opens on IMDb's synopsis (users' scene-by-scene account) when the film has one, with a switch to Wikipedia's
 * shorter plot when there are both. The popup first asks before showing it (both give away the ending); once a
 * film's plot has been shown, it opens straight on the plot for that film for a day.
 *
 * Both are looked up when the page opens, so the button is ready to tap; it fades in once either is found and is
 * never shown when there is neither. It is the same height as the heading, so nothing moves when it appears.
 */
export function FullPlotButton({
  tmdbId, imdbId, title, year,
}: { tmdbId: number; imdbId: string | null; title: string; year: string | null }) {
  const fetchPlots = useServerFn(getFullPlots);
  const { data: plots } = useQuery({
    queryKey: ["fullplot", tmdbId],
    queryFn: () => fetchPlots({ data: { tmdbId, imdbId } }),
    staleTime: 60 * 60 * 1000,
  });
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [picked, setPicked] = useState<Source>("imdb");
  const scroller = useRef<HTMLDivElement>(null);
  const available = SOURCES.filter((s) => plots?.[s.key]);
  if (!plots || available.length === 0) return null;
  // IMDb first; Wikipedia when IMDb has no synopsis.
  const source = plots[picked] ? picked : available[0].key;
  const plot = plots[source]!;

  const change = (o: boolean) => {
    setOpen(o);
    if (o) {
      setRevealed(revealedRecently(tmdbId)); // the guard comes back, unless this film was revealed today
      setPicked("imdb");
    }
  };
  const pick = (s: Source) => {
    setPicked(s);
    scroller.current?.scrollTo({ top: 0 }); // the other one starts from its beginning
  };
  const reveal = () => {
    setRevealed(true);
    rememberRevealed(tmdbId);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={change}>
      <DialogPrimitive.Trigger
        className="-mr-1 inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-sm font-medium text-primary hover:bg-primary/10 cursor-pointer animate-in fade-in duration-300"
      >
        <BookOpen className="size-4" />
        Full plot
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          ref={scroller}
          aria-describedby={undefined}
          // Fills the screen and slides up from the bottom; it scrolls inside itself.
          className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-background outline-none duration-300 data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-[40%] data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom-[30%] data-[state=closed]:fade-out-0"
        >
          <BackCloses />
          <div className="sticky top-0 z-10 border-b border-white/10 bg-background/95 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <div className="mx-auto flex max-w-2xl items-center gap-3 px-5 pb-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Full plot</p>
                <DialogPrimitive.Title className="truncate text-xl font-bold tracking-tight">
                  {title}
                  {year && <span className="font-normal text-muted-foreground"> ({year})</span>}
                </DialogPrimitive.Title>
              </div>
              <DialogPrimitive.Close
                aria-label="Close"
                className="grid size-10 shrink-0 place-items-center rounded-full bg-white/10 cursor-pointer hover:bg-white/15"
              >
                <X className="size-5" />
              </DialogPrimitive.Close>
            </div>
            {/* The switch, once the plot is showing and there are both. */}
            {revealed && available.length > 1 && (
              <div className="mx-auto max-w-2xl px-5 pb-3">
                <div className="grid grid-cols-2 gap-1 rounded-2xl bg-white/[0.07] p-1" role="radiogroup" aria-label="Plot from">
                  {available.map((s) => {
                    const on = s.key === source;
                    return (
                      <button
                        key={s.key}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => !on && pick(s.key)}
                        className={[
                          "rounded-xl px-3 py-2 text-[15px] font-medium transition active:scale-95 cursor-pointer",
                          on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                        ].join(" ")}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {revealed ? (
            <article key={source} className="mx-auto max-w-2xl px-5 pt-5 pb-[max(2.5rem,env(safe-area-inset-bottom))] animate-in fade-in duration-300">
              {plot.blocks.map((b, i) =>
                b.kind === "h" ? (
                  <h3 key={i} className="mt-6 mb-2 text-lg font-semibold">{b.text}</h3>
                ) : (
                  <p key={i} className="mb-4 text-[17px] leading-relaxed text-foreground/90">{b.text}</p>
                ),
              )}
              {source === "imdb" ? (
                <p className="mt-8 border-t border-white/10 pt-4 text-xs leading-snug text-muted-foreground">
                  Synopsis written by IMDb users.{" "}
                  <a href={plot.url} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
                    Read it on IMDb
                  </a>
                </p>
              ) : (
                <p className="mt-8 border-t border-white/10 pt-4 text-xs leading-snug text-muted-foreground">
                  From the Wikipedia article{" "}
                  <a href={plot.url} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
                    {plot.article}
                  </a>
                  , available under{" "}
                  <a
                    href="https://creativecommons.org/licenses/by-sa/4.0/"
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline"
                  >
                    CC BY-SA 4.0
                  </a>
                  .
                </p>
              )}
            </article>
          ) : (
            <div className="mx-auto flex min-h-[60dvh] max-w-sm flex-col items-center justify-center px-6 py-10 text-center">
              <div className="mb-4 grid size-14 place-items-center rounded-full bg-amber-500/15 text-amber-400">
                <EyeOff className="size-7" />
              </div>
              <h3 className="text-xl font-bold">Spoilers ahead</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
                This is the whole story, ending included.
              </p>
              <button
                type="button"
                onClick={reveal}
                className="mt-6 w-full rounded-2xl bg-primary py-3.5 text-[15px] font-semibold text-primary-foreground cursor-pointer active:opacity-90"
              >
                Show the plot
              </button>
              <DialogPrimitive.Close className="mt-2 w-full rounded-2xl py-3.5 text-[15px] font-medium text-muted-foreground cursor-pointer hover:bg-white/[0.06]">
                Not now
              </DialogPrimitive.Close>
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
