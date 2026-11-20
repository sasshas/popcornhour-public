import { Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useCanGoBackSafe } from "@/components/layout/AppShell";

/**
 * The frame of one Settings page (Account, Appearance, Sync, ...): a "Settings" back link, the page title and a
 * short line under it, then the page's own content in the usual card.
 * Back goes back in history when there is somewhere to go (so the phone's Back gesture and this button agree),
 * otherwise (page opened directly) it opens the Settings menu.
 */
export function SettingsSubpage({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  const router = useRouter();
  const canGoBack = useCanGoBackSafe();
  const BACK = "-ml-2 inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-sm text-muted-foreground hover:text-foreground";
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-8 pt-[max(1rem,env(safe-area-inset-top))] pb-8 md:pt-8 space-y-6">
      <header>
        {canGoBack ? (
          <button type="button" onClick={() => router.history.back()} className={BACK}>
            <ArrowLeft className="size-4" /> Settings
          </button>
        ) : (
          <Link to="/settings" className={BACK}>
            <ArrowLeft className="size-4" /> Settings
          </Link>
        )}
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground mt-1">{hint}</p>
      </header>
      <section className="rounded-2xl border border-border bg-surface/30 p-6">{children}</section>
    </div>
  );
}
