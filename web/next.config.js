/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = dirname(fileURLToPath(import.meta.url));

/*
 * docs.openadminos.com is served by this app. Requests for that host are
 * rewritten to app/docs-host, which renders the docs at the root. Everywhere
 * else (previews, local dev) the same pages render under /docs. The redirect
 * list comes from the docs mirror written by scripts/generate-gitbook-docs.mjs
 * and keeps old GitBook and file-path URLs working.
 */
const DOCS_HOST = "docs.openadminos.com";
/** @type {import("next/dist/lib/load-custom-routes").RouteHas[]} */
const docsHost = [{ type: "host", value: "docs\\.openadminos\\.com" }];
/** @type {import("next/dist/lib/load-custom-routes").RouteHas[]} */
const wwwHost = [{ type: "host", value: "www\\.openadminos\\.com" }];

/** @type {{ redirects: { source: string, destination: string }[] }} */
const docsManifest = JSON.parse(
  readFileSync(join(webRoot, "content", "docs", "manifest.json"), "utf8"),
);

function docsRedirects() {
  return docsManifest.redirects.flatMap(({ source, destination }) => [
    {
      source: `/${source}`,
      has: docsHost,
      destination: `/${destination}`,
      permanent: true,
    },
    {
      source: `/docs/${source}`,
      missing: docsHost,
      destination: destination ? `/docs/${destination}` : "/docs",
      permanent: true,
    },
  ]);
}

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
      // The docs have their own host. Temporary, so the target can change.
      {
        source: "/docs/:path*",
        has: wwwHost,
        destination: `https://${DOCS_HOST}/:path*`,
        permanent: false,
      },
      ...docsRedirects(),
      // app/docs-host is only meant to be reached through the host rewrite,
      // and /docs is only the preview prefix. File paths such as the search
      // index under /docs stay reachable on the docs host.
      {
        source: "/docs-host/:path*",
        missing: docsHost,
        destination: "/docs/:path*",
        permanent: false,
      },
      {
        source: "/:prefix(docs|docs-host)/:path([^.]*)",
        has: docsHost,
        destination: "/:path",
        permanent: false,
      },
      {
        source: "/:prefix(docs|docs-host)",
        has: docsHost,
        destination: "/",
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        // Page paths on the docs host. Paths with a file extension (assets,
        // sitemap.xml, page.md) and Next internals pass through.
        {
          source:
            "/:path((?!_next/|_vercel/|docs/|docs-host/|docs$|docs-host$)[^.]+)",
          has: docsHost,
          destination: "/docs-host/:path",
        },
        { source: "/", has: docsHost, destination: "/docs-host" },
        {
          source: "/:path(.+)\\.md",
          has: docsHost,
          destination: "/docs/raw/:path",
        },
        {
          source: "/sitemap.xml",
          has: docsHost,
          destination: "/docs/sitemap.xml",
        },
        {
          source: "/robots.txt",
          has: docsHost,
          destination: "/docs/robots.txt",
        },
        { source: "/llms.txt", has: docsHost, destination: "/docs/llms.txt" },
        // Markdown export under /docs for previews and local dev.
        {
          source: "/docs/:path(.+)\\.md",
          missing: docsHost,
          destination: "/docs/raw/:path",
        },
      ],
    };
  },
  turbopack: {
    root: webRoot,
  },
};

export default config;
