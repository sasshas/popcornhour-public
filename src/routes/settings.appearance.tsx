import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import {
  ACCENTS, DEFAULT_ACCENT, DEFAULT_THEME, THEMES, getStoredAccent, getStoredGlass, getStoredTheme, setAccent,
  setGlass, setTheme, type AccentId, type ThemeId,
} from "@/lib/theme";
import { TITLE_AREAS, setShowTitles, useShowTitles, type TitleArea } from "@/hooks/use-show-titles";
import { setFullscreenMode, useFullscreenMode } from "@/hooks/use-fullscreen-mode";
import { setShowSpecials, useShowSpecials } from "@/hooks/use-season-prefs";
import { setAllCountries, useAllCountries } from "@/hooks/use-all-countries";
import { Switch } from "@/components/ui/switch";
import { SettingsSubpage } from "@/components/settings/SettingsSubpage";

export const Route = createFileRoute("/settings/appearance")({ component: AppearancePage });

/** One "titles under posters" switch for a section of the app. */
function TitleSwitch({ area, label, hint }: { area: TitleArea; label: string; hint: string }) {
  const on = useShowTitles(area);
  const id = `titles-${area}`;
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div>
        <label htmlFor={id} className="text-sm font-medium">{label}</label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={on} onCheckedChange={(v) => setShowTitles(area, v)} />
    </div>
  );
}

/** Theme, glass, titles, fullscreen, specials, streaming countries and the accent colour. Each applies straight away and is remembered on this device. */
function AppearancePage() {
  const [theme, setThemeState] = useState<ThemeId>(DEFAULT_THEME);
  const [accent, setAccentState] = useState<AccentId>(DEFAULT_ACCENT);
  const [glass, setGlassState] = useState(true);
  const fullscreen = useFullscreenMode();
  const showSpecials = useShowSpecials();
  const allCountries = useAllCountries();
  useEffect(() => {
    setThemeState(getStoredTheme());
    setAccentState(getStoredAccent());
    setGlassState(getStoredGlass());
  }, []);

  return (
    <SettingsSubpage title="Appearance" hint="Saved on this device, so your phone and computer can differ.">
      <p className="text-sm font-medium">Theme</p>
      <div role="radiogroup" aria-label="Theme" className="mt-2 grid grid-cols-2 gap-3">
        {THEMES.map((t) => {
          const selected = t.id === theme;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                setTheme(t.id);
                setThemeState(t.id);
              }}
              className={[
                "flex flex-col gap-2 rounded-xl border-2 p-2 text-left transition",
                selected ? "border-primary" : "border-border hover:border-foreground/40",
              ].join(" ")}
            >
              {/* A tiny picture of the theme: its page colour with a card and a pill on it */}
              <span
                aria-hidden
                className="relative block h-14 w-full overflow-hidden rounded-lg ring-1 ring-white/10"
                style={{ backgroundColor: t.swatch }}
              >
                <span
                  className="absolute left-2 right-2 top-2 h-5 rounded-md"
                  style={{ backgroundColor: t.id === "dark" ? "#2e2e30" : "#17181c" }}
                />
                <span
                  className="absolute bottom-2 left-2 h-3.5 w-12 rounded-full border"
                  style={{ borderColor: t.id === "dark" ? "rgb(255 255 255 / 0.3)" : "rgb(255 255 255 / 0.12)" }}
                />
                {selected && (
                  <span className="absolute right-1.5 bottom-1.5 grid size-5 place-items-center rounded-full bg-primary">
                    <Check className="size-3.5 text-primary-foreground" strokeWidth={3} />
                  </span>
                )}
              </span>
              <span className="px-1 pb-0.5">
                <span className="block text-sm font-medium">{t.name}</span>
                <span className="block text-xs text-muted-foreground">{t.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-5 flex items-center justify-between gap-4">
        <div>
          <label htmlFor="liquid-glass" className="text-sm font-medium">Liquid glass</label>
          <p className="text-xs text-muted-foreground">Frosted, see-through panels over a soft glow of your colour.</p>
        </div>
        <Switch
          id="liquid-glass"
          checked={glass}
          onCheckedChange={(on) => {
            setGlass(on);
            setGlassState(on);
          }}
        />
      </div>

      <p className="mt-5 text-sm font-medium">Titles under posters</p>
      <p className="text-xs text-muted-foreground">
        Turn a section off for a cleaner look: just the posters (the year or streaming service stays under each).
      </p>
      <div className="mt-2 divide-y divide-border/60 rounded-xl border border-border/60 px-4">
        {TITLE_AREAS.map((a) => <TitleSwitch key={a.id} area={a.id} label={a.label} hint={a.hint} />)}
      </div>

      <div className="mt-4 flex items-center justify-between gap-4">
        <div>
          <label htmlFor="fullscreen-mode" className="text-sm font-medium">Fullscreen browser</label>
          <p className="text-xs text-muted-foreground">
            Turn on if your phone browser hides its own toolbar. The calendar then folds its bar away when you tap
            Today or This week, and stops the date below the Android status bar. Off keeps the bar showing, with the
            date just under it.
          </p>
        </div>
        <Switch id="fullscreen-mode" checked={fullscreen} onCheckedChange={setFullscreenMode} />
      </div>

      <div className="mt-4 flex items-center justify-between gap-4">
        <div>
          <label htmlFor="show-specials" className="text-sm font-medium">Specials on show pages</label>
          <p className="text-xs text-muted-foreground">
            A show's extras (shorts, behind the scenes, holiday episodes), listed after its seasons.
          </p>
        </div>
        <Switch id="show-specials" checked={showSpecials} onCheckedChange={setShowSpecials} />
      </div>

      <div className="mt-4 flex items-center justify-between gap-4">
        <div>
          <label htmlFor="all-countries" className="text-sm font-medium">All streaming countries</label>
          <p className="text-xs text-muted-foreground">
            The streaming country menus (Where to watch, Filter in the Library and lists, and the Calendar) list
            Australia, United States, United Kingdom and Canada. Turn on to list every country as well.
          </p>
        </div>
        <Switch id="all-countries" checked={allCountries} onCheckedChange={setAllCountries} />
      </div>

      <p className="mt-5 text-sm font-medium">Accent colour</p>
      <div role="radiogroup" aria-label="Accent colour" className="mt-4 flex flex-wrap gap-3">
        {ACCENTS.map((a) => {
          const selected = a.id === accent;
          return (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={a.name}
              title={a.name}
              onClick={() => {
                setAccent(a.id);
                setAccentState(a.id);
              }}
              className={[
                "size-11 rounded-full grid place-items-center border-2 transition",
                selected ? "border-foreground scale-105" : "border-transparent hover:border-foreground/40",
              ].join(" ")}
              style={{ backgroundColor: `oklch(0.70 0.16 ${a.hue})` }}
            >
              {selected && <Check className="size-5 text-black/80" strokeWidth={3} />}
            </button>
          );
        })}
      </div>
    </SettingsSubpage>
  );
}
