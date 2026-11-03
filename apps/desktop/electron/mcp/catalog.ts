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
    pitch: "Reviewed PowerShell scripts for Intune automation, with their permissions.",
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
