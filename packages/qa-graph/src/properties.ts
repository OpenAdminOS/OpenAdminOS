export interface GraphProperty {
  name: string;
  type: string;
  collection: boolean;
  readOnly: boolean;
}

export function parseProperties(raw: string): GraphProperty[] {
  return raw
    .split("|")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(parseEntry);
}

function parseEntry(entry: string): GraphProperty {
  const tokens = entry.split(/\s+/);
  const name = tokens[0] ?? "";
  const readOnly = tokens.includes("Read-only");
  const collection = tokens.includes("collection");
  const typeTokens = tokens.slice(1).filter(
    (token) => token !== "Read-only" && token !== "collection",
  );
  const type = typeTokens.join(" ");
  return { name, type, collection, readOnly };
}

export function primitiveKind(type: string): string {
  const lower = type.toLowerCase();
  if (lower === "string" || lower === "edm.string") return "string";
  if (
    lower === "boolean" ||
    lower === "edm.boolean"
  ) {
    return "boolean";
  }
  if (
    lower === "int16" ||
    lower === "int32" ||
    lower === "int64" ||
    lower === "edm.int16" ||
    lower === "edm.int32" ||
    lower === "edm.int64" ||
    lower === "double" ||
    lower === "edm.double" ||
    lower === "single" ||
    lower === "edm.single" ||
    lower === "decimal" ||
    lower === "edm.decimal"
  ) {
    return "number";
  }
  if (lower === "datetimeoffset" || lower === "edm.datetimeoffset" || lower === "date") {
    return "string-date";
  }
  if (lower === "guid" || lower === "edm.guid") {
    return "string-guid";
  }
  return "complex";
}
