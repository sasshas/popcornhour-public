import { useEffect, useState } from "react";
import { Play, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useBackToClose } from "@/lib/back-to-close";

/**
 * A button that plays a YouTube trailer over the page.
 *  - compact: a smaller, full-width button (for tight spots, like under a small poster).
 *  - inDialog: use when the button itself sits inside a popup. A plain full-screen overlay would be trapped
 *    inside the popup there (and a popup blocks clicks outside itself), so the player is a popup of its own.
 */
export function TrailerButton({
  youtubeKey, label = "Play trailer", compact = false, inDialog = false,
}: { youtubeKey: string; label?: string; compact?: boolean; inDialog?: boolean }) {
  const [open, setOpen] = useState(false);
  // The full-screen player is not a Radix popup, so it registers for Back itself (the inDialog one is a dialog).
  useBackToClose(open && !inDialog, () => setOpen(false));

  useEffect(() => {
    if (!open || inDialog) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, inDialog]);

  const player = (
    <iframe
      src={`https://www.youtube.com/embed/${youtubeKey}?autoplay=1&rel=0`}
      title="Trailer"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen
      className="w-full h-full"
    />
  );

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`float-glass inline-flex items-center rounded-full bg-background/70 backdrop-blur-md border border-border font-semibold text-foreground hover:bg-background/90 shadow-lg ${
          compact ? "w-full justify-center gap-1.5 px-3 py-1.5 text-xs" : "gap-2 px-5 py-2.5 text-sm"
        }`}
      >
        <Play className={compact ? "size-3 fill-current" : "size-4 fill-current"} /> {label}
      </button>

      {inDialog ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent
            overlayClassName="bg-black/85 backdrop-blur-sm"
            className="w-[calc(100%-1.5rem)] max-w-5xl aspect-video gap-0 overflow-hidden rounded-2xl border-0 bg-black p-0 sm:rounded-2xl"
          >
            <DialogTitle className="sr-only">Trailer</DialogTitle>
            {open && player}
          </DialogContent>
        </Dialog>
      ) : (
        open && (
          <div
            className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm grid place-items-center p-4 animate-in fade-in"
            onClick={() => setOpen(false)}
          >
            <button
              onClick={() => setOpen(false)}
              className="absolute top-4 right-4 size-10 grid place-items-center rounded-full bg-surface/90 border border-border text-foreground hover:bg-surface"
              aria-label="Close"
            >
              <X className="size-5" />
            </button>
            <div
              className="w-full max-w-5xl aspect-video rounded-2xl overflow-hidden ring-1 ring-border shadow-2xl bg-black"
              onClick={(e) => e.stopPropagation()}
            >
              {player}
            </div>
          </div>
        )
      )}
    </>
  );
}
