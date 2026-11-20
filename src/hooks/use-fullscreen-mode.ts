import { createLocalFlag } from "@/hooks/use-local-flag";

// "My phone browser is in fullscreen": off unless someone switches it on for this device (Settings > Appearance).
// The calendar uses it for Today / This week: in fullscreen the Android status bar sits over the top of the page, so
// the date has to stop that far down, and the controls bar folds away instead of staying put.
export const [getFullscreenMode, setFullscreenMode, useFullscreenMode] = createLocalFlag("cx:fullscreen", false);

/** About how tall (in CSS pixels) the Android status bar is, which fullscreen leaves drawn over the top of the page. */
export const STATUS_BAR_PX = 40;

/** The gap a long dropdown menu keeps from the screen's edges. */
const MENU_EDGE_GAP = 8;

/**
 * How far a long dropdown menu (the streaming-country list) must stay from each screen edge: a small gap, plus room
 * for the status bar at the top in fullscreen, where the menu would otherwise slide under it and its top items could
 * not be tapped. Pass it as the menu's `collisionPadding`.
 */
export function useMenuEdgeGap() {
  const fullscreen = useFullscreenMode();
  return { top: MENU_EDGE_GAP + (fullscreen ? STATUS_BAR_PX : 0), right: MENU_EDGE_GAP, bottom: MENU_EDGE_GAP, left: MENU_EDGE_GAP };
}
