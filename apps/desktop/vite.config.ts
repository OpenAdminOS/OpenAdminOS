import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Single source of truth for the version shown in the UI — pulled from
// the desktop package.json at build time so prepare-release.mjs is the
// only place we ever need to bump it. Without this, sidebar / status
// strip / Settings / Onboarding can drift like they did at v0.1.5.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "package.json");
const pkgVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version as string;

export default defineConfig({
  // Emit relative asset URLs so the production build loads correctly
  // when Electron serves dist/index.html over the file:// protocol.
  // The default ("/") resolves <script src="/assets/foo.js"> to the
  // filesystem root, so nothing loads from inside the packaged .app
  // and the window stays blank.
  base: "./",
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
