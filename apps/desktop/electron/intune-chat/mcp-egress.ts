/**
 * Canonical text for the MCP egress check. A tenant value can hide behind
 * an encoding ("%43%6F%6E%74%6F%73%6F"), an HTML entity, a backslash
 * escape or zero-width characters inside an ID. Every check runs on the
 * decoded form, and the decoded form is what is sent, so what was checked
 * and what leaves the device are the same text.
 */

const HTML_NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const MAX_DECODE_PASSES = 8;

function codePoint(value: number): string | undefined {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : undefined;
}

/** One pass of every decoding, then NFKC and removal of invisible characters. */
function decodeOnce(text: string): string {
  return text
    .replace(/&#x([0-9a-f]{1,6});?/gi, (match, hex: string) => codePoint(Number.parseInt(hex, 16)) ?? match)
    .replace(/&#(\d{1,7});?/g, (match, digits: string) => codePoint(Number.parseInt(digits, 10)) ?? match)
    .replace(/&([a-z]+);/gi, (match, name: string) => HTML_NAMED[name.toLowerCase()] ?? match)
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (match, hex: string) => codePoint(Number.parseInt(hex, 16)) ?? match)
    .replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        // Not valid UTF-8 as a whole: decode the ASCII escapes, keep the rest for the residue check.
        return run.replace(/%([0-9a-f]{2})/gi, (match, hex: string) => {
          const value = Number.parseInt(hex, 16);
          return value < 0x80 ? String.fromCharCode(value) : match;
        });
      }
    })
    .normalize("NFKC")
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .replace(/[\t\n\r\f\v\u0085\u2028\u2029]+/g, " ");
}

/** Decodes repeatedly until the text no longer changes. */
export function canonicalEgressText(text: string): string {
  let current = text;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    const next = decodeOnce(current);
    if (next === current) return next;
    current = next;
  }
  return current;
}

const ENCODED_RESIDUE = /%[0-9a-f]{2}|\\u[0-9a-f{]|\\x[0-9a-f]{2}|&#x?[0-9a-f]+;?|&[a-z]+;/i;
const NON_PRINTABLE = /[\p{Cc}\p{Cs}\p{Co}\p{Cn}]/u;

/**
 * Why canonical text cannot be sent: it still holds an encoded sequence
 * (nested past the decode limit, or bytes that are not valid text) or a
 * character that does not print. Undefined when it is plain text.
 */
export function egressResidue(canonical: string): "encoded" | "non-printable" | undefined {
  if (ENCODED_RESIDUE.test(canonical)) return "encoded";
  if (NON_PRINTABLE.test(canonical)) return "non-printable";
  return undefined;
}
