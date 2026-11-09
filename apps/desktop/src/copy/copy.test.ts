import { describe, expect, it } from "vitest";
import {
  CHAT_COPY,
  COMMON_COPY,
  SETTINGS_ITEMS,
  SETTINGS_SECTIONS,
  SETUP_COPY,
  chatErrorCopy,
  deriveToolHostsCopy,
  deriveTrustCopy,
  HOSTED_CONFIRM_COPY,
  PROVIDER_COMPANIES,
  promptsGoTo,
  sendsThroughTool,
  providerDataLocation,
  providerDataLocationDetail,
  searchSettings,
} from "./index.js";

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

describe("v0.4 copy catalog", () => {
  it("uses the restrained product voice", () => {
    const strings = stringsIn({ CHAT_COPY, COMMON_COPY, SETTINGS_ITEMS, SETTINGS_SECTIONS, SETUP_COPY });
    expect(strings.length).toBeGreaterThan(30);
    for (const value of strings) {
      expect(value.trim()).not.toBe("");
      expect(value).not.toMatch(/(?:awesome|supercharge|revolutionary|intelligent agents)/i);
      expect(value).not.toMatch(/[!🚀🎉]/u);
      expect(value).not.toMatch(/\.\.\./);
    }
  });

  it("recommends a daily reader and separates consent from scoped coverage", () => {
    expect(SETUP_COPY.dailyRole).toContain("Global Reader");
    expect(SETUP_COPY.consentRole).toMatch(/Global Administrator.*only needed once/);
    expect(SETUP_COPY.scopedRoles).toMatch(/Security Reader.*Conditional Access Administrator.*Intune Administrator/);
    expect(SETUP_COPY.scopedRoles).toContain("reduced coverage");
    expect(SETUP_COPY.dailyRole + SETUP_COPY.consentRole + SETUP_COPY.scopedRoles).not.toContain("\u2014");
  });

  it("derives local and hosted trust boundaries with the provider's documented location", () => {
    const local = deriveTrustCopy({
      provider: { name: "Ollama", isLocal: true },
      model: "qwen2.5:7b",
      scope: { tenantNames: ["Contoso"] },
    });
    expect(local.strip).toBe("local-only · no data leaves this device");
    expect(local.boundary).toBeUndefined();

    const hosted = deriveTrustCopy({
      provider: { id: "anthropic", name: "Claude Code", isLocal: false },
      scope: { tenantNames: ["Contoso", "Fabrikam"] },
      attachments: { workspaceTitle: "Incident 42", evidenceCount: 2 },
    });
    expect(hosted.strip).toBe("hosted · tenant context sent to Claude Code · location set by your account");
    expect(hosted.confirmBody).toContain("(Claude Code · location set by your account)");
    expect(hosted.boundary).toBe("Prompts and tenant data leave this device through Claude Code; location set by your account, with workspace Incident 42, 2 evidence items.");
    expect(hosted.confirmBody).toContain("2 selected tenants");
    expect(hosted.confirmBody).toContain("2 evidence items");
  });

  it("names MCP tool hosts honestly, also for a local model", () => {
    const hosts = ["learn.microsoft.com", "www.kqlsearch.com", "www.intuneautomation.com"];
    const local = deriveTrustCopy({ provider: { name: "Ollama", isLocal: true }, scope: { tenantNames: ["Contoso"] }, toolHosts: hosts });
    expect(local.strip).toBe("local model · tool queries to learn.microsoft.com +2");
    expect(local.strip).not.toMatch(/no data leaves/);
    const disclosure = "MCP queries are written from your current question only, never from Graph or cache data. Words from that question can be sent to learn.microsoft.com, www.kqlsearch.com and www.intuneautomation.com. A filter blocks known tenant names, IDs, email addresses and IP addresses, but cannot guarantee it catches every private detail.";
    expect(local.toolHosts?.detail).toBe(disclosure);
    expect(local.toolHosts?.composer).toBe(disclosure);
    // With MCP tools on, a local model no longer claims that prompts stay on the device.
    expect(local.storage).toBe("The model, Graph and cache data, and chat history stay on this device.");
    expect(deriveTrustCopy({ provider: { name: "Ollama", isLocal: true } }).storage).toBe("Tenant data, prompts, and chat history stay on this device.");
    const hosted = deriveTrustCopy({ provider: { id: "anthropic", name: "Claude Code", isLocal: false }, toolHosts: ["learn.microsoft.com"] });
    expect(hosted.strip).toBe("hosted · tenant context sent to Claude Code · location set by your account · tool queries to learn.microsoft.com");
    expect(deriveToolHostsCopy([])).toBeUndefined();
    expect(deriveTrustCopy({ provider: { name: "Ollama", isLocal: true }, toolHosts: [] }).strip).toBe("local-only · no data leaves this device");
    for (const value of [...stringsIn(local.toolHosts), local.storage]) {
      expect(value).not.toMatch(/[!\u2014\u2013]| - /u);
    }
  });

  it("keeps Settings ids unique and searchable from the same catalog", () => {
    const ids = [
      ...SETTINGS_SECTIONS.map((entry) => `section-${entry.id}`),
      ...Object.keys(SETTINGS_ITEMS),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(searchSettings("cache").map((result) => result.title)).toEqual(
      expect.arrayContaining(["Data", "Tenant cache", "Periodic cache refresh"]),
    );
  });

  it("gives every typed error a specific recovery action", () => {
    expect(chatErrorCopy("Provider stopped responding.")).toEqual({
      what: "The answer could not be completed.",
      why: "Provider stopped responding.",
      action: { label: "Retry", kind: "retry" },
    });
    expect(chatErrorCopy("Error: bridge failed\n    at /home/user/app/main.js:42").why).toBeUndefined();
  });
});

describe("hosted data locations (maintainer decision, 2026-11-09, refined)", () => {
  it("says who sets the location, as the strip label, for every hosted provider", () => {
    expect(providerDataLocation({ id: "anthropic", name: "Claude Code" })).toBe("Claude Code · location set by your account");
    expect(providerDataLocation({ id: "openai", name: "Codex" })).toBe("Codex · location set by your account");
    expect(providerDataLocation({ id: "azure-openai", name: "Azure OpenAI" })).toBe("Azure OpenAI · location set by your deployment type");
    expect(providerDataLocation({ id: "copilot", name: "GitHub Copilot CLI" })).toBe("GitHub Copilot CLI · location not stated");
    expect(providerDataLocation({ id: "gemini", name: "Gemini CLI" })).toBe("Gemini CLI · location not stated");
    expect(providerDataLocation({ name: "Example" })).toBe("Example · location not stated");
  });

  it("gives the detail for tooltips, the confirmation and What ran, and none where the vendor states nothing", () => {
    expect(providerDataLocationDetail({ id: "anthropic" })).toBe(
      "Claude Code sends prompts to Anthropic, or to Amazon Bedrock or Google Vertex if its settings select them. On Anthropic's API, inference can run in any region by default and data at rest stays in the US; a workspace can restrict inference to the US.",
    );
    expect(providerDataLocationDetail({ id: "openai" })).toBe("Codex sends prompts to OpenAI, or to the endpoint its configuration selects. Processing follows your workspace's data residency setting.");
    expect(providerDataLocationDetail({ id: "azure-openai" })).toBe(
      "Global deployments can process in any Azure region, Data Zone deployments within the US, EU or Asia Pacific, Standard deployments within your resource's geography.",
    );
    expect(providerDataLocationDetail({ id: "copilot" })).toBeUndefined();
    expect(providerDataLocationDetail({ id: "gemini" })).toBeUndefined();
  });

  it("names a CLI as the way prompts leave, and an API as the place they go", () => {
    expect(promptsGoTo({ id: "anthropic", name: "Claude Code" })).toBe("Prompts leave this device through Claude Code; location set by your account");
    expect(promptsGoTo({ id: "openai", name: "Codex" }, true)).toBe("Prompts and tenant data leave this device through Codex; location set by your account");
    expect(promptsGoTo({ id: "azure-openai", name: "Azure OpenAI" })).toBe("Prompts go to Azure OpenAI · location set by your deployment type");
    expect(promptsGoTo({ id: "gemini", name: "Gemini CLI" })).toBe("Prompts leave this device through Gemini CLI; location not stated");
    expect(promptsGoTo({ id: "copilot", name: "GitHub Copilot CLI" })).toBe("Prompts leave this device through GitHub Copilot CLI; location not stated");
  });
});

describe("hosted confirmation wording, as PR #175 (design round review)", () => {
  it("names a CLI as the way the question leaves and an API by its company", () => {
    expect(sendsThroughTool({ id: "anthropic" })).toBe(true);
    expect(HOSTED_CONFIRM_COPY.titleThrough("Claude Code")).toBe("Send this question through Claude Code?");
    expect(HOSTED_CONFIRM_COPY.sendThrough("Claude Code")).toBe("Send through Claude Code");
    expect(HOSTED_CONFIRM_COPY.bodyThroughTenant("Claude Code", "Contoso")).toMatch(/^Claude Code answers with your existing sign-in\./);
    expect(sendsThroughTool({ id: "azure-openai" })).toBe(false);
    expect(HOSTED_CONFIRM_COPY.title(PROVIDER_COMPANIES["azure-openai"]!)).toBe("Send this question to Azure OpenAI?");
  });
});
