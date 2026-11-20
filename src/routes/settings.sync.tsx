import { createFileRoute } from "@tanstack/react-router";
import { SyncSection } from "@/components/settings/SyncSection";
import { SettingsSubpage } from "@/components/settings/SettingsSubpage";

export const Route = createFileRoute("/settings/sync")({ component: SyncPage });

function SyncPage() {
  return (
    <SettingsSubpage title="Sync" hint="Where your library comes from, and where your changes go.">
      <SyncSection />
    </SettingsSubpage>
  );
}
