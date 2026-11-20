import { Link2, Share2 } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { FloatingSheet } from "@/components/ui/floating-sheet";
import { createLocalFlag } from "@/hooks/use-local-flag";
import googleIcon from "@/assets/links/google.svg";
import traktIcon from "@/assets/links/trakt.svg";
import letterboxdIcon from "@/assets/links/letterboxd.svg";
import wikipediaIcon from "@/assets/links/wikipedia.svg";
import tmdbIcon from "@/assets/ratings/tmdb.png";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  tmdbId: number;
  imdbId?: string | null;
  homepage?: string | null;
  year?: string | null;
  mediaType?: "movie" | "tv";
};

// Share's "Link to" choice: off = IMDb (or TMDb), on = this app's own page. Saved on this device.
const [, setShareOwnLink, useShareOwnLink] = createLocalFlag("cx:share-own-link", false);

// Every icon sits in the same 32px cell so the labels line up.
const IMG = "size-7 rounded-md";
const ICONS: Record<string, ReactNode> = {
  Website: <Link2 className="size-5 text-foreground/80" />,
  Google: <img src={googleIcon} alt="" className="size-6" />,
  Trakt: <img src={traktIcon} alt="" className={IMG} />,
  // Same yellow chip as the IMDb score in the ratings row.
  IMDb: <span className="rounded bg-[#f5c518] px-1 py-0.5 text-[10px] font-black leading-none text-black">IMDb</span>,
  TMDb: <img src={tmdbIcon} alt="" className={IMG} />,
  Letterboxd: <img src={letterboxdIcon} alt="" className={IMG} />,
  Wikipedia: <img src={wikipediaIcon} alt="" className={IMG} />,
};

export function LinksDialog({ open, onOpenChange, title, tmdbId, imdbId, homepage, year, mediaType = "movie" }: Props) {
  const q = encodeURIComponent(title);
  const tv = mediaType === "tv";
  const tmdbUrl = `https://www.themoviedb.org/${tv ? "tv" : "movie"}/${tmdbId}`;
  const links: { label: string; href: string }[] = [
    ...(homepage ? [{ label: "Website", href: homepage }] : []),
    { label: "Google", href: `https://www.google.com/search?q=${q}+${tv ? "tv+series" : "movie"}` },
    { label: "Trakt", href: imdbId ? `https://trakt.tv/search/imdb/${imdbId}` : `https://trakt.tv/search?query=${q}` },
    ...(imdbId ? [{ label: "IMDb", href: `https://www.imdb.com/title/${imdbId}/` }] : []),
    { label: "TMDb", href: tmdbUrl },
    // Letterboxd only has films.
    ...(imdbId && !tv ? [{ label: "Letterboxd", href: `https://letterboxd.com/imdb/${imdbId}/` }] : []),
    { label: "Wikipedia", href: `https://en.wikipedia.org/w/index.php?search=${q}` },
  ];

  // What gets shared: the movie's name and year, linked to the page picked under "Link to" (remembered on this
  // device). IMDb (TMDb when it has no IMDb id) is a public page anyone can open; Popcornhour is this page in this
  // app, at the address it is open on now, which only works where that address does and behind the password.
  const ownLink = useShareOwnLink();
  const name = year ? `${title} (${year})` : title;
  const publicUrl = imdbId ? `https://www.imdb.com/title/${imdbId}/` : tmdbUrl;
  const publicLabel = imdbId ? "IMDb" : "TMDb";

  async function share() {
    const shareUrl = ownLink ? `${window.location.origin}/${tv ? "tv" : "movie"}/${tmdbId}` : publicUrl;
    // The phone's share sheet, where the browser offers it (only on https addresses).
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: name, text: name, url: shareUrl });
        return;
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return; // closed the share sheet
      }
    }
    // Otherwise copy it. Pasted into somewhere that keeps formatting (email, notes) the name itself is the
    // link; anywhere else it pastes as the name followed by the link.
    if (copyLink(name, shareUrl)) toast.success("Copied", { description: name });
    else toast.error("Couldn't copy the link");
  }

  return (
    <FloatingSheet open={open} onOpenChange={onOpenChange} title="Links">
      <div className="grid grid-cols-2 gap-2.5">
        {links.map((l) => (
          <a
            key={l.label}
            href={l.href}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-3 rounded-2xl bg-white/[0.07] px-3.5 py-3.5 text-[15px] font-medium transition hover:bg-white/[0.13] active:bg-white/[0.16]"
          >
            <span className="grid size-8 shrink-0 place-items-center">{ICONS[l.label]}</span>
            {l.label}
          </a>
        ))}
        <div className="col-span-2 mt-1 flex items-center gap-3">
          <span className="shrink-0 text-sm text-muted-foreground">Link to</span>
          <div role="radiogroup" aria-label="Link to" className="grid flex-1 grid-cols-2 gap-1 rounded-full bg-white/[0.07] p-1">
            {[
              { own: false, label: publicLabel },
              { own: true, label: "Popcornhour" },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                role="radio"
                aria-checked={ownLink === o.own}
                onClick={() => setShareOwnLink(o.own)}
                className={[
                  "rounded-full px-3 py-1.5 text-sm font-medium transition",
                  ownLink === o.own ? "bg-white/[0.18] text-foreground" : "text-foreground/60 hover:text-foreground",
                ].join(" ")}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={share}
          className="col-span-2 flex items-center justify-center gap-2.5 rounded-2xl bg-white/[0.14] px-3.5 py-3.5 text-[15px] font-semibold transition hover:bg-white/[0.2] active:bg-white/[0.24]"
        >
          <Share2 className="size-5" />
          Share
        </button>
      </div>
    </FloatingSheet>
  );
}

// Copies the name as a link (rich text) plus "name url" as plain text. Uses the old copy command, because
// the newer clipboard API is switched off on plain http addresses like the home server's.
function copyLink(name: string, url: string): boolean {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData("text/plain", `${name} ${url}`);
    e.clipboardData?.setData("text/html", `<a href="${esc(url)}">${esc(name)}</a>`);
    e.preventDefault();
  };
  document.addEventListener("copy", onCopy);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.removeEventListener("copy", onCopy);
  }
}
