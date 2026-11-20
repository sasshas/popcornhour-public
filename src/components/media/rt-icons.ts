import type { PopcornIcon, TomatometerIcon } from "@/lib/rotten-tomatoes";
import rtCertified from "@/assets/ratings/rt-certified-fresh.png";
import rtFresh from "@/assets/ratings/rt-fresh.svg";
import rtRotten from "@/assets/ratings/rt-rotten.svg";
import popcornUpright from "@/assets/ratings/rt-popcorn-upright.svg";
import popcornSpilled from "@/assets/ratings/rt-popcorn-spilled.svg";
import verifiedHot from "@/assets/ratings/rt-verified-hot.png";

// Images and names for each Rotten Tomatoes verdict (which one applies is decided in src/lib/rotten-tomatoes.ts).
export const TOMATO_ICON: Record<TomatometerIcon, string> = { certified: rtCertified, fresh: rtFresh, rotten: rtRotten };
export const TOMATO_LABEL: Record<TomatometerIcon, string> = { certified: "Certified Fresh", fresh: "Fresh", rotten: "Rotten" };
export const POPCORN_ICON: Record<PopcornIcon, string> = {
  "verified-hot": verifiedHot,
  upright: popcornUpright,
  spilled: popcornSpilled,
};
export const POPCORN_LABEL: Record<PopcornIcon, string> = {
  "verified-hot": "Verified Hot",
  upright: "Upright popcorn",
  spilled: "Spilled popcorn",
};
