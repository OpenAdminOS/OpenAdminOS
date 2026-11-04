import { afterEach, describe, expect, it, vi } from "vitest";

import { hostedDisclosureKey, readHostedDisclosures, recordHostedDisclosure, showFullHostedDisclosure } from "./hosted-disclosure";

const key = hostedDisclosureKey({ providerId: "openai", model: "gpt-5", toolHosts: "MCP tool queries go to learn.microsoft.com." });
const base = { hosted: true, currentKey: key, conversationId: "c1", acknowledged: {}, providerId: "openai", model: "gpt-5" };
const answer = (model: string) => [{ role: "user" as const }, { role: "assistant" as const, providerId: "openai" as const, model }];

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("hosted disclosure", () => {
  it("shows the full sentence on a conversation's first message and never for a local model", () => {
    expect(showFullHostedDisclosure({ ...base, conversationId: null, messages: [] })).toBe(true);
    expect(showFullHostedDisclosure({ ...base, messages: [] })).toBe(true);
    expect(showFullHostedDisclosure({ ...base, hosted: false, messages: [] })).toBe(false);
  });

  it("shows it again when the provider, model or MCP hosts differ from what the conversation sent with", () => {
    const acknowledged = { c1: key };
    expect(showFullHostedDisclosure({ ...base, acknowledged, messages: answer("gpt-5") })).toBe(false);
    const moreHosts = hostedDisclosureKey({ providerId: "openai", model: "gpt-5", toolHosts: "MCP tool queries go to learn.microsoft.com and www.kqlsearch.com." });
    expect(showFullHostedDisclosure({ ...base, currentKey: moreHosts, acknowledged, messages: answer("gpt-5") })).toBe(true);
    expect(showFullHostedDisclosure({ ...base, currentKey: hostedDisclosureKey({ providerId: "anthropic", model: "x" }), acknowledged, messages: answer("gpt-5") })).toBe(true);
    // No record: the latest answer's provider and model decide.
    expect(showFullHostedDisclosure({ ...base, messages: answer("gpt-5") })).toBe(false);
    expect(showFullHostedDisclosure({ ...base, messages: answer("gpt-4.1") })).toBe(true);
  });

  it("keeps the record per viewer and survives storage that throws", () => {
    const next = recordHostedDisclosure({}, "c1", key);
    expect(next).toEqual({ c1: key });
    expect(readHostedDisclosures()).toEqual({ c1: key });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readHostedDisclosures()).toEqual({});
    expect(recordHostedDisclosure({}, "c2", key)).toEqual({ c2: key });
  });
});
