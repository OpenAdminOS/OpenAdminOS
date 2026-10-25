import { buildSearchIndex } from "~/lib/docs/site";

// Static search index for the docs search dialog. Built once per deploy;
// search runs in the reader's browser.
export const dynamic = "force-static";

export function GET() {
  return Response.json(buildSearchIndex());
}
