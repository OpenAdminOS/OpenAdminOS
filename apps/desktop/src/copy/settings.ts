export const SETTINGS_SECTIONS = [
  { id: "providers", title: "Providers", description: "Choose where answers are generated.", keywords: ["llm", "model", "ollama", "anthropic", "openai", "local", "hosted"] },
  { id: "tenants", title: "Tenants", description: "Manage Microsoft 365 connections and delegated permissions.", keywords: ["microsoft", "entra", "account", "connection", "permissions"] },
  { id: "chat", title: "Chat", description: "Configure retrieval, cache, and local learning behavior.", keywords: ["conversation", "cache", "refresh", "investigation", "learning"] },
  { id: "gateway", title: "Gateway", description: "Pair local MCP clients with one tenant.", keywords: ["mcp", "loopback", "external", "proposal", "pairing", "client"] },
  { id: "general", title: "General", description: "Configure desktop behavior, safety, and local history.", keywords: ["menu bar", "scheduler", "sandbox", "theme", "retention", "audit"] },
  { id: "privacy", title: "Privacy", description: "Review data residency, telemetry, registry, and updates.", keywords: ["data", "telemetry", "residency", "registry", "crash", "writes"] },
  { id: "about", title: "About", description: "Review version, diagnostics, and project information.", keywords: ["version", "diagnostics", "support", "github"] },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const SETTINGS_ITEMS = {
  "chat-investigation-mode": { section: "chat", title: "Chat investigation mode", description: "Choose how single-tenant Chat gathers read-only evidence.", keywords: ["agentic", "deterministic", "tools"] },
  "tenant-cache": { section: "chat", title: "Tenant cache", description: "Refresh the local Graph data used by Chat.", keywords: ["graph", "refresh", "rows"] },
  "periodic-cache-refresh": { section: "chat", title: "Periodic cache refresh", description: "Schedule local cache refreshes while signed in.", keywords: ["schedule", "interval"] },
  "local-self-training": { section: "chat", title: "Local self-training", description: "Review local agent suggestions and learning files.", keywords: ["learning", "suggestions"] },
  "menu-bar-companion": { section: "general", title: "Menu bar companion", description: "Open a compact local Chat companion.", keywords: ["tray", "launch"] },
  "experimental-sandboxed-code": { section: "general", title: "Experimental sandboxed code", description: "Control MXC for code-backed preview agents.", keywords: ["mxc", "sandbox", "experimental"] },
  "os-scheduler": { section: "general", title: "OS scheduler", description: "Run active schedules in the background.", keywords: ["background", "schedule"] },
  "default-tenant-scope": { section: "general", title: "Default tenant scope", description: "Review the tenant used for agent runs.", keywords: ["active tenant", "scope"] },
  "destructive-confirmation": { section: "general", title: "Destructive write confirmation", description: "Require a typed phrase for destructive writes.", keywords: ["typed phrase", "safety", "write"] },
  theme: { section: "general", title: "Theme", description: "Review the current appearance setting.", keywords: ["dark", "appearance"] },
  "run-history-retention": { section: "general", title: "Run history retention", description: "Control pruning of local run records.", keywords: ["history", "prune", "local"] },
  "change-history": { section: "general", title: "Change history", description: "Control pruning of local drift snapshots.", keywords: ["drift", "retention", "snapshots"] },
  "audit-log-export": { section: "general", title: "Audit log export", description: "Export retained audit records.", keywords: ["json", "csv", "events"] },
  "tenant-telemetry": { section: "privacy", title: "Tenant telemetry", description: "Review what OpenAdminOS does not collect.", keywords: ["analytics", "privacy"] },
  "registry-install-counts": { section: "privacy", title: "Registry install counts", description: "Control anonymous aggregate install counting.", keywords: ["registry", "counts", "telemetry"] },
  "agent-registry-source": { section: "privacy", title: "Agent registry source", description: "Review the public agent registry source.", keywords: ["github", "source", "agents"] },
  "crash-reporting": { section: "privacy", title: "Crash reporting", description: "Review local error-reporting behavior.", keywords: ["errors", "logs"] },
  "tenant-data-residency": { section: "privacy", title: "Tenant data residency", description: "Review where the active provider sends tenant context.", keywords: ["local", "hosted", "provider"] },
  "graph-writes": { section: "privacy", title: "Graph writes", description: "Review the confirmation boundary for Microsoft Graph changes.", keywords: ["confirmation", "write", "diff"] },
  "update-channel": { section: "privacy", title: "Update channel", description: "Review signed application update behavior.", keywords: ["stable", "release", "github"] },
} as const satisfies Record<string, { section: SettingsSectionId; title: string; description: string; keywords: readonly string[] }>;

export type SettingsItemId = keyof typeof SETTINGS_ITEMS;

export interface SettingsSearchResult {
  id: string;
  section: SettingsSectionId;
  title: string;
  description: string;
  kind: "section" | "setting";
}
export function searchSettings(query: string): SettingsSearchResult[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const entries: Array<SettingsSearchResult & { haystack: string }> = [
    ...SETTINGS_SECTIONS.map((entry) => ({
      id: `section-${entry.id}`,
      section: entry.id,
      title: entry.title,
      description: entry.description,
      kind: "section" as const,
      haystack: [entry.title, entry.description, ...entry.keywords].join(" ").toLocaleLowerCase(),
    })),
    ...Object.entries(SETTINGS_ITEMS).map(([id, entry]) => ({
      id,
      section: entry.section,
      title: entry.title,
      description: entry.description,
      kind: "setting" as const,
      haystack: [entry.title, entry.description, ...entry.keywords].join(" ").toLocaleLowerCase(),
    })),
  ];
  return entries
    .filter((entry) => terms.every((term) => entry.haystack.includes(term)))
    .map(({ haystack: _haystack, ...entry }) => entry);
}
