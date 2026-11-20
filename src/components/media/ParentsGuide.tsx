import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, ChevronUp, Heart, Swords, MessageSquareWarning, Wine, Zap } from "lucide-react";
import { getParentsGuide, type ParentsGuideSeverity, type ParentsGuideItem } from "@/lib/tmdb.functions";

const LABELS: Record<string, string> = {
  SEXUAL_CONTENT: "Sex & Nudity",
  VIOLENCE: "Violence & Gore",
  PROFANITY: "Profanity",
  ALCOHOL_DRUGS: "Alcohol, Drugs & Smoking",
  FRIGHTENING_INTENSE_SCENES: "Frightening & Intense",
};

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  SEXUAL_CONTENT: Heart,
  VIOLENCE: Swords,
  PROFANITY: MessageSquareWarning,
  ALCOHOL_DRUGS: Wine,
  FRIGHTENING_INTENSE_SCENES: Zap,
};

const SEVERITY_INDEX: Record<ParentsGuideSeverity, number> = { none: 0, mild: 1, moderate: 2, severe: 3 };
const SEVERITY_LABEL: Record<ParentsGuideSeverity, string> = { none: "None", mild: "Mild", moderate: "Moderate", severe: "Severe" };
const SEVERITY_COLOR: Record<ParentsGuideSeverity, string> = {
  none: "bg-emerald-500",
  mild: "bg-yellow-500",
  moderate: "bg-orange-500",
  severe: "bg-red-600",
};
const SEVERITY_TEXT: Record<ParentsGuideSeverity, string> = {
  none: "text-emerald-500",
  mild: "text-yellow-500",
  moderate: "text-orange-500",
  severe: "text-red-500",
};

/** Four segments. Full width on a phone (the row puts them on their own line), fixed-size on desktop. */
function SeverityBars({ severity, className = "" }: { severity: ParentsGuideSeverity | null; className?: string }) {
  const level = severity ? SEVERITY_INDEX[severity] : -1;
  const color = severity ? SEVERITY_COLOR[severity] : "bg-muted";
  return (
    <div className={`flex gap-1.5 ${className}`}>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={`h-1.5 md:h-2 flex-1 md:flex-none md:w-8 rounded-full ${i <= level ? color : "bg-muted"}`} />
      ))}
    </div>
  );
}

function CategoryRow({ item }: { item: ParentsGuideItem }) {
  const [open, setOpen] = useState(false);
  const hasReviews = item.reviews.length > 0;
  const Icon = ICONS[item.category] ?? Zap;
  const sevText = item.severity ? SEVERITY_TEXT[item.severity] : "text-muted-foreground";
  return (
    <div className="rounded-xl border border-border bg-surface">
      <button
        type="button"
        onClick={() => hasReviews && setOpen((o) => !o)}
        // Phone: icon, label, severity and chevron on the first line, the bars on a line of their own below
        // (they sort last and span every column). Desktop: one line, with the bars between label and severity.
        className="w-full grid grid-cols-[auto_minmax(0,1fr)_auto_auto] md:grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-x-3 gap-y-2.5 md:gap-4 p-3 text-left"
        disabled={!hasReviews}
      >
        <Icon className={`size-5 shrink-0 ${sevText}`} />
        <div className="min-w-0 text-sm font-medium md:truncate">{LABELS[item.category] ?? item.category}</div>
        <SeverityBars severity={item.severity} className="order-last col-span-4 md:order-none md:col-span-1" />
        <div className={`text-sm font-medium md:w-20 text-right ${sevText}`}>
          {item.severity ? SEVERITY_LABEL[item.severity] : "—"}
        </div>
        <div className="w-4 shrink-0 flex justify-end">
          {hasReviews ? (open ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />) : null}
        </div>
      </button>
      {open && hasReviews && (
        <ul className="border-t border-border px-4 py-3 space-y-2 text-sm text-muted-foreground">
          {item.reviews.slice(0, 10).map((r, i) => (
            <li key={i} className="leading-relaxed">
              {r.isSpoiler && <span className="mr-1.5 text-[10px] uppercase tracking-wide font-semibold rounded bg-amber-500/20 text-amber-500 px-1.5 py-0.5">Spoiler</span>}
              {r.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ParentsGuide({ imdbId }: { imdbId?: string | null }) {
  const fetchGuide = useServerFn(getParentsGuide);
  const { data, isLoading } = useQuery({
    queryKey: ["parents-guide", imdbId],
    queryFn: () => fetchGuide({ data: { imdbId: imdbId! } }),
    enabled: !!imdbId,
    staleTime: 1000 * 60 * 60 * 24,
  });

  if (!imdbId) return null;
  if (isLoading) return null;
  if (!data || data.length === 0) return null;

  return (
    <section className="px-4 md:px-10 max-w-4xl">
      <div className="flex items-baseline justify-between mb-3 gap-3">
        <h2 className="text-lg font-semibold">Parents guide</h2>
        <span className="text-[11px] text-muted-foreground">Source: IMDb</span>
      </div>
      <div className="grid gap-2">
        {data.map((item) => (
          <CategoryRow key={item.category} item={item} />
        ))}
      </div>
    </section>
  );
}