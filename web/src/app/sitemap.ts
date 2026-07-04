import type { MetadataRoute } from "next";

import { BLOG_POSTS, blogPostPath } from "./blog/posts";
import { SITE_URL } from "./seo";

const ROUTES = [
  ["/", "2026-06-05"],
  ["/download", "2026-06-04"],
  ["/examples", "2026-07-04"],
  ["/registry", "2026-06-02"],
  ["/trust-model", "2026-06-02"],
  ["/use-cases/intune", "2026-06-02"],
  ["/blog", "2026-06-05"],
  ["/llm-providers", "2026-06-02"],
  ["/privacy", "2026-06-04"],
  ["/terms", "2026-06-04"],
  ["/legal-notice", "2026-06-04"],
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    ...ROUTES.map(([path, lastModified]) => ({
      url: new URL(path, SITE_URL).toString(),
      lastModified: new Date(lastModified),
    })),
    ...BLOG_POSTS.map((post) => ({
      url: new URL(blogPostPath(post), SITE_URL).toString(),
      lastModified: new Date(post.updatedAt),
    })),
  ];
}
