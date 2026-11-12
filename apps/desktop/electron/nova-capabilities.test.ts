import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AppState, ConnectorSummary, ManagedPolicyStatus, NovaProfile, NovaProfilePatch } from "@openadminos/agent-sdk";

import {
  NOVA_PROFILE_CHANGED,
  NOVA_SETTINGS_UNREADABLE,
  prepareNovaAction,
  prepareNovaProfileChange,
  type NovaActionHost,
  type NovaSettings,
} from "./nova-actions.js";
import { effectiveNovaProfile } from "./nova-profile.js";

const state = {
  activeTenantId: "tenant-a",
  activeProviderId: "ollama",
  tenants: [{ id: "tenant-a", displayName: "Northwind", username: "admin@example.test" }],
  installedAgents: [{ name: "Find inactive devices", slug: "find-inactive-devices" }],
} as AppState;

function policy(values: ManagedPolicyStatus["values"], locked: ManagedPolicyStatus["locked"] = []): ManagedPolicyStatus {
  return { path: "/policy.json", values, locked, issues: [] } as unknown as ManagedPolicyStatus;
}

function host(initial: { profile?: NovaProfile; policy?: ManagedPolicyStatus } = {}) {
  let profile = initial.profile;
  let managed = initial.policy;
  let failing = false;
  const sends: unknown[] = [];
  const runs: unknown[] = [];
  const saved: NovaProfilePatch[] = [];
  const connectors = [{ descriptor: { id: "slack", name: "Slack" }, status: "connected", config: { defaultChannel: "C1", defaultChannelLabel: "ops" } }] as unknown as ConnectorSummary[];
  const value: NovaActionHost = {
    profile: async (): Promise<NovaSettings> => {
      if (failing) throw new Error("state.json could not be read");
      return { profile, effective: effectiveNovaProfile(profile, managed), policy: managed };
    },
    applyProfileProposal: async (patch) => { saved.push(patch); },
    activeTenantId: async () => state.activeTenantId,
    connectors: async () => connectors,
    send: async (input) => { sends.push(input); return {}; },
    startRun: async (...args) => { runs.push(args); return { id: "run-1" } as never; },
  };
  return {
    host: value,
    sends,
    runs,
    saved,
    set(next: NovaProfile | undefined) { profile = next; },
    setPolicy(next: ManagedPolicyStatus | undefined) { managed = next; },
    fail() { failing = true; },
  };
}

describe("Nova abilities are enforced in code", () => {
  it("refuses an agent run when starting agents is off, before the card", async () => {
    const f = host({ profile: { capabilities: { startAgents: false } } });
    await assert.rejects(prepareNovaAction("run Find inactive devices", undefined, state, f.host), /Starting agents is turned off in Settings, Nova/);
    assert.equal(f.runs.length, 0);
  });

  it("names the IT department when the policy turns an ability off", async () => {
    const f = host({ policy: policy({ novaCapabilities: { startAgents: false } }) });
    await assert.rejects(prepareNovaAction("run Find inactive devices", undefined, state, f.host), /turned off for Nova by your IT department/);
  });

  it("refuses a send through a connector that is turned off", async () => {
    const f = host({ profile: { connectorSends: { slack: false } } });
    await assert.rejects(prepareNovaAction("send this via Slack", "Report", state, f.host), /Sending through Slack is turned off in Settings, Nova/);
    assert.equal(f.sends.length, 0);
  });

  it("refuses a send outside the IT allow-list of connectors", async () => {
    const f = host({ policy: policy({ novaCapabilities: { connectorSends: ["outlook"] } }) });
    await assert.rejects(prepareNovaAction("send this via Slack", "Report", state, f.host), /by your IT department/);
  });

  it("fails closed when the settings cannot be read", async () => {
    const f = host();
    f.fail();
    await assert.rejects(prepareNovaAction("run Find inactive devices", undefined, state, f.host), new RegExp(NOVA_SETTINGS_UNREADABLE.slice(0, 40)));
    await assert.rejects(prepareNovaAction("send this via Slack", "Report", state, f.host), new RegExp(NOVA_SETTINGS_UNREADABLE.slice(0, 40)));
  });

  it("checks again at the click: a switch turned off after the card stops the run and the send", async () => {
    const f = host();
    const run = await prepareNovaAction("run Find inactive devices", undefined, state, f.host);
    const send = await prepareNovaAction("send this via Slack", "Report", state, f.host);
    f.set({ capabilities: { startAgents: false }, connectorSends: { slack: false } });
    await assert.rejects(run!.execute(new AbortController().signal), /Starting agents is turned off/);
    await assert.rejects(send!.execute(new AbortController().signal), /Sending through Slack is turned off/);
    assert.equal(f.runs.length, 0);
    assert.equal(f.sends.length, 0);
  });

  it("checks again at the click: unreadable settings stop the action", async () => {
    const f = host();
    const run = await prepareNovaAction("run Find inactive devices", undefined, state, f.host);
    f.fail();
    await assert.rejects(run!.execute(new AbortController().signal), /could not read its settings/);
    assert.equal(f.runs.length, 0);
  });
});

describe("Nova settings proposals", () => {
  it("shows the old and new instructions and saves nothing until the click", async () => {
    const f = host({ profile: { instructions: "Answer in English." } });
    const prepared = await prepareNovaProfileChange({ field: "instructions", mode: "append", text: "Name device counts first." }, f.host);
    assert.equal(prepared.preview.kind, "profile");
    assert.equal(prepared.preview.previousBody, "Answer in English.");
    assert.equal(prepared.preview.body, "Answer in English.\nName device counts first.");
    assert.equal(f.saved.length, 0);
    const result = await prepared.execute(new AbortController().signal);
    assert.deepEqual(f.saved, [{ instructions: "Answer in English.\nName device counts first." }]);
    assert.match(result.text, /next conversation/);
  });

  it("refuses a change to instructions the IT department locked, before the card", async () => {
    const f = host({ policy: policy({ novaInstructions: "IT text." }, ["novaInstructions"]) });
    await assert.rejects(prepareNovaProfileChange({ field: "instructions", mode: "replace", text: "Mine." }, f.host), /Your IT department set the standing instructions/);
  });

  it("refuses instructions over the limit, before the card", async () => {
    const f = host();
    await assert.rejects(prepareNovaProfileChange({ field: "instructions", mode: "replace", text: "x".repeat(4001) }, f.host), /at most 4000 characters/);
  });

  it("turns an ability off, never on, and says so when it is already off", async () => {
    const f = host();
    const prepared = await prepareNovaProfileChange({ field: "capability", capability: "webSearch", enabled: false }, f.host);
    assert.match(prepared.preview.title, /Turn off web search/);
    await prepared.execute(new AbortController().signal);
    assert.deepEqual(f.saved, [{ capabilities: { webSearch: false } }]);
    const off = host({ profile: { capabilities: { webSearch: false } } });
    await assert.rejects(prepareNovaProfileChange({ field: "capability", capability: "webSearch", enabled: false }, off.host), /already off/);
  });

  it("does not save when the value changed between the card and the click", async () => {
    const f = host({ profile: { greetingName: "Sam" } });
    const prepared = await prepareNovaProfileChange({ field: "greetingName", text: "Alex" }, f.host);
    f.set({ greetingName: "Kim" });
    await assert.rejects(prepared.execute(new AbortController().signal), new RegExp(NOVA_PROFILE_CHANGED.slice(0, 30)));
    assert.equal(f.saved.length, 0);
  });
});
