import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getTraktSentiments } from "@/lib/tmdb.functions";

/**
 * "What people are saying": up to three good points (green) and three bad ones (red), from Trakt's summary of the
 * movie's or show's comments. Draws nothing while loading or when there is no summary, so the page never shows an empty box.
 */
export function WhatPeopleSay({ imdbId, mediaType = "movie" }: { imdbId?: string | null; mediaType?: "movie" | "tv" }) {
  const fetchSentiments = useServerFn(getTraktSentiments);
  const { data } = useQuery({
    queryKey: ["trakt-sentiments", mediaType, imdbId],
    queryFn: () => fetchSentiments({ data: { imdbId: imdbId!, mediaType } }),
    enabled: !!imdbId,
    staleTime: 1000 * 60 * 60 * 6,
  });
  if (!data) return null;

  const Line = ({ text, tone }: { text: string; tone: "good" | "bad" }) => (
    <li className="flex items-start gap-2.5 text-sm">
      <span className={`mt-1 h-3.5 w-1 shrink-0 rounded-full ${tone === "good" ? "bg-emerald-400" : "bg-rose-400"}`} aria-hidden />
      <span className="sr-only">{tone === "good" ? "Liked: " : "Disliked: "}</span>
      {text}
    </li>
  );

  return (
    <section className="px-4 md:px-10 max-w-4xl">
      <h2 className="text-lg font-semibold mb-2">What people are saying</h2>
      <div className="rounded-xl bg-surface border border-border px-4 py-3 grid gap-3 sm:grid-cols-2">
        {data.good.length > 0 && (
          <ul className="space-y-1.5">
            {data.good.map((t) => <Line key={t} text={t} tone="good" />)}
          </ul>
        )}
        {data.bad.length > 0 && (
          <ul className="space-y-1.5">
            {data.bad.map((t) => <Line key={t} text={t} tone="bad" />)}
          </ul>
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground opacity-70">Summed up from comments on Trakt</p>
    </section>
  );
}
