/**
 * Generates deterministic GitBook Markdown from repository metadata.
 *
 * Hand-authored pages live under docs/gitbook. Generated pages live under
 * docs/gitbook/generated and should not be edited manually.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { load as parseYaml } from "js-yaml";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const docsRoot = join(repoRoot, "docs", "gitbook");
const generatedRoot = join(docsRoot, "generated");
const generatedAgentsRoot = join(generatedRoot, "agents");
const generatedReferenceRoot = join(generatedRoot, "reference");
const agentsRoot = join(repoRoot, "agents");
const registryPath = join(agentsRoot, "index.json");

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readManifest(slug) {
  const path = join(agentsRoot, slug, "manifest.yaml");
  return parseYaml(readFileSync(path, "utf8"));
}

function listAgentSlugs() {
  return readdirSync(agentsRoot)
    .filter((entry) => {
      const dir = join(agentsRoot, entry);
      return statSync(dir).isDirectory() && existsSync(join(dir, "manifest.yaml"));
    })
    .sort((a, b) => a.localeCompare(b));
}

function git(args, fallback = "unknown") {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function lastChanged(path) {
  const hash = git(["log", "-1", "--format=%h", "--", path]);
  const date = git(["log", "-1", "--format=%cs", "--", path]);
  return { hash, date };
}

function mdEscape(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ")
    .trim();
}

function sentence(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.endsWith(".") ? text : `${text}.`;
}

function frontMatter(title, description) {
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
}

function displayDefault(value) {
  if (value === undefined || value === null || value === "") return "None";
  return `\`${mdEscape(value)}\``;
}

function displayConfirmation(value) {
  const text = String(value ?? "").trim();
  if (!text) return "Runtime confirmation required";
  return `\`${mdEscape(text.replace(/\{\{[^}]+\}\}/g, "N").replace(/\s+/g, " "))}\``;
}

function displayAction(value) {
  const action = String(value ?? "").trim();
  if (action === "graph-write") return "Graph write";
  if (!action) return "Write operation";
  return action
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function flattenSkills(skills) {
  const flat = [];
  for (const skill of Array.isArray(skills) ? skills : []) {
    flat.push(skill);
    const nested = skill?.settings?.do ?? skill?.settings?.steps ?? skill?.settings?.pipeline;
    flat.push(...flattenSkills(nested));
  }
  return flat;
}

function collectManifestDetails(manifest) {
  const skills = flattenSkills(manifest?.skills);
  const graphCalls = [];
  const scopes = new Set();
  const writeActions = [];
  const llmSteps = [];

  for (const skill of skills) {
    const format = skill?.format;
    const settings = skill?.settings ?? {};
    const skillScopes = Array.isArray(settings.scopes) ? settings.scopes : [];
    for (const scope of skillScopes) {
      if (typeof scope === "string") scopes.add(scope);
    }

    if (format === "graph") {
      graphCalls.push({
        id: skill.id,
        label: skill.label,
        method: settings.method ?? "GET",
        path: settings.path ?? "",
        scopes: skillScopes,
      });
    }

    if (format === "write") {
      writeActions.push({
        id: skill.id,
        label: skill.label,
        kind: settings.kind ?? settings.action ?? "write",
        confirmation: settings.confirmationPhrase ?? settings.confirmation ?? "",
        scopes: skillScopes,
      });
    }

    if (format === "llm") {
      llmSteps.push({
        id: skill.id,
        label: skill.label,
        maxTokens: settings.maxTokens,
        temperature: settings.temperature,
      });
    }
  }

  const settings = Array.isArray(manifest?.definition?.settings)
    ? manifest.definition.settings
    : [];

  return {
    execution: manifest?.execution ?? { kind: "template" },
    graphCalls,
    scopes: [...scopes].sort(),
    writeActions,
    llmSteps,
    settings,
  };
}

function agentPage(agent) {
  const manifest = readManifest(agent.slug);
  const descriptor = manifest?.descriptor ?? {};
  const details = collectManifestDetails(manifest);
  const changed = lastChanged(`agents/${agent.slug}`);
  const sourceUrl = `https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/${agent.slug}`;
  const manifestUrl = `https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/${agent.slug}/manifest.yaml`;

  const lines = [
    frontMatter(agent.name, agent.description),
    `# ${agent.name}`,
    "",
    sentence(agent.description),
    "",
    "## Classification",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Agent ID | \`${mdEscape(agent.id)}\` |`,
    `| Version | \`${mdEscape(agent.version)}\` |`,
    `| Mode | \`${mdEscape(agent.mode)}\` |`,
    `| Tier | \`${mdEscape(agent.tier)}\` |`,
    `| Category | \`${mdEscape(agent.category)}\` |`,
    `| Required Entra tier | \`${mdEscape(agent.requiresEntraTier)}\` |`,
    `| Preferred model | \`${mdEscape(descriptor.preferredModel ?? "not pinned")}\` |`,
    `| Minimum app version | \`${mdEscape(agent.minAppVersion)}\` |`,
    `| Author | ${mdEscape(agent.author?.name ?? "unknown")}${agent.author?.verified ? " · verified" : ""} |`,
    `| Last changed | ${changed.date} · \`${changed.hash}\` |`,
    "",
  ];

  lines.push("## Execution", "");
  if (details.execution?.kind === "script") {
    lines.push(
      `This agent runs \`${mdEscape(details.execution.entrypoint)}\` inside the experimental \`${mdEscape(details.execution.sandbox)}\` sandbox. The Graph and LLM steps below are broker permissions, not host-interpreted pipeline steps.`,
      "",
    );
  } else {
    lines.push("This agent runs through the host-side Agent Template interpreter.", "");
  }

  lines.push("## Tenant Data Access", "");
  if (details.graphCalls.length === 0) {
    lines.push("No Graph read calls are declared in the manifest.", "");
  } else {
    lines.push("| Step | Graph call | Scopes |", "| --- | --- | --- |");
    for (const call of details.graphCalls) {
      lines.push(
        `| ${mdEscape(call.label ?? call.id)} | \`${mdEscape(call.method)} ${mdEscape(call.path)}\` | ${call.scopes.map((scope) => `\`${mdEscape(scope)}\``).join("<br>")} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Graph Scopes", "");
  if (details.scopes.length === 0) {
    lines.push("No Graph scopes are declared.", "");
  } else {
    for (const scope of details.scopes) lines.push(`- \`${scope}\``);
    lines.push("");
  }

  lines.push("## Write Behavior", "");
  if (agent.mode !== "write" && details.writeActions.length === 0) {
    lines.push("This is a read-only agent. It does not declare write operations.", "");
  } else if (details.writeActions.length === 0) {
    lines.push("The agent is classified as write-mode, but no write step was found in the manifest.", "");
  } else {
    lines.push("| Step | Action | Confirmation | Scopes |", "| --- | --- | --- | --- |");
    for (const action of details.writeActions) {
      lines.push(
        `| ${mdEscape(action.label ?? action.id)} | ${mdEscape(displayAction(action.kind))} | ${displayConfirmation(action.confirmation)} | ${action.scopes.map((scope) => `\`${mdEscape(scope)}\``).join("<br>")} |`,
      );
    }
    lines.push("");
    lines.push("Write agents always pause for confirmation in OpenAdminOS. Destructive operations require the typed confirmation phrase shown by the app.", "");
  }

  lines.push("## LLM Use", "");
  if (details.llmSteps.length === 0) {
    lines.push("No LLM step is declared. This should fail agent QA because OpenAdminOS agents are expected to use the configured model.", "");
  } else {
    lines.push("| Step | Settings |", "| --- | --- |");
    for (const step of details.llmSteps) {
      const settings = [
        step.temperature !== undefined ? `temperature ${step.temperature}` : null,
        step.maxTokens !== undefined ? `max tokens ${step.maxTokens}` : null,
      ].filter(Boolean).join(" · ");
      lines.push(`| ${mdEscape(step.label ?? step.id)} | ${settings || "Manifest defaults"} |`);
    }
    lines.push("");
  }

  lines.push("## Settings", "");
  if (details.settings.length === 0) {
    lines.push("No user-configurable settings are declared.", "");
  } else {
    lines.push("| Setting | Type | Default | Description |", "| --- | --- | --- | --- |");
    for (const setting of details.settings) {
      lines.push(
        `| \`${mdEscape(setting.id)}\` | ${mdEscape(setting.type)} | ${displayDefault(setting.default)} | ${mdEscape(setting.description ?? setting.label ?? "")} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Source", "", `- [Agent source](${sourceUrl})`, `- [Manifest](${manifestUrl})`, "");
  return lines.join("\n");
}

function agentCatalogPage(agents) {
  const changed = lastChanged("agents");
  const lines = [
    frontMatter("Agent catalog", "Catalog of OpenAdminOS agents and dashboards."),
    "# Agent Catalog",
    "",
    "This catalog lists the current OpenAdminOS agents and dashboards. Mode, scopes, tenant data access, and write behavior are taken from each agent's reviewed metadata.",
    "",
    `Last updated: ${changed.date} · \`${changed.hash}\`.`,
    "",
    "| Agent | Mode | Tier | Category | Required Entra tier | Scopes |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const agent of agents) {
    lines.push(
      `| [${mdEscape(agent.name)}](agents/${agent.slug}.md) | \`${mdEscape(agent.mode)}\` | \`${mdEscape(agent.tier)}\` | \`${mdEscape(agent.category)}\` | \`${mdEscape(agent.requiresEntraTier)}\` | ${agent.scopes.map((scope) => `\`${mdEscape(scope)}\``).join("<br>")} |`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

function scopeMatrixPage(agents) {
  const scopeMap = new Map();
  for (const agent of agents) {
    for (const scope of agent.scopes ?? []) {
      const entries = scopeMap.get(scope) ?? [];
      entries.push(agent);
      scopeMap.set(scope, entries);
    }
  }

  const lines = [
    frontMatter("Graph scope matrix", "Microsoft Graph permission matrix for OpenAdminOS agents."),
    "# Graph Scope Matrix",
    "",
    "This reference shows which agents require each Microsoft Graph scope.",
    "",
    "| Scope | Agents |",
    "| --- | --- |",
  ];

  for (const [scope, entries] of [...scopeMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
      `| \`${mdEscape(scope)}\` | ${entries.map((agent) => `[${mdEscape(agent.name)}](../agents/${agent.slug}.md)`).join("<br>")} |`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

function writeSafetyMatrixPage(agents) {
  const lines = [
    frontMatter("Write safety matrix", "Write-operation reference for OpenAdminOS agents."),
    "# Write Safety Matrix",
    "",
    "OpenAdminOS write agents always pause for human confirmation. This reference lists the current write-mode agents, their declared write actions, and the required confirmation text.",
    "",
    "| Agent | Action | Confirmation | Scopes |",
    "| --- | --- | --- | --- |",
  ];

  let rows = 0;
  for (const agent of agents) {
    const manifest = readManifest(agent.slug);
    const details = collectManifestDetails(manifest);
    if (agent.mode !== "write" && details.writeActions.length === 0) continue;

    if (details.writeActions.length === 0) {
      rows += 1;
      lines.push(`| [${mdEscape(agent.name)}](../agents/${agent.slug}.md) | Not declared | Runtime confirmation required | ${agent.scopes.map((scope) => `\`${mdEscape(scope)}\``).join("<br>")} |`);
      continue;
    }

    for (const action of details.writeActions) {
      rows += 1;
      lines.push(
        `| [${mdEscape(agent.name)}](../agents/${agent.slug}.md) | ${mdEscape(displayAction(action.kind))} | ${displayConfirmation(action.confirmation)} | ${action.scopes.map((scope) => `\`${mdEscape(scope)}\``).join("<br>")} |`,
      );
    }
  }

  if (rows === 0) lines.push("| None | No write agents declared | - | - |");
  lines.push("");
  return lines.join("\n");
}

function providerMatrixPage() {
  return [
    frontMatter("LLM provider matrix", "Provider trust and data-flow reference for OpenAdminOS."),
    "# LLM Provider Matrix",
    "",
    "| Provider | Local or hosted | Current status | Data-flow message |",
    "| --- | --- | --- | --- |",
    "| Ollama | Local | Available | Tenant prompts and responses stay on this device. |",
    "| Apple Foundation | Local | Available on compatible Macs | Tenant prompts and responses stay on this device through Apple's on-device Foundation Models framework. |",
    "| LM Studio | Local | Available | Tenant prompts and responses stay on this device through the local LM Studio server. |",
    "| OpenAI Codex | Hosted | Available through the local Codex CLI | Tenant prompts are sent to OpenAI through the user's Codex account. OpenAdminOS does not store an OpenAI API key. |",
    "| Anthropic | Hosted | Available through the local Claude Code CLI | Tenant prompts are sent to Anthropic through the user's Claude Code login. OpenAdminOS does not store an Anthropic API key. |",
    "| Azure OpenAI | Hosted | Available | Tenant prompts are sent to the configured Azure OpenAI resource. OpenAdminOS stores one encrypted key locally. |",
    "",
  ].join("\n");
}

function summaryPage(agents) {
  const agentLinks = agents
    .map((agent) => `- [${agent.name}](generated/agents/${agent.slug}.md)`)
    .join("\n");

  return `# Summary

## Basics

- [Overview](README.md)
- [Installation](getting-started/installation.md)
- [First run](getting-started/first-run.md)
- [Connect a tenant](getting-started/connect-tenant.md)

## Features

- [Intune Chat](features/intune-chat.md)
- [Multi-tenant Intune Chat](features/multi-tenant-intune-chat.md)
- [Workspaces](features/workspaces.md)
- [Changes and drift](features/changes.md)

## Trust Model

- [Local-first guarantee](trust/local-first.md)
- [Hosted providers](trust/hosted-providers.md)
- [Write confirmation](trust/write-confirmation.md)
- [Registry trust](trust/registry-trust.md)
- [Sandboxed code](trust/sandboxed-code.md)

## Connectors

- [Connector setup](connectors/README.md)
- [Delivery rules](connectors/delivery-rules.md)
- [Connector setup reference](connectors/setup-reference.md)

## Agents

- [Agent docs overview](agents/README.md)
- [Build your own Agent](agents/build-your-own-agent.md)
- [Share with community](agents/share-with-community.md)
- [Agent catalog](generated/agent-catalog.md)
- [Graph scope matrix](generated/reference/graph-scope-matrix.md)
- [Write safety matrix](generated/reference/write-safety-matrix.md)
${agentLinks}

## Developers

- [Architecture](developers/architecture.md)
- [Documentation automation](developers/documentation-automation.md)
- [LLM provider matrix](generated/reference/llm-provider-matrix.md)
`;
}

function writeGeneratedFile(relativePath, content) {
  const path = join(docsRoot, relativePath);
  ensureDir(dirname(path));
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`);
}

function main() {
  ensureDir(generatedAgentsRoot);
  ensureDir(generatedReferenceRoot);

  const registry = readJson(registryPath);
  const registryAgents = Array.isArray(registry.agents) ? registry.agents : [];
  const manifestSlugs = listAgentSlugs();
  const registrySlugs = new Set(registryAgents.map((agent) => agent.slug));
  const missing = manifestSlugs.filter((slug) => !registrySlugs.has(slug));
  if (missing.length > 0) {
    throw new Error(`agents/index.json is missing manifest(s): ${missing.join(", ")}. Run npm run registry:index first.`);
  }

  const agents = registryAgents
    .filter((agent) => manifestSlugs.includes(agent.slug))
    .sort((a, b) => a.name.localeCompare(b.name));

  writeGeneratedFile("SUMMARY.md", summaryPage(agents));
  writeGeneratedFile("generated/agent-catalog.md", agentCatalogPage(agents));
  writeGeneratedFile("generated/reference/graph-scope-matrix.md", scopeMatrixPage(agents));
  writeGeneratedFile("generated/reference/write-safety-matrix.md", writeSafetyMatrixPage(agents));
  writeGeneratedFile("generated/reference/llm-provider-matrix.md", providerMatrixPage());

  for (const agent of agents) {
    writeGeneratedFile(`generated/agents/${agent.slug}.md`, agentPage(agent));
  }

  const generatedRelative = relative(repoRoot, generatedRoot);
  console.log(`Generated GitBook docs in ${generatedRelative} for ${agents.length} agent(s).`);
}

main();
