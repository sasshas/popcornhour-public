import { useEffect, useState } from "react";
import { detectRegion } from "@/lib/region";

/** The streaming region, or null until the browser has been read (so server and first client render agree). */
export function useRegion(): string | null {
  const [region, setRegion] = useState<string | null>(null);
  useEffect(() => {
    setRegion(detectRegion());
    const onChange = (e: Event) => setRegion((e as CustomEvent<string>).detail);
    window.addEventListener("cx:region-change", onChange);
    return () => window.removeEventListener("cx:region-change", onChange);
  }, []);
  return region;
}
