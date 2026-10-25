import Link from "next/link";

import { type DocsBase, docsHref } from "~/lib/docs/paths";

import { GITHUB_URL } from "../../seo";
import { buttonPrimary, buttonSecondary } from "../../ui";

export function DocsNotFound({ base }: { base: DocsBase }) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto w-full max-w-3xl px-5 pb-24 pt-16 focus:outline-none sm:px-8 lg:px-12"
    >
      <p className="text-sm font-medium text-brand-faint">404</p>
      <h1 className="font-display mt-3 text-balance text-[2.3rem] leading-[1.08] sm:text-[2.75rem]">
        There is no docs page at this address
      </h1>
      <p className="mt-4 max-w-xl text-pretty text-lg leading-8 text-brand-muted">
        Older links redirect to their current pages. If you followed a link
        and landed here, the page was removed or the link is mistyped. Search
        the docs, or start from the overview.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href={docsHref(base, "")} className={buttonPrimary}>
          Go to the overview
        </Link>
        <a
          href={`${GITHUB_URL}/issues/new?title=${encodeURIComponent("docs: broken link")}`}
          className={buttonSecondary}
        >
          Report a broken link
        </a>
      </div>
    </main>
  );
}
