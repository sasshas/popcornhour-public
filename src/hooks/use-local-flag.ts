import { useSyncExternalStore } from "react";

/**
 * An on/off choice saved in this browser (like the other Appearance settings), shared live between the settings page
 * and whichever page uses it. `defaultOn` is what it is until someone changes it.
 * Returns [get, set, useIt]: read it anywhere, change it, or follow it in a component.
 */
export function createLocalFlag(key: string, defaultOn: boolean, legacy?: () => boolean | null) {
  const event = `${key}-change`;
  let memory: boolean | null = null; // used when the browser won't let us save

  // `legacy` (optional) reads a choice saved somewhere older, so moving a setting does not reset it: used only
  // until the flag is set for the first time.
  const get = (): boolean => {
    if (memory !== null) return memory;
    try {
      const v = localStorage.getItem(key);
      if (v !== null) return v === "1";
    } catch {
      return defaultOn;
    }
    try {
      return legacy?.() ?? defaultOn;
    } catch {
      return defaultOn;
    }
  };

  const set = (on: boolean): void => {
    memory = on;
    try {
      localStorage.setItem(key, on ? "1" : "0");
    } catch {}
    window.dispatchEvent(new Event(event));
  };

  const subscribe = (cb: () => void) => {
    window.addEventListener(event, cb);
    window.addEventListener("storage", cb);
    return () => {
      window.removeEventListener(event, cb);
      window.removeEventListener("storage", cb);
    };
  };

  // The server has no saved choice, so it always renders the default (and the first client render matches it).
  const use = (): boolean => useSyncExternalStore(subscribe, get, () => defaultOn);

  return [get, set, use] as const;
}
