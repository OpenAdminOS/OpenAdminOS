import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Emit relative asset URLs so the production build loads correctly
  // when Electron serves dist/index.html over the file:// protocol.
  // The default ("/") resolves <script src="/assets/foo.js"> to the
  // filesystem root, so nothing loads from inside the packaged .app
  // and the window stays blank.
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
