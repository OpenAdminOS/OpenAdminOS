import type { ReactNode } from "react";

import { DocsShell } from "../docs/_components/DocsShell";

// Docs at the root of docs.openadminos.com. next.config.js rewrites requests
// for that host to this route tree, so links here carry no /docs prefix.
export default function DocsHostLayout({ children }: { children: ReactNode }) {
  return <DocsShell base="">{children}</DocsShell>;
}
