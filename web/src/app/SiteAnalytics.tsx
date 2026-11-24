import Script from "next/script";

import { PLAUSIBLE_SCRIPT_URL } from "~/lib/site-analytics";

const PLAUSIBLE_INIT_SCRIPT = `window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
plausible.init()`;

export function SiteAnalytics({ nonce }: { nonce?: string }) {
  return (
    <>
      <Script id="plausible-init" strategy="afterInteractive" nonce={nonce}>
        {PLAUSIBLE_INIT_SCRIPT}
      </Script>
      <Script async src={PLAUSIBLE_SCRIPT_URL} strategy="afterInteractive" />
    </>
  );
}
