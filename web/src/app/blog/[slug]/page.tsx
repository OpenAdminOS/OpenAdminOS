import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { MarketingShell } from "../../MarketingShell";
import {
  JsonLd,
  SITE_NAME,
  absoluteUrl,
  breadcrumbSchema,
  organizationSchema,
  pageMetadata,
  softwareApplicationSchema,
  webPageSchema,
  websiteSchema,
} from "../../seo";
import {
  BLOG_POSTS,
  type MarkdownBlock,
  blogPostPath,
  blogPostingSchema,
  getBlogPost,
} from "../posts";

interface BlogPostPageProps {
  params: Promise<{
    slug: string;
  }>;
}

export function generateStaticParams() {
  return BLOG_POSTS.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: BlogPostPageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = getBlogPost(slug);
  if (!post) return {};

  const metadata = pageMetadata({
    title: post.seoTitle,
    description: post.description,
    path: blogPostPath(post),
  });

  return {
    ...metadata,
    openGraph: {
      title: post.title,
      description: post.description,
      url: absoluteUrl(blogPostPath(post)),
      siteName: SITE_NAME,
      type: "article",
      publishedTime: post.publishedAt,
      modifiedTime: post.updatedAt,
      authors: [post.authorName],
      tags: post.keywords,
      images: [
        {
          url: absoluteUrl(post.imagePath),
          width: 1200,
          height: 630,
          alt: post.imageAlt,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.description,
      images: [absoluteUrl(post.imagePath)],
    },
  };
}

export default async function BlogPostPage({ params }: BlogPostPageProps) {
  const { slug } = await params;
  const post = getBlogPost(slug);
  if (!post) notFound();

  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      websiteSchema(),
      softwareApplicationSchema(),
      webPageSchema({
        path: blogPostPath(post),
        name: post.title,
        description: post.description,
        dateModified: post.updatedAt,
      }),
      breadcrumbSchema([
        { name: "Home", path: "/" },
        { name: "Blog", path: "/blog" },
        { name: post.title, path: blogPostPath(post) },
      ]),
      blogPostingSchema(post),
    ],
  };

  return (
    <MarketingShell>
      <JsonLd data={structuredData} />

      <article className="mx-auto max-w-6xl">
        <Link
          href="/blog"
          className="text-sm text-white/45 underline-offset-4 transition hover:text-white/75 hover:underline"
        >
          Blog
        </Link>

        <header className="mt-8 border-b border-white/10 pb-10">
          <div className="flex flex-wrap items-center gap-2 text-xs text-white/42">
            <span className="rounded-full border border-white/10 bg-white/[0.035] px-2 py-1 font-medium text-white/62">
              {post.category}
            </span>
            <span>{post.authorName}</span>
            <span aria-hidden="true">/</span>
            <time dateTime={post.publishedAt}>{formatDate(post.publishedAt)}</time>
            <span aria-hidden="true">/</span>
            <span>{post.readingTime}</span>
          </div>
          <h1 className="mt-5 max-w-4xl text-balance text-4xl font-semibold tracking-tight text-white sm:text-6xl">
            {post.title}
          </h1>
          <p className="mt-5 max-w-3xl text-base leading-7 text-white/62 sm:text-lg">
            {post.description}
          </p>
          <img
            src={post.imagePath}
            alt={post.imageAlt}
            width="1200"
            height="630"
            className="mt-8 aspect-[1200/630] w-full rounded-lg border border-white/10 bg-white/[0.035] object-cover"
            loading="eager"
            fetchPriority="high"
          />
        </header>

        <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0">
            <section
              aria-labelledby="takeaways-heading"
              className="rounded-lg border border-sky-300/15 bg-sky-300/[0.045] p-5"
            >
              <h2
                id="takeaways-heading"
                className="text-sm font-semibold uppercase tracking-[0.18em] text-sky-200/85"
              >
                Short version
              </h2>
              <ul className="mt-4 space-y-3 text-sm leading-6 text-white/68">
                {post.takeaways.map((takeaway) => (
                  <li key={takeaway} className="flex gap-3">
                    <span
                      aria-hidden="true"
                      className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-200/80"
                    />
                    <span>{renderInline(takeaway)}</span>
                  </li>
                ))}
              </ul>
            </section>

            <div className="mt-10 space-y-8 text-white/64">
              {post.blocks.map((block, index) => renderBlock(block, index))}
            </div>

            <section className="mt-12 rounded-lg border border-white/10 bg-white/[0.035] p-5">
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-white/45">
                About the author
              </h2>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-white/62">
                {post.authorName} publishes practical notes for Microsoft 365
                and Intune administrators building local-first agent workflows
                with explicit Graph permissions, provider boundaries, and
                write-confirmation gates.
              </p>
            </section>

            <footer className="mt-12 border-t border-white/10 pt-8">
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-white/45">
                Related
              </h2>
              <div className="mt-4 flex flex-wrap gap-3">
                {post.relatedLinks.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="rounded-md border border-white/10 bg-white/[0.035] px-3 py-2 text-sm text-white/70 transition hover:border-white/20 hover:text-white"
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </footer>
          </div>

          <aside className="self-start lg:sticky lg:top-6">
            <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
              <h2 className="text-sm font-semibold tracking-tight text-white">
                In this article
              </h2>
              <nav aria-label="Article sections" className="mt-4">
                <ol className="space-y-2">
                  {post.headingLinks.map((heading) => (
                    <li key={heading.id}>
                      <a
                        href={`#${heading.id}`}
                        className="block text-sm leading-5 text-white/55 underline-offset-4 transition hover:text-white hover:underline"
                      >
                        {heading.text}
                      </a>
                    </li>
                  ))}
                </ol>
              </nav>
              <div className="mt-5 border-t border-white/10 pt-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/35">
                  Primary query
                </p>
                <p className="mt-2 font-mono text-xs leading-5 text-white/55">
                  {post.primaryKeyword}
                </p>
              </div>
            </div>
          </aside>
        </div>
      </article>
    </MarketingShell>
  );
}

function renderBlock(block: MarkdownBlock, index: number) {
  switch (block.type) {
    case "heading":
      if (block.level === 2) {
        return (
          <h2
            key={`${block.id}-${index}`}
            id={block.id}
            className="scroll-mt-24 pt-4 text-2xl font-semibold tracking-tight text-white"
          >
            {block.text}
          </h2>
        );
      }

      return (
        <h3
          key={`${block.id}-${index}`}
          id={block.id}
          className="scroll-mt-24 pt-2 text-xl font-semibold tracking-tight text-white"
        >
          {block.text}
        </h3>
      );
    case "paragraph":
      return (
        <p key={index} className="max-w-3xl text-base leading-7 text-white/64">
          {renderInline(block.text)}
        </p>
      );
    case "unordered-list":
      return (
        <ul key={index} className="max-w-3xl space-y-2 text-base leading-7 text-white/64">
          {block.items.map((item) => (
            <li key={item} className="flex gap-3">
              <span
                aria-hidden="true"
                className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-white/35"
              />
              <span>{renderInline(item)}</span>
            </li>
          ))}
        </ul>
      );
    case "ordered-list":
      return (
        <ol
          key={index}
          className="max-w-3xl list-decimal space-y-2 pl-5 text-base leading-7 text-white/64 marker:font-mono marker:text-white/35"
        >
          {block.items.map((item) => (
            <li key={item} className="pl-2">
              {renderInline(item)}
            </li>
          ))}
        </ol>
      );
    case "quote":
      return (
        <blockquote
          key={index}
          className="max-w-3xl border-l-2 border-sky-200/45 pl-4 text-base leading-7 text-white/72"
        >
          {renderInline(block.text)}
        </blockquote>
      );
    case "table":
      return (
        <div key={index} className="overflow-x-auto rounded-lg border border-white/10">
          <table className="min-w-full border-collapse text-left text-sm">
            <thead className="bg-white/[0.055] text-white">
              <tr>
                {block.headers.map((header) => (
                  <th
                    key={header}
                    scope="col"
                    className="border-b border-white/10 px-4 py-3 font-semibold"
                  >
                    {renderInline(header)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {block.rows.map((row, rowIndex) => (
                <tr key={`${row.join("-")}-${rowIndex}`} className="align-top">
                  {row.map((cell, cellIndex) => (
                    <td key={`${cell}-${cellIndex}`} className="px-4 py-3 leading-6 text-white/62">
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function renderInline(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`)/g);

  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={`${part}-${index}`}
          className="rounded border border-white/10 bg-black/25 px-1 py-0.5 font-mono text-[0.9em] text-white/76"
        >
          {part.slice(1, -1)}
        </code>
      );
    }

    return part;
  });
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}
