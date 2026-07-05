import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "package.json");
const pkgVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version as string;

// No Vite plugins here: esbuild already transforms TSX for jsdom tests, and
// @vitejs/plugin-react/@tailwindcss/vite would bind vitest to a second vite
// instance whose plugin types clash under the npm hoisted layout.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/test/setup.ts"],
  },
});
