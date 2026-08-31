/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = dirname(fileURLToPath(import.meta.url));

/** @type {import("next").NextConfig} */
const config = {
  outputFileTracingRoot: webRoot,
  poweredByHeader: false,
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "openadminos.com" }],
        destination: "https://www.openadminos.com/:path*",
        permanent: true,
      },
    ];
  },
  turbopack: {
    root: webRoot,
  },
};

export default config;
