import type { ReactNode } from "react";
import { notFound } from "next/navigation";

import { MarketingShell } from "~/app/MarketingShell";
import { adventEnabled } from "~/lib/advent/config";

export const dynamic = "force-dynamic";

export default function AdventLayout({ children }: { children: ReactNode }) {
  if (!adventEnabled()) notFound();
  return (
    <MarketingShell>
      <noscript><p className="mb-5 text-sm text-brand-muted">Advent of Admin needs JavaScript to submit answers.</p></noscript>
      {children}
    </MarketingShell>
  );
}
