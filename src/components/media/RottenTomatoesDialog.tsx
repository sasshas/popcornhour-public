import { FloatingSheet } from "@/components/ui/floating-sheet";
import { popcornIcon, tomatometerIcon } from "@/lib/rotten-tomatoes";
import { POPCORN_ICON, POPCORN_LABEL, TOMATO_ICON, TOMATO_LABEL } from "@/components/media/rt-icons";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mediaType: "movie" | "tv";
  critics: { score: number; reviews: number | null } | null;
  audience: { score: number; ratings: number | null } | null;
  /** The title's page on rottentomatoes.com, when known. */
  url: string | null;
};

function ScoreCard({
  icon, name, who, score, detail,
}: { icon: string | null; name: string; who: string; score: number | null; detail: string }) {
  return (
    <div className="flex items-center gap-4 rounded-2xl bg-white/[0.07] p-4">
      <div className="grid size-14 shrink-0 place-items-center">
        {icon ? <img src={icon} alt="" className="size-14 object-contain" /> : null}
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {who} · {name}
        </p>
        <p className="text-3xl font-bold leading-tight">{score === null ? "—" : `${score}%`}</p>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

/** What the Rotten Tomatoes badge opens: the critics' score and the audience ("user") score, with their counts. */
export function RottenTomatoesDialog({ open, onOpenChange, mediaType, critics, audience, url }: Props) {
  const tomato = critics ? tomatometerIcon(critics.score, critics.reviews, mediaType) : null;
  const popcorn = audience ? popcornIcon(audience.score, audience.ratings) : null;
  return (
    <FloatingSheet open={open} onOpenChange={onOpenChange} title="Rotten Tomatoes">
      <div className="space-y-2.5">
        <ScoreCard
          who="Critics"
          name="Tomatometer"
          icon={tomato ? TOMATO_ICON[tomato] : null}
          score={critics?.score ?? null}
          detail={
            critics && tomato
              ? `${TOMATO_LABEL[tomato]}${critics.reviews ? ` · ${critics.reviews.toLocaleString()} reviews` : ""}`
              : "No critic score yet"
          }
        />
        <ScoreCard
          who="Audience"
          name="Popcornmeter"
          icon={popcorn ? POPCORN_ICON[popcorn] : null}
          score={audience?.score ?? null}
          detail={
            audience && popcorn
              ? `${POPCORN_LABEL[popcorn]}${audience.ratings ? ` · ${audience.ratings.toLocaleString()}+ ratings` : ""}`
              : "No audience score yet"
          }
        />
      </div>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="mt-3 flex items-center justify-center rounded-2xl bg-white/[0.07] py-3.5 text-[15px] font-medium transition hover:bg-white/[0.13] active:bg-white/[0.16]"
        >
          Open on Rotten Tomatoes
        </a>
      )}
      <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
        Certified Fresh and Verified Hot are worked out from the score and the number of reviews, so they can
        differ slightly from the badges on Rotten Tomatoes itself.
      </p>
    </FloatingSheet>
  );
}
