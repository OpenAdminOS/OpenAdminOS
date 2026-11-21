import type { IntuneChatInvestigationToolName } from "@openadminos/agent-sdk";
import type { TemplateInterpolation } from "@openadminos/runtime/data-classification";
import { isMcpChatToolName } from "./tools.js";
import { isSplashtopReadTool } from "../splashtop/reads.js";

// Graph rows, cache projections and external payloads enter through their
// own ingress observers. For host-computed projections and trace copies, a
// matching scalar alone cannot prove where the host got the result.
function needsProvenance(tool: IntuneChatInvestigationToolName, path: readonly string[]): boolean {
  let first = 0;
  while (path[first] === "observation") first++;
  const [root, field, child, grandchild] = path.slice(first);
  if (root === "params") return true;
  if (root === "trace") return field === "params" || field === "cacheSource" || field === "graphSource" ||
    field === "resultSummary" || field === "error" || field === "mcpSource" &&
      child !== "serverId" && child !== "serverName" && child !== "host" && child !== "tool";
  if (root !== "result" || !field) return false;
  if (field === "error") return true;
  switch (tool) {
    case "list_cached_resources":
      return field !== "resources" || grandchild !== "resource" && grandchild !== "label";
    case "query_cache":
      return field !== "resource" && !(field === "rows" && child === "[]" && grandchild === "row") &&
        !(field === "snapshot" && (child === "resource" || child === "label"));
    case "graph_get":
      return field !== "rows" && field !== "value" && field !== "endpointSummary" && field !== "scopes";
    case "refresh_resource":
      return field !== "resource" && field !== "label";
    case "query_drift":
      return field !== "rows" || grandchild !== "resource";
    case "find_graph_endpoint":
      return field === "query" || field === "candidates" && (grandchild === "usable" || grandchild === "blockedReason");
    case "web_search":
      return false; // The result is registered at public ingress. Its trace summary is synthesized.
    default:
      if (isMcpChatToolName(tool)) return field === "matched" || field === "counts" ||
        field === "content" || field === "empty" || field === "truncated" || field === "citations";
      if (isSplashtopReadTool(tool)) return field === "page";
      return true;
  }
}

/** Walk the serialized observation after whitespace, escaping and host clipping. */
export function* traceToolObservation(
  tool: IntuneChatInvestigationToolName, body: string, offset: number,
): Generator<TemplateInterpolation | undefined, boolean> {
  const token = /\s*("[^"\\]*(?:\\.[^"\\]*)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:])/gy;
  const path: string[] = [];
  const read = () => token.exec(body)?.[1];
  function* value(part: string | undefined, depth: number): Generator<TemplateInterpolation | undefined, boolean> {
    if (!part || depth > 32) return false;
    if (part === "{" || part === "[") {
      const close = part === "{" ? "}" : "]";
      let next = read();
      while (next !== close) {
        let child: string | undefined;
        if (part === "{") {
          if (!next?.startsWith('"') || read() !== ":") return false;
          path.push(JSON.parse(next) as string);
          child = read();
        } else {
          path.push("[]");
          child = next;
        }
        if (!(yield* value(child, depth + 1))) return false;
        path.pop();
        next = read();
        if (next === close) break;
        if (next !== ",") return false;
        next = read();
      }
      yield;
      return true;
    }
    if (part === "}" || part === "]" || part === "," || part === ":") return false;
    const quoted = part.startsWith('"');
    const end = offset + token.lastIndex - Number(quoted);
    const start = end - part.length + 2 * Number(quoted);
    if (end > start && part !== "null" && needsProvenance(tool, path)) yield { start, end, key: "", incomplete: true };
    else yield;
    return true;
  }

  return (yield* value(read(), 0)) && token.lastIndex === body.length;
}
