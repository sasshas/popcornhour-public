import { createFileRoute } from "@tanstack/react-router";
import { BackupPanel } from "@/components/settings/BackupSection";
import { SettingsSubpage } from "@/components/settings/SettingsSubpage";

export const Route = createFileRoute("/settings/backup")({ component: BackupPage });

function BackupPage() {
  return (
    <SettingsSubpage
      title="Backup"
      hint="A copy of your whole library, saved on your server. One is also saved before every import."
    >
      <BackupPanel />
    </SettingsSubpage>
  );
}
