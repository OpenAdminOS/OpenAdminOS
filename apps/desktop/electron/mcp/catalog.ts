import type { McpServerAuth } from "@openadminos/agent-sdk";

/**
 * Remote MCP servers the Marketplace offers. The list lives in code until
 * a public catalog file exists. Every entry is public, read-only, needs no
 * sign-in and never touches the tenant. Tool schemas are not stored here:
 * the host lists them live from the server after it connects.
 */
/**
 * One kind of record in a server's results that becomes one numbered
 * source. Keys name fields of the record; a dot reaches a nested field
 * ("source.url").
 */
export interface McpResultShape {
  /** Title parts, each the first of its keys that holds text. Every part must have text for the record to match. */
  title: ReadonlyArray<readonly string[]>;
  /** Keys that must hold a value for the record to match. */
  requires?: readonly string[];
  /** Link keys; the first https link is the source's URL. */
  url?: readonly string[];
  /** Text keys; the first that holds text starts the excerpt. */
  text?: readonly string[];
  /** Short fields listed after the text as "key: value" lines. */
  facts?: readonly string[];
  /** Keys that hold the item's own ID, for the item-ID rule. */
  id?: readonly string[];
}

/**
 * How a server's results are read into sources, by their structure. A
 * record that matches a shape is not searched further. When none matches,
 * the result is empty, unless `whole` makes the whole result one source.
 */
export interface McpResultFormat {
  items: readonly McpResultShape[];
  /**
   * For servers that answer one record per call: the result becomes one
   * source titled by the tool and its params, unless one of the count keys
   * is zero, which means nothing was found.
   */
  whole?: { url: readonly string[]; emptyWhenZero?: readonly string[] };
}

export interface McpCatalogEntry {
  id: string;
  name: string;
  publisher: string;
  url: string;
  description: string;
  /** One line for cards and the spotlight. */
  pitch: string;
  /**
   * Our own line on what Chat uses this server for. The model sees it next
   * to the server's tools, so it does not depend on the server's wording.
   */
  useFor: string;
  /** Lowercase names an admin may use for the server. Naming one in a question calls it. */
  aliases: readonly string[];
  /** Lowercase words that make the server a chosen source for a docs question. */
  topics: readonly string[];
  auth: McpServerAuth;
  readOnly: true;
  /**
   * The tools OpenAdminOS uses from this server. The host still lists tools
   * live, but only these reach the Marketplace, Chat and the query writer,
   * and a call to any other is refused before anything is sent. Without a
   * list, every tool the server lists is offered.
   */
  tools?: readonly string[];
  /**
   * Params, per tool, that name one specific item, such as a roadmap ID or
   * a KB number. Such a value is sent only when it appears in the admin's
   * current question or in an earlier result of the same server in this
   * answer, as links are.
   */
  itemParams?: Readonly<Record<string, readonly string[]>>;
  /** How results are read into sources. Without it, items with a title or name and a link are read. */
  results?: McpResultFormat;
}

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: "microsoft-learn",
    name: "Microsoft Learn",
    publisher: "Microsoft",
    url: "https://learn.microsoft.com/api/mcp",
    description:
      "Searches and fetches official Microsoft documentation and code samples. Chat can cite current Learn articles for Intune, Entra and Graph behaviour.",
    pitch: "Official Microsoft documentation and code samples, cited in Chat.",
    useFor: "Current official Microsoft documentation: product behaviour, requirements, setup steps and Graph API reference.",
    aliases: ["microsoft learn", "ms learn", "learn docs"],
    topics: [],
    auth: "none",
    readOnly: true,
  },
  {
    id: "kql-search",
    name: "KQL Search",
    publisher: "KQL Search",
    url: "https://www.kqlsearch.com/mcp",
    description:
      "A reference library of community KQL queries for Sentinel, Defender and Log Analytics. Chat can find examples to start from. Returned queries are community text and are not run against your tenant.",
    pitch: "Community KQL examples to start a hunting or reporting query.",
    useFor: "Example KQL queries for Sentinel, Defender advanced hunting and Log Analytics. Not for product documentation.",
    aliases: ["kql search", "kqlsearch"],
    topics: ["kql", "kusto", "advanced hunting", "hunting query", "log analytics", "sentinel"],
    auth: "none",
    readOnly: true,
  },
  {
    id: "intuneautomation",
    name: "IntuneAutomation",
    publisher: "IntuneAutomation",
    url: "https://www.intuneautomation.com/mcp/",
    description:
      "A library of PowerShell scripts for Intune and Microsoft Graph automation, with metadata on required permissions. The server only returns script text. It never connects to your tenant or runs a script.",
    pitch: "PowerShell scripts for Intune automation, with their permissions.",
    useFor: "Ready-made PowerShell scripts for Intune and Graph automation, with the permissions each needs. Not for product documentation.",
    aliases: ["intuneautomation", "intune automation"],
    topics: ["powershell", "script", "scripts", "runbook", "automation"],
    auth: "none",
    readOnly: true,
  },
];

export function mcpCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.id === id);
}

export function mcpHost(url: string): string {
  return new URL(url).hostname;
}
