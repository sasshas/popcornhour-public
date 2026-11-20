import { createLocalFlag } from "@/hooks/use-local-flag";

// "Show the title under each poster", chosen per part of the app in Settings > Appearance. On unless switched off
// on this device. (Movie and TV posters share a section: TV shows follow whichever section they appear in.)
export type TitleArea = "home" | "library" | "lists" | "calendar";

/**
 * The Library used to keep its own choice inside its saved view settings; carry that over. It is read once, as soon as
 * the app loads in the browser, because the Library page rewrites those settings (without this field) when it opens.
 */
const legacyLibrary: boolean | null = (() => {
  try {
    const p = JSON.parse(localStorage.getItem("library:prefs") ?? "null");
    return typeof p?.showTitles === "boolean" ? p.showTitles : null;
  } catch {
    return null; // on the server there is no localStorage; or nothing saved
  }
})();
const legacyLibraryChoice = () => legacyLibrary;

const flags: Record<TitleArea, ReturnType<typeof createLocalFlag>> = {
  home: createLocalFlag("cx:titles-home", true),
  library: createLocalFlag("cx:titles-library", true, legacyLibraryChoice),
  lists: createLocalFlag("cx:titles-lists", true),
  calendar: createLocalFlag("cx:titles", true), // (the calendar's original key)
};

/** The sections listed in Settings > Appearance, in order. */
export const TITLE_AREAS: { id: TitleArea; label: string; hint: string }[] = [
  { id: "home", label: "Home, search & browse", hint: "Movie and TV rows on Home, search results, See more pages" },
  { id: "library", label: "Library", hint: "Your movies and TV shows" },
  { id: "lists", label: "Lists", hint: "The posters inside a list" },
  { id: "calendar", label: "Calendar", hint: "Release calendar posters (the streaming service stays under each)" },
];

export const setShowTitles = (area: TitleArea, on: boolean) => flags[area][1](on);
/** Whether titles show under this section's posters. (Pass a fixed area: it is a hook.) */
export const useShowTitles = (area: TitleArea): boolean => flags[area][2]();
