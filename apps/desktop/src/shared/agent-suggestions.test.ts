import { describe, expect, it } from "vitest";

import { suggestAgentForQuestion } from "./agent-suggestions.js";
import type { AgentSummary } from "./openAdminOS.js";

const installedAgents = [
  agent({
    slug: "find-inactive-devices",
    name: "Find inactive devices",
    description:
      "Reviews Intune-managed device inactivity by sync age, compliance, OS, ownership, and enrollment signals with review-first cleanup guidance.",
    category: "devices",
    mode: "read",
    scopes: ["DeviceManagementManagedDevices.Read.All"],
  }),
  agent({
    slug: "offboarding-agent",
    name: "Offboarding agent",
    description:
      "Builds a conservative stale-device offboarding plan from Intune sync, Entra sign-in, ownership, compliance, and trust signals, then retires devices after typed confirmation.",
    category: "devices",
    mode: "write",
    scopes: ["DeviceManagementManagedDevices.ReadWrite.All"],
  }),
  agent({
    slug: "compliance-overview",
    name: "Compliance overview",
    description:
      "Reviews Intune compliance by state, operating system, ownership, enrollment, and stale inventory signals.",
    category: "compliance",
    mode: "read",
    scopes: ["DeviceManagementManagedDevices.Read.All"],
  }),
  agent({
    slug: "dormant-app-registrations",
    name: "Dormant app registrations",
    description:
      "Reviews app registrations for stale experiments, risky exposure, credentials, and cleanup candidates with evidence-backed recommendations.",
    category: "apps",
    mode: "read",
    scopes: ["Application.Read.All"],
  }),
];

describe("suggestAgentForQuestion", () => {
  it("matches a not-synced devices question to the inactive-devices agent", () => {
    const suggestion = suggestAgentForQuestion(
      "Which Intune devices have not synced in the last 45 days?",
      installedAgents,
    );

    expect(suggestion?.agent.slug).toBe("find-inactive-devices");
    expect(suggestion?.score).toBeGreaterThanOrEqual(8);
  });

  it("matches a compliance question to compliance overview", () => {
    const suggestion = suggestAgentForQuestion(
      "Show noncompliant Windows devices by ownership and enrollment.",
      installedAgents,
    );

    expect(suggestion?.agent.slug).toBe("compliance-overview");
  });

  it("returns null for unrelated questions", () => {
    expect(suggestAgentForQuestion("What's the weather in Hamburg?", installedAgents)).toBeNull();
  });

  it("handles case and punctuation around domain terms", () => {
    const suggestion = suggestAgentForQuestion(
      "STALE, inactive devices???",
      installedAgents,
    );

    expect(suggestion?.agent.slug).toBe("find-inactive-devices");
  });

  it("matches service-principal phrasing to app registrations", () => {
    const suggestion = suggestAgentForQuestion(
      "Which service principals have old credentials?",
      installedAgents,
    );

    expect(suggestion?.agent.slug).toBe("dormant-app-registrations");
  });
});

function agent(overrides: {
  slug: string;
  name: string;
  description: string;
  category: AgentSummary["category"];
  mode: AgentSummary["mode"];
  scopes: string[];
}): AgentSummary {
  return {
    id: overrides.slug,
    slug: overrides.slug,
    name: overrides.name,
    description: overrides.description,
    mode: overrides.mode,
    category: overrides.category,
    tier: "agent",
    requiresEntraTier: "free",
    scopes: overrides.scopes,
    author: { name: "OpenAdminOS", verified: true },
    version: "0.1.0",
    installedAt: "2026-07-05T10:00:00.000Z",
  };
}
