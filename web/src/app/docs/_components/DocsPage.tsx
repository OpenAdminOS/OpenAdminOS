import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  DOCS_REPO_URL,
  DOCS_ROUTES,
  DOCS_SITE_NAME,
  type DocsBase,
  type DocsPage,
  docsHref,
  docsMarkdownUrl,
  docsUrl,
  getDocsPage,
  routeFromSlug,
  slugFromRoute,
} from "~/lib/docs/site";

import { Stage } from "../../home/Stage";
import {
  JsonLd,
  SOCIAL_IMAGE_PATH,
  TWITTER_IMAGE_PATH,
  absoluteUrl,
} from "../../seo";
import { DocsArticle } from "./DocsArticle";
import { DocsToc } from "./DocsToc";

export interface DocsRouteProps {
  params: Promise<{ slug?: string[] }>;
}

export function docsStaticParams() {
  return DOCS_ROUTES.map((route) => ({ slug: slugFromRoute(route) }));
}

function pageTitle(page: DocsPage) {
  return page.route ? `${page.title} - ${DOCS_SITE_NAME}` : DOCS_SITE_NAME;
}

export async function docsMetadata({
  params,
}: DocsRouteProps): Promise<Metadata> {
  const { slug } = await params;
  const page = getDocsPage(routeFromSlug(slug), "");
  if (!page) {
    return {
      title: { absolute: `Page not found - ${DOCS_SITE_NAME}` },
      robots: { index: false },
    };
  }

  const url = docsUrl(page.route);
  const title = pageTitle(page);

  return {
    title: { absolute: title },
    description: page.summary,
    alternates: {
      canonical: url,
      types: { "text/markdown": docsMarkdownUrl(page) },
    },
    openGraph: {
      title,
      description: page.summary,
      url,
      siteName: DOCS_SITE_NAME,
      type: "article",
      images: [
        {
          url: absoluteUrl(SOCIAL_IMAGE_PATH),
          width: 1200,
          height: 630,
          alt: "OpenAdminOS social preview",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: page.summary,
      images: [absoluteUrl(TWITTER_IMAGE_PATH)],
    },
  };
}

function breadcrumbs(page: DocsPage, base: DocsBase) {
  const first = page.section.pages[0];
  const crumbs = [{ title: "Docs", route: "" }];
  if (first && page.route !== "")
    crumbs.push({ title: page.section.title, route: first.route });
  crumbs.push(...page.parents);
  return crumbs.map((crumb) => ({
    ...crumb,
    href: docsHref(base, crumb.route),
  }));
}

export async function DocsRoutePage({
  params,
  base,
}: DocsRouteProps & { base: DocsBase }) {
  const { slug } = await params;
  const page = getDocsPage(routeFromSlug(slug), base);
  if (!page) notFound();

  const crumbs = breadcrumbs(page, base);
  const sourceUrl = page.generated
    ? `${DOCS_REPO_URL}/blob/main/scripts/generate-gitbook-docs.mjs`
    : `${DOCS_REPO_URL}/edit/main/docs/gitbook/${page.source}`;

  return (
    <div className="px-5 pb-20 pt-8 sm:px-8 lg:px-12 lg:pt-12 xl:grid xl:grid-cols-[minmax(0,1fr)_13.5rem] xl:gap-14">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "TechArticle",
              headline: page.title,
              description: page.summary,
              url: docsUrl(page.route),
              isPartOf: {
                "@type": "WebSite",
                name: DOCS_SITE_NAME,
                url: docsUrl(""),
              },
            },
            {
              "@type": "BreadcrumbList",
              itemListElement: [
                ...crumbs,
                { title: page.title, route: page.route },
              ].map((crumb, index) => ({
                "@type": "ListItem",
                position: index + 1,
                name: crumb.title,
                item: docsUrl(crumb.route),
              })),
            },
          ],
        }}
      />
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full min-w-0 max-w-3xl focus:outline-none xl:mx-0"
      >
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-brand-faint">
            {crumbs.map((crumb, index) => (
              <li key={crumb.href} className="flex items-center gap-1.5">
                {index > 0 ? <span aria-hidden>/</span> : null}
                <Link
                  href={crumb.href}
                  className="transition-colors hover:text-brand-ink"
                >
                  {crumb.title}
                </Link>
              </li>
            ))}
          </ol>
        </nav>

        <h1 className="font-display mt-4 text-balance text-[2.3rem] leading-[1.08] sm:text-[2.75rem]">
          {page.title}
        </h1>
        {page.description ? (
          <p className="mt-4 text-pretty text-[17px] leading-7 text-brand-muted sm:text-lg sm:leading-8">
            {page.description}
          </p>
        ) : null}
        {page.route === "" ? (
          <Stage tone="sand" className="mt-8 h-24 rounded-[16px] sm:h-32" />
        ) : null}

        {page.headings.length > 0 ? (
          <details className="group mt-8 rounded-[12px] border border-brand-line xl:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-brand-ink [&::-webkit-details-marker]:hidden">
              On this page
              <svg
                aria-hidden
                viewBox="0 0 20 20"
                className="h-4 w-4 text-brand-faint transition-transform group-open:rotate-180"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5.5 8l4.5 4.5L14.5 8" />
              </svg>
            </summary>
            <ul className="space-y-px border-t border-brand-line-soft px-2 py-2">
              {page.headings.map((heading) => (
                <li key={heading.id}>
                  <a
                    href={`#${heading.id}`}
                    className={`block rounded-lg py-1.5 pr-2 text-sm text-brand-muted hover:bg-brand-hover hover:text-brand-ink ${
                      heading.depth === 3 ? "pl-6" : "pl-2"
                    }`}
                  >
                    {heading.text}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <div className="mt-8">
          <DocsArticle html={page.html} />
        </div>

        <div className="mt-14 flex flex-wrap items-center justify-between gap-3 border-t border-brand-line-soft pt-6 text-[13px] text-brand-faint">
          {page.generated ? (
            <span>
              Generated from repository metadata by{" "}
              <a href={sourceUrl} className="text-link text-brand-muted">
                generate-gitbook-docs.mjs
              </a>
              .
            </span>
          ) : (
            <a href={sourceUrl} className="text-link text-brand-muted">
              Edit this page on GitHub
            </a>
          )}
          <a
            href={docsMarkdownUrl(page)}
            className="transition-colors hover:text-brand-ink"
          >
            View as Markdown
          </a>
        </div>

        {page.prev || page.next ? (
          <nav
            aria-label="Previous and next pages"
            className="mt-6 grid gap-3 sm:grid-cols-2"
          >
            {page.prev ? (
              <Link
                href={docsHref(base, page.prev.route)}
                rel="prev"
                className="group rounded-[14px] border border-brand-line px-4 py-3.5 transition-colors hover:border-brand-line-strong hover:bg-brand-hover"
              >
                <span className="block text-xs text-brand-faint">Previous</span>
                <span className="mt-1 block text-[15px] font-medium text-brand-ink">
                  <span aria-hidden className="mr-1.5 text-brand-faint">
                    ←
                  </span>
                  {page.prev.title}
                </span>
              </Link>
            ) : (
              <span className="hidden sm:block" />
            )}
            {page.next ? (
              <Link
                href={docsHref(base, page.next.route)}
                rel="next"
                className="group rounded-[14px] border border-brand-line px-4 py-3.5 text-right transition-colors hover:border-brand-line-strong hover:bg-brand-hover"
              >
                <span className="block text-xs text-brand-faint">Next</span>
                <span className="mt-1 block text-[15px] font-medium text-brand-ink">
                  {page.next.title}
                  <span aria-hidden className="ml-1.5 text-brand-faint">
                    →
                  </span>
                </span>
              </Link>
            ) : null}
          </nav>
        ) : null}
      </main>

      <aside className="hidden xl:block">
        <div className="sticky top-28 max-h-[calc(100dvh-8rem)] overflow-y-auto">
          <DocsToc headings={page.headings} />
        </div>
      </aside>
    </div>
  );
}
