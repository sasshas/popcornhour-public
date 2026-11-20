import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { nitro } from "nitro/vite";

export default defineConfig({
  // 8080 is registered as part of the Trakt redirect URI (http://localhost:8080/api/public/trakt/callback)
  // and PUBLIC_URL, so a busy port is an error, not a reason to drift to another one.
  server: { port: 8080, strictPort: true },
  plugins: [
    tsconfigPaths(),
    tailwindcss(),
    tanstackStart(),
    // `vite build` emits a standalone Node server in .output/ (run: node .output/server/index.mjs).
    nitro({ preset: "node-server" }),
    viteReact(),
  ],
});
