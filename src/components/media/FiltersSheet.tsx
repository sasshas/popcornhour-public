import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FloatingSheet } from "@/components/ui/floating-sheet";
import { Switch } from "@/components/ui/switch";
import { CountryRadioGroup } from "@/components/media/CountryRadioGroup";
import { useMenuEdgeGap } from "@/hooks/use-fullscreen-mode";
import { regionName } from "@/lib/region";

/**
 * The Filter button and the "Filters" panel it opens, shared by the Library and a list's page so the two look and
 * work the same. The page keeps the state (which genres are picked, its own switch); this only draws it.
 */

/** Each genre found among `rows`, A-Z, with how many have it. A picked genre none of them has is kept (with 0), so it can be unpicked. */
export function genreCounts<T>(
  rows: readonly T[],
  genresOf: (row: T) => readonly string[] | null,
  picked: readonly string[],
): [genre: string, count: number][] {
  const counts = new Map<string, number>();
  for (const r of rows) for (const g of genresOf(r) ?? []) counts.set(g, (counts.get(g) ?? 0) + 1);
  for (const g of picked) if (!counts.has(g)) counts.set(g, 0);
  return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
}

/** The rows that have any of the picked genres (all of them when none is picked). */
export function withGenres<T>(rows: T[], genresOf: (row: T) => readonly string[] | null, picked: readonly string[]): T[] {
  if (picked.length === 0) return rows;
  const set = new Set(picked);
  return rows.filter((r) => genresOf(r)?.some((g) => set.has(g)));
}

/** "Comedy", or "these genres" when more than one is picked: for "Nothing here in …". */
export function pickedGenresLabel(picked: readonly string[]): string {
  return picked.length === 1 ? picked[0] : "these genres";
}

export function FilterButton({
  onClick,
  pickedGenres,
  region,
}: {
  onClick: () => void;
  pickedGenres: readonly string[];
  region: string | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-full bg-surface border border-border px-3 py-1.5 text-xs hover:border-primary/50"
      title="Filters"
    >
      <SlidersHorizontal className="size-3.5" />
      Filter
      {pickedGenres.length > 0 && (
        <span className="max-w-28 truncate rounded-full bg-primary text-primary-foreground px-1.5 text-[10px] font-semibold">
          {pickedGenres.length === 1 ? pickedGenres[0] : `${pickedGenres.length} genres`}
        </span>
      )}
      {region && <span className="rounded-full bg-primary/15 text-primary px-1.5 text-[10px] font-semibold">{region}</span>}
    </button>
  );
}

export type FilterSwitch = {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (on: boolean) => void;
};

export function FiltersSheet({
  open,
  onOpenChange,
  toggle,
  genres,
  pickedGenres,
  onToggleGenre,
  genresLoading,
  region,
  onClearAll,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A switch row at the top (the Library's "Include movies in cinemas", a list's "Streaming only"); none when absent. */
  toggle?: FilterSwitch | null;
  genres: readonly (readonly [string, number])[];
  pickedGenres: readonly string[];
  onToggleGenre: (genre: string, on: boolean) => void;
  /** The genres are still being looked up (shows "Loading…" instead of "None found"). */
  genresLoading: boolean;
  region: string | null;
  /** Unpicks the genres and switches the switch off. "Clear all" shows only when there is something to clear. */
  onClearAll: () => void;
}) {
  const menuEdgeGap = useMenuEdgeGap(); // keeps the country menu clear of the status bar in fullscreen
  const canClear = pickedGenres.length > 0 || !!toggle?.checked;
  return (
    <FloatingSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Filters"
      action={
        canClear && (
          <button
            type="button"
            onClick={onClearAll}
            className="rounded-full px-2 py-1 text-[15px] font-medium text-primary hover:bg-primary/10"
          >
            Clear all
          </button>
        )
      }
    >
      {/* Scrolls inside when the genres and the rest do not fit (a long TV list on a short phone). */}
      <div className="-mx-5 max-h-[min(70dvh,36rem)] space-y-6 overflow-y-auto px-5 pb-1">
        {toggle && (
          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-2xl bg-white/[0.07] px-4 py-3.5">
            <span>
              <span className="block text-[15px] font-medium">{toggle.label}</span>
              <span className="block text-xs text-muted-foreground">{toggle.hint}</span>
            </span>
            <Switch
              checked={toggle.checked}
              onCheckedChange={toggle.onChange}
              className="h-7 w-12 data-[state=unchecked]:bg-white/20 [&>span]:size-6 [&>span]:bg-white [&>span]:data-[state=checked]:translate-x-5"
            />
          </label>
        )}
        <section>
          <h3 className="mb-3 text-base font-semibold">Genres</h3>
          {genres.length === 0 ? (
            <p className="text-sm text-muted-foreground">{genresLoading ? "Loading…" : "None found"}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {genres.map(([g, count]) => {
                const on = pickedGenres.includes(g);
                return (
                  <button
                    key={g}
                    type="button"
                    aria-pressed={on}
                    title={`${count} ${count === 1 ? "title" : "titles"}`}
                    onClick={() => onToggleGenre(g, !on)}
                    className={[
                      "rounded-xl px-3.5 py-2 text-[15px] font-medium transition active:scale-95",
                      on ? "bg-primary text-primary-foreground" : "bg-white/[0.07] hover:bg-white/[0.13]",
                    ].join(" ")}
                  >
                    {g}
                  </button>
                );
              })}
            </div>
          )}
        </section>
        <section>
          <h3 className="mb-3 text-base font-semibold">
            Streaming country <span className="text-xs font-normal text-muted-foreground">via JustWatch</span>
          </h3>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-2xl bg-white/[0.07] px-4 py-3.5 text-[15px] font-medium hover:bg-white/[0.13]"
              >
                {region ? regionName(region) : "Choose a country"}
                <ChevronDown className="size-4 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              collisionPadding={menuEdgeGap}
              className="w-60 max-h-[min(70dvh,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto"
            >
              <CountryRadioGroup region={region} />
            </DropdownMenuContent>
          </DropdownMenu>
        </section>
      </div>
    </FloatingSheet>
  );
}
