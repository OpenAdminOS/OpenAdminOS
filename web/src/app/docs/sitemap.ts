import type { MetadataRoute } from "next";

import { DOCS_ROUTES, docsUrl } from "~/lib/docs/site";

// Sitemap for docs.openadminos.com, served there at /sitemap.xml through a
// rewrite. Docs URLs live on their own host, so they get their own sitemap.
export default function sitemap(): MetadataRoute.Sitemap {
  return DOCS_ROUTES.map((route) => ({
    url: docsUrl(route),
    changeFrequency: "weekly",
    priority: route ? 0.7 : 1,
  }));
}
