import { DOCS_ROUTES, findDocsPagePath, getDocsPage } from "~/lib/docs/site";

// Markdown export of each page at /<page>.md, as GitBook offered. Reached
// through a rewrite in next.config.js.
export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS_ROUTES.map((route) => getDocsPage(route, ""))
    .filter((page) => page !== undefined)
    .map((page) => ({ path: page.path.split("/") }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const nav = findDocsPagePath(path);
  const page = nav ? getDocsPage(nav.route, "") : undefined;
  if (!page) return new Response("Not found", { status: 404 });

  const intro = page.description ? `\n${page.description}\n` : "";
  return new Response(`# ${page.title}\n${intro}\n${page.markdown}`, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
