import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useAuth } from "@/hooks/use-auth";
import { listEpisodeProgress, toggleEpisode, markEpisodesUpTo } from "@/lib/library.functions";
import { addPlay } from "@/lib/plays.functions";
import { WatchDialog, PreviousEpisodesDialog, type WatchDialogResult } from "@/components/media/WatchDialog";
import { PlaysSheet } from "@/components/media/PlaysSheet";
import type { Episode } from "@/lib/tmdb";

const PREV_PREF_KEY = "cinexplore.prevEpisodesPref"; // "yes" | "no" | null

/**
 * Marking a season's episodes watched, shared by the season page (the tick on each episode) and an episode's own
 * page. `onCheck(episode)` on an unwatched episode asks when (and the rating) and then, if earlier episodes are
 * still unwatched, whether to mark those too (an answer can be remembered); on a watched one it opens its watch
 * history. `dialogs` must be drawn somewhere on the page.
 */
export function useEpisodeWatching(tvId: number, sn: number, episodes: Episode[]) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const fetchProgress = useServerFn(listEpisodeProgress);
  const fetchToggle = useServerFn(toggleEpisode);
  const fetchMarkUpTo = useServerFn(markEpisodesUpTo);
  const fetchAddPlay = useServerFn(addPlay);

  // The same lookup (and key) as the show page's season list, so both stay in step.
  const progressKey = ["episode-progress", tvId, user?.id ?? null];
  const { data: progress } = useQuery({
    queryKey: progressKey,
    queryFn: () => fetchProgress({ data: { tvTmdbId: tvId } }),
    enabled: !!user,
  });
  const inSeason = (progress ?? []).filter((p) => p.season_number === sn);
  const watchedSet = new Set(inSeason.map((p) => p.episode_number));
  const watchedAtMap = new Map(inSeason.map((p) => [p.episode_number, p.watched_at as string | null]));

  const toggle = useMutation({
    mutationFn: (vars: { episodeNumber: number; watched: boolean; watchedAt?: string; rating?: number | null }) =>
      fetchToggle({ data: { tvTmdbId: tvId, seasonNumber: sn, ...vars } }),
    onSuccess: () => refreshAfterTick(),
  });
  const markUpTo = useMutation({
    mutationFn: (vars: { throughEpisode: number; episodeNumbers: number[]; watchedAt?: string }) =>
      fetchMarkUpTo({ data: { tvTmdbId: tvId, seasonNumber: sn, ...vars } }),
    onSuccess: () => refreshAfterTick(),
  });
  // A tick can move the show between Watchlist, Watching and Watched, so the library is asked again too.
  function refreshAfterTick() {
    qc.invalidateQueries({ queryKey: progressKey });
    qc.invalidateQueries({ queryKey: ["library"] });
    qc.invalidateQueries({ queryKey: ["library-item", "tv", tvId] });
  }

  const [watchOpen, setWatchOpen] = useState(false);
  const [prevOpen, setPrevOpen] = useState(false);
  const [playsOpen, setPlaysOpen] = useState(false);
  const [activeEp, setActiveEp] = useState<{ number: number; name: string } | null>(null);
  const [pendingResult, setPendingResult] = useState<WatchDialogResult | null>(null);

  const earlierUnwatched = (epNum: number) =>
    episodes.filter((e) => e.episode_number < epNum && !watchedSet.has(e.episode_number)).map((e) => e.episode_number);
  const airDateOf = (epNum: number) => episodes.find((e) => e.episode_number === epNum)?.air_date ?? null;

  const onCheck = (ep: { episode_number: number; name: string }) => {
    setActiveEp({ number: ep.episode_number, name: ep.name });
    if (watchedSet.has(ep.episode_number)) setPlaysOpen(true);
    else setWatchOpen(true);
  };

  const handleValidate = (res: WatchDialogResult) => {
    if (!activeEp) return;
    const earlier = earlierUnwatched(activeEp.number);
    toggle.mutate({ episodeNumber: activeEp.number, watched: true, watchedAt: res.watchedAt, rating: res.rating });
    fetchAddPlay({
      data: {
        mediaType: "tv",
        tmdbId: tvId,
        seasonNumber: sn,
        episodeNumber: activeEp.number,
        watchedAt: res.watchedAt,
        rating: res.rating,
      },
    }).catch(() => {});
    if (earlier.length === 0) {
      setActiveEp(null);
      return;
    }
    const pref = typeof window !== "undefined" ? localStorage.getItem(PREV_PREF_KEY) : null;
    if (pref === "yes") {
      markUpTo.mutate({ throughEpisode: activeEp.number, episodeNumbers: earlier, watchedAt: res.watchedAt });
      setActiveEp(null);
    } else if (pref === "no") {
      setActiveEp(null);
    } else {
      setPendingResult(res);
      setPrevOpen(true);
    }
  };

  const dialogs = (
    <>
      {activeEp && (
        <WatchDialog
          open={watchOpen}
          onOpenChange={setWatchOpen}
          title={activeEp.name}
          releaseDate={airDateOf(activeEp.number)}
          onValidate={handleValidate}
        />
      )}
      <PreviousEpisodesDialog
        open={prevOpen}
        onOpenChange={setPrevOpen}
        onYes={(remember) => {
          if (remember) localStorage.setItem(PREV_PREF_KEY, "yes");
          if (activeEp && pendingResult) {
            const earlier = earlierUnwatched(activeEp.number);
            markUpTo.mutate({ throughEpisode: activeEp.number, episodeNumbers: earlier, watchedAt: pendingResult.watchedAt });
          }
          setActiveEp(null);
          setPendingResult(null);
        }}
        onNo={(remember) => {
          if (remember) localStorage.setItem(PREV_PREF_KEY, "no");
          setActiveEp(null);
          setPendingResult(null);
        }}
      />
      {activeEp && (
        <PlaysSheet
          open={playsOpen}
          onOpenChange={(o) => {
            setPlaysOpen(o);
            if (!o) setActiveEp(null);
          }}
          title={`S${sn} · E${activeEp.number} — ${activeEp.name}`}
          mediaType="tv"
          tmdbId={tvId}
          seasonNumber={sn}
          episodeNumber={activeEp.number}
          releaseDate={airDateOf(activeEp.number)}
          fallbackWatchedAt={watchedAtMap.get(activeEp.number) ?? null}
          onChanged={() => {
            qc.invalidateQueries({ queryKey: progressKey });
            qc.invalidateQueries({ queryKey: ["library"] });
            qc.invalidateQueries({ queryKey: ["library-item", "tv", tvId] });
          }}
        />
      )}
    </>
  );

  return { user, progress, watchedSet, watchedAtMap, onCheck, dialogs };
}
