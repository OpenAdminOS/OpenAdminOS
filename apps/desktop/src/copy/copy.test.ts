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

  it("derives local and hosted trust boundaries, naming only a documented region", () => {
    const local = deriveTrustCopy({
      provider: { name: "Ollama", isLocal: true },
      model: "qwen2.5:7b",
      scope: { tenantNames: ["Contoso"] },
    });
    expect(local.strip).toBe("local-only · no data leaves this device");
    expect(local.boundary).toBeUndefined();

    const hosted = deriveTrustCopy({
      provider: { id: "anthropic", name: "Anthropic", isLocal: false },
      scope: { tenantNames: ["Contoso", "Fabrikam"] },
      attachments: { workspaceTitle: "Incident 42", evidenceCount: 2 },
    });
    expect(hosted.strip).toContain("Anthropic");
    expect(hosted.confirmBody).toContain("2 selected tenants");
    expect(hosted.confirmBody).toContain("2 evidence items");
    // The region comes from the provider's documented data location, never guessed (PR #175 round 2, R).
    expect(hosted.confirmBody).toContain("(Anthropic API · US)");
    const unknown = deriveTrustCopy({ provider: { name: "Example", isLocal: false }, scope: { tenantNames: ["Contoso"] } });
    expect(unknown.confirmBody).toContain("(Example · region not stated)");
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
    const hosted = deriveTrustCopy({ provider: { id: "anthropic", name: "Anthropic", isLocal: false }, toolHosts: ["learn.microsoft.com"] });
    expect(hosted.strip).toBe("hosted · tenant context sent to Anthropic API · US · tool queries to learn.microsoft.com");
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

describe("hosted trust copy names the region (PR #175 Muse round 2, R)", () => {
  it("names where prompts go in the strip, boundary and confirmation with a tenant", () => {
    const copy = deriveTrustCopy({ provider: { id: "openai", name: "OpenAI", isLocal: false }, model: "gpt-5", scope: { tenantNames: ["Contoso"] } });
    expect(copy.strip).toBe("hosted · tenant context sent to OpenAI API · US");
    expect(copy.boundary).toBe("Tenant context will be sent to OpenAI API · US.");
    expect(copy.confirmBody).toBe("OpenAI using gpt-5 (OpenAI API · US) will receive the prompt and selected context from Contoso.");
  });
});
