import type { Metadata } from "next";
import Link from "next/link";

import { MarketingShell } from "../MarketingShell";
import {
  JsonLd,
  SITE_URL,
  breadcrumbSchema,
  organizationSchema,
  pageMetadata,
  softwareApplicationSchema,
  webPageSchema,
  websiteSchema,
} from "../seo";
import { BLOG_POSTS, blogPostPath } from "./posts";

const TITLE = "OpenAdminOS Blog";
const DESCRIPTION =
  "Practical notes on Microsoft 365 admin agents, Intune automation, Microsoft Graph permissions, local LLM providers, and write-agent safety.";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/blog",
});

export default function BlogIndexPage() {
  const [featuredPost, ...posts] = BLOG_POSTS;
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      websiteSchema(),
      softwareApplicationSchema(),
      webPageSchema({
        path: "/blog",
        name: TITLE,
        description: DESCRIPTION,
        dateModified: "2026-06-05",
      }),
      breadcrumbSchema([
        { name: "Home", path: "/" },
        { name: "Blog", path: "/blog" },
      ]),
      {
        "@type": "Blog",
        "@id": `${SITE_URL}/blog#blog`,
        name: TITLE,
        description: DESCRIPTION,
        url: `${SITE_URL}/blog`,
        publisher: { "@id": `${SITE_URL}/#organization` },
        blogPost: BLOG_POSTS.map((post) => ({
          "@id": `${SITE_URL}${blogPostPath(post)}#blogposting`,
        })),
      },
      {
        "@type": "ItemList",
        "@id": `${SITE_URL}/blog#posts`,
        name: "OpenAdminOS blog posts",
        itemListElement: BLOG_POSTS.map((post, index) => ({
          "@type": "ListItem",
          position: index + 1,
          url: `${SITE_URL}${blogPostPath(post)}`,
          name: post.title,
          description: post.description,
          image: `${SITE_URL}${post.imagePath}`,
        })),
      },
    ],
  };

  return (
    <MarketingShell>
      <JsonLd data={structuredData} />

      <section className="grid gap-8 border-b border-white/10 pb-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="max-w-4xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
            Blog
          </p>
          <h1 className="mt-4 text-balance text-4xl font-semibold tracking-tight text-white sm:text-6xl">
            Practical notes for Microsoft 365 admins.
          </h1>
          <p className="mt-5 max-w-3xl text-base leading-7 text-white/62 sm:text-lg">
            Field-style writing on local-first agents, Microsoft Graph,
            PowerShell trade-offs, and tenant safety. Built for admins who need
            clear boundaries before automation touches a tenant.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            {["Microsoft Graph", "Intune", "Local LLMs", "Write safety"].map(
              (topic) => (
                <span
                  key={topic}
                  className="rounded-md border border-white/10 bg-white/[0.035] px-2.5 py-1.5 font-mono text-xs text-white/55"
                >
                  {topic}
                </span>
              ),
            )}
          </div>
        </div>

        <aside className="self-start rounded-lg border border-white/10 bg-white/[0.035] p-4">
          <h2 className="text-sm font-semibold tracking-tight text-white">
            Reading order
          </h2>
          <ol className="mt-4 space-y-3">
            {BLOG_POSTS.map((post, index) => (
              <li key={post.slug} className="grid grid-cols-[1.5rem_1fr] gap-3">
                <span className="font-mono text-xs text-white/35">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <Link
                  href={blogPostPath(post)}
                  className="text-sm leading-5 text-white/65 underline-offset-4 transition hover:text-white hover:underline"
                >
                  {post.title}
                </Link>
              </li>
            ))}
          </ol>
        </aside>
      </section>

      {featuredPost ? (
        <section className="mt-10">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-200/70">
            Start here
          </p>
          <article className="mt-4 grid gap-6 rounded-lg border border-sky-300/15 bg-sky-300/[0.045] p-5 lg:grid-cols-[minmax(0,1fr)_18rem] lg:p-6">
            <div>
              <PostMeta post={featuredPost} />
              <h2 className="mt-4 max-w-3xl text-balance text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                <Link
                  href={blogPostPath(featuredPost)}
                  className="underline-offset-4 transition hover:text-white/82 hover:underline"
                >
                  {featuredPost.title}
                </Link>
              </h2>
              <p className="mt-4 max-w-3xl text-sm leading-6 text-white/64 sm:text-base">
                {featuredPost.description}
              </p>
              <Link
                href={blogPostPath(featuredPost)}
                className="mt-6 inline-flex rounded-md bg-white px-3 py-2 text-sm font-semibold text-[#070709] transition hover:bg-white/90"
              >
                Read first
              </Link>
            </div>

            <div className="border-t border-white/10 pt-5 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
              <img
                src={featuredPost.imagePath}
                alt={featuredPost.imageAlt}
                width="1200"
                height="630"
                className="aspect-[1200/630] w-full rounded-lg border border-white/10 bg-black/20 object-cover"
              />
              <h3 className="mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-white/45">
                Short version
              </h3>
              <ul className="mt-4 space-y-3 text-sm leading-6 text-white/62">
                {featuredPost.takeaways.map((takeaway) => (
                  <li key={takeaway} className="flex gap-3">
                    <span
                      aria-hidden="true"
                      className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-200/80"
                    />
                    <span>{takeaway}</span>
                  </li>
                ))}
              </ul>
            </div>
          </article>
        </section>
      ) : null}

      <section className="mt-12">
        <div className="flex flex-col justify-between gap-3 border-t border-white/10 pt-10 sm:flex-row sm:items-end">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
              Guides
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
              The core series
            </h2>
          </div>
          <p className="max-w-xl text-sm leading-6 text-white/48">
            Each post is written as a decision aid: definition, trade-offs,
            concrete tenant example, and a checklist.
          </p>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {posts.map((post) => (
            <article
              key={post.slug}
              className="flex min-h-[20rem] flex-col rounded-lg border border-white/10 bg-white/[0.035] p-5 transition hover:border-white/18 hover:bg-white/[0.05]"
            >
              <img
                src={post.imagePath}
                alt={post.imageAlt}
                width="1200"
                height="630"
                className="aspect-[1200/630] w-full rounded-lg border border-white/10 bg-black/20 object-cover"
                loading="lazy"
              />
              <div className="mt-5">
                <PostMeta post={post} />
              </div>
              <h3 className="mt-4 text-balance text-2xl font-semibold tracking-tight text-white">
                <Link
                  href={blogPostPath(post)}
                  className="underline-offset-4 transition hover:text-white/82 hover:underline"
                >
                  {post.title}
                </Link>
              </h3>
              <p className="mt-3 text-sm leading-6 text-white/60">
                {post.description}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {post.keywords.slice(0, 3).map((keyword) => (
                  <span
                    key={keyword}
                    className="rounded-md border border-white/10 bg-black/20 px-2 py-1 font-mono text-[11px] text-white/42"
                  >
                    {keyword}
                  </span>
                ))}
              </div>
              <Link
                href={blogPostPath(post)}
                className="mt-auto pt-6 text-sm font-medium text-sky-200 underline-offset-4 transition hover:text-white hover:underline"
              >
                Read article
              </Link>
            </article>
          ))}
        </div>
      </section>
    </MarketingShell>
  );
}

function PostMeta({ post }: { post: (typeof BLOG_POSTS)[number] }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-white/42">
      <span className="rounded-full border border-white/10 bg-white/[0.035] px-2 py-1 font-medium text-white/62">
        {post.category}
      </span>
      <time dateTime={post.publishedAt}>{formatDate(post.publishedAt)}</time>
      <span aria-hidden="true">/</span>
      <span>{post.readingTime}</span>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}
