import { createLocalFlag } from "@/hooks/use-local-flag";

// How a show page lists its seasons, saved on this device.
// Specials (TMDB's "season 0": extras, shorts, behind the scenes) are shown unless switched off in Settings > Appearance.
export const [getShowSpecials, setShowSpecials, useShowSpecials] = createLocalFlag("cx:show-specials", true);
// Newest season first unless the sort arrow above the list is flipped.
export const [getSeasonsNewestFirst, setSeasonsNewestFirst, useSeasonsNewestFirst] = createLocalFlag("cx:seasons-newest-first", true);
