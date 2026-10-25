// URL helpers shared by server and client docs components. No Node APIs.

export const DOCS_HOST = "docs.openadminos.com";
export const DOCS_ORIGIN = `https://${DOCS_HOST}`;
export const DOCS_SITE_NAME = "OpenAdminOS docs";

/**
 * Path prefix for links. Pages reached on docs.openadminos.com live at the
 * root; everywhere else (previews, local dev) they live under /docs.
 */
export type DocsBase = "" | "/docs";

/** Built at build time by app/docs/search-index.json/route.ts. */
export const DOCS_SEARCH_INDEX_PATH = "/docs/search-index.json";

export function docsHref(base: DocsBase, route: string, hash = "") {
  const pathname = route ? `${base}/${route}` : base || "/";
  return `${pathname}${hash}`;
}

export function docsUrl(route: string) {
  return route ? `${DOCS_ORIGIN}/${route}` : `${DOCS_ORIGIN}/`;
}
