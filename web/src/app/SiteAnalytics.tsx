"use client";

import { useSelectedLayoutSegment } from "next/navigation";
import Script from "next/script";

const PLAUSIBLE_SCRIPT_URL =
  "https://plausible.io/js/pa-XFfGfDtFtmyoJlLIYR5dv.js";
const PLAUSIBLE_INIT_SCRIPT = `window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
plausible.init()`;

// The privacy page covers Plausible on the marketing website only, so the
// docs routes (app/docs, app/docs-host) do not load it. The segment comes
// from the route tree, so it is also correct behind the docs host rewrite.
const SEGMENTS_WITHOUT_ANALYTICS = new Set(["docs", "docs-host"]);

export function SiteAnalytics() {
  const segment = useSelectedLayoutSegment();
  if (segment && SEGMENTS_WITHOUT_ANALYTICS.has(segment)) return null;

  return (
    <>
      <Script id="plausible-init" strategy="afterInteractive">
        {PLAUSIBLE_INIT_SCRIPT}
      </Script>
      <Script async src={PLAUSIBLE_SCRIPT_URL} strategy="afterInteractive" />
    </>
  );
}
