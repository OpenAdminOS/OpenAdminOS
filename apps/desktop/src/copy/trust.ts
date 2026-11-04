import type { ProviderSummary } from "../shared/openAdminOS";

export interface TrustScope {
  tenantNames: string[];
}

export interface TrustAttachments {
  workspaceTitle?: string;
  evidenceCount?: number;
  noteCount?: number;
  includesInstructions?: boolean;
}

export interface TrustCopyInput {
  provider?: Pick<ProviderSummary, "name" | "isLocal">;
  model?: string;
  scope?: TrustScope;
  attachments?: TrustAttachments;
  /** Hosts of enabled MCP servers that receive the tool queries the model writes. */
  toolHosts?: readonly string[];
}

export interface ToolHostsCopy {
  /** Short status strip segment, for example "tool queries to learn.microsoft.com +2". */
  strip: string;
  /** Tooltip sentence naming every host. */
  detail: string;
  /** Composer line naming every host. */
  composer: string;
}

export interface DerivedTrustCopy {
  strip: string;
  boundary?: string;
  confirmTitle: string;
  confirmBody: string;
  storage: string;
  isLocal: boolean;
  toolHosts?: ToolHostsCopy;
}

function listHosts(hosts: readonly string[]): string {
  if (hosts.length <= 2) return hosts.join(" and ");
  return `${hosts.slice(0, -1).join(", ")} and ${hosts.at(-1)}`;
}

/**
 * Names the third-party hosts that receive MCP tool queries. Shown with
 * local providers too: the queries leave the device even when the model
 * does not.
 */
export function deriveToolHostsCopy(hosts: readonly string[] | undefined): ToolHostsCopy | undefined {
  const unique = [...new Set(hosts ?? [])].filter(Boolean);
  if (unique.length === 0) return undefined;
  return {
    strip: `tool queries to ${unique[0]}${unique.length > 1 ? ` +${unique.length - 1}` : ""}`,
    detail: `MCP tool queries the model writes go to ${listHosts(unique)}. The model is told to send only public questions, never tenant names, IDs or tenant data.`,
    composer: `MCP tool queries go to ${listHosts(unique)}.`,
  };
}

function scopeLabel(scope?: TrustScope): string {
  const tenants = scope?.tenantNames.filter(Boolean) ?? [];
  if (tenants.length === 0) return "the active tenant";
  if (tenants.length === 1) return tenants[0]!;
  return `${tenants.length} selected tenants`;
}

function attachmentLabel(attachments?: TrustAttachments): string | undefined {
  if (!attachments) return undefined;
  const parts: string[] = [];
  if (attachments.workspaceTitle) parts.push(`workspace ${attachments.workspaceTitle}`);
  if (attachments.evidenceCount) {
    parts.push(`${attachments.evidenceCount} evidence item${attachments.evidenceCount === 1 ? "" : "s"}`);
  }
  if (attachments.noteCount) {
    parts.push(`${attachments.noteCount} note${attachments.noteCount === 1 ? "" : "s"}`);
  }
  if (attachments.includesInstructions) parts.push("workspace instructions");
  return parts.length > 0 ? parts.join(", ") : undefined;
}

export function deriveTrustCopy(input: TrustCopyInput): DerivedTrustCopy {
  const providerName = input.provider?.name ?? "No provider";
  const model = input.model?.trim();
  const modelDetail = model ? ` using ${model}` : "";
  const scope = scopeLabel(input.scope);
  const attachments = attachmentLabel(input.attachments);
  const toolHosts = deriveToolHostsCopy(input.toolHosts);

  if (!input.provider) {
    return {
      strip: "Provider not configured",
      confirmTitle: "Select a provider",
      confirmBody: "Choose an LLM provider before sending tenant context.",
      storage: "No tenant context is sent.",
      isLocal: true,
    };
  }

  if (input.provider.isLocal) {
    return {
      strip: toolHosts ? `local model · ${toolHosts.strip}` : "local-only · no data leaves this device",
      ...(toolHosts ? { toolHosts } : {}),
      ...(attachments
        ? { boundary: `${attachments} will be included. Processing stays on this device.` }
        : {}),
      confirmTitle: "Process tenant context on this device",
      confirmBody: `${providerName}${modelDetail} will process context from ${scope} locally${attachments ? `, including ${attachments}` : ""}.`,
      storage: "Tenant data, prompts, and chat history stay on this device.",
      isLocal: true,
    };
  }

  return {
    strip: `hosted · tenant context sent to ${providerName}${toolHosts ? ` · ${toolHosts.strip}` : ""}`,
    ...(toolHosts ? { toolHosts } : {}),
    boundary: `Tenant context will be sent to ${providerName}${attachments ? ` with ${attachments}` : ""}.`,
    confirmTitle: "Send tenant context to hosted provider",
    confirmBody: `${providerName}${modelDetail} will receive the prompt and selected context from ${scope}${attachments ? `, including ${attachments}` : ""}.`,
    storage: "Chat history and the Graph cache stay on this device.",
    isLocal: false,
  };
}
