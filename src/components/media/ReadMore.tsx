import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

// Written out in full so the stylesheet keeps them.
const CLAMP = { 4: "line-clamp-4", 6: "line-clamp-6" } as const;

/**
 * Long text cut to a few lines with a fade and a "Read more" button that opens the rest (a person's biography, a
 * season's plot). The button only shows when there is more to read. Until the page has measured it, a long text is
 * assumed to be cut, so the button does not pop in a moment later.
 *
 * `scrollTo`: closing a long text from far down brings this back on screen (its heading, when given) rather than
 * leaving you lower in the page. Give it `scroll-mt-16` so it stops just under the floating Back button.
 */
export function ReadMore({
  text, lines, className = "", scrollTo,
}: {
  text: string;
  lines: keyof typeof CLAMP;
  className?: string;
  scrollTo?: RefObject<HTMLElement | null>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  // About 60 characters to a line on a phone.
  const [cut, setCut] = useState(text.length > lines * 60);
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure); // turning the phone changes how many lines it takes
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, text]);
  const toggle = () => {
    const target = scrollTo?.current ?? ref.current;
    if (open && target && target.getBoundingClientRect().top < 0) target.scrollIntoView({ block: "start" });
    setOpen(!open);
  };
  const faded = !open && cut;
  return (
    <div>
      <p
        ref={ref}
        id={id}
        className={[
          "text-muted-foreground leading-relaxed whitespace-pre-line scroll-mt-16",
          className,
          open ? "" : CLAMP[lines],
          faded ? "[mask-image:linear-gradient(to_bottom,black_55%,transparent)]" : "",
        ].join(" ")}
      >
        {text}
      </p>
      {cut && (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={id}
          className="mt-2 inline-flex items-center gap-1 rounded-full py-1 text-sm font-semibold text-primary hover:underline"
        >
          {open ? "Show less" : "Read more"}
          {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
      )}
    </div>
  );
}
