import type { McpServerAuth } from "@openadminos/agent-sdk";

import type { BuiltinReference } from "./host.js";
import { SPLASHTOP_KB_URL, SPLASHTOP_KNOWLEDGE_BASE } from "../splashtop/knowledge-base.js";

/**
 * Remote MCP servers the Marketplace offers. The list lives in code until
 * a public catalog file exists. Every entry is public, read-only, needs no
 * sign-in and never touches the tenant. Entries whose server lists tools
 * OpenAdminOS does not need carry a tool allowlist. Tool schemas are not stored here:
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
   * Link keys read on the records that enclose a matched record. A matched
   * record without a link of its own takes the nearest enclosing one, so
   * entries nested in a cited page (the CVEs of a KEV answer) keep its URL.
   */
  inheritUrl?: readonly string[];
  /**
   * For servers that answer one record per call: the result becomes one
   * source titled by the tool and its params, unless one of the count keys
   * is zero, which means nothing was found.
   */
  whole?: { url: readonly string[]; emptyWhenZero?: readonly string[] };
}

/**
 * The form of one tool's item IDs. Only a value of this form is sent, as
 * its canonical text, and only when the same ID is a token of the admin's
 * question or an earlier result of the same server in this answer gave it.
 */
export interface McpItemIdForm {
  /**
   * "number": ASCII digits only. "slug": ASCII digits, or lowercase ASCII
   * letters and digits in words joined by single hyphens, as older Azure
   * update IDs are ("2021regions", "3-years-reserved-capacity-now-available").
   */
  kind: "number" | "slug";
  /**
   * A prefix that may stand before a number, matched in any case, for
   * example "KB". "KB5034441", "kb5034441" and "5034441" name the same item.
   */
  prefix?: string;
  /** The server takes the ID with its prefix, in upper case ("KB5034441"). Otherwise the number alone is sent. */
  sendPrefix?: true;
}

/**
 * Where one tool's params name a specific item, and the form of its IDs.
 * Such a value is sent only when it appears in the admin's current
 * question or in an earlier result of the same server in this answer, as
 * links are.
 */
export interface McpItemIdRule {
  /** Params that take one item ID, such as a roadmap ID or a KB number. */
  params?: readonly string[];
  /**
   * A param that takes an OData filter, and the fields in it that name one
   * item. The filter is read before sending (see mcp-filter.ts): every value
   * compared with one of these fields must pass the same item-ID rule, and
   * a filter that cannot be read is refused. `literal` is how the server
   * compares the field: as a number (`id eq 109560`) or as text
   * (`id eq '466774'`).
   */
  filter?: { param: string; fields: readonly string[]; literal: "number" | "string" };
  form: McpItemIdForm;
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
  /**
   * The host also serves sites other than this server, as www.microsoft.com
   * does, so naming the host does not name the server. The server URL with
   * its path, the name and the aliases still do.
   */
  sharedHost?: true;
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
  /** Per tool, the params that name one specific item and the form of its IDs; see `McpItemIdRule`. */
  itemIds?: Readonly<Record<string, McpItemIdRule>>;
  /**
   * Our own note per tool on how to fill its params, for the query writer.
   * Oversized schemas lose their descriptions, and some params take a
   * syntax or slug the writer cannot guess.
   */
  queryHints?: Readonly<Record<string, string>>;
  /** How results are read into sources. Without it, items with a title or name and a link are read. */
  results?: McpResultFormat;
  /** Who runs the server, in one plain sentence, for the install review. Without it, the publisher is named. */
  operator?: string;
  /** The operator's terms or privacy page, where one exists. */
  policy?: { label: string; url: string };
  /** Further plain statements for the install review, for example that results are community text. */
  notes?: readonly string[];
  /**
   * Built into OpenAdminOS: it calls the public API at `url`'s host from
   * this device instead of connecting to an MCP server.
   */
  builtin?: BuiltinReference;
  /** Results are community text; Chat tells the model so with each result. */
  communityText?: true;
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
  {
    id: "release-communications",
    name: "Microsoft Release Communications",
    publisher: "Microsoft",
    url: "https://www.microsoft.com/releasecommunications/mcp",
    description:
      "Microsoft 365 roadmap items and Azure updates, including retirements, from Microsoft Release Communications. Chat can cite what is rolling out, in preview or retiring, with each item's ID and dates.",
    pitch: "Microsoft 365 roadmap and Azure updates, with release and retirement dates.",
    useFor: "What is new, rolling out, in preview or retiring in Microsoft 365 and Azure: roadmap items and Azure updates with their IDs, status and dates. Not for how a feature works.",
    aliases: ["release communications", "microsoft 365 roadmap", "m365 roadmap"],
    sharedHost: true,
    topics: ["roadmap", "retirement", "retirements", "retiring", "what's new", "rollout", "rolling out", "azure update", "azure updates"],
    auth: "none",
    readOnly: true,
    tools: ["get_recent_m365_roadmaps", "get_m365_roadmap_by_id", "get_recent_azure_updates", "get_azure_update_by_id"],
    // Roadmap IDs are numbers. Azure update IDs are numbers in text, and older ones are slugs ("2021regions"); live check 2026-11-05.
    // The list filters compare id as a number for roadmaps and as text for Azure updates; baseId also names one item.
    itemIds: {
      get_m365_roadmap_by_id: { params: ["id"], form: { kind: "number" } },
      get_azure_update_by_id: { params: ["id"], form: { kind: "slug" } },
      get_recent_m365_roadmaps: { filter: { param: "filter", fields: ["id", "baseId"], literal: "number" }, form: { kind: "number" } },
      get_recent_azure_updates: { filter: { param: "filter", fields: ["id", "baseId"], literal: "string" }, form: { kind: "slug" } },
    },
    queryHints: {
      get_recent_m365_roadmaps: "Put a few title words in search, for example Intune or Microsoft Teams. filter takes only an OData expression such as products/any(p: p eq 'Microsoft Intune') or status eq 'Rolling out'; leave it out otherwise. To read past the records an earlier call listed, set skip to its offset plus the records it listed.",
      get_recent_azure_updates: "Put a few title words in search, for example Retirement or Azure Monitor. filter takes only an OData expression such as tags/any(t: t eq 'Retirements'); leave it out otherwise. To read past the records an earlier call listed, set skip to its offset plus the records it listed.",
    },
    results: {
      items: [{
        title: [["title"]],
        text: ["description"],
        facts: ["id", "status", "products", "platforms", "releaseRings", "cloudInstances", "tags", "availabilities", "generalAvailabilityDate", "previewAvailabilityDate", "modified"],
        id: ["id"],
      }],
    },
    operator: "Microsoft runs this server at www.microsoft.com.",
    policy: { label: "Microsoft API Terms of Use", url: "https://learn.microsoft.com/en-us/legal/microsoft-apis/terms-of-use" },
  },
  {
    id: "windowsforum",
    name: "WindowsForum",
    publisher: "WindowsForum.com",
    url: "https://mcp.windowsforum.com/",
    description:
      "Knowledge Base articles for Windows 10, Windows 11 and Windows Server updates, looked up through the WindowsForum.com community server. Chat can find a KB article by topic, build or number and read its known issues. WindowsForum.com is independent and not affiliated with Microsoft.",
    pitch: "Windows update KB articles and known issues, by topic, build or KB number.",
    useFor: "Windows 10, Windows 11 and Windows Server update KB articles: release dates, OS builds, known issues and workarounds. Not for Intune or Entra documentation.",
    // The server runs at mcp.windowsforum.com; the site's own domain names it too.
    aliases: ["windowsforum", "windows forum", "windowsforum.com"],
    topics: ["kb", "cumulative update", "cumulative updates", "known issue", "known issues", "patch", "patches", "patch tuesday", "update history", "os build"],
    auth: "none",
    readOnly: true,
    // The server lists 29 tools, among them forum search and member lookups. Only the two KB tools are used.
    tools: ["search_kb", "get_kb_article"],
    itemIds: { get_kb_article: { params: ["kb_id"], form: { kind: "number", prefix: "KB", sendPrefix: true } } },
    queryHints: { get_kb_article: "kb_id takes one KB number, for example KB5058919." },
    results: {
      items: [{ title: [["title"]], url: ["url"], text: ["content", "summary"], facts: ["kb_id", "release_date", "applies_to"], id: ["kb_id"] }],
    },
    operator: "Fara Technologies LLC runs WindowsForum.com, an independent community, as the server itself states. It is not affiliated with Microsoft.",
    policy: { label: "WindowsForum.com privacy policy", url: "https://windowsforum.com/help/privacy-policy/" },
    notes: ["Results come through a community server and are community text. Treat them as third-party reference that can be wrong or out of date."],
    communityText: true,
  },
  {
    id: "splashtop-docs",
    name: "Splashtop API Reference",
    publisher: "Splashtop",
    url: "https://docs.splashtop.com/mcp",
    description:
      "The Splashtop Open API reference: endpoints, parameters, authentication and regions for Splashtop Enterprise. Chat can look up which endpoint lists computers, sessions or logs and how to call it. Read-only reference; it never calls the Splashtop API for you.",
    pitch: "Splashtop Open API reference: endpoints, parameters and how to call them.",
    useFor: "Splashtop Open API questions: which endpoint to use, its parameters, authentication and regional base URLs. Not for how to set up, use or troubleshoot Splashtop products (that is Splashtop Docs), not for Microsoft 365.",
    aliases: ["splashtop api", "splashtop api reference", "splashtop open api"],
    topics: ["splashtop", "remote access", "remote support", "splashtop api", "open api"],
    auth: "none",
    readOnly: true,
    // The server also lists execute-request, which sends any request to the Splashtop API
    // through the server operator. Only the four reference tools are used.
    tools: ["search-endpoints", "list-endpoints", "get-endpoint", "get-server-variables"],
    queryHints: {
      "search-endpoints": "pattern takes a short keyword such as computers, sessions or logs.",
      "get-endpoint": "path is an API path from search-endpoints, method is GET, POST, PUT or DELETE.",
    },
    operator: "ReadMe hosts this server for Splashtop and generates it from Splashtop's API documentation.",
    policy: { label: "Splashtop API documentation", url: "https://docs.splashtop.com/docs/getting-started" },
  },
  {
    id: "splashtop-kb",
    name: "Splashtop Docs",
    publisher: "Splashtop",
    url: SPLASHTOP_KB_URL,
    description:
      "Splashtop's documentation at support-splashtopbusiness.splashtop.com: setup, how-to and troubleshooting articles for Splashtop Business, Enterprise, SOS and Remote Support. Built into OpenAdminOS: Chat searches the Help Center directly from this device, with no MCP server in between and no sign-in.",
    pitch: "Splashtop documentation: setup, how-tos and troubleshooting, from support-splashtopbusiness.splashtop.com.",
    useFor: "How to set up, use or troubleshoot Splashtop products: Streamer deployment, connection errors, SOS, file transfer, remote reboot. Not for the Splashtop API reference, not for Microsoft 365.",
    aliases: ["splashtop", "splashtop docs", "splashtop documentation", "splashtop knowledge base", "splashtop help center", "splashtop support"],
    topics: ["splashtop", "streamer", "splashtop sos", "remote access", "remote support", "remote reboot"],
    auth: "none",
    readOnly: true,
    tools: ["search_articles", "get_article"],
    itemIds: { get_article: { params: ["id"], form: { kind: "number" } } },
    queryHints: {
      search_articles: "query takes a few product words such as reboot computer, streamer deployment or SOS connection, never names of people, computers or companies.",
      get_article: "id is an article id that search_articles returned in this answer.",
    },
    results: {
      items: [
        { title: [["title"]], requires: ["id"], url: ["url"], text: ["snippet", "body"], facts: ["updated_at", "locale"], id: ["id"] },
      ],
    },
    operator: "Splashtop runs its Help Center on Zendesk. OpenAdminOS calls its public article search and article API from this device.",
    policy: { label: "Splashtop privacy policy", url: "https://www.splashtop.com/legal/privacy-policy" },
    builtin: SPLASHTOP_KNOWLEDGE_BASE,
  },
  {
    id: "endoflife-ai",
    name: "endoflife.ai",
    publisher: "EndofLife AI Inc.",
    url: "https://mcp.endoflife.ai/mcp",
    description:
      "End-of-life and end-of-support dates for hundreds of software products, built on endoflife.date data, with a risk score and CISA KEV exposure. Chat can check whether a Windows, Windows Server or other product version is still supported.",
    pitch: "End-of-life and support dates for operating systems and software.",
    useFor: "When a product version reaches end of life or end of support, its lifecycle, upgrade path and CISA KEV exposure. Not for Microsoft feature documentation.",
    aliases: ["endoflife.ai", "endoflife ai"],
    topics: ["end of life", "end-of-life", "end of support", "end-of-support", "lifecycle", "life cycle", "eol", "support ends", "support end", "end of servicing"],
    auth: "none",
    readOnly: true,
    queryHints: {
      check_eol: "product takes a slug such as windows, windows-server or macos, and version a release cycle such as 2016, 10-22h2 or 11-24h2-e. When unsure of either, ask list_products or get_product_lifecycle first.",
      get_risk_score: "product takes a slug such as windows or windows-server, and version a release cycle such as 2016 or 11-24h2-e.",
      get_upgrade_path: "product takes a slug such as windows or windows-server, and version a release cycle such as 2016 or 10-22h2.",
      get_product_lifecycle: "product takes a slug only, such as windows, windows-server or macos, never with a version in it.",
      get_kev_exposure: "product takes a slug only, such as windows-server; version is optional and takes a release cycle such as 2016.",
      get_upcoming_eol: "products takes slugs such as windows and windows-server, and days a number of days ahead.",
      list_products: "query takes part of a product slug, such as windows or mac.",
    },
    // scan_stack and check_sbom take whole software inventories, which would send a list of what runs in the estate.
    tools: ["check_eol", "get_risk_score", "list_products", "get_product_lifecycle", "get_kev_exposure", "get_upcoming_eol", "get_edge_device_status", "get_upgrade_path"],
    results: {
      items: [
        {
          title: [["product_name", "product"], ["version"]],
          requires: ["eol_date"],
          url: ["score_card_url", "score_url", "source.url", "product_url"],
          facts: ["status", "is_supported", "eol_date", "days_until_eol", "days_past_eol", "support_date", "extended_support_available", "latest_release", "release_date", "score", "grade_label", "eol_date_source", "eol_date_source_url"],
        },
        { title: [["name"]], url: ["product_url"], facts: ["category", "in_cisa_kev", "successor", "lines"] },
        { title: [["cve"], ["vulnerability_name"]], facts: ["date_added", "due_date", "required_action", "known_ransomware_use"] },
      ],
      // A KEV answer cites its product page in source.url; its CVE entries carry no link of their own.
      inheritUrl: ["source.url", "product_url"],
      whole: { url: ["source.url", "product_url"], emptyWhenZero: ["match_count", "returned", "platform_count"] },
    },
    operator: "EndofLife AI Inc., an Alberta (Canada) corporation, runs endoflife.ai, as its privacy policy and terms state.",
    policy: { label: "endoflife.ai privacy policy", url: "https://endoflife.ai/privacy" },
    notes: [
      "Its privacy policy says it records the tool name and outcome of each call, and the product name when a call fails, but not the questions and answers of successful calls.",
      "Its terms cover using the data for your own IT estate. Reporting on other organisations needs a data licence from the operator.",
    ],
  },
];

export function mcpCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.id === id);
}

export function mcpHost(url: string): string {
  return new URL(url).hostname;
}
