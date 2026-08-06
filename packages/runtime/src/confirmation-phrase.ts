const TEMPLATE_EXPRESSION = /\{\{[\s\S]*?\}\}/g;

/**
 * Typed confirmation phrases are a last-line destructive-action safeguard.
 * Keep them explicit, count-bound, and difficult to approve accidentally.
 */
export function confirmationPhraseProblem(
  value: unknown,
  options: { template?: boolean } = {},
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "must be a non-empty string";
  }

  const normalized = (options.template
    ? value.replace(TEMPLATE_EXPRESSION, "1")
    : value
  ).trim();
  if (!/^[A-Z][A-Z0-9 -]*$/.test(normalized)) {
    return "must use uppercase words, digits, spaces, and hyphens only";
  }
  if (normalized.length < 12 || normalized.split(/\s+/).length < 3) {
    return "must contain an explicit operation, count, and target noun";
  }
  if (!/\d/.test(normalized)) {
    return "must include the number of affected objects";
  }
  return undefined;
}
