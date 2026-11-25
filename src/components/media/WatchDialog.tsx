import { useEffect, useMemo, useState } from "react";
import { Calendar, Clock } from "lucide-react";
import { RatingPicker } from "@/components/media/RatingPicker";
import { UNKNOWN_WATCHED_AT } from "@/lib/watched-date";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type WatchDialogResult = {
  watchedAt: string; // ISO string
  rating: number | null;
};

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function fromLocalInput(date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = (time || "00:00").split(":").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initialRating?: number | null;
  releaseDate?: string | null;
  /** A movie's US digital (streaming / rent / buy) release date, for the "Streaming date" pill. */
  streamingDate?: string | null;
  onValidate: (result: WatchDialogResult) => void;
};

export function WatchDialog({ open, onOpenChange, title, initialRating, releaseDate, streamingDate, onValidate }: Props) {
  const now = useMemo(() => new Date(), [open]);
  const init = toLocalInput(now);
  const [date, setDate] = useState(init.date);
  const [time, setTime] = useState(init.time);
  const [rating, setRating] = useState<number | null>(initialRating ?? null);
  // "Unknown date": watched, but not sure when. The date and time boxes are greyed out while it is chosen; touching
  // them, or another pill, picks a real date again.
  const [unknown, setUnknown] = useState(false);

  useEffect(() => {
    if (open) {
      const i = toLocalInput(new Date());
      setDate(i.date);
      setTime(i.time);
      setRating(initialRating ?? null);
      setUnknown(false);
    }
  }, [open, initialRating]);

  // Release / streaming date pills set that day at 8pm. TMDB's dates are a day ("2026-08-14") or midnight UTC
  // ("2026-08-14T00:00:00.000Z"), so only the first 10 characters are the day.
  const dayOf = (s?: string | null) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
  const releaseDay = dayOf(releaseDate);
  // The streaming pill shows once the movie is out to stream (not for a future date), and not when it is the same
  // day as the release date (a straight-to-streaming movie), where it would do the same thing.
  const streamingDay = (() => {
    const d = dayOf(streamingDate);
    return d && d !== releaseDay && d <= toLocalInput(now).date ? d : null;
  })();
  const pickDay = (day: string) => {
    const d = new Date(`${day}T20:00`);
    if (!isNaN(d.getTime())) {
      const i = toLocalInput(d);
      setDate(i.date);
      setTime(i.time);
      setUnknown(false);
    }
  };

  const submit = () => {
    const watchedAt = unknown ? UNKNOWN_WATCHED_AT : fromLocalInput(date, time).toISOString();
    onValidate({ watchedAt, rating });
    onOpenChange(false);
  };

  const pill = "rounded-md border px-3 py-1.5 text-sm transition";
  const pillIdle = `${pill} border-border bg-surface hover:border-primary/50`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-center text-xl">{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5 pt-2">
          <RatingPicker value={rating} onChange={setRating} allowClear tone="gold" />

          <div className={`space-y-3 transition-opacity ${unknown ? "opacity-40" : ""}`}>
            <label className="flex items-center gap-3">
              <Calendar className="size-5 text-foreground" />
              <div className="flex-1">
                <div className="text-xs text-muted-foreground">Watch date</div>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => { setDate(e.target.value); setUnknown(false); }}
                  onFocus={() => setUnknown(false)}
                  className="bg-transparent w-full text-lg outline-none text-foreground [color-scheme:dark]"
                />
              </div>
            </label>
            <label className="flex items-center gap-3">
              <Clock className="size-5 text-foreground" />
              <div className="flex-1">
                <div className="text-xs text-muted-foreground">Watch time</div>
                <input
                  type="time"
                  value={time}
                  onChange={(e) => { setTime(e.target.value); setUnknown(false); }}
                  onFocus={() => setUnknown(false)}
                  className="bg-transparent w-full text-lg outline-none text-foreground [color-scheme:dark]"
                />
              </div>
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                const i = toLocalInput(new Date());
                setDate(i.date);
                setTime(i.time);
                setUnknown(false);
              }}
              className={pillIdle}
            >
              Now
            </button>
            {releaseDay && (
              <button type="button" onClick={() => pickDay(releaseDay)} className={pillIdle}>
                Release date
              </button>
            )}
            {streamingDay && (
              <button type="button" onClick={() => pickDay(streamingDay)} className={pillIdle}>
                Streaming date
              </button>
            )}
            <button
              type="button"
              aria-pressed={unknown}
              onClick={() => setUnknown((u) => !u)}
              className={unknown ? `${pill} border-primary bg-primary/15 text-primary` : pillIdle}
            >
              Unknown date
            </button>
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="px-4 py-2 text-sm font-medium text-primary hover:opacity-90"
          >
            Validate
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ConfirmProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onYes: (remember: boolean) => void;
  onNo: (remember: boolean) => void;
};

export function PreviousEpisodesDialog({ open, onOpenChange, onYes, onNo }: ConfirmProps) {
  const [remember, setRemember] = useState(false);
  useEffect(() => { if (open) setRemember(false); }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Previous episodes</DialogTitle>
        </DialogHeader>
        <p className="text-muted-foreground">
          Do you want to mark all previous episodes as watched?
        </p>
        <label className="flex items-center justify-between gap-3 pt-2">
          <span className="text-sm">Remember my choice</span>
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="size-5 accent-primary"
          />
        </label>
        <DialogFooter className="gap-2 sm:gap-2">
          <button
            type="button"
            onClick={() => { onNo(remember); onOpenChange(false); }}
            className="px-4 py-2 text-sm text-primary hover:opacity-90"
          >
            No
          </button>
          <button
            type="button"
            onClick={() => { onYes(remember); onOpenChange(false); }}
            className="px-4 py-2 text-sm font-medium text-primary hover:opacity-90"
          >
            Yes
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}