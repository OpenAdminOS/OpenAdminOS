import type { Provider } from "../types";

export const providers: Provider[] = [
  {
    id: "ollama",
    name: "Ollama",
    description:
      "Run open-source models locally. Tenant data and prompts never leave your machine.",
    isLocal: true,
    status: "connected",
    detail: "Running on http://localhost:11434",
    models: ["llama3.1:8b", "llama3.1:70b", "qwen2.5-coder:14b", "mistral:7b"],
    defaultModel: "llama3.1:8b",
  },
  {
    id: "lm-studio",
    name: "LM Studio",
    description:
      "Local model runner with a friendly UI. Pair with the same privacy guarantees as Ollama.",
    isLocal: true,
    status: "available",
    detail: "Detected, not connected",
    models: [],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    description:
      "Use your installed Claude Code CLI's authentication. No API keys stored in Open Agents.",
    isLocal: false,
    status: "connected",
    detail: "claude-code v2.0.4 detected · Anthropic subscription",
    models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"],
    defaultModel: "claude-sonnet-4-6",
  },
  {
    id: "codex",
    name: "Codex CLI",
    description:
      "Use your installed Codex CLI's authentication. No API keys stored in Open Agents.",
    isLocal: false,
    status: "not-installed",
    detail: "Codex CLI not found on PATH",
    models: [],
  },
];

export const activeProviderId = "ollama";
