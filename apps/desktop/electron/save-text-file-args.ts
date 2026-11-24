import type { SaveTextFileArgs } from "@openadminos/agent-sdk";

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

export function requireBoundedString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} must not be empty.`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${name} is too long.`);
  }
  return trimmed;
}

export function validateSaveTextFileArgs(value: unknown): SaveTextFileArgs {
  if (!isPlainRecord(value)) {
    throw new Error("saveTextFile args must be an object.");
  }
  const suggestedName = requireBoundedString(value.suggestedName, "suggestedName", 160);
  // CSV quoting and formula escaping fit within twice the chat table's 4 MiB JSON budget.
  const maxContent = /\.csv$/i.test(suggestedName) ? 8 * 1024 * 1024 : 2_000_000;
  if (typeof value.content === "string" && value.content.length > maxContent) {
    throw new Error(`File content exceeds the ${maxContent.toLocaleString()} character export limit.`);
  }
  const content = requireBoundedString(value.content, "content", maxContent);
  const args: SaveTextFileArgs = { suggestedName, content };
  if (value.filters !== undefined) {
    if (!Array.isArray(value.filters) || value.filters.length > 10) {
      throw new Error("saveTextFile filters must be an array with at most 10 entries.");
    }
    args.filters = value.filters.map((filter, index) => {
      if (!isPlainRecord(filter)) {
        throw new Error(`saveTextFile filters[${index}] must be an object.`);
      }
      if (!Array.isArray(filter.extensions) || filter.extensions.length === 0 || filter.extensions.length > 20) {
        throw new Error(`saveTextFile filters[${index}].extensions is invalid.`);
      }
      return {
        name: requireBoundedString(filter.name, `saveTextFile filters[${index}].name`, 80),
        extensions: filter.extensions.map((extension, extensionIndex) => {
          const value = requireBoundedString(
            extension,
            `saveTextFile filters[${index}].extensions[${extensionIndex}]`,
            24,
          );
          if (!/^[a-z0-9]+$/i.test(value)) {
            throw new Error("saveTextFile filter extensions must be alphanumeric.");
          }
          return value;
        }),
      };
    });
  }
  return args;
}
