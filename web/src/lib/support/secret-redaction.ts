const SECRET_REDACTION = "[redacted-secret]";
const PRIVATE_KEY_REDACTION = "[redacted-private-key]";

const SECRET_TOKEN_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z ]*PRIVATE KEY-----/gi,
    replacement: PRIVATE_KEY_REDACTION,
  },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\bgh[opsuhr]_[A-Za-z0-9_]{30,}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\bsk-ant-api\d{2}-[A-Za-z0-9_-]{20,}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\b(?:xox[abprs]|xapp)-[A-Za-z0-9-]{20,}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\bnpm_[A-Za-z0-9]{36,}\b/g, replacement: SECRET_REDACTION },
  { pattern: /\bvercel_[A-Za-z0-9]{20,}\b/g, replacement: SECRET_REDACTION },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: SECRET_REDACTION,
  },
  { pattern: /\b[0-9a-f]{64,}\b/gi, replacement: SECRET_REDACTION },
  { pattern: /\b[A-Za-z0-9+/]{48,}={0,2}/g, replacement: SECRET_REDACTION },
];

const SECRET_KEY_NAMES =
  "api[_-]?key|apikey|client[_-]?secret|clientSecret|secret|password|passwd|pwd|refresh[_-]?token|access[_-]?token|id[_-]?token|auth[_-]?token|token|private[_-]?key|connection[_-]?string|webhook[_-]?url|sas[_-]?token|shared[_-]?access[_-]?signature";

const KEYED_SECRET_PATTERN = new RegExp(
  `\\b(${SECRET_KEY_NAMES})\\b(\\s*["']?\\s*[:=]\\s*["']?)([^"'\\s,;\\]}]{8,})`,
  "gi",
);
const AUTH_HEADER_PATTERN =
  /\b(authorization\s*[:=]\s*(?:bearer|basic)\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

export function redactSupportSecrets(value: string): string {
  if (!value) return value;

  let redacted = value;
  for (const { pattern, replacement } of SECRET_TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }

  redacted = redacted.replace(
    AUTH_HEADER_PATTERN,
    (_match, prefix: string) => `${prefix}${SECRET_REDACTION}`,
  );
  redacted = redacted.replace(
    KEYED_SECRET_PATTERN,
    (_match, name: string, separator: string) => `${name}${separator}${SECRET_REDACTION}`,
  );

  return redacted;
}

export function redactSupportPublicText(value: string): string {
  return redactSupportSecrets(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      "[guid]",
    )
    .replace(/\b[A-Za-z0-9-]+\.onmicrosoft\.com\b/gi, "[tenant-domain]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\/Users\/[^\s"')\]]+/g, "[local-path]")
    .replace(/\/home\/[^\s"')\]]+/g, "[local-path]")
    .replace(/[A-Z]:\\Users\\[^\s"')\]]+/gi, "[local-path]")
    .replace(/\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g, "[domain]");
}
