import { createLocalFlag } from "@/hooks/use-local-flag";

// "List every streaming country" (Settings > Appearance). Off: the country menus list only the pinned few
// (Australia, United States, United Kingdom, Canada), plus the chosen country if it is another one.
export const [getAllCountries, setAllCountries, useAllCountries] = createLocalFlag("cx:all-countries", false);
