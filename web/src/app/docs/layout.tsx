import type { ReactNode } from "react";

import { DocsShell } from "./_components/DocsShell";

// Docs under /docs: preview deployments and local development. On
// docs.openadminos.com the same pages are served from app/docs-host.
export default function DocsLayout({ children }: { children: ReactNode }) {
  return <DocsShell base="/docs">{children}</DocsShell>;
}
