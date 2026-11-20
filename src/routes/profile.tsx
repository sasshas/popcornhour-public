import { createFileRoute, redirect } from "@tanstack/react-router";

// The Profile page was merged into Settings (display name and Sign out are in its Account section).
// This route only stays so an old bookmark or link to /profile still lands somewhere useful.
export const Route = createFileRoute("/profile")({
  beforeLoad: () => {
    throw redirect({ to: "/settings", replace: true });
  },
});
