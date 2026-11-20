import { Fragment } from "react";
import { DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { PINNED_REGION_COUNT, countryChoices, storeRegion } from "@/lib/region";
import { useAllCountries } from "@/hooks/use-all-countries";

/**
 * The streaming-country choices inside a dropdown menu ("Where to watch", and the Library's and a list's Filter).
 * Normally just the pinned countries, plus the chosen one if it is another; with "All streaming countries" on
 * (Settings > Appearance), the rest of the world follows below a line.
 */
export function CountryRadioGroup({ region }: { region: string | null }) {
  const all = useAllCountries();
  const shown = countryChoices(region, all);
  return (
    <DropdownMenuRadioGroup value={region ?? ""} onValueChange={storeRegion}>
      {shown.map(([code, name], i) => (
        <Fragment key={code}>
          {i === PINNED_REGION_COUNT && <DropdownMenuSeparator />}
          <DropdownMenuRadioItem value={code}>{name}</DropdownMenuRadioItem>
        </Fragment>
      ))}
    </DropdownMenuRadioGroup>
  );
}
