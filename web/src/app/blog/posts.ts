import fs from "node:fs";
import path from "node:path";

import { load as parseYaml } from "js-yaml";

import { SITE_URL, SOCIAL_IMAGE_PATH, absoluteUrl } from "../seo";

export interface BlogPostLink {
  href: string;
  label: string;
}

export type MarkdownBlock =
  | {
      type: "heading";
      level: 2 | 3;
      id: string;
      text: string;
    }
  | {
      type: "paragraph";
      text: string;
    }
  | {
      type: "unordered-list" | "ordered-list";
      items: string[];
    }
  | {
      type: "table";
      headers: string[];
      rows: string[][];
    }
  | {
      type: "quote";
      text: string;
    };

export interface BlogPost {
  slug: string;
  title: string;
  seoTitle: string;
  description: string;
  category: string;
  authorName: string;
  imagePath: string;
  imageAlt: string;
  publishedAt: string;
  updatedAt: string;
  readingTime: string;
  primaryKeyword: string;
  keywords: string[];
  takeaways: string[];
  headingLinks: Array<{
    id: string;
    text: string;
  }>;
  blocks: MarkdownBlock[];
  relatedLinks: BlogPostLink[];
}

interface BlogPostFrontmatter {
  status?: string;
  title?: string;
  seo_title?: string;
  slug?: string;
  description?: string;
  primary_keyword?: string;
  secondary_keywords?: string[];
}

const BLOG_CONTENT_DIR = resolveBlogContentDir();
const PUBLISHED_AT = "2026-06-05";
const UPDATED_AT = "2026-06-05";
const AUTHOR_NAME = "OpenAdminOS editorial";

const POST_ORDER = [
  "what-is-an-ai-agent-for-microsoft-365-admins",
  "powershell-vs-logic-apps-vs-ai-agents",
  "microsoft-graph-and-ai-agents",
  "why-run-microsoft-365-ai-agents-on-your-own-device",
  "how-to-build-your-own-microsoft-365-admin-agent",
] as const;

const CATEGORY_BY_SLUG: Record<string, string> = {
  "what-is-an-ai-agent-for-microsoft-365-admins": "Definitions",
  "powershell-vs-logic-apps-vs-ai-agents": "Automation",
  "microsoft-graph-and-ai-agents": "Microsoft Graph",
  "why-run-microsoft-365-ai-agents-on-your-own-device": "Trust model",
  "how-to-build-your-own-microsoft-365-admin-agent": "Builder",
};

const TAKEAWAYS_BY_SLUG: Record<string, string[]> = {
  "what-is-an-ai-agent-for-microsoft-365-admins": [
    "A Microsoft 365 admin agent is a declared workflow, not a chatbot with broad Graph access.",
    "The runtime contract matters: scopes, active tenant, model boundary, and write mode should be visible.",
    "Agents help when work needs correlation, explanation, prioritization, or a reviewed change plan.",
  ],
  "powershell-vs-logic-apps-vs-ai-agents": [
    "PowerShell is still the right tool for deterministic exports and narrow operations.",
    "Logic Apps fit event-driven cloud workflows and service integrations.",
    "AI agents fit tenant investigations that need evidence, reasoning, and reviewable plans.",
  ],
  "microsoft-graph-and-ai-agents": [
    "Microsoft Graph gives admin agents the tenant evidence that makes their output specific.",
    "Graph scopes are part of the user-facing trust contract, not internal plumbing.",
    "Read agents and write agents need different runtime gates.",
  ],
  "why-run-microsoft-365-ai-agents-on-your-own-device": [
    "Local-first execution changes the default path for tenant evidence, prompts, and run history.",
    "Hosted providers can still be useful, but the UI should label when tenant context leaves the device.",
    "Running locally does not replace Graph scope review or write confirmation.",
  ],
  "how-to-build-your-own-microsoft-365-admin-agent": [
    "Start with the admin question and tenant evidence before writing the prompt.",
    "Declare Graph scopes and read/write mode as part of the agent design.",
    "Test provider, Graph, empty-result, and write-confirmation behavior before install.",
  ],
};

const RELATED_LINKS_BY_SLUG: Record<string, BlogPostLink[]> = {
  "what-is-an-ai-agent-for-microsoft-365-admins": [
    { href: "/trust-model", label: "Trust model" },
    { href: "/registry", label: "Agent registry" },
    { href: "/llm-providers", label: "LLM providers" },
    { href: "/use-cases/intune", label: "Intune use cases" },
  ],
  "powershell-vs-logic-apps-vs-ai-agents": [
    { href: "/trust-model", label: "Trust model" },
    { href: "/blog/microsoft-graph-and-ai-agents", label: "Microsoft Graph and agents" },
    { href: "/llm-providers", label: "LLM providers" },
    { href: "/registry", label: "Agent registry" },
  ],
  "microsoft-graph-and-ai-agents": [
    { href: "/registry", label: "Agent registry" },
    { href: "/trust-model", label: "Trust model" },
    { href: "/use-cases/intune", label: "Intune use cases" },
    { href: "/llm-providers", label: "LLM providers" },
  ],
  "why-run-microsoft-365-ai-agents-on-your-own-device": [
    { href: "/llm-providers", label: "LLM providers" },
    { href: "/trust-model", label: "Trust model" },
    { href: "/registry", label: "Agent registry" },
    { href: "/download", label: "Download" },
  ],
  "how-to-build-your-own-microsoft-365-admin-agent": [
    { href: "/registry", label: "Agent registry" },
    { href: "/trust-model", label: "Trust model" },
    { href: "/blog/microsoft-graph-and-ai-agents", label: "Microsoft Graph and agents" },
    { href: "/llm-providers", label: "LLM providers" },
  ],
};

export const BLOG_POSTS: readonly BlogPost[] = loadBlogPosts();

export function getBlogPost(slug: string) {
  return BLOG_POSTS.find((post) => post.slug === slug);
}

export function blogPostPath(post: Pick<BlogPost, "slug">) {
  return `/blog/${post.slug}`;
}

export function blogPostUrl(post: Pick<BlogPost, "slug">) {
  return absoluteUrl(blogPostPath(post));
}

export function blogPostingSchema(post: BlogPost) {
  const url = blogPostUrl(post);

  return {
    "@type": "BlogPosting",
    "@id": `${url}#blogposting`,
    headline: post.title,
    description: post.description,
    url,
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": `${url}#webpage`,
    },
    datePublished: post.publishedAt,
    dateModified: post.updatedAt,
    inLanguage: "en",
    keywords: post.keywords.join(", "),
    image: [absoluteUrl(post.imagePath)],
    thumbnailUrl: absoluteUrl(post.imagePath),
    author: {
      "@type": "Organization",
      name: post.authorName,
      url: SITE_URL,
    },
    publisher: {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
    },
    isPartOf: {
      "@type": "Blog",
      "@id": `${SITE_URL}/blog#blog`,
      name: "OpenAdminOS Blog",
    },
    about: {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#software`,
    },
  };
}

function loadBlogPosts(): BlogPost[] {
  const posts = fs
    .readdirSync(BLOG_CONTENT_DIR)
    .filter((fileName) => fileName.endsWith(".md"))
    .map((fileName) => readBlogPost(path.join(BLOG_CONTENT_DIR, fileName)));

  return posts.sort((a, b) => {
    const aIndex = POST_ORDER.indexOf(a.slug as (typeof POST_ORDER)[number]);
    const bIndex = POST_ORDER.indexOf(b.slug as (typeof POST_ORDER)[number]);
    return normalizeOrderIndex(aIndex) - normalizeOrderIndex(bIndex);
  });
}

function resolveBlogContentDir() {
  const candidates = [
    path.join(process.cwd(), "content", "blog"),
    path.join(process.cwd(), "web", "content", "blog"),
  ];
  const contentDir = candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });

  if (!contentDir) {
    throw new Error(
      `Blog content directory not found. Tried: ${candidates.join(", ")}`,
    );
  }

  return contentDir;
}

function readBlogPost(filePath: string): BlogPost {
  const raw = fs.readFileSync(filePath, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match?.[1] || !match[2]) {
    throw new Error(`Blog post is missing frontmatter: ${filePath}`);
  }

  const frontmatter = parseYaml(match[1]) as BlogPostFrontmatter;
  const slug = requiredString(frontmatter.slug, "slug", filePath);
  const title = requiredString(frontmatter.title, "title", filePath);
  const seoTitle =
    typeof frontmatter.seo_title === "string" && frontmatter.seo_title.length > 0
      ? frontmatter.seo_title
      : title;
  const description = requiredString(frontmatter.description, "description", filePath);
  const primaryKeyword = requiredString(
    frontmatter.primary_keyword,
    "primary_keyword",
    filePath,
  );
  const secondaryKeywords = Array.isArray(frontmatter.secondary_keywords)
    ? frontmatter.secondary_keywords.filter((keyword): keyword is string => typeof keyword === "string")
    : [];
  const publishableMarkdown = stripInternalSections(stripFirstHeading(match[2]));
  const blocks = parseMarkdownBlocks(publishableMarkdown);
  const wordCount = countWords(publishableMarkdown);

  return {
    slug,
    title,
    seoTitle,
    description,
    category: CATEGORY_BY_SLUG[slug] ?? "Microsoft 365",
    authorName: AUTHOR_NAME,
    imagePath: `/blog/og/${slug}.png`,
    imageAlt: `${title} - OpenAdminOS blog preview`,
    publishedAt: PUBLISHED_AT,
    updatedAt: UPDATED_AT,
    readingTime: `${Math.max(4, Math.ceil(wordCount / 220))} min read`,
    primaryKeyword,
    keywords: [primaryKeyword, ...secondaryKeywords],
    takeaways: TAKEAWAYS_BY_SLUG[slug] ?? [],
    headingLinks: blocks
      .filter((block): block is Extract<MarkdownBlock, { type: "heading" }> => block.type === "heading" && block.level === 2)
      .map((block) => ({ id: block.id, text: block.text })),
    blocks,
    relatedLinks: RELATED_LINKS_BY_SLUG[slug] ?? [],
  };
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]?.trimEnd() ?? "";

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const headingMatch = line.match(/^(##|###)\s+(.+)$/);
    if (headingMatch?.[1] && headingMatch[2]) {
      const text = headingMatch[2].trim();
      blocks.push({
        type: "heading",
        level: headingMatch[1] === "##" ? 2 : 3,
        id: slugify(text),
        text,
      });
      index += 1;
      continue;
    }

    if (line.startsWith("|")) {
      const tableLines: string[] = [];
      while ((lines[index] ?? "").trim().startsWith("|")) {
        tableLines.push(lines[index] ?? "");
        index += 1;
      }
      const table = parseTable(tableLines);
      if (table) blocks.push(table);
      continue;
    }

    if (line.startsWith("- ")) {
      const items: string[] = [];
      while ((lines[index] ?? "").trim().startsWith("- ")) {
        items.push((lines[index] ?? "").trim().replace(/^- /, ""));
        index += 1;
      }
      blocks.push({ type: "unordered-list", items });
      continue;
    }

    if (/^\d+\.\s+/.test(line.trim())) {
      const items: string[] = [];
      while (/^\d+\.\s+/.test((lines[index] ?? "").trim())) {
        items.push((lines[index] ?? "").trim().replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "ordered-list", items });
      continue;
    }

    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while ((lines[index] ?? "").trim().startsWith("> ")) {
        quoteLines.push((lines[index] ?? "").trim().replace(/^> /, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: quoteLines.join(" ") });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && isParagraphLine(lines[index] ?? "")) {
      paragraphLines.push((lines[index] ?? "").trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function parseTable(lines: string[]): Extract<MarkdownBlock, { type: "table" }> | null {
  const [headerLine, separatorLine, ...rowLines] = lines;
  if (!headerLine || !separatorLine || !/^\|\s*:?-{3,}/.test(separatorLine)) return null;

  return {
    type: "table",
    headers: splitTableRow(headerLine),
    rows: rowLines.map(splitTableRow).filter((row) => row.length > 0),
  };
}

function splitTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isParagraphLine(line: string) {
  const trimmed = line.trim();
  return (
    trimmed !== "" &&
    !trimmed.startsWith("## ") &&
    !trimmed.startsWith("### ") &&
    !trimmed.startsWith("|") &&
    !trimmed.startsWith("- ") &&
    !trimmed.startsWith("> ") &&
    !/^\d+\.\s+/.test(trimmed)
  );
}

function stripFirstHeading(markdown: string) {
  return markdown.replace(/^# .+\n+/, "");
}

function stripInternalSections(markdown: string) {
  const relatedIndex = markdown.search(/^## Related reading\s*$/m);
  const linkedinIndex = markdown.search(/^## LinkedIn draft\s*$/m);
  const firstInternalIndex = [relatedIndex, linkedinIndex]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  return firstInternalIndex === undefined
    ? markdown.trim()
    : markdown.slice(0, firstInternalIndex).trim();
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function countWords(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*`|.-]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

function requiredString(value: unknown, field: string, filePath: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Blog post frontmatter field \`${field}\` is required: ${filePath}`);
  }

  return value;
}

function normalizeOrderIndex(index: number) {
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}
