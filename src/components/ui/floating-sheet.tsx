import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/**
 * A frosted, rounded panel over a lighter blurred backdrop. On a phone it floats near the bottom, inset
 * from the screen edges, with a grab handle; on larger screens it is a centred panel.
 * Used for the Links and Rotten Tomatoes popups, and the Calendar's movie details.
 *
 * `slides`: the caller opens and closes it inside a browser view transition (see the Calendar), which slides the
 * panel up from the bottom and back down (styles.css, "sheet"). Its own fade is then switched off, so the two do
 * not play on top of each other and the panel is gone the moment it is closed.
 */
export function FloatingSheet({
  open, onOpenChange, title, children, slides, action,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  slides?: boolean;
  /** Shown at the right end of the title's line (the Library's Filters puts "Clear all" there). */
  action?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName={`bg-black/40 backdrop-blur-sm ${slides ? "animate-none!" : ""}`}
        style={slides ? { animation: "none", viewTransitionName: "sheet" } : undefined}
        className="glass-sheet left-3 right-3 top-auto bottom-3 w-auto max-w-none translate-x-0 translate-y-0 gap-0 rounded-[28px] p-5 pt-3 shadow-2xl data-[state=open]:slide-in-from-bottom-6 sm:left-1/2 sm:right-auto sm:top-1/2 sm:bottom-auto sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[28px] sm:data-[state=open]:slide-in-from-bottom-0"
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-white/25 sm:hidden" aria-hidden />
        {action ? (
          <div className="mb-4 flex items-center justify-between gap-3">
            <DialogTitle className="text-2xl font-bold tracking-tight">{title}</DialogTitle>
            {/* pr-7: clear of the dialog's close cross in the top-right corner. */}
            <div className="pr-7">{action}</div>
          </div>
        ) : (
          <DialogTitle className="mb-4 text-2xl font-bold tracking-tight">{title}</DialogTitle>
        )}
        {children}
      </DialogContent>
    </Dialog>
  );
}
