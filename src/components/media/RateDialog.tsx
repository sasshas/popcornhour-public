import { useEffect, useState } from "react";
import { RatingPicker } from "@/components/media/RatingPicker";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  value: number | null;
  onSubmit: (value: number | null) => void;
};

export function RateDialog({ open, onOpenChange, title, value, onSubmit }: Props) {
  const [rating, setRating] = useState<number | null>(value);

  useEffect(() => {
    if (open) setRating(value);
  }, [open, value]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-center text-lg">Rate {title}</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <RatingPicker value={rating} onChange={setRating} />
        </div>
        <div className="flex gap-2">
          {value !== null && (
            <button
              onClick={() => { onSubmit(null); onOpenChange(false); }}
              className="h-11 px-4 rounded-full border border-border text-sm text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => { onSubmit(rating); onOpenChange(false); }}
            disabled={rating === null}
            className="flex-1 h-11 rounded-full bg-primary text-primary-foreground font-semibold disabled:opacity-50"
          >
            Rate
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}