export type AgentMode = "read" | "write";
export type AgentStatus = "idle" | "running" | "needs-input" | "failed";
export type ProviderId = "claude-code" | "codex" | "ollama" | "lm-studio";
export type ProviderStatus = "connected" | "available" | "not-installed";

export interface Author {
  name: string;
  handle: string;
  verified: boolean;
}

export interface Agent {
  id: string;
  slug: string;
  name: string;
  description: string;
  mode: AgentMode;
  category: "devices" | "apps" | "policies" | "compliance" | "updates";
  scopes: string[];
  author: Author;
  version: string;
  installed: boolean;
  installs?: number;
  rating?: number;
  lastRunAt?: string;
  preferredModel?: string;
}

export interface RunStep {
  id: string;
  label: string;
  state: "pending" | "active" | "done" | "error";
  detail?: string;
}

export interface Provider {
  id: ProviderId;
  name: string;
  description: string;
  isLocal: boolean;
  status: ProviderStatus;
  detail?: string;
  models?: string[];
  defaultModel?: string;
}
