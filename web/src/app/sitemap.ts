import type { MetadataRoute } from "next";

import { SITE_URL } from "./seo";

const ROUTES = [
  ["/", "2026-06-04"],
  ["/download", "2026-06-04"],
  ["/registry", "2026-06-02"],
  ["/trust-model", "2026-06-02"],
  ["/use-cases/intune", "2026-06-02"],
  ["/llm-providers", "2026-06-02"],
  ["/privacy", "2026-06-04"],
  ["/terms", "2026-06-04"],
  ["/legal-notice", "2026-06-04"],
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map(([path, lastModified]) => ({
    url: new URL(path, SITE_URL).toString(),
    lastModified: new Date(lastModified),
  }));
}
