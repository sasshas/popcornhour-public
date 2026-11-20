import { Clapperboard, MonitorPlay, Tv } from "lucide-react";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/**
 * "2 Apr" for a date this year, "2 Apr 2027" otherwise. Release dates arrive as midnight UTC, so the day is read in
 * UTC: reading it in local time would show the day before in timezones behind UTC.
 */
export function shortDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (isNaN(d.getTime())) return iso;
  const year = d.getUTCFullYear();
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year === new Date().getFullYear() ? "" : ` ${year}`}`;
}

export type ReleaseKind = "digital" | "cinema" | "in-cinemas" | "tv";

const KIND_NAME: Record<ReleaseKind, string> = {
  digital: "Digital release",
  cinema: "Cinema release",
  "in-cinemas": "In cinemas since",
  tv: "First airs",
};

/**
 * The small dark date pill on an Upcoming poster (Library and lists), in the poster's bottom-left corner just above
 * the streaming logos: a gold screen for the digital (home) date, a blue clapperboard for the cinema date (or the
 * words "In cinemas" once it has opened there), and a green TV for a show's first air date. No backdrop blur: it is
 * on every poster.
 */
export function ReleaseDateBadge({ date, kind }: { date: string; kind: ReleaseKind }) {
  return (
    <div
      className="flex items-center gap-1 rounded-full bg-black/70 py-0.5 pl-1.5 pr-2 text-[11px] font-semibold leading-4 text-white ring-1 ring-white/15 whitespace-nowrap"
      title={`${KIND_NAME[kind]} ${shortDate(date)}`}
    >
      {kind === "digital" ? (
        <MonitorPlay className="size-3 text-[var(--gold)]" aria-hidden />
      ) : kind === "cinema" || kind === "in-cinemas" ? (
        <Clapperboard className="size-3 text-sky-300" aria-hidden />
      ) : (
        <Tv className="size-3 text-emerald-300" aria-hidden />
      )}
      {kind === "in-cinemas" ? (
        <>
          In cinemas<span className="sr-only"> since {shortDate(date)}</span>
        </>
      ) : (
        <>
          <span className="sr-only">{KIND_NAME[kind]} </span>
          {shortDate(date)}
        </>
      )}
    </div>
  );
}
