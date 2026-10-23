import { DOCS_ORIGIN } from "~/lib/docs/site";

// robots.txt for docs.openadminos.com. The marketing site keeps app/robots.ts.
export const dynamic = "force-static";

export function GET() {
  return new Response(
    [
      "User-agent: *",
      "Allow: /",
      "",
      `Sitemap: ${DOCS_ORIGIN}/sitemap.xml`,
      "",
    ].join("\n"),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}
