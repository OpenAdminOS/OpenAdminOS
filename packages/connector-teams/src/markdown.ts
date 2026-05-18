/**
 * Minimal Markdown → Teams-compatible HTML renderer.
 *
 * Microsoft Graph's `chatMessage` endpoint accepts a small HTML subset
 * (b, i, u, s, br, p, a, code, pre, blockquote, ul, ol, li, h1–h6).
 * Native Markdown is NOT supported, so the connector renders here
 * before posting. Authored content is HTML-escaped first to keep
 * agent output from injecting arbitrary HTML.
 *
 * Supported syntax:
 *   - **bold**  __bold__
 *   - *italic*  _italic_
 *   - `inline code`
 *   - ```fenced code blocks```
 *   - [link text](https://...)
 *   - # / ## / ### headings
 *   - `- ` and `* ` bullet lists
 *   - `1. ` numbered lists
 *   - blank line → paragraph break
 *
 * Anything outside this surface is treated as plain text.
 */
export function renderMarkdownForTeams(input: string): string {
  const escaped = escapeHtml(input);
  const lines = escaped.split(/\r?\n/);

  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code block (``` ... ```)
    if (/^```/.test(line)) {
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i] ?? "")) {
        buffer.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1; // consume closing fence
      out.push(`<pre><code>${buffer.join("\n")}</code></pre>`);
      continue;
    }

    // Bullet list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        const item = (lines[i] ?? "").replace(/^\s*[-*]\s+/, "");
        items.push(`<li>${renderInline(item)}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Numbered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        const item = (lines[i] ?? "").replace(/^\s*\d+\.\s+/, "");
        items.push(`<li>${renderInline(item)}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Headings
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const content = heading[2] ?? "";
      out.push(`<h${level}>${renderInline(content)}</h${level}>`);
      i += 1;
      continue;
    }

    // Blank line — close any in-progress paragraph
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Paragraph (gather consecutive non-empty, non-list, non-heading lines)
    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^```/.test(lines[i] ?? "") &&
      !/^\s*[-*]\s+/.test(lines[i] ?? "") &&
      !/^\s*\d+\.\s+/.test(lines[i] ?? "") &&
      !/^#{1,6}\s+/.test(lines[i] ?? "")
    ) {
      paragraphLines.push(lines[i] ?? "");
      i += 1;
    }
    if (paragraphLines.length > 0) {
      out.push(`<p>${renderInline(paragraphLines.join("<br>"))}</p>`);
    }
  }

  return out.join("");
}

function renderInline(text: string): string {
  let result = text;

  // Inline code first — masks its contents from further substitution.
  const codeBlocks: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_match, body: string) => {
    const token = ` CODE${codeBlocks.length} `;
    codeBlocks.push(`<code>${body}</code>`);
    return token;
  });

  // Links [text](url) — only http(s) URLs are honored.
  result = result.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_match, label: string, href: string) =>
      `<a href="${href}">${label}</a>`,
  );

  // Bold (** or __)
  result = result.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  result = result.replace(/__([^_]+)__/g, "<b>$1</b>");

  // Italic (* or _)
  result = result.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<i>$2</i>");
  result = result.replace(/(^|[^_])_([^_\s][^_]*?)_/g, "$1<i>$2</i>");

  // Restore inline code tokens
  for (let idx = 0; idx < codeBlocks.length; idx += 1) {
    result = result.replace(` CODE${idx} `, codeBlocks[idx] ?? "");
  }

  return result;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
