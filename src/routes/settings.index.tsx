import { createFileRoute, Link } from "@tanstack/react-router";
import { Bell, ChevronRight, Palette, RefreshCw, Save, User, Wrench, type LucideIcon } from "lucide-react";

export const Route = createFileRoute("/settings/")({ component: SettingsMenu });

const SECTIONS: { to: string; icon: LucideIcon; title: string; hint: string }[] = [
  { to: "/settings/account", icon: User, title: "Account", hint: "Your name in the app, and signing out" },
  { to: "/settings/appearance", icon: Palette, title: "Appearance", hint: "Liquid glass, titles under posters, colour" },
  { to: "/settings/sync", icon: RefreshCw, title: "Sync", hint: "Trakt and WeTrakr: import and send your changes" },
  { to: "/settings/notifications", icon: Bell, title: "Notifications", hint: "Tells your phone when a watchlist movie comes out" },
  { to: "/settings/backup", icon: Save, title: "Backup", hint: "Copies of your library saved on your server" },
  { to: "/settings/maintenance", icon: Wrench, title: "Library maintenance", hint: "Fix missing artwork" },
];

/** The Settings menu: one row per section, each opening its own page. */
function SettingsMenu() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-8 pt-[max(1rem,env(safe-area-inset-top))] pb-8 md:pt-8 space-y-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your account and connections.</p>
      </header>
      <nav className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border bg-surface/30">
        {SECTIONS.map((s) => (
          <Link
            key={s.to}
            to={s.to}
            className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-white/[0.04] active:bg-white/[0.07]"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
              <s.icon className="size-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{s.title}</span>
              <span className="block text-xs text-muted-foreground">{s.hint}</span>
            </span>
            <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </nav>
    </div>
  );
}
