import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "@/lib/auth-middleware";
import type { WikiPlot } from "@/server/wiki-plot.server";

export type { WikiPlot, WikiPlotBlock } from "@/server/wiki-plot.server";

/** A movie's full plot from both places, each null when that site has none. */
export type FullPlots = { imdb: WikiPlot | null; wikipedia: WikiPlot | null };

/** A movie's full plot: IMDb's synopsis and Wikipedia's plot section, looked up side by side. */
export const getFullPlots = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({ tmdbId: z.number().int().positive(), imdbId: z.string().regex(/^tt\d+$/).nullable() }).parse(d),
  )
  .handler(async ({ data }): Promise<FullPlots> => {
    const [{ getWikiPlot }, { getImdbSynopsis }] = await Promise.all([
      import("@/server/wiki-plot.server"),
      import("@/server/imdb-synopsis.server"),
    ]);
    const [imdb, wikipedia] = await Promise.all([
      data.imdbId ? getImdbSynopsis(data.imdbId) : Promise.resolve(null),
      getWikiPlot(data.tmdbId, data.imdbId),
    ]);
    return { imdb, wikipedia };
  });
