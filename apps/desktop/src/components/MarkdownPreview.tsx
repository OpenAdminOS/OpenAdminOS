import type { ReactNode } from "react";

/**
 * Renders a constrained subset of Markdown as React nodes — same
 * syntax surface as the Teams connector's `renderMarkdownForTeams`
 * server-side renderer, so the modal preview matches what will land
 * in the destination system.
 *
 * Why this exists rather than mounting innerHTML from the connector's
 * pre-rendered string:
 *   - Avoids any `innerHTML` injection surface for agent-authored
 *     (often LLM-generated) content. Even with the connector's
 *     `escapeHtml` step, a React tree is structurally safer.
 *   - Stays in the React rendering model — easier to style, animate,
 *     and embed inside existing components.
 *
 * Supported syntax:
 *   - `# / ## / …` headings
 *   - `- ` and `* ` bullet lists
 *   - `1. ` numbered lists
 *   - ```fenced code blocks```
 *   - Nested lists, tables, blockquotes and strikethrough
 *   - Blank-line paragraph breaks
 *   - `**bold**` / `__bold__`
 *   - `*italic*` / `_italic_`
 *   - `` `inline code` ``
 *   - `[label](https://…)` links
 *
 * Anything outside this surface is rendered as plain text.
 */
export function MarkdownPreview({
  source,
  className,
  numberedSections = true,
}: {
  source: string;
  className?: string;
  numberedSections?: boolean;
}) {
  const blocks = parseBlocks(source, numberedSections);
  return (
    <div className={className}>
      {blocks.map((block, idx) => renderBlock(block, idx))}
    </div>
  );
}

/**
 * Strip markdown markers and collapse to a single-line plain string —
 * for use in dense list rows (Activity feed, AgentDetail run list)
 * where the cell is truncated and rendering as paragraphs would break
 * the layout. Same syntax surface as `MarkdownPreview`, but the output
 * is intentionally lossy: only the visible text survives.
 */
export function stripMarkdownToPlainText(source: string): string {
  return source
    // Fenced code blocks → drop the fences, keep the content on one line.
    .replace(/```[\s\S]*?```/g, (match) =>
      match.replace(/```/g, "").replace(/\r?\n+/g, " "),
    )
    // Headings: drop the leading hashes.
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    // Bullet / numbered list markers.
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    // Inline code: keep the inner text.
    .replace(/`([^`]+)`/g, "$1")
    // Bold / italic markers.
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(?<![*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1")
    .replace(/(?<![_\w])_([^_\s][^_]*?)_(?!\w)/g, "$1")
    // Links: keep the label, drop the URL.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
    // Collapse all whitespace runs (including newlines) to a single space.
    .replace(/\s+/g, " ")
    .trim();
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "ul" | "ol"; items: { text: string; children: Block[] }[]; start?: number }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "code"; content: string };

function tableCells(line: string) { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|')); }
function tableStart(lines: string[], index: number) { const header = tableCells(lines[index] || ''), divider = tableCells(lines[index + 1] || ''); return header.length > 1 && header.length === divider.length && divider.every(cell => /^:?-{3,}:?$/.test(cell)); }

function parseBlocks(input: string, numberedSections = true, depth = 0): Block[] {
  if (depth > 16) return [{ kind: "paragraph", text: input }];
  const lines = input.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (/^```/.test(line)) {
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i] ?? "")) {
        buffer.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ kind: "code", content: buffer.join("\n") });
      continue;
    }

    if (tableStart(lines, i)) {
      const headers = tableCells(line), rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] || '').includes('|') && (lines[i] || '').trim()) rows.push(tableCells(lines[i++]!));
      blocks.push({ kind: "table", headers, rows });
      continue;
    }
    if (/^>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^> ?/, ''));
      blocks.push({ kind: "quote", blocks: parseBlocks(quote.join('\n'), numberedSections, depth + 1) });
      continue;
    }
    const reportSection = line.match(/^\s*(\d+)\.\s+(.{1,90})$/);
    if (numberedSections && reportSection && !/^\s*\d+\.\s+/.test(lines[i + 1] ?? "") &&
        ((lines[i + 1] ?? "").trim() === "" || !/^\s{2,}\S/.test(lines[i + 1] ?? ""))) {
      blocks.push({ kind: "heading", level: 3, text: `${reportSection[1]}. ${reportSection[2]}` });
      i++; continue;
    }
    const list = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (list) {
      const indent = list[1].length, ordered = /\d/.test(list[2]);
      const items: { text: string; children: Block[] }[] = [];
      while (i < lines.length) {
        const item = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]!);
        if (!item || item[1].length !== indent || /\d/.test(item[2]) !== ordered) break;
        i++;
        const children: string[] = [];
        while (i < lines.length && (lines[i]!.trim() === '' ? /^\s+\S/.test(lines[i + 1] || '') : /^\s+/.exec(lines[i]!)?.[0].length! > indent)) children.push(lines[i++]!);
        const nonblank = children.filter(child => child.trim());
        const trim = nonblank.length ? Math.min(...nonblank.map(child => /^\s*/.exec(child)![0].length)) : 0;
        items.push({ text: item[3], children: parseBlocks(children.map(child => child.slice(trim)).join('\n'), false, depth + 1) });
      }
      blocks.push({ kind: ordered ? 'ol' : 'ul', items, ...(ordered ? { start: Number.parseInt(list[2], 10) } : {}) });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]?.length ?? 1,
        text: heading[2] ?? "",
      });
      i += 1;
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^```/.test(lines[i] ?? "") &&
      !/^\s*[-*+]\s+/.test(lines[i] ?? "") &&
      !/^>/.test(lines[i] ?? "") &&
      !tableStart(lines, i) &&
      !/^\s*\d+\.\s+/.test(lines[i] ?? "") &&
      !/^#{1,6}\s+/.test(lines[i] ?? "")
    ) {
      paragraphLines.push(lines[i] ?? "");
      i += 1;
    }
    if (paragraphLines.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraphLines.join("\n") });
    }
  }
  return blocks;
}

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const headingClasses: Record<number, string> = {
        1: "mt-4 text-[15px] font-semibold first:mt-0",
        2: "mt-4 text-[14px] font-semibold first:mt-0",
        3: "mt-3.5 text-[13px] font-semibold first:mt-0",
        4: "mt-2 text-[13px] font-semibold first:mt-0",
        5: "mt-2 text-[12.5px] font-semibold uppercase tracking-wider first:mt-0",
        6: "mt-2 text-[11.5px] font-semibold uppercase tracking-wider first:mt-0",
      };
      const className = headingClasses[block.level] ?? headingClasses[6];
      const children = renderInline(block.text);
      switch (block.level) {
        case 1:
          return (
            <h1 key={index} className={className}>
              {children}
            </h1>
          );
        case 2:
          return (
            <h2 key={index} className={className}>
              {children}
            </h2>
          );
        case 3:
          return (
            <h3 key={index} className={className}>
              {children}
            </h3>
          );
        case 4:
          return (
            <h4 key={index} className={className}>
              {children}
            </h4>
          );
        case 5:
          return (
            <h5 key={index} className={className}>
              {children}
            </h5>
          );
        default:
          return (
            <h6 key={index} className={className}>
              {children}
            </h6>
          );
      }
    }
    case "paragraph":
      return (
        <p key={index} className="mt-2 whitespace-pre-wrap leading-relaxed first:mt-0">
          {renderInline(block.text)}
        </p>
      );
    case "ul":
      return (
        <ul
          key={index}
          className="mt-2 list-disc space-y-1 pl-5 first:mt-0"
        >
          {block.items.map((item, idx) => (
            <li key={idx}>{renderInline(item.text)}{item.children.map((child, childIndex) => renderBlock(child, childIndex))}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol
          key={index}
          start={block.start}
          className="mt-2 list-decimal space-y-1 pl-5 first:mt-0"
        >
          {block.items.map((item, idx) => (
            <li key={idx}>{renderInline(item.text)}{item.children.map((child, childIndex) => renderBlock(child, childIndex))}</li>
          ))}
        </ol>
      );
    case "quote":
      return <blockquote key={index} className="my-2 border-l-2 border-[var(--color-border-strong)] pl-3 text-[var(--color-text-muted)]">{block.blocks.map((child, i) => renderBlock(child, i))}</blockquote>;
    case "table":
      return <div key={index} className="my-2 max-w-full overflow-auto" role="region" aria-label="Table" tabIndex={0}><table className="w-full border-collapse text-left text-xs"><thead><tr>{block.headers.map((header, i) => <th key={i} scope="col" className="border border-[var(--color-border)] p-2 font-semibold">{renderInline(header)}</th>)}</tr></thead><tbody>{block.rows.map((row, i) => <tr key={i}>{block.headers.map((_, j) => <td key={j} className="border border-[var(--color-border)] p-2">{renderInline(row[j] || '')}</td>)}</tr>)}</tbody></table></div>;
    case "code":
      return (
        <pre
          key={index}
          className="mt-2 overflow-auto rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-2 font-mono text-[11.5px] leading-relaxed first:mt-0"
        >
          <code>{block.content}</code>
        </pre>
      );
  }
}

interface InlineToken {
  kind: "text" | "bold" | "italic" | "strike" | "code" | "link";
  text: string;
  href?: string;
  index: number;
  length: number;
}

function renderInline(input: string): ReactNode[] {
  const tokens = tokenizeInline(input);
  return tokens.map((token, index) => {
    switch (token.kind) {
      case "bold":
        return <strong key={index}>{renderInline(token.text)}</strong>;
      case "italic":
        return <em key={index}>{renderInline(token.text)}</em>;
      case "strike":
        return <del key={index}>{renderInline(token.text)}</del>;
      case "code":
        return (
          <code
            key={index}
            className="rounded bg-[var(--color-bg)] px-1 py-0.5 font-mono text-[11.5px]"
          >
            {token.text}
          </code>
        );
      case "link":
        return (
          <a
            key={index}
            href={token.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[var(--color-accent)] underline-offset-2 hover:underline"
          >
            {token.text}
          </a>
        );
      case "text":
      default:
        return <span key={index}>{token.text}</span>;
    }
  });
}

function tokenizeInline(input: string): InlineToken[] {
  const allMatches: InlineToken[] = [];
  const patterns: Array<{
    pattern: RegExp;
    build(captured: string[]): Omit<InlineToken, "index" | "length">;
  }> = [
    { pattern: /~~([^~]+)~~/g, build: c => ({ kind: "strike", text: c[0] ?? "" }) },
    {
      pattern: /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      build: (c) => ({ kind: "link", text: c[0] ?? "", href: c[1] ?? "" }),
    },
    {
      pattern: /`([^`]+)`/g,
      build: (c) => ({ kind: "code", text: c[0] ?? "" }),
    },
    {
      pattern: /\*\*([^*]+)\*\*/g,
      build: (c) => ({ kind: "bold", text: c[0] ?? "" }),
    },
    {
      pattern: /__([^_]+)__/g,
      build: (c) => ({ kind: "bold", text: c[0] ?? "" }),
    },
    {
      pattern: /(?<![*\w])\*([^*\s][^*]*?)\*(?!\w)/g,
      build: (c) => ({ kind: "italic", text: c[0] ?? "" }),
    },
    {
      pattern: /(?<![_\w])_([^_\s][^_]*?)_(?!\w)/g,
      build: (c) => ({ kind: "italic", text: c[0] ?? "" }),
    },
  ];

  for (const { pattern, build } of patterns) {
    for (const m of input.matchAll(pattern)) {
      if (m.index === undefined) continue;
      allMatches.push({
        ...build(m.slice(1)),
        index: m.index,
        length: m[0].length,
      });
    }
  }

  allMatches.sort((a, b) => a.index - b.index);
  const accepted: InlineToken[] = [];
  let nextAllowed = 0;
  for (const candidate of allMatches) {
    if (candidate.index < nextAllowed) continue;
    accepted.push(candidate);
    nextAllowed = candidate.index + candidate.length;
  }

  const tokens: InlineToken[] = [];
  let cursor = 0;
  for (const tok of accepted) {
    if (tok.index > cursor) {
      tokens.push({
        kind: "text",
        text: input.slice(cursor, tok.index),
        index: cursor,
        length: tok.index - cursor,
      });
    }
    tokens.push(tok);
    cursor = tok.index + tok.length;
  }
  if (cursor < input.length) {
    tokens.push({
      kind: "text",
      text: input.slice(cursor),
      index: cursor,
      length: input.length - cursor,
    });
  }

  return tokens;
}
