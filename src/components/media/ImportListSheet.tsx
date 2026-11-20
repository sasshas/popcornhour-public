import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ArrowLeft, Check, Film, X } from "lucide-react";
import { FloatingSheet } from "@/components/ui/floating-sheet";
import { addMoviesToList, importFromMdblist, matchMovieTitles } from "@/lib/lists.functions";
import { img } from "@/lib/tmdb";
import type { TitleCandidate, TitleMatch } from "@/server/title-match.server";

type Mode = "mdblist" | "titles";

const titles = (n: number) => `${n.toLocaleString()} ${n === 1 ? "title" : "titles"}`;
const movies = (n: number) => `${n.toLocaleString()} ${n === 1 ? "movie" : "movies"}`;
const yearOf = (c: TitleCandidate) => c.releaseDate?.slice(0, 4) ?? "";

/**
 * A list's ⋮ > Import. Two ways in:
 *  - MDBList link: every title on an MDBList list is added at once.
 *  - List of titles: paste movie names (one per line, a year helps). Each is matched to a film; sure matches are shown
 *    for a quick look (any can be dropped), and where the match isn't certain the likely films are shown to pick from
 *    (or skip). Nothing is added until "Add" is tapped.
 * Titles already on the list stay as they are either way.
 */
export function ImportListSheet({
  open,
  onOpenChange,
  listId,
  listName,
  onList,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listId: string;
  listName: string;
  /** "movie:123" keys already on the list, to label matches that are already there. */
  onList: ReadonlySet<string>;
  /** Called after anything was added, to refresh the list. */
  onImported: () => void;
}) {
  const [mode, setMode] = useState<Mode>("mdblist");

  // ---- MDBList link
  const [url, setUrl] = useState("");
  const fetchImport = useServerFn(importFromMdblist);
  const mdblist = useMutation({
    mutationFn: (u: string) => fetchImport({ data: { listId, url: u } }),
    onSuccess: (r) => {
      if (!r.ok) {
        toast.error(r.problem);
        return; // the panel stays open so the link can be fixed
      }
      onOpenChange(false);
      setUrl("");
      const extra = [
        r.alreadyThere > 0 ? `${titles(r.alreadyThere)} already on the list` : "",
        r.cutOff ? "only the first 5,000 were read" : "",
      ].filter(Boolean).join(", ");
      if (r.found === 0) toast("That MDBList list is empty");
      else if (r.added === 0) toast.success(`Everything on it is already here (${titles(r.found)})`);
      else toast.success(`Added ${titles(r.added)}${extra ? ` (${extra})` : ""}`);
      if (r.added > 0) onImported();
    },
    onError: () => toast.error("Couldn't import that list. Nothing was changed"),
  });

  // ---- List of titles
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ matches: TitleMatch[]; cutOff: boolean } | null>(null);
  /** Per line (index): the film picked for an unsure line, or "skip". Unanswered lines are skipped. */
  const [picks, setPicks] = useState<Record<number, TitleCandidate | "skip">>({});
  /** Sure matches the person took out. */
  const [dropped, setDropped] = useState<ReadonlySet<number>>(() => new Set());
  const fetchMatch = useServerFn(matchMovieTitles);
  const fetchAdd = useServerFn(addMoviesToList);
  const match = useMutation({
    mutationFn: (t: string) => fetchMatch({ data: { text: t } }),
    onSuccess: (r) => {
      setResult(r);
      setPicks({});
      setDropped(new Set());
    },
    onError: () => toast.error("Couldn't look those titles up. Try again in a minute"),
  });

  const lines = result?.matches ?? [];
  const sure = lines.flatMap((m, i) => (m.status === "sure" ? [{ m, i }] : []));
  const unsure = lines.flatMap((m, i) => (m.status === "unsure" ? [{ m, i }] : []));
  const none = lines.filter((m) => m.status === "none");
  const unanswered = unsure.filter(({ i }) => picks[i] === undefined).length;
  // What "Add" sends: kept sure matches + picked films, each film once.
  const chosen = useMemo(() => {
    const out = new Map<number, TitleCandidate>();
    for (const { m, i } of sure) if (m.match && !dropped.has(i)) out.set(m.match.tmdbId, m.match);
    for (const { i } of unsure) {
      const p = picks[i];
      if (p && p !== "skip") out.set(p.tmdbId, p);
    }
    return [...out.values()];
  }, [result, picks, dropped]); // eslint-disable-line react-hooks/exhaustive-deps
  const newCount = chosen.filter((c) => !onList.has(`movie:${c.tmdbId}`)).length;

  const add = useMutation({
    mutationFn: () =>
      fetchAdd({
        data: {
          listId,
          items: chosen.map((c) => ({
            tmdbId: c.tmdbId,
            title: c.title,
            posterPath: c.posterPath,
            backdropPath: c.backdropPath,
            releaseDate: c.releaseDate,
          })),
        },
      }),
    onSuccess: (r) => {
      onOpenChange(false);
      setText("");
      setResult(null);
      if (r.added === 0) toast.success("They're all on the list already");
      else
        toast.success(
          `Added ${movies(r.added)}${r.alreadyThere > 0 ? ` (${movies(r.alreadyThere)} already on the list)` : ""}`,
        );
      if (r.added > 0) onImported();
    },
    onError: () => toast.error("Couldn't add them. Nothing was changed"),
  });

  const busy = mdblist.isPending || match.isPending || add.isPending;

  return (
    <FloatingSheet
      open={open}
      onOpenChange={(o) => {
        if (!busy) onOpenChange(o); // stays open while something runs
      }}
      title="Import"
    >
      {/* minmax(0,1fr): the sideways rows of films scroll inside the panel instead of widening it past the screen. */}
      <div className="grid grid-cols-[minmax(0,1fr)]">
      {/* The two ways in. */}
      <div className="mb-4 grid grid-cols-2 rounded-full border border-border bg-surface p-1" role="group" aria-label="Import from">
        {(
          [
            ["mdblist", "MDBList link"],
            ["titles", "List of titles"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            disabled={busy}
            onClick={() => setMode(value)}
            aria-pressed={mode === value}
            className={[
              "rounded-full px-3 py-2 text-sm font-medium whitespace-nowrap disabled:opacity-60",
              mode === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "mdblist" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim() && !busy) mdblist.mutate(url.trim());
          }}
          className="space-y-3"
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            // Plain text, not type="url": the browser would refuse "mdblist.com/lists/…" pasted without https://.
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="https://mdblist.com/lists/…"
            disabled={busy}
            className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-base outline-none focus:border-primary disabled:opacity-60"
          />
          <p className="text-sm text-muted-foreground">
            Every movie and show on that list is added to “{listName}”. Titles already here stay as they are.
          </p>
          <button
            type="submit"
            disabled={!url.trim() || busy}
            className="w-full rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {mdblist.isPending ? "Importing…" : "Import"}
          </button>
        </form>
      ) : !result ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() && !busy) match.mutate(text);
          }}
          className="space-y-3"
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            autoCapitalize="off"
            spellCheck={false}
            placeholder={"One movie per line, e.g.\nHeat (1995)\nDune 2021\nParasite\n\nor all on one line:\nHeat, Dune, Parasite"}
            disabled={busy}
            className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2.5 text-base outline-none focus:border-primary disabled:opacity-60"
          />
          <p className="text-sm text-muted-foreground">
            A year helps tell films with the same name apart. You'll see the matches before anything is added, and
            choose where it isn't clear.
          </p>
          <button
            type="submit"
            disabled={!text.trim() || busy}
            className="w-full rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {match.isPending ? "Finding matches…" : "Find matches"}
          </button>
        </form>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {[
              sure.length ? `${sure.length} matched` : "",
              unsure.length ? `${unsure.length} to check` : "",
              none.length ? `${none.length} not found` : "",
            ].filter(Boolean).join(" · ")}
            {result.cutOff && " · only the first 500 lines were read"}
          </p>
          {/* The review scrolls; the buttons below stay in view. */}
          <div className="-mx-1 max-h-[52dvh] space-y-5 overflow-y-auto px-1 pb-1">
            {unsure.length > 0 && (
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">Which one did you mean?</h3>
                {unsure.map(({ m, i }) => (
                  <div key={i} className="space-y-1.5">
                    <p className="truncate text-sm text-muted-foreground">“{m.line}”</p>
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {m.candidates.map((c) => (
                        <CandidateCard
                          key={c.tmdbId}
                          c={c}
                          picked={picks[i] !== "skip" && picks[i]?.tmdbId === c.tmdbId}
                          already={onList.has(`movie:${c.tmdbId}`)}
                          onPick={() => setPicks((p) => ({ ...p, [i]: c }))}
                        />
                      ))}
                      <button
                        type="button"
                        onClick={() => setPicks((p) => ({ ...p, [i]: "skip" }))}
                        aria-pressed={picks[i] === "skip"}
                        className={[
                          "flex w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border text-xs",
                          picks[i] === "skip"
                            ? "border-primary bg-primary/15 text-foreground"
                            : "border-dashed border-border text-muted-foreground",
                        ].join(" ")}
                      >
                        <X className="size-4" /> None of these
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            )}

            {none.length > 0 && (
              <section className="space-y-1">
                <h3 className="text-sm font-semibold">Not found</h3>
                {none.map((m, k) => (
                  <p key={k} className="truncate text-sm text-muted-foreground">“{m.line}”</p>
                ))}
              </section>
            )}

            {sure.length > 0 && (
              <section className="space-y-1">
                <h3 className="text-sm font-semibold">Matched</h3>
                {sure.map(({ m, i }) => {
                  const c = m.match!;
                  const off = dropped.has(i);
                  return (
                    <div key={i} className={`flex items-center gap-3 py-1 ${off ? "opacity-40" : ""}`}>
                      <Thumb path={c.posterPath} className="h-12 w-8" />
                      <div className="min-w-0 flex-1">
                        <p className={`truncate text-sm font-medium ${off ? "line-through" : ""}`}>
                          {c.title} <span className="font-normal text-muted-foreground">{yearOf(c)}</span>
                        </p>
                        {onList.has(`movie:${c.tmdbId}`) && <p className="text-xs text-muted-foreground">Already on the list</p>}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setDropped((d) => {
                            const n = new Set(d);
                            if (!n.delete(i)) n.add(i);
                            return n;
                          })
                        }
                        aria-label={off ? `Put ${c.title} back` : `Leave out ${c.title}`}
                        title={off ? "Put back" : "Leave out"}
                        className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground"
                      >
                        {off ? <Check className="size-4" /> : <X className="size-4" />}
                      </button>
                    </div>
                  );
                })}
              </section>
            )}
          </div>

          {unanswered > 0 && (
            <p className="text-xs text-muted-foreground">
              {unanswered} not chosen yet {unanswered === 1 ? "is" : "are"} left out.
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setResult(null)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2.5 text-sm disabled:opacity-50"
            >
              <ArrowLeft className="size-4" /> Edit
            </button>
            <button
              type="button"
              onClick={() => add.mutate()}
              disabled={chosen.length === 0 || busy}
              className="flex-1 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {add.isPending
                ? "Adding…"
                : newCount > 0
                  ? `Add ${movies(newCount)}`
                  : chosen.length > 0
                    ? "Already on the list"
                    : "Nothing to add"}
            </button>
          </div>
        </div>
      )}
      </div>
    </FloatingSheet>
  );
}

function Thumb({ path, className }: { path: string | null; className: string }) {
  const src = img(path, "w92");
  return src ? (
    <img src={src} alt="" loading="lazy" className={`${className} shrink-0 rounded object-cover bg-surface`} />
  ) : (
    <div className={`${className} grid shrink-0 place-items-center rounded bg-surface text-muted-foreground`}>
      <Film className="size-4" />
    </div>
  );
}

/** One film to pick for an unsure line: small poster, name, year. */
function CandidateCard({
  c, picked, already, onPick,
}: { c: TitleCandidate; picked: boolean; already: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={picked}
      title={c.originalTitle ? `${c.title} (${c.originalTitle})` : c.title}
      className={[
        "relative w-20 shrink-0 rounded-lg border p-1 text-left",
        picked ? "border-primary bg-primary/15" : "border-border",
      ].join(" ")}
    >
      <Thumb path={c.posterPath} className="h-[6.75rem] w-full" />
      {picked && (
        <span className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-3" />
        </span>
      )}
      <p className="mt-1 line-clamp-2 text-[11px] leading-tight font-medium">{c.title}</p>
      <p className="text-[11px] text-muted-foreground">
        {yearOf(c) || "—"}
        {already && " · on list"}
      </p>
    </button>
  );
}
