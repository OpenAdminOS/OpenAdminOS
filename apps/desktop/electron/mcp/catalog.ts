import type { McpServerAuth } from "@openadminos/agent-sdk";

/**
 * Remote MCP servers the Marketplace offers. The list lives in code until
 * a public catalog file exists. Every entry is public, read-only, needs no
 * sign-in and never touches the tenant. Tool schemas are not stored here:
 * the host lists them live from the server after it connects.
 */
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
