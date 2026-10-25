import {
  DOCS_NAV,
  DOCS_ROUTES,
  docsMarkdownUrl,
  getDocsPage,
} from "~/lib/docs/site";

// Index of the docs for language-model tools, in the llms.txt format GitBook
// served at docs.openadminos.com/llms.txt.
export const dynamic = "force-static";

export function GET() {
  const lines = ["# OpenAdminOS docs", ""];
  for (const section of DOCS_NAV) {
    lines.push(`## ${section.title}`, "");
    for (const route of DOCS_ROUTES) {
      const page = getDocsPage(route, "");
      if (!page || page.section.slug !== section.slug) continue;
      const description = page.description ? `: ${page.description}` : "";
      lines.push(`- [${page.title}](${docsMarkdownUrl(page)})${description}`);
    }
    lines.push("");
  }
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
