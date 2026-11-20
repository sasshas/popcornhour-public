// How the page now showing was reached. router.tsx records every history change here.
//  - "PUSH": a fresh visit (a link or a bottom-bar tab was tapped). The page opens at the top, with nothing to put
//    back, so it may draw what is on screen first and the rest a moment later.
//  - anything else (BACK, FORWARD, GO, REPLACE), or null for the page the app was opened on: the page must be drawn
//    in full straight away, so Back can return to the same scroll place and the poster you had tapped.
let last: string | null = null;

export function setLastNavAction(type: string): void {
  last = type;
}

export function isFreshVisit(): boolean {
  return last === "PUSH";
}
