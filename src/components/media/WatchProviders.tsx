import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getWatchProviders } from "@/lib/tmdb.functions";
import { img } from "@/lib/tmdb";
import { useEffect, useState } from "react";
import { ChevronDown, Globe } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { regionName as nameOf } from "@/lib/region";
import { CountryRadioGroup } from "@/components/media/CountryRadioGroup";
import { useRegion } from "@/hooks/use-region";
import { useMenuEdgeGap } from "@/hooks/use-fullscreen-mode";

/** TMDB logo sizes (name, width in px) offered to the browser through srcset. */
const LOGO_SIZES = [["w45", 45], ["w92", 92], ["w154", 154]] as const;

type Provider = { provider_id: number; provider_name: string; logo_path: string | null };

export function WatchProviders({ mediaType, tmdbId }: { mediaType: "movie" | "tv"; tmdbId: number }) {
  const region = useRegion() ?? "US"; // shared setting: also changed from the Library's Filter menu
  const menuEdgeGap = useMenuEdgeGap(); // keeps the country menu clear of the status bar in fullscreen

  const regionName = nameOf(region);

  const fetchProviders = useServerFn(getWatchProviders);
  const { data, isLoading } = useQuery({
    queryKey: ["watch-providers", mediaType, tmdbId],
    queryFn: () => fetchProviders({ data: { mediaType, id: tmdbId } }),
    staleTime: 1000 * 60 * 60,
  });

  const byRegion = data?.[region];
  const flatrate = byRegion?.flatrate ?? [];
  const rent = byRegion?.rent ?? [];
  const buy = byRegion?.buy ?? [];
  const free = byRegion?.free ?? [];
  const ads = byRegion?.ads ?? [];
  const link = byRegion?.link;
  const hasAny = flatrate.length || rent.length || buy.length || free.length || ads.length;

  return (
    <section className="px-4 md:px-10">
      {/* The country picker sits at the right end of the heading's line, as a pill that opens the same menu as the Library's Filter. */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-lg md:text-xl font-semibold whitespace-nowrap">Where to watch</h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-surface border border-border pl-3 pr-2.5 py-2 text-sm font-medium hover:border-primary/50"
              title="Streaming country"
              aria-label={`Streaming country: ${regionName}`}
            >
              <Globe className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{regionName}</span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" collisionPadding={menuEdgeGap} className="w-60 max-h-[min(70dvh,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Streaming country <span className="opacity-60">(via JustWatch)</span>
            </DropdownMenuLabel>
            <CountryRadioGroup region={region} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isLoading ? (
        // Holds the space of one row of logos while the list loads, so the sections below do not jump down.
        <div className="flex items-center gap-2" aria-hidden>
          <span className="w-14 shrink-0" />
          {[0, 1, 2].map((i) => <span key={i} className="size-10 rounded-lg bg-surface animate-pulse" />)}
        </div>
      ) : !hasAny ? (
        <p className="text-sm text-muted-foreground">Not currently available to stream, rent, or buy in this region.</p>
      ) : (
        <div className="space-y-3">
          <ProviderRow label="Stream" providers={[...flatrate, ...free, ...ads]} link={link} />
          <ProviderRow label="Rent" providers={rent} link={link} />
          <ProviderRow label="Buy" providers={buy} link={link} />
        </div>
      )}
    </section>
  );
}

function ProviderRow({ label, providers, link }: { label: string; providers: Provider[]; link?: string }) {
  if (!providers.length) return null;
  const seen = new Set<number>();
  const unique = providers.filter((p) => (seen.has(p.provider_id) ? false : (seen.add(p.provider_id), true)));
  const Row = (
    <div className="flex flex-wrap gap-2 items-center">
      <span className="text-xs font-medium text-muted-foreground w-14 shrink-0">{label}</span>
      {unique.map((p) => <ProviderLogo key={p.provider_id} p={p} />)}
    </div>
  );
  return link ? (
    <a href={link} target="_blank" rel="noreferrer" className="block hover:opacity-90 transition">{Row}</a>
  ) : Row;
}

/**
 * How one logo file sits in its rounded box. The files are square, but not all alike:
 *   bigger   the file has its own rounded shape and outline drawn in, on a see-through background (Apple TV Store).
 *            Our rounded box cut through that outline and showed slivers of it. It is drawn a little larger, so the
 *            drawn-in outline and see-through corners fall outside the box and only our own outline shows.
 *   smaller  the file has artwork right in its corners (the "STORE" lettering of JustWatch TV Store), which our
 *            rounded corners would cut off. It is drawn a little smaller, on a box filled with the file's own
 *            background colour.
 * Every other logo fills the box edge to edge, as before.
 */
type LogoFit = { scale: number; bg: string | null };
const PLAIN_FIT: LogoFit = { scale: 1, bg: null };
/** How much larger a file with its own drawn-in shape is shown. */
const OWN_SHAPE_SCALE = 1.1;
const fitCache = new Map<string, LogoFit>();
/** The box's corner radius as a share of its width (rounded-lg is 14px in this theme, on a 40px box). */
const CORNER = 0.35;

function measureLogo(el: HTMLImageElement): LogoFit {
  const N = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return PLAIN_FIT;
  ctx.drawImage(el, 0, 0, N, N);
  const d = ctx.getImageData(0, 0, N, N).data;
  const at = (x: number, y: number) => {
    const i = (y * N + x) * 4;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]] as const;
  };
  const far = (a: readonly number[], b: readonly number[]) =>
    Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) > 60;

  const corners = [at(0, 0), at(N - 1, 0), at(0, N - 1), at(N - 1, N - 1)];
  if (corners.some((c) => c[3] < 128)) return { scale: OWN_SHAPE_SCALE, bg: null };
  // Corners of different colours (a band across the bottom, say): no single colour to fill the box with, so leave it.
  const bg = corners[0];
  if (corners.some((c) => far(c, bg))) return PLAIN_FIT;

  // The largest size at which nothing but background falls outside the rounded corners.
  const r = CORNER * N;
  const steps = [1, 0.94, 0.88, 0.82];
  for (const scale of steps) {
    let cut = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (!far(at(x, y), bg)) continue;
        const px = N / 2 + (x + 0.5 - N / 2) * scale;
        const py = N / 2 + (y + 0.5 - N / 2) * scale;
        const dx = Math.max(r - px, px - (N - r), 0);
        const dy = Math.max(r - py, py - (N - r), 0);
        if (dx > 0 && dy > 0 && Math.hypot(dx, dy) > r) cut++;
      }
    }
    if (cut <= 1 || scale === steps[steps.length - 1]) {
      return scale === 1 ? PLAIN_FIT : { scale, bg: `rgb(${bg[0]} ${bg[1]} ${bg[2]})` };
    }
  }
  return PLAIN_FIT;
}

/**
 * Works out the fit of a logo from a copy of the file fetched just for reading its pixels. (The copy on screen cannot
 * be read: the browser keeps it from an ordinary request, and the image server then refuses a readable one for the
 * same address. w185 is a size nothing else in the app asks for.)
 */
function loadFit(path: string): Promise<LogoFit> {
  return new Promise((resolve) => {
    const probe = new Image();
    probe.crossOrigin = "anonymous";
    probe.onload = () => {
      let fit = PLAIN_FIT;
      try {
        fit = measureLogo(probe);
      } catch {
        // pixels not readable: keep the plain look
      }
      fitCache.set(path, fit);
      resolve(fit);
    };
    probe.onerror = () => resolve(PLAIN_FIT);
    probe.src = img(path, "w185")!;
  });
}

function ProviderLogo({ p }: { p: Provider }) {
  const path = p.logo_path;
  const [fit, setFit] = useState<LogoFit>(() => (path && fitCache.get(path)) || PLAIN_FIT);

  useEffect(() => {
    if (!path || fitCache.has(path)) return;
    let live = true;
    void loadFit(path).then((f) => live && setFit(f));
    return () => {
      live = false;
    };
  }, [path]);

  return (
    <span
      title={p.provider_name}
      className="size-10 rounded-lg overflow-hidden ring-1 ring-border bg-surface"
      style={fit.bg ? { backgroundColor: fit.bg } : undefined}
    >
      {path ? (
        <img
          src={img(path, "w154")!}
          // The box is 40px wide. The browser picks the smallest file with at least one real pixel per screen
          // pixel: a phone screen (3 pixels per px) needs 120, which the old fixed 92px file had to be stretched to.
          srcSet={LOGO_SIZES.map(([size, w]) => `${img(path, size)} ${w}w`).join(", ")}
          sizes="40px"
          alt={p.provider_name}
          decoding="async"
          className="w-full h-full object-cover"
          style={fit.scale !== 1 ? { transform: `scale(${fit.scale})` } : undefined}
        />
      ) : null}
    </span>
  );
}
