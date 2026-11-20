import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { FloatingSheet } from "@/components/ui/floating-sheet";
import { useRegion } from "@/hooks/use-region";
import { displayName, formatDateAULong } from "@/lib/utils";

/** TMDB's release_dates block, as it comes on a movie's details. */
export type ReleaseDates = {
  results?: {
    iso_3166_1: string;
    release_dates: { type: number; release_date: string; certification?: string; note?: string }[];
  }[];
};

/** TMDB's release types, by number. */
const TYPE_LABEL: Record<number, string> = {
  1: "Premiere",
  2: "Theatrical (limited)",
  3: "Theatrical",
  4: "Digital",
  5: "Physical",
  6: "TV",
};

type Country = {
  code: string;
  name: string;
  cert: string | null;
  /** Newest first, as on Trakt. */
  rows: { type: string; day: string; note: string | null }[];
};

const dayOf = (s: string) => (/^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

function toCountries(rd: ReleaseDates | undefined): Country[] {
  return (rd?.results ?? [])
    .map((r) => {
      const rows = r.release_dates
        .map((x) => ({ type: TYPE_LABEL[x.type] ?? "Release", day: dayOf(x.release_date) ?? "", note: x.note?.trim() || null }))
        .filter((x) => x.day)
        .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
      const cert = r.release_dates.map((x) => x.certification?.trim()).find((c) => !!c) ?? null;
      return { code: r.iso_3166_1, name: displayName("region", r.iso_3166_1) ?? r.iso_3166_1, cert, rows };
    })
    .filter((c) => c.rows.length > 0);
}

/** How many countries TMDB has release dates for (0 hides the tappable date). */
export function countReleaseCountries(rd: ReleaseDates | undefined): number {
  return toCountries(rd).length;
}

/**
 * Every release of a movie TMDB knows, by country: cinema, digital, physical and TV dates with their notes, and the
 * country's rating. Opened from the release date beside the poster. The streaming country (Where to watch) comes first,
 * then the United States (the dates the Library and Calendar go by); the rest are folded under "All countries".
 */
export function ReleasesDialog({
  open, onOpenChange, releaseDates,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  releaseDates: ReleaseDates | undefined;
}) {
  const region = useRegion() ?? "US";
  const [showAll, setShowAll] = useState(false);

  const { pinned, rest } = useMemo(() => {
    const all = toCountries(releaseDates);
    const order = [...new Set([region, "US"])];
    const pinned = order.map((c) => all.find((x) => x.code === c)).filter((x): x is Country => !!x);
    const rest = all.filter((x) => !order.includes(x.code)).sort((a, b) => a.name.localeCompare(b.name));
    return { pinned, rest };
  }, [releaseDates, region]);

  const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, this device's day

  return (
    <FloatingSheet
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setShowAll(false);
      }}
      title="Releases"
    >
      <div className="-mx-1 max-h-[65dvh] space-y-2.5 overflow-y-auto px-1 pb-1">
        {pinned.map((c) => <CountryCard key={c.code} c={c} today={today} />)}
        {pinned.length === 0 && rest.length === 0 && (
          <p className="text-sm text-muted-foreground">TMDB has no release dates for this movie.</p>
        )}
        {rest.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="flex w-full items-center justify-between rounded-2xl bg-white/[0.07] px-4 py-3 text-[15px] font-medium transition hover:bg-white/[0.13] active:bg-white/[0.16]"
              aria-expanded={showAll}
            >
              <span>{pinned.length ? "Other countries" : "All countries"} <span className="text-muted-foreground">({rest.length})</span></span>
              <ChevronDown className={`size-4 text-muted-foreground transition-transform ${showAll ? "rotate-180" : ""}`} />
            </button>
            {showAll && rest.map((c) => <CountryCard key={c.code} c={c} today={today} />)}
          </>
        )}
        <p className="pt-1 text-xs text-muted-foreground">Release dates from TMDB.</p>
      </div>
    </FloatingSheet>
  );
}

function CountryCard({ c, today }: { c: Country; today: string }) {
  return (
    <section className="rounded-2xl bg-white/[0.07] px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold">
          <span className="text-[11px] font-bold text-muted-foreground">{c.code}</span>
          <span className="truncate">{c.name}</span>
        </h3>
        {c.cert && (
          <span className="shrink-0 rounded-md border border-primary/60 px-1.5 py-0.5 text-[11px] font-bold text-primary">{c.cert}</span>
        )}
      </div>
      <ul className="space-y-1.5 text-sm">
        {c.rows.map((r, i) => {
          const ahead = r.day > today;
          return (
            <li key={i} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{r.type}</span>
              <span className={ahead ? "font-semibold text-primary" : "text-muted-foreground"}>
                {formatDateAULong(`${r.day}T12:00`)}
              </span>
              {r.note && <span className="text-xs italic text-muted-foreground">({r.note})</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
