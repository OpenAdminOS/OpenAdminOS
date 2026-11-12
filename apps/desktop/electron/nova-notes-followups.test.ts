import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AppState, NovaProfile, SecretAccessor, SendIntuneChatMessageResult } from "@openadminos/agent-sdk";

import type { AuditLogEventSeed } from "./audit-log.js";
import { NOVA_VOICE_CONSENT_NOT_KEPT, prepareNovaFollowUp, type NovaActionHost } from "./nova-actions.js";
import { NovaFollowUps } from "./nova-followups.js";
import { NOVA_NOTE_CHANGED, NovaMemory, openNovaDatabase } from "./nova-memory.js";
import { NOVA_NOTES_UNREADABLE_NOTICE, NOVA_SESSION_PROFILE_CHANGED, NovaService, type NovaChatOptions } from "./nova.js";
import { defaultNovaSettings } from "./nova-test-settings.js";
import { NOVA_PROFILE_SHORTENED_NOTICE, effectiveNovaProfile } from "./nova-profile.js";
import { novaCommand, parseNovaCommand } from "../src/shared/nova-command.js";

function fixture(options: { profile?: NovaProfile; memoryOff?: boolean } = {}) {
  const live = { profile: options.profile };
  const values = new Map<string, string>([["api-key", "test-key"]]);
  const secrets: SecretAccessor = { get: async (k) => values.get(k), set: async (k, v) => { values.set(k, v); }, remove: async (k) => { values.delete(k); } };
  const state = {
    activeTenantId: "tenant-a",
    activeProviderId: "ollama",
    activeOrganizationId: "org-a",
    organizations: [{ id: "org-a", name: "Northwind", createdAt: "", connections: { microsoft365: { tenantId: "tenant-a" } } }],
    tenants: [{ id: "tenant-a", displayName: "Northwind" }],
    providers: [{ id: "ollama", name: "Ollama", isLocal: true, status: "connected", models: ["llama3"] }],
    installedAgents: [],
  } as unknown as AppState;
  const events: AuditLogEventSeed[] = [];
  const db = openNovaDatabase(":memory:");
  const memory = new NovaMemory(db, { audit: (batch) => events.push(...batch) });
  const followUps = new NovaFollowUps(db, { audit: (batch) => events.push(...batch) });
  const consents: Array<Record<string, unknown>> = [];
  const chatOptions: NovaChatOptions[] = [];
  const requests: Array<{ url: string; body?: string }> = [];
  const settings = () => {
    const base = defaultNovaSettings(live.profile);
    return options.memoryOff ? { ...base, effective: { ...base.effective, memoryEnabled: false, locked: { ...base.effective.locked, memory: true } } } : base;
  };
  const host: NovaActionHost = {
    profile: async () => settings(),
    activeTenantId: async () => state.activeTenantId,
    connectors: async () => [],
    send: async () => { throw new Error("Nova must not send in these tests."); },
    startRun: async () => { throw new Error("Nova must not start runs in these tests."); },
    recordVoiceConsent: (input) => { consents.push(input); },
    notes: {
      promptNotes: async (tenantId) => (settings().effective.memoryEnabled ? memory.promptNotes(tenantId) : []),
      propose: async (input) => memory.propose({ ...input, organizationId: "org-a" }),
      confirm: async (id, _tenantId, expectedText) => memory.confirm(id, expectedText),
      forget: async (id) => memory.forget(id),
      discardProposed: async (id) => memory.discardProposed(id),
    },
    followUps: {
      check: async (minutes) => followUps.checkLimits(minutes),
      create: async (input) => followUps.create({ ...input, organizationId: "org-a", providerLocal: true }),
    },
  };
  const nova = new NovaService(
    secrets,
    async () => state,
    async (_input, chatOption) => {
      chatOptions.push(chatOption);
      return { conversation: { id: "conversation-a" }, assistantMessage: { content: "42 devices", status: "completed" } } as SendIntuneChatMessageResult;
    },
    async (url, init) => {
      requests.push({ url: String(url), body: init?.body ? String(init.body) : undefined });
      return Response.json({ transport: { sdp: "answer" } });
    },
    host,
  );
  return { nova, memory, followUps, events, consents, chatOptions, requests, state, host, live };
}

async function start(f: ReturnType<typeof fixture>, mode: "local" | "openai" = "local") {
  const { sessionId } = await f.nova.handle({ action: "start", mode, tenantId: "tenant-a", consent: mode === "openai", ...(mode === "openai" ? { sdp: "v=0" } : {}) });
  return sessionId!;
}

describe("Nova commands for notes and follow-ups", () => {
  it("reads remember and check-again requests, and leaves other wordings alone", () => {
    assert.deepEqual(novaCommand("Remember that the Berlin office uses the Kiosk profile."), { kind: "remember", text: "the Berlin office uses the Kiosk profile.", source: "user-said" });
    assert.equal(novaCommand("Remember to check the Berlin devices")?.kind === "remember", false);
    assert.deepEqual(novaCommand("Check compliance again in an hour"), { kind: "follow-up", question: "Check compliance", minutes: 60 });
    assert.deepEqual(novaCommand("In 30 minutes, look at the failed app installs again"), { kind: "follow-up", question: "Look at the failed app installs", minutes: 30 });
    assert.deepEqual(novaCommand("recheck the encryption report again in 2 days"), { kind: "follow-up", question: "Check the encryption report", minutes: 2880 });
    assert.equal(novaCommand("Send the compliance report every day")?.kind, "clarify");
    assert.deepEqual(parseNovaCommand('{"kind":"follow-up","question":"Check compliance","minutes":90}', { agents: [] }), { kind: "follow-up", question: "Check compliance", minutes: 90 });
    assert.deepEqual(parseNovaCommand('{"kind":"remember","text":"We use Autopilot for every new laptop"}', { agents: [] }), { kind: "remember", text: "We use Autopilot for every new laptop", source: "nova-proposed" });
    assert.equal(parseNovaCommand(`{"kind":"remember","text":"${"x".repeat(301)}"}`, { agents: [] }).kind, "clarify");
  });
});

describe("Nova notes", () => {
  it("stores a note for review when it prepares the card, and only the click confirms it", async () => {
    const f = fixture();
    const sessionId = await start(f);
    const prepared = await f.nova.handle({ action: "answer", sessionId, text: "Remember that the Berlin office uses the Kiosk profile." });
    assert.equal(prepared.pendingAction?.kind, "remember");
    assert.equal(prepared.pendingAction?.target, "Northwind");
    assert.equal(prepared.pendingAction?.body, "the Berlin office uses the Kiosk profile.");
    assert.match(prepared.pendingAction?.deliveryNote ?? "", /You asked for this note/);
    const [note] = f.memory.list("tenant-a");
    assert.equal(note?.reviewState, "proposed");
    assert.equal(note?.sessionId, sessionId);
    assert.ok(note?.turnId);
    assert.deepEqual(f.memory.promptNotes("tenant-a"), []);
    const spoken = await f.nova.handle({ action: "answer", sessionId, text: "Yes" });
    assert.match(spoken.text!, /Use the confirmation button/);
    assert.equal(f.memory.list("tenant-a")[0]?.reviewState, "proposed");
    const done = await f.nova.handle({ action: "decide-action", sessionId, actionId: spoken.pendingAction!.id, approved: true });
    assert.match(done.text!, /Nova will remember this in Northwind/);
    assert.equal(f.memory.list("tenant-a")[0]?.reviewState, "confirmed");
    assert.deepEqual(f.memory.promptNotes("tenant-a"), ["the Berlin office uses the Kiosk profile."]);
  });

  it("forgets the note when the card is cancelled", async () => {
    const f = fixture();
    const sessionId = await start(f);
    const prepared = await f.nova.handle({ action: "answer", sessionId, text: "Remember that we never wipe kiosks." });
    const cancelled = await f.nova.handle({ action: "decide-action", sessionId, actionId: prepared.pendingAction!.id, approved: false });
    assert.match(cancelled.text!, /did not keep the note/);
    assert.deepEqual(f.memory.list("tenant-a"), []);
    assert.ok(f.events.some((event) => event.type === "nova.memory-note-forgotten"));
  });

  it("does not confirm a note from its card after the note was edited or confirmed in Settings", async () => {
    for (const change of ["edit", "confirm", "forget"] as const) {
      const f = fixture();
      const sessionId = await start(f);
      const prepared = await f.nova.handle({ action: "answer", sessionId, text: "Remember that Berlin uses kiosks" });
      assert.equal(prepared.pendingAction?.kind, "remember", change);
      const note = f.memory.list("tenant-a")[0]!;
      if (change === "edit") f.memory.edit(note.id, "Berlin and Munich use kiosks.");
      else if (change === "confirm") f.memory.confirm(note.id);
      else f.memory.forget(note.id);
      const result = await f.nova.handle({ action: "decide-action", sessionId, actionId: prepared.pendingAction!.id, approved: true });
      assert.equal(result.answerError?.includes(NOVA_NOTE_CHANGED) ?? result.text?.includes(NOVA_NOTE_CHANGED), true, `${change}: ${JSON.stringify(result)}`);
      if (change === "edit") assert.equal(f.memory.get(note.id)?.text, "Berlin and Munich use kiosks.");
    }
  });

  it("keeps a note confirmed in Settings when its card is cancelled afterwards", async () => {
    const f = fixture();
    const sessionId = await start(f);
    const prepared = await f.nova.handle({ action: "answer", sessionId, text: "Remember that we never wipe kiosks." });
    const [note] = f.memory.list("tenant-a");
    f.memory.confirm(note!.id);
    await f.nova.handle({ action: "decide-action", sessionId, actionId: prepared.pendingAction!.id, approved: false });
    assert.equal(f.memory.list("tenant-a")[0]?.reviewState, "confirmed");
    assert.equal(f.events.some((event) => event.type === "nova.memory-note-forgotten"), false);
  });

  it("keeps notes out when the IT policy turns them off, and stores none", async () => {
    const f = fixture({ memoryOff: true });
    const confirmed = f.memory.propose({ tenantId: "tenant-a", text: "Kept but unused", source: "user-said" });
    f.memory.confirm(confirmed.id);
    const sessionId = await start(f);
    const refused = await f.nova.handle({ action: "answer", sessionId, text: "Remember that Contoso owns the kiosks." });
    assert.match(refused.answerError!, /IT department turned Nova notes off/);
    assert.equal(f.memory.list("tenant-a").length, 1);
    await f.nova.handle({ action: "answer", sessionId, text: "How many devices?" });
    assert.equal(f.chatOptions.at(-1)!.voiceProfile?.notes, undefined);
  });

  it("refuses a note while notes are paused", async () => {
    const f = fixture({ profile: { memoryPaused: true } });
    const sessionId = await start(f);
    const refused = await f.nova.handle({ action: "answer", sessionId, text: "Remember that Contoso owns the kiosks." });
    assert.match(refused.answerError!, /notes are paused/);
    assert.deepEqual(f.memory.list("tenant-a"), []);
  });

  it("gives confirmed notes, never proposed ones, to the hosted and the local prompt, and says so in the consent", async () => {
    const f = fixture();
    const confirmed = f.memory.propose({ tenantId: "tenant-a", text: "Kiosks are in Berlin", source: "user-said" });
    f.memory.confirm(confirmed.id);
    f.memory.propose({ tenantId: "tenant-a", text: "Unreviewed guess", source: "nova-proposed" });
    const sessionId = await start(f, "openai");
    const body = JSON.parse(f.requests.find((request) => request.url.includes("/live/sessions"))!.body!);
    assert.match(body.session.instructions, /Kiosks are in Berlin/);
    assert.doesNotMatch(body.session.instructions, /Unreviewed guess/);
    assert.equal(f.consents[0]!.includesMemory, true);
    await f.nova.handle({ action: "answer", sessionId, text: "How many devices?" });
    assert.deepEqual(f.chatOptions.at(-1)!.voiceProfile?.notes, ["Kiosks are in Berlin"]);
  });
});

describe("Nova settings changed during a session", () => {
  it("leaves a note paused or forgotten mid-session out of the next local answer", async () => {
    const f = fixture();
    const note = f.memory.propose({ tenantId: "tenant-a", text: "Kiosks are in Berlin", source: "user-said" });
    f.memory.confirm(note.id);
    const sessionId = await start(f);
    await f.nova.handle({ action: "answer", sessionId, text: "How many devices?" });
    assert.deepEqual(f.chatOptions.at(-1)!.voiceProfile?.notes, ["Kiosks are in Berlin"]);
    f.live.profile = { memoryPaused: true };
    await f.nova.handle({ action: "answer", sessionId, text: "How many devices now?" });
    assert.equal(f.chatOptions.at(-1)!.voiceProfile?.notes, undefined);
    f.live.profile = undefined;
    f.memory.forget(note.id);
    let calls = f.chatOptions.length;
    await f.nova.handle({ action: "answer", sessionId, text: "How many Windows devices are there?" });
    assert.equal(f.chatOptions.length, calls + 1);
    assert.equal(f.chatOptions.at(-1)!.voiceProfile?.notes, undefined);
    f.live.profile = { instructions: "Answer in German." };
    calls = f.chatOptions.length;
    await f.nova.handle({ action: "answer", sessionId, text: "How many macOS devices are there?" });
    assert.equal(f.chatOptions.length, calls + 1);
    assert.equal(f.chatOptions.at(-1)!.voiceProfile?.effective.instructions, "Answer in German.");
  });

  it("ends a hosted session whose notes were forgotten or whose instructions changed, and keeps one that only gained a note", async () => {
    const f = fixture();
    const note = f.memory.propose({ tenantId: "tenant-a", text: "Kiosks are in Berlin", source: "user-said" });
    f.memory.confirm(note.id);
    let sessionId = await start(f, "openai");
    const added = f.memory.propose({ tenantId: "tenant-a", text: "Laptops are in Munich", source: "user-said" });
    f.memory.confirm(added.id);
    await f.nova.handle({ action: "answer", sessionId, text: "How many devices?" });
    f.memory.forget(note.id);
    await assert.rejects(f.nova.handle({ action: "answer", sessionId, text: "How many devices now?" }), { message: NOVA_SESSION_PROFILE_CHANGED });
    await assert.rejects(f.nova.handle({ action: "answer", sessionId, text: "Still there?" }), /Start a new conversation/);
    sessionId = await start(f, "openai");
    f.live.profile = { instructions: "Answer in German." };
    await assert.rejects(f.nova.handle({ action: "answer", sessionId, text: "How many devices?" }), { message: NOVA_SESSION_PROFILE_CHANGED });
    sessionId = await start(f, "openai");
    f.live.profile = { instructions: "Answer in German.", memoryPaused: true };
    await assert.rejects(f.nova.handle({ action: "answer", sessionId, text: "How many devices?" }), { message: NOVA_SESSION_PROFILE_CHANGED });
  });
});

describe("Nova hosted sessions after a settings change, without another question", () => {
  it("ends the session when a note it received is forgotten or paused, and keeps it otherwise", async () => {
    const f = fixture();
    const note = f.memory.propose({ tenantId: "tenant-a", text: "Kiosks are in Berlin", source: "user-said" });
    f.memory.confirm(note.id);
    let sessionId = await start(f, "openai");
    // A new note was not given to OpenAI, so it changes nothing.
    f.memory.confirm(f.memory.propose({ tenantId: "tenant-a", text: "Laptops are in Munich", source: "user-said" }).id);
    assert.equal(await f.nova.revalidateHostedSession(), false);
    f.memory.forget(note.id);
    assert.equal(await f.nova.revalidateHostedSession(), true);
    await assert.rejects(f.nova.handle({ action: "answer", sessionId, text: "How many devices?" }), /Start a new conversation/);
    sessionId = await start(f, "openai");
    f.live.profile = { memoryPaused: true };
    assert.equal(await f.nova.revalidateHostedSession(), true);
    // A local session holds no prompt at OpenAI; it reads notes per answer instead.
    f.live.profile = undefined;
    sessionId = await start(f, "local");
    f.live.profile = { instructions: "Answer in German." };
    assert.equal(await f.nova.revalidateHostedSession(), false);
    void sessionId;
  });

  it("does not send instructions that changed while a hosted session was starting", async () => {
    const f = fixture({ profile: { instructions: "Answer in English." } });
    let release: (() => void) | undefined;
    const read = f.host.notes!.promptNotes;
    f.host.notes!.promptNotes = async (tenantId) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return read(tenantId);
    };
    const starting = start(f, "openai");
    for (let index = 0; index < 100 && !release; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(release, "the start is reading the profile");
    f.live.profile = { instructions: "Answer in German." };
    // No session yet, so nothing to end; the start must notice by itself.
    assert.equal(await f.nova.revalidateHostedSession(), false);
    f.host.notes!.promptNotes = read;
    release!();
    await assert.rejects(starting, { message: NOVA_SESSION_PROFILE_CHANGED });
    assert.equal(f.requests.some((request) => request.url.includes("/live/sessions")), false, "the old instructions did not go to OpenAI");
    assert.equal(f.consents.length, 0);
  });

  it("sends the starting organization's own instructions, and nothing, after a switch to another organization", async () => {
    const f = fixture({ profile: { addenda: { "org-a": "Northwind uses kiosks.", "org-b": "Fabrikam uses shared iPads." } } });
    const state = f.state as unknown as { activeTenantId: string; activeOrganizationId: string; organizations: unknown[]; tenants: unknown[] };
    state.organizations.push({ id: "org-b", name: "Fabrikam", createdAt: "", connections: { microsoft365: { tenantId: "tenant-b" } } });
    state.tenants.push({ id: "tenant-b", displayName: "Fabrikam" });
    const organizationOf = (tenantId?: string) => (tenantId ?? state.activeTenantId) === "tenant-b" ? "org-b" : "org-a";
    f.host.profile = async (tenantId?: string) => ({ ...defaultNovaSettings(f.live.profile), effective: effectiveNovaProfile(f.live.profile, undefined, organizationOf(tenantId)) });
    let release: (() => void) | undefined;
    const read = f.host.notes!.promptNotes;
    f.host.notes!.promptNotes = async (tenantId) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return read(tenantId);
    };
    const starting = start(f, "openai");
    for (let index = 0; index < 100 && !release; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(release, "the start is reading the profile");
    state.activeTenantId = "tenant-b";
    state.activeOrganizationId = "org-b";
    assert.equal(await f.nova.activeOrganizationChanged(), false, "no session yet");
    f.host.notes!.promptNotes = read;
    release!();
    await assert.rejects(starting, /tenant or provider changed/);
    assert.equal(f.requests.some((request) => request.url.includes("/live/sessions")), false, "nothing went to OpenAI");
    assert.equal(f.requests.some((request) => request.body?.includes("Fabrikam uses shared iPads.")), false, "the other organization's instructions were not sent");
    assert.equal(f.consents.length, 0);
  });

  it("reads a session's own organization instructions, not the active organization's", async () => {
    const f = fixture({ profile: { addenda: { "org-a": "Northwind uses kiosks." } } });
    const tenants: Array<string | undefined> = [];
    f.host.profile = async (tenantId?: string) => { tenants.push(tenantId); return defaultNovaSettings(f.live.profile); };
    const sessionId = await start(f);
    await f.nova.handle({ action: "answer", sessionId, text: "How many devices are noncompliant?" });
    // Ability checks read the settings without a tenant; the session's own reads name it.
    const named = tenants.filter((tenantId) => tenantId !== undefined);
    assert.ok(named.length >= 2, "the start and the answer read the session's organization");
    assert.ok(named.every((tenantId) => tenantId === "tenant-a"), named.join(", "));
  });

  it("ends a live session when another organization becomes active", async () => {
    const f = fixture();
    const sessionId = await start(f);
    assert.equal(await f.nova.activeOrganizationChanged(), false, "the same organization keeps its session");
    (f.state as unknown as { activeTenantId: string }).activeTenantId = "tenant-b";
    assert.equal(await f.nova.activeOrganizationChanged(), true);
    await assert.rejects(f.nova.handle({ action: "answer", sessionId, text: "How many devices?" }), /tenant or provider changed/);
  });

  it("does not send a note forgotten while a hosted start reads its profile a second time", async () => {
    const f = fixture();
    const note = f.memory.confirm(f.memory.propose({ tenantId: "tenant-a", text: "Berlin uses kiosks.", source: "user-said" }).id);
    let release: (() => void) | undefined;
    const read = f.host.notes!.promptNotes;
    f.host.notes!.promptNotes = async (tenantId) => {
      const notes = await read(tenantId);
      await new Promise<void>((resolve) => { release = resolve; });
      return notes;
    };
    const wait = async () => { for (let index = 0; index < 100 && !release; index += 1) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(release); };
    const starting = start(f, "openai");
    await wait();
    // Something changed during the first read: the start reads again.
    await f.nova.revalidateHostedSession();
    let first = release!; release = undefined; first();
    await wait();
    // During that second read a change is announced and its check finds
    // nothing yet; then the note is forgotten before any other check runs.
    f.host.notes!.promptNotes = read;
    assert.equal(await f.nova.revalidateHostedSession(), false);
    f.memory.forget(note.id);
    first = release!; release = undefined; first();
    await assert.rejects(starting, { message: NOVA_SESSION_PROFILE_CHANGED });
    assert.equal(f.requests.some((request) => request.url.includes("/live/sessions")), false, "the forgotten note did not go to OpenAI");
    assert.equal(f.consents.length, 0);
  });

  it("sends nothing when the provider is switched while a hosted start reads its connectors, with no change announced", async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    f.host.connectors = async () => { await new Promise<void>((resolve) => { release = resolve; }); return []; };
    const starting = start(f, "openai");
    for (let index = 0; index < 100 && !release; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(release, "the start is reading its connectors");
    const state = f.state as unknown as { activeProviderId: string; providers: unknown[] };
    state.providers.push({ id: "lm-studio", name: "LM Studio", isLocal: true, status: "connected", models: ["qwen"] });
    state.activeProviderId = "lm-studio";
    release!();
    await assert.rejects(starting, /tenant or provider changed/);
    assert.equal(f.requests.some((request) => request.url.includes("/live/sessions")), false, "nothing went to OpenAI");
    assert.equal(f.consents.length, 0);
  });

  it("sends nothing when the organization is disconnected while a hosted start reads its key, with no change announced", async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    let closed = false;
    f.host.activeTenantId = async () => (closed ? undefined : "tenant-a");
    const nova = f.nova as unknown as { secrets: SecretAccessor };
    const get = nova.secrets.get;
    nova.secrets = { ...nova.secrets, get: async (key) => { await new Promise<void>((resolve) => { release = resolve; }); return get(key); } };
    const starting = start(f, "openai");
    for (let index = 0; index < 100 && !release; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(release, "the start is reading the API key");
    closed = true;
    release!();
    await assert.rejects(starting, /tenant or provider changed/);
    assert.equal(f.requests.some((request) => request.url.includes("/live/sessions")), false, "nothing went to OpenAI");
    assert.equal(f.consents.length, 0);
  });

  it("sends nothing when the provider endpoint moved while a hosted start reads its connectors", async () => {
    const f = fixture();
    let endpoint = "http://127.0.0.1:11434";
    f.host.providerEndpoint = async () => endpoint;
    let release: (() => void) | undefined;
    f.host.connectors = async () => { await new Promise<void>((resolve) => { release = resolve; }); return []; };
    const starting = start(f, "openai");
    for (let index = 0; index < 100 && !release; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(release);
    endpoint = "http://10.0.0.5:11434";
    release!();
    await assert.rejects(starting, /tenant or provider changed/);
    assert.equal(f.consents.length, 0);
  });

  it("ends a live session when its provider or model changes", async () => {
    const f = fixture();
    const sessionId = await start(f);
    assert.equal(await f.nova.sessionContextChanged(), false, "nothing changed");
    const state = f.state as unknown as { activeProviderId: string; providers: unknown[] };
    state.providers.push({ id: "lm-studio", name: "LM Studio", isLocal: true, status: "connected", models: ["qwen"] });
    state.activeProviderId = "lm-studio";
    assert.equal(await f.nova.sessionContextChanged(), true);
    await assert.rejects(f.nova.handle({ action: "answer", sessionId, text: "How many devices?" }));
  });

  it("ends a live session when its organization is connected again with another sign-in", async () => {
    const f = fixture();
    const tenants = (f.state as unknown as { tenants: Array<Record<string, unknown>> }).tenants;
    tenants[0] = { ...tenants[0], connectionId: "connection-1", username: "admin@northwind.example", homeAccountId: "home-1" };
    const sessionId = await start(f, "openai");
    assert.equal(await f.nova.sessionContextChanged(), false, "nothing changed");
    tenants[0] = { ...tenants[0], connectionId: "connection-2", username: "other@northwind.example", homeAccountId: "home-2" };
    assert.equal(await f.nova.sessionContextChanged(), true);
    await assert.rejects(f.nova.handle({ action: "answer", sessionId, text: "How many devices?" }));
  });

  it("sends nothing when the organization is connected again while a hosted start reads its connectors", async () => {
    const f = fixture();
    const tenants = (f.state as unknown as { tenants: Array<Record<string, unknown>> }).tenants;
    tenants[0] = { ...tenants[0], connectionId: "connection-1", username: "admin@northwind.example", homeAccountId: "home-1" };
    let release: (() => void) | undefined;
    f.host.connectors = async () => { await new Promise<void>((resolve) => { release = resolve; }); return []; };
    const starting = start(f, "openai");
    for (let index = 0; index < 100 && !release; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(release, "the start is reading its connectors");
    tenants[0] = { ...tenants[0], connectionId: "connection-2" };
    release!();
    await assert.rejects(starting, /tenant or provider changed/);
    assert.equal(f.requests.some((request) => request.url.includes("/live/sessions")), false, "nothing went to OpenAI");
    assert.equal(f.consents.length, 0);
  });

  it("says the settings could not be read when a shortcut is asked for and they cannot be", async () => {
    const f = fixture({ profile: { shortcuts: [{ id: "s1", name: "Morning check", prompt: "How many devices are noncompliant?", createdAt: "2026-11-12T08:00:00.000Z" }] } });
    const sessionId = await start(f);
    f.host.profile = async () => { throw new Error("state.json is locked"); };
    const answer = await f.nova.handle({ action: "answer", sessionId, text: "Run morning check" }).catch((error: Error) => ({ text: error.message, answerError: error.message }));
    assert.match(answer.answerError ?? "", /could not read its settings/);
  });

  it("ends the session when the settings cannot be read", async () => {
    const f = fixture();
    await start(f, "openai");
    f.host.profile = async () => { throw new Error("state.json unreadable"); };
    assert.equal(await f.nova.revalidateHostedSession(), true);
  });
});

describe("Nova sends", () => {
  it("refuses a connector Nova may not send to before any tenant research", async () => {
    const f = fixture({ profile: { connectorSends: { slack: false } } });
    f.host.connectors = async () => [{ descriptor: { id: "slack", name: "Slack" }, status: "connected", config: { defaultChannel: "C1" } }] as never;
    const sessionId = await start(f);
    const calls = f.chatOptions.length;
    const answer = await f.nova.handle({ action: "answer", sessionId, text: "Send me the noncompliant devices via Slack" });
    assert.match(answer.answerError ?? "", /Sending through Slack is turned off/);
    assert.equal(f.chatOptions.length, calls, "no tenant research ran for a message that cannot be sent");
  });
});

describe("Nova hosted voice consent", () => {
  it("does not start hosted voice when the consent was kept nowhere", async () => {
    const f = fixture();
    f.host.recordVoiceConsent = () => { throw new Error(NOVA_VOICE_CONSENT_NOT_KEPT); };
    await assert.rejects(start(f, "openai"), { message: NOVA_VOICE_CONSENT_NOT_KEPT });
    assert.equal(f.requests.some((request) => request.url.includes("/live/sessions")), false, "nothing went to OpenAI");
    delete f.host.recordVoiceConsent;
    await assert.rejects(start(f, "openai"), { message: NOVA_VOICE_CONSENT_NOT_KEPT });
    assert.equal(f.requests.length, 0);
  });

  it("records and watches only the notes that fit the hosted prompt", async () => {
    // Long instructions and notes of three-byte characters leave room for only some notes.
    const f = fixture({ profile: { instructions: "Answer with care. ".repeat(222).trim() } });
    for (let index = 0; index < 6; index += 1) f.memory.confirm(f.memory.propose({ tenantId: "tenant-a", text: `Note ${index} ${"€".repeat(280)}`, source: "user-said" }).id);
    await start(f, "openai");
    const body = JSON.parse(f.requests.find((request) => request.url.includes("/live/sessions"))!.body!);
    const sent = f.memory.list("tenant-a").filter((note) => body.session.instructions.includes(JSON.stringify(note.text).slice(1, -1)));
    assert.equal(f.consents[0]!.includesMemory, sent.length > 0);
    // Forgetting a note OpenAI never received does not end the session.
    assert.ok(sent.length > 0, "some notes fit");
    const unsent = f.memory.list("tenant-a").find((note) => !sent.some((entry) => entry.id === note.id));
    assert.ok(unsent, "some notes did not fit");
    f.memory.forget(unsent.id);
    assert.equal(await f.nova.revalidateHostedSession(), false);
  });

  it("says once, at the start, when the reasoning model gets a shortened profile", async () => {
    const f = fixture({ profile: { instructions: "Answer in short sentences and name the source of each fact. ".repeat(60).slice(0, 3000) } });
    const full = await f.nova.handle({ action: "start", mode: "local", tenantId: "tenant-a", consent: false });
    assert.equal(full.notice, undefined, "a full-size model gets all of it");
    const state = f.state as unknown as { activeProviderId: string; providers: unknown[] };
    state.providers.push({ id: "apple-foundation", name: "Apple Intelligence", isLocal: true, status: "connected", models: ["apple"] });
    state.activeProviderId = "apple-foundation";
    const small = await f.nova.handle({ action: "start", mode: "local", tenantId: "tenant-a", consent: false });
    assert.equal(small.notice, NOVA_PROFILE_SHORTENED_NOTICE);
  });

  it("tells the admin when the notes could not be read at the start", async () => {
    const f = fixture();
    f.host.notes!.promptNotes = async () => { throw new Error("openadminos.db locked"); };
    const started = await f.nova.handle({ action: "start", mode: "local", tenantId: "tenant-a", consent: false });
    assert.equal(started.notice, NOVA_NOTES_UNREADABLE_NOTICE);
  });
});

describe("Nova follow-ups", () => {
  it("sets nothing until the click, then one read-only follow-up in the organization", async () => {
    const f = fixture();
    const sessionId = await start(f);
    const prepared = await f.nova.handle({ action: "answer", sessionId, text: "Check compliance again in an hour" });
    assert.equal(prepared.pendingAction?.kind, "follow-up");
    assert.equal(prepared.pendingAction?.target, "Northwind");
    assert.equal(prepared.pendingAction?.body, "Check compliance");
    assert.match(prepared.pendingAction?.deliveryNote ?? "", /Read-only\. Sending the result anywhere still needs your click\./);
    assert.match(prepared.pendingAction?.deliveryNote ?? "", /Ollama · llama3/);
    assert.equal(f.followUps.pendingCount(), 0);
    const done = await f.nova.handle({ action: "decide-action", sessionId, actionId: prepared.pendingAction!.id, approved: true });
    assert.match(done.text!, /Nova asks this again/);
    const [followUp] = f.followUps.list("tenant-a");
    assert.equal(followUp?.question, "Check compliance");
    assert.equal(followUp?.status, "pending");
    assert.equal(followUp?.model, "llama3");
  });

  it("refuses a follow-up that would send or run something, and one over the limits", async () => {
    const f = fixture();
    const sessionId = await start(f);
    const sends = await f.nova.handle({ action: "answer", sessionId, text: "Check compliance and email the result again in an hour" });
    assert.notEqual(sends.pendingAction?.kind, "follow-up");
    const late = await f.nova.handle({ action: "answer", sessionId, text: "Check compliance again in 8 days" });
    assert.match(late.answerError!, /at most 7 days/);
    for (let index = 0; index < 5; index += 1) f.followUps.create({ tenantId: "tenant-a", question: "Check", providerId: "ollama", delayMinutes: 60, providerLocal: true });
    const full = await f.nova.handle({ action: "answer", sessionId, text: "Check compliance again in an hour" });
    assert.match(full.answerError!, /already have 5 pending follow-ups/);
  });

  it("refuses an over-long or empty question before the card, not after the click", async () => {
    const f = fixture();
    await assert.rejects(prepareNovaFollowUp({ question: "Check ".repeat(120), minutes: 60 }, f.state, f.host), /at most 600 characters/);
    await assert.rejects(prepareNovaFollowUp({ question: "   ", minutes: 60 }, f.state, f.host), /needs a question/);
    assert.equal(f.followUps.pendingCount(), 0);
  });
});
