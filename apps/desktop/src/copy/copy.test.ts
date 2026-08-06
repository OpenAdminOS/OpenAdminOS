import { describe, expect, it } from "vitest";
import {
  CHAT_COPY,
  COMMON_COPY,
  SETTINGS_ITEMS,
  SETTINGS_SECTIONS,
  chatErrorCopy,
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
    const strings = stringsIn({ CHAT_COPY, COMMON_COPY, SETTINGS_ITEMS, SETTINGS_SECTIONS });
    expect(strings.length).toBeGreaterThan(30);
    for (const value of strings) {
      expect(value.trim()).not.toBe("");
      expect(value).not.toMatch(/(?:awesome|supercharge|revolutionary|intelligent agents)/i);
      expect(value).not.toMatch(/[!🚀🎉]/u);
      expect(value).not.toMatch(/\.\.\./);
    }
  });

  it("derives local and hosted trust boundaries without inventing a region", () => {
    const local = deriveTrustCopy({
      provider: { name: "Ollama", isLocal: true },
      model: "qwen2.5:7b",
      scope: { tenantNames: ["Contoso"] },
    });
    expect(local.strip).toBe("local-only · no data leaves this device");
    expect(local.boundary).toBeUndefined();

    const hosted = deriveTrustCopy({
      provider: { name: "Anthropic", isLocal: false },
      scope: { tenantNames: ["Contoso", "Fabrikam"] },
      attachments: { workspaceTitle: "Incident 42", evidenceCount: 2 },
    });
    expect(hosted.strip).toContain("Anthropic");
    expect(hosted.confirmBody).toContain("2 selected tenants");
    expect(hosted.confirmBody).toContain("2 evidence items");
    expect(hosted.confirmBody).not.toMatch(/\b(?:US|EU|region)\b/i);
  });

  it("keeps Settings ids unique and searchable from the same catalog", () => {
    const ids = [
      ...SETTINGS_SECTIONS.map((entry) => `section-${entry.id}`),
      ...Object.keys(SETTINGS_ITEMS),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(searchSettings("cache").map((result) => result.title)).toEqual(
      expect.arrayContaining(["Chat", "Tenant cache", "Periodic cache refresh"]),
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
