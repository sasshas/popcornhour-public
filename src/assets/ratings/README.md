# Rating icons

Used by `src/components/media/RatingsBar.tsx`. Which one is shown is decided in `src/lib/rotten-tomatoes.ts`.

| File | What | Source |
|---|---|---|
| `rt-fresh.svg` | Rotten Tomatoes "Fresh" tomato (critics 60%+) | Wikimedia Commons, `File:Rotten Tomatoes.svg` (recorded as public domain, trademarked) |
| `rt-rotten.svg` | Rotten Tomatoes "Rotten" splat (critics under 60%) | Wikimedia Commons, `File:Rotten Tomatoes rotten.svg` |
| `rt-popcorn-upright.svg` | Audience score 60%+ | Wikimedia Commons, `File:Rotten Tomatoes positive audience.svg` |
| `rt-popcorn-spilled.svg` | Audience score under 60% | Wikimedia Commons, `File:Rotten Tomatoes negative audience.svg` |
| `rt-certified-fresh.png` | Certified Fresh badge | The image supplied by the app's owner (from the Rotten Tomatoes Wikipedia page), shrunk from 1024px to 192px, transparency kept. |
| `rt-verified-hot.png` | Verified Hot badge (audience 90%+ with 500+ ratings) | The Rotten Tomatoes badge image from the link the app's owner supplied (mediaplaynews.com), shrunk from 287x300 to 160x167, transparency kept. |
| `metacritic.png` | Metacritic logo (dark disc, yellow ring, white "m") | Wikimedia Commons, `File:Metacritic.svg`, drawn once to a 128px transparent PNG (the original SVG used a transform that one phone browser drew as a blank white disc; a PNG looks the same everywhere). `metacritic.svg` is the cleaned-up source and is no longer used by the app. |
| `tmdb.png` | TMDB logo | The image supplied by the app's owner. |

The Rotten Tomatoes SVGs were only cleaned up (editor metadata removed, `viewBox` added so they scale).

"Rotten Tomatoes", its icons and the "Certified Fresh" badge are trademarks of Fandango; "Metacritic" and its logo are
trademarks of their owner; "TMDB" and its logo belong to TMDB. They are here to label scores in a personal, self-hosted app. If this repository is ever made
public, review the brand guidelines of both services first (TMDB's terms also ask for an attribution notice).
