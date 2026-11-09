/**
 * Generates deterministic GitBook Markdown from repository metadata.
 *
 * Hand-authored pages live under docs/gitbook. Generated pages live under
 * docs/gitbook/generated and should not be edited manually.
 *
 * The docs site in web/ cannot read docs/ during the Vercel build, because
 * the Vercel project's Root Directory is web/. This script therefore also
 * mirrors every page listed in SUMMARY.md into web/content/docs together with
 * a manifest of routes and redirects. docs/gitbook stays the source; the
 * mirror is checked by `npm run docs:check`.
 */

import { execFileSync } from "node:child_process";
import { tsImport } from "tsx/esm/api";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { load as parseYaml } from "js-yaml";

import { buildDocsSite, parseSummary } from "./docs-site-routes.mjs";

const { DEFAULT_WRITE_MAX_ACTIONS } = await tsImport("../packages/agent-sdk/src/write-limits.ts", import.meta.url);
const {
  SERVICES,
  AVAILABLE_SERVICES,
  BASELINE_SERVICE_SCOPES,
  GRAPH_DELEGATED_PERMISSION_IDS,
  MICROSOFT_GRAPH_APP_ID,
  normalizeGraphScopeName,
} = await tsImport("../packages/agent-sdk/src/services.ts", import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const docsRoot = join(repoRoot, "docs", "gitbook");
const generatedRoot = join(docsRoot, "generated");
const generatedAgentsRoot = join(generatedRoot, "agents");
const generatedReferenceRoot = join(generatedRoot, "reference");
const generatedServicesRoot = join(generatedRoot, "services");
const agentsRoot = join(repoRoot, "agents");
const registryPath = join(agentsRoot, "index.json");
const webDocsRoot = join(repoRoot, "web", "content", "docs");

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
  // A fixed length: git's automatic abbreviation grows with the object
  // count, so a fresh CI clone and a local clone can print different hashes.
  const hash = git(["log", "-1", "--abbrev=8", "--format=%h", "--", path]);
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
  if (agent.mode === "write") {
    const limits = descriptor.writeLimits;
    lines.push(`At most ${limits?.maxActions ?? DEFAULT_WRITE_MAX_ACTIONS} actions per run (${limits ? "manifest limit" : "host default"}). Plans above the limit fail before confirmation and are checked again before any changes are applied.`, "");
    for (const [kind, max] of Object.entries(limits?.maxActionsPerOperation ?? {})) {
      lines.push(`- ${mdEscape(displayAction(kind))}: at most ${max} actions per run.`);
    }
    if (limits?.maxActionsPerOperation) lines.push("");
  }
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

// Delegated Graph scopes a user can consent to without an administrator,
// from the Lokka check of the Microsoft Graph service principal on
// 2026-11-04 (tasks/todo.md, "Lokka verification"). Every other scope in
// that table needs admin consent.
const USER_CONSENT_SCOPES = new Set(["openid", "profile", "offline_access", "User.Read", "User.ReadBasic.All"]);

function consentFor(name) {
  if (!Object.hasOwn(GRAPH_DELEGATED_PERMISSION_IDS, name)) {
    throw new Error(`${name} has no verified permission ID in packages/agent-sdk/src/services.ts.`);
  }
  return USER_CONSENT_SCOPES.has(name) ? "User" : "Admin";
}

function scopeCode(name) {
  return `\`${mdEscape(name)}\``;
}

function agentLink(agent, prefix) {
  return `[${mdEscape(agent.name)}](${prefix}${agent.slug}.md)`;
}

function agentsUsingScope(agents, name) {
  return agents.filter((agent) => (agent.scopes ?? []).some((scope) => normalizeGraphScopeName(scope) === name));
}

function agentsForService(agents, serviceId) {
  return agents.filter((agent) => (agent.services ?? []).includes(serviceId));
}

function scopeMatrixPage(agents) {
  const lines = [
    frontMatter("Graph scope matrix", "Microsoft Graph permission matrix for OpenAdminOS agents, grouped by service."),
    "# Graph Scope Matrix",
    "",
    "This reference shows which agents require each Microsoft Graph scope, grouped by service. A scope that two services share, such as `User.Read.All`, is listed under both. Run-time scopes are never requested when a tenant is connected; they are requested when an agent that declares them runs. See [Permissions by service](permissions-by-service.md) for the reason behind each scope.",
    "",
  ];

  const listed = new Set();
  for (const service of AVAILABLE_SERVICES) {
    lines.push(`## ${service.title}`, "", "| Scope | Part | Agents |", "| --- | --- | --- |");
    for (const part of service.parts) {
      for (const scope of part.scopes) {
        listed.add(scope.name);
        const users = agentsUsingScope(agents, scope.name);
        lines.push(
          `| ${scopeCode(scope.name)} | ${mdEscape(part.title)}${part.planned ? " (planned)" : ""} | ${users.length > 0 ? users.map((agent) => agentLink(agent, "../agents/")).join("<br>") : "None"} |`,
        );
      }
    }
    for (const scope of service.agentOnlyScopes) {
      const users = agentsUsingScope(agents, scope.name);
      if (users.length === 0) continue;
      listed.add(scope.name);
      lines.push(
        `| ${scopeCode(scope.name)} | Run time only | ${users.map((agent) => agentLink(agent, "../agents/")).join("<br>")} |`,
      );
    }
    lines.push("");
  }

  const other = new Map();
  for (const agent of agents) {
    for (const scope of agent.scopes ?? []) {
      const name = normalizeGraphScopeName(scope);
      if (listed.has(name)) continue;
      other.set(name, [...(other.get(name) ?? []), agent]);
    }
  }
  if (other.size > 0) {
    lines.push("## Outside A Service", "", "| Scope | Agents |", "| --- | --- |");
    for (const [name, entries] of [...other.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`| ${scopeCode(name)} | ${entries.map((agent) => agentLink(agent, "../agents/")).join("<br>")} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function permissionsByServicePage() {
  const lines = [
    frontMatter(
      "Permissions by service",
      "Every delegated Microsoft Graph permission OpenAdminOS requests, by service and part, with the reason and the consent it needs.",
    ),
    "# Permissions By Service",
    "",
    "This page is generated from the service registry in `packages/agent-sdk/src/services.ts`, the same source the app uses for the connect dialog, Settings and the setup script. Every permission is delegated: OpenAdminOS acts as the signed-in admin and can only read what that account can read.",
    "",
    "Consent shows who can approve a permission. **Admin** means an administrator has to grant consent for the tenant before anyone can use it. **User** means a user can consent for themselves. Permission IDs are the delegated permission IDs on the Microsoft Graph service principal (app ID `" + MICROSOFT_GRAPH_APP_ID + "`). They are listed for the `requiredResourceAccess` manifest snippet; the setup script resolves them again at run time.",
    "",
    "## Sign-in",
    "",
    "With the OpenAdminOS app, every connection requests these four scopes plus the scopes of the parts you choose, and nothing else. With your own app registration, sign-in requests `https://graph.microsoft.com/.default` and `offline_access`, and the token carries whatever the registration has been granted.",
    "",
    "| Scope | Reason | Consent | Permission ID |",
    "| --- | --- | --- | --- |",
  ];
  for (const scope of BASELINE_SERVICE_SCOPES) {
    lines.push(`| ${scopeCode(scope.name)} | ${mdEscape(scope.reason)} | ${consentFor(scope.name)} | \`${scope.permissionId}\` |`);
  }
  lines.push("");

  for (const service of AVAILABLE_SERVICES) {
    lines.push(
      `## ${service.title}`,
      "",
      `${sentence(service.summary)} [${service.title} guide](../services/${service.id}.md).`,
      "",
      "| Part | Scope | Reason | Consent | Permission ID |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const part of service.parts) {
      for (const scope of part.scopes) {
        lines.push(
          `| ${mdEscape(part.title)}${part.planned ? " (planned, never requested)" : ""} | ${scopeCode(scope.name)} | ${mdEscape(scope.reason)} | ${consentFor(scope.name)} | \`${scope.permissionId}\` |`,
        );
      }
    }
    lines.push("");
    if (service.agentOnlyScopes.length > 0) {
      lines.push(
        `### ${service.title} Run-Time Scopes`,
        "",
        "Never requested when a tenant is connected. An agent that declares one of these asks for consent when it runs, and a write still pauses for diff confirmation.",
        "",
        "| Scope | Reason |",
        "| --- | --- |",
      );
      for (const scope of service.agentOnlyScopes) {
        lines.push(`| ${scopeCode(scope.name)} | ${mdEscape(scope.reason)} |`);
      }
      lines.push("");
    }
  }

  const planned = SERVICES.filter((service) => service.status === "planned");
  if (planned.length > 0) {
    lines.push(
      "## Planned Services",
      "",
      `${planned.map((service) => service.title).join(", ")} are planned and request nothing today. See [Planned services](../../services/planned.md).`,
      "",
    );
  }
  return lines.join("\n");
}

function servicePage(service, agents) {
  const parts = service.parts.filter((part) => !part.planned);
  const plannedParts = service.parts.filter((part) => part.planned);
  const scopeNames = [...new Set(parts.flatMap((part) => part.scopes.map((scope) => scope.name)))];
  const lines = [
    frontMatter(service.title, `What the ${service.title} service covers in OpenAdminOS, its permissions, roles and licences.`),
    `# ${service.title}`,
    "",
    sentence(service.summary),
    "",
    `Connecting ${service.title} requests ${scopeNames.length} delegated Microsoft Graph read scope${scopeNames.length === 1 ? "" : "s"} on top of the four sign-in scopes. Choose all of its parts or only some of them in the connect dialog, and add the rest later in Settings, Tenants. A part is on only when every one of its scopes is granted. With your own app registration, OpenAdminOS reads the granted permissions from the token and switches on each part that is fully granted; see [Own app registration](../../getting-started/own-app-registration.md).`,
    "",
    "## Parts And Permissions",
    "",
  ];
  for (const part of parts) {
    lines.push(
      `### ${part.title}`,
      "",
      sentence(part.summary),
      "",
      "| Scope | Reason | Consent |",
      "| --- | --- | --- |",
    );
    for (const scope of part.scopes) {
      lines.push(`| ${scopeCode(scope.name)} | ${mdEscape(scope.reason)} | ${consentFor(scope.name)} |`);
    }
    lines.push("");
    if (part.chatExamples.length > 0) {
      lines.push("Chat questions this part answers:", "");
      for (const example of part.chatExamples) lines.push(`- ${mdEscape(example)}`);
      lines.push("");
    }
  }
  if (plannedParts.length > 0) {
    lines.push("## Planned Parts", "", "These parts are documented only. OpenAdminOS never requests their scopes today.", "");
    for (const part of plannedParts) {
      lines.push(`- **${mdEscape(part.title)}**: ${sentence(part.summary)} Needs ${part.scopes.map((scope) => scopeCode(scope.name)).join(", ")}.`);
    }
    lines.push("");
  }
  if (service.agentOnlyScopes.length > 0) {
    lines.push(
      "## Run-Time Scopes",
      "",
      "Agents may declare these. They are never requested when a tenant is connected, only when an agent that declares them runs. Writes always pause for diff confirmation.",
      "",
      "| Scope | Reason |",
      "| --- | --- |",
    );
    for (const scope of service.agentOnlyScopes) lines.push(`| ${scopeCode(scope.name)} | ${mdEscape(scope.reason)} |`);
    lines.push("");
  }
  lines.push(
    "## Roles",
    "",
    "Delegated permissions never add rights: OpenAdminOS can only read what the signed-in account can read. These roles let the account read this service without permission to change it, or with the narrowest permission that covers it. See [Roles](../../guides/roles.md) for who can grant admin consent.",
    "",
    "| Role | Why |",
    "| --- | --- |",
  );
  for (const role of service.roles) lines.push(`| ${mdEscape(role.name)} | ${mdEscape(role.why)} |`);
  lines.push("", "## Licences", "");
  for (const licence of service.licences) lines.push(`- ${mdEscape(licence)}`);
  lines.push("", "## Agents", "");
  const serviceAgents = agentsForService(agents, service.id);
  if (serviceAgents.length === 0) {
    lines.push("No agent in the registry declares this service yet.");
  } else {
    lines.push("Agents in the registry that declare this service. An agent cannot run while a service it declares is not connected.", "");
    lines.push("| Agent | Mode | Scopes |", "| --- | --- | --- |");
    for (const agent of serviceAgents) {
      lines.push(
        `| ${agentLink(agent, "../agents/")} | \`${mdEscape(agent.mode)}\` | ${(agent.scopes ?? []).length > 0 ? agent.scopes.map(scopeCode).join("<br>") : "None"} |`,
      );
    }
  }
  lines.push("", "See also [Permissions by service](../reference/permissions-by-service.md).", "");
  return lines.join("\n");
}

function writeSafetyMatrixPage(agents) {
  const lines = [
    frontMatter("Write safety matrix", "Write-operation reference for OpenAdminOS agents."),
    "# Write Safety Matrix",
    "",
    "OpenAdminOS write agents always pause for human confirmation. This reference lists the current write-mode agents, their declared write actions, and the required confirmation text.",
    "",
    "| Agent | Action | Plan limit | Confirmation | Scopes |",
    "| --- | --- | --- | --- | --- |",
  ];

  let rows = 0;
  for (const agent of agents) {
    const manifest = readManifest(agent.slug);
    const details = collectManifestDetails(manifest);
    if (agent.mode !== "write" && details.writeActions.length === 0) continue;
    const limits = manifest?.descriptor?.writeLimits;
    const planLimit = `${limits?.maxActions ?? DEFAULT_WRITE_MAX_ACTIONS} actions (${limits ? "manifest" : "host default"})`;

    if (details.writeActions.length === 0) {
      rows += 1;
      lines.push(`| [${mdEscape(agent.name)}](../agents/${agent.slug}.md) | Not declared | ${planLimit} | Runtime confirmation required | ${agent.scopes.map((scope) => `\`${mdEscape(scope)}\``).join("<br>")} |`);
      continue;
    }

    for (const action of details.writeActions) {
      rows += 1;
      lines.push(
        `| [${mdEscape(agent.name)}](../agents/${agent.slug}.md) | ${mdEscape(displayAction(action.kind))} | ${planLimit}${Object.hasOwn(limits?.maxActionsPerOperation ?? {}, action.kind) ? `<br>${limits.maxActionsPerOperation[action.kind]} of this kind` : ""} | ${displayConfirmation(action.confirmation)} | ${action.scopes.map((scope) => `\`${mdEscape(scope)}\``).join("<br>")} |`,
      );
    }
  }

  if (rows === 0) lines.push("| None | No write agents declared | - | - | - |");
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
    "| GitHub Copilot | Hosted | Available through Copilot CLI 1.0.83 or newer | Supplied prompts and context go through GitHub Copilot to the selected model service. Existing CLI authentication and account limits apply. |",
    "| Google Gemini | Hosted | Available through Gemini CLI 0.59.0 or newer; explicit connection test required | Supplied prompts and context go to Google. Existing CLI authentication and account limits apply. |",
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
- [Organizations and Connections](getting-started/organizations.md)
- [Connect with the shared app](getting-started/connect-shared-app.md)
- [Own app registration](getting-started/own-app-registration.md)
- [Managed configuration](getting-started/managed-configuration.md)

## Services

- [Intune](generated/services/intune.md)
- [Entra](generated/services/entra.md)
- [Defender](generated/services/defender.md)
- [Splashtop](services/splashtop.md)
- [Planned services](services/planned.md)
- [Permissions by service](generated/reference/permissions-by-service.md)
- [Roles](guides/roles.md)

## Features

- [Tenant Chat](features/intune-chat.md)
- [Cache and Nova](features/cache-and-nova.md)
- [Multi-tenant Chat](features/multi-tenant-intune-chat.md)
- [Workspaces](features/workspaces.md)
- [Changes and drift](features/changes.md)
- [Agent Team](features/office.md)
- [Marketplace](features/marketplace.md)

## Trust model

- [Local-first guarantee](trust/local-first.md)
- [Authentication and permissions](trust/authentication.md)
- [Hosted providers](trust/hosted-providers.md)
- [Write confirmation](trust/write-confirmation.md)
- [Registry trust](trust/registry-trust.md)
- [Sandboxed code](trust/sandboxed-code.md)
- [EU AI Act](trust/eu-ai-act.md)

## Troubleshooting

- [Consent and sign-in errors](troubleshooting/consent-errors.md)

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

function writeWebDocsMirror() {
  const summary = readFileSync(join(docsRoot, "SUMMARY.md"), "utf8");
  const site = buildDocsSite(parseSummary(summary));

  rmSync(webDocsRoot, { recursive: true, force: true });
  for (const page of site.pages) {
    const from = join(docsRoot, page.source);
    if (!existsSync(from)) {
      throw new Error(`SUMMARY.md links to a missing page: ${page.source}`);
    }
    const to = join(webDocsRoot, page.source);
    ensureDir(dirname(to));
    copyFileSync(from, to);
  }

  const manifest = {
    generatedBy: "scripts/generate-gitbook-docs.mjs",
    source: "docs/gitbook",
    sections: site.sections,
    redirects: site.redirects,
  };
  writeFileSync(join(webDocsRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return site;
}

function main() {
  ensureDir(generatedAgentsRoot);
  ensureDir(generatedReferenceRoot);
  ensureDir(generatedServicesRoot);

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
  writeGeneratedFile("generated/reference/permissions-by-service.md", permissionsByServicePage());
  for (const service of AVAILABLE_SERVICES) {
    writeGeneratedFile(`generated/services/${service.id}.md`, servicePage(service, agents));
  }
  writeGeneratedFile("generated/reference/write-safety-matrix.md", writeSafetyMatrixPage(agents));
  writeGeneratedFile("generated/reference/llm-provider-matrix.md", providerMatrixPage());

  for (const agent of agents) {
    writeGeneratedFile(`generated/agents/${agent.slug}.md`, agentPage(agent));
  }

  const generatedRelative = relative(repoRoot, generatedRoot);
  console.log(`Generated GitBook docs in ${generatedRelative} for ${agents.length} agent(s).`);

  const site = writeWebDocsMirror();
  console.log(
    `Mirrored ${site.pages.length} page(s) and ${site.redirects.length} redirect(s) into ${relative(repoRoot, webDocsRoot)}.`,
  );
}

main();
