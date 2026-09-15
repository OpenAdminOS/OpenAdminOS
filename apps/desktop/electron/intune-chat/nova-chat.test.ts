import { NovaTranscript } from "../../src/shared/nova-transcript.js";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { AppStateStore } from "../state.js";
import type { RunGraphApi, RunLlmApi } from "@openadminos/agent-sdk";

async function fixture(empty = false, deviceRows?: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), "nova-chat-review-"));
  const path = join(dir, "state.json");
  await writeFile(
    path,
    JSON.stringify({
      activeTenantId: "tenant-a",
      activeProviderId: "ollama",
      activeModelByProviderId: { ollama: "test-model" },
      installedAgents: [],
      runs: [],
      tenants: [
        {
          id: "tenant-a",
          displayName: "Contoso",
          username: "test@example.invalid",
          homeAccountId: "test",
          addedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  const calls: string[] = [];
  const prompts: Array<{ system?: string; prompt: string }> = [];
  const graph: RunGraphApi = {
    listManagedDevices: async () => [],
    retireManagedDevice: async () => {
      throw Error("Unexpected write");
    },
    request: async (input) => {
      calls.push(input.path);
      assert.equal(input.method, "GET");
      if (input.path === "/deviceManagement/managedDevices")
        return {
          value: empty
            ? []
            : deviceRows ?? [
                {
                  id: "device-1",
                  operatingSystem: "Windows",
                  isEncrypted: true,
                },
              ],
        };
      if (input.path === "/devices") return { value: [] };
      if (input.path === "/users")
        return {
          value: [
            {
              id: "user-1",
              displayName: "Guest",
              userType: "Guest",
              accountEnabled: false,
            },
          ],
        };
      return { value: [] };
    },
  };
  const llm: RunLlmApi = {
    available: true,
    defaultModel: "test-model",
    complete: async (opts) => {
      prompts.push(opts);
      return { text: "Evidence answer", model: "test-model" };
    },
    async *stream(opts) {
      prompts.push(opts);
      yield {
        delta: "Evidence answer",
        accumulated: "Evidence answer",
        done: true,
        model: "test-model",
      };
    },
  };
  const store = new AppStateStore({
    filePath: path,
    userDataPath: dir,
    statsApiUrl: "",
    tokenStore: { read: async () => "", write: async () => {} },
    graphFactory: () => graph,
    llmFactory: () => llm,
  });
  await store.setChatInvestigationMode("always-deterministic");
  return {
    store,
    llm,
    calls,
    prompts,
    cleanup: () => { store.close(); return rm(dir, { recursive: true, force: true }); },
  };
}
const options = {
  voice: true,
  scope: { tenantId: "tenant-a", providerId: "ollama" as const },
};
it("answers device availability without a model round trip and saves the evidence conversation", async () => {
  const f = await fixture();
  try {
    const result = await f.store.streamIntuneChatMessage(
      { content: "Do you see any of my devices?" },
      () => {},
      options,
    );
    assert.match(result.assistantMessage.content, /1 Intune managed devices/);
    assert.match(result.assistantMessage.content, /0 Entra device records/);
    assert.equal(result.assistantMessage.status, "completed");
    assert.equal(f.prompts.length, 0);
    assert.equal(result.assistantMessage.sources?.length, 2);
    assert.ok(result.conversation.id);
  } finally {
    await f.cleanup();
  }
});
it("reuses a fresh empty snapshot instead of repeatedly fetching it", async () => {
  const f = await fixture(true);
  try {
    await f.store.streamIntuneChatMessage(
      { content: "How many devices?" },
      () => {},
      options,
    );
    const count = f.calls.length;
    await f.store.streamIntuneChatMessage(
      { content: "How many devices?" },
      () => {},
      options,
    );
    assert.equal(f.calls.length, count);
    assert.equal(f.prompts.length, 0);
  } finally {
    await f.cleanup();
  }
});
it("rejects a changed tenant before fetching or sending any model context", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.store.streamIntuneChatMessage({ content: "Devices?" }, () => {}, {
        ...options,
        scope: { tenantId: "another-tenant", providerId: "ollama" },
      }),
      /changed/,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.prompts.length, 0);
  } finally {
    await f.cleanup();
  }
});
it("includes the prior question in voice follow-ups and bounds model input", async () => {
  const f = await fixture();
  try {
    const first = await f.store.streamIntuneChatMessage(
      { content: "Which users are guests?" },
      () => {},
      options,
    );
    const second = await f.store.streamIntuneChatMessage(
      {
        content: "Which of those are disabled?",
        conversationId: first.conversation.id,
      },
      () => {},
      options,
    );
    assert.equal(second.assistantMessage.status, "completed");
    const prompt = f.prompts.at(-1)!;
    assert.match(prompt.prompt, /Which users are guests/);
    assert.match(prompt.prompt, /Which of those are disabled/);
    assert.match(prompt.system!, /Unrelated uncached resources/);
    assert.ok(
      Buffer.byteLength(prompt.prompt) + Buffer.byteLength(prompt.system!) <=
        12000,
    );
    assert.ok(
      second.assistantMessage.sources?.some((s) => s.resource === "users"),
    );
  } finally {
    await f.cleanup();
  }
});

it("answers reported encryption and OS summaries without fetching unrelated policies", async () => {
  const f = await fixture();
  try {
    const result = await f.store.streamIntuneChatMessage(
      { content: "Are my devices encrypted?" },
      () => {},
      options,
    );
    assert.equal(result.assistantMessage.status, "completed");
    assert.match(
      result.assistantMessage.content,
      /1 report encryption enabled/,
    );
    assert.deepEqual(f.calls, ["/deviceManagement/managedDevices"]);
    assert.equal(f.prompts.length, 0);
    assert.equal(result.assistantMessage.sources?.length, 1);
  } finally {
    await f.cleanup();
  }
});


it("Nova combines tenant and public evidence, preserving citations in Chat within the voice budget", async () => {
  const f = await fixture();
  try {
    const replies = [
      JSON.stringify({ tool: "query_cache", params: { resource: "managedDevices", limit: 1 } }),
      JSON.stringify({ tool: "web_search", params: { query: "Current Windows support guidance" } }),
      JSON.stringify({ final: true, answer: "The tenant has a Windows device. Public guidance describes supported Windows releases." }),
    ];
    let searches = 0;
    f.llm.complete = async opts => {
      assert.ok(Buffer.byteLength(opts.system ?? "") + Buffer.byteLength(opts.prompt) <= 12000);
      return { text: replies.shift() ?? "Unexpected extra request", model: "test-model" };
    };
    const result = await f.store.streamIntuneChatMessage(
      { content: "Compare my devices with current Windows support guidance" }, () => {},
      { ...options, webSearch: async query => {
        assert.equal(query, "Current Windows support guidance");
        searches++;
        return { text: "Public guidance", sources: [{ title: "Vendor guidance", url: "https://learn.microsoft.com/windows" }], searchedAt: new Date().toISOString() };
      } },
    );
    assert.equal(searches, 1);
    assert.equal(result.assistantMessage.status, "completed", result.assistantMessage.content);
    assert.deepEqual(result.assistantMessage.toolTrace?.map(t => t.tool), ["query_cache", "web_search"]);
    const saved = (await f.store.getIntuneChatMessages(result.conversation.id)).find(m => m.role === "assistant")!;
    assert.equal(saved.toolTrace?.[1]?.tool, "web_search");
    assert.equal(saved.toolTrace?.[1]?.webSources?.length, 1);
    assert.match(result.assistantMessage.content, /Public web sources/);
    assert.match(result.assistantMessage.content, /https:\/\/learn.microsoft.com\/windows/);
  } finally { await f.cleanup(); }
});
it("a simple tenant count does not trigger paid web research", async () => {
  const f = await fixture();
  try {
    const result = await f.store.streamIntuneChatMessage({ content: "How many devices?" }, () => {}, {
      ...options, webSearch: async () => { assert.fail("Search was unnecessary"); },
    });
    assert.match(result.assistantMessage.content, /1 Intune managed devices/);
    assert.equal(f.prompts.length, 0);
  } finally { await f.cleanup(); }
});

it("failed web research cannot silently become an uncited current-facts answer", async () => {
  const f = await fixture();
  try {
    const replies = [JSON.stringify({ tool: "web_search", params: { query: "Recent public guidance" } }), "An unsupported current claim"];
    f.llm.complete = async () => ({ text: replies.shift()!, model: "test-model" });
    const result = await f.store.streamIntuneChatMessage({ content: "Research recent vendor guidance" }, () => {}, {
      ...options, webSearch: async () => { throw new Error("OpenAI web search failed (HTTP 429). Retry later."); },
    });
    assert.equal(result.assistantMessage.status, "failed");
    assert.match(result.assistantMessage.content, /HTTP 429/);
    assert.doesNotMatch(result.assistantMessage.content, /unsupported current claim/);
  } finally { await f.cleanup(); }
});

it("natural cached inventory phrasing skips reasoning without swallowing compound research", async () => {
  const f = await fixture();
  try {
    const samples = ["What are the currently installed OS versions on my devices?", "Hey Nova, can you tell me what is the number of Intune devices in my tenant?", "What is the encryption status of my devices?"];
    for (const content of samples) {
      const result = await f.store.streamIntuneChatMessage({ content }, () => {}, options);
      assert.equal(result.assistantMessage.status, "completed");
    }
    assert.equal(f.prompts.length, 0);
    await f.store.streamIntuneChatMessage({ content: "What are the currently installed OS versions on my devices, and what are the latest available versions?" }, () => {}, options);
    assert.ok(f.prompts.length > 0, "compound public research must still reach reasoning");
  } finally { await f.cleanup(); }
});


it("Nova can research macOS with a populated documentation index and large web evidence", async () => {
  const f = await fixture();
  try {
    f.store.retrieveDocumentation = async () => Array.from({ length: 12 }, (_, i) => ({
      file: `docs/macos-${i}.md`, title: "macOS reference", text: "Device documentation 漢字. ".repeat(400), score: 1,
    }));
    let completions = 0;
    f.llm.complete = async opts => {
      f.prompts.push(opts);
      completions++;
      assert.ok(Buffer.byteLength(opts.system ?? "") + Buffer.byteLength(opts.prompt) <= 12000);
      return { text: completions === 1
        ? JSON.stringify({ tool: "web_search", params: { query: "Latest macOS versions Apple" } })
        : "Apple publishes the current macOS versions on its support page.", model: "test-model" };
    };
    let searches = 0;
    const result = await f.store.streamIntuneChatMessage(
      { content: "Hi Nova. How are you Um, can you tell me what the latest version versions for macOS are" }, () => {},
      { ...options, webSearch: async () => {
        searches++;
        return { text: "Apple macOS guidance 漢字. ".repeat(180), sources: [{ title: "Apple releases", url: "https://support.apple.com/en-us/100100" }], searchedAt: new Date().toISOString() };
      } },
    );
    assert.equal(result.assistantMessage.status, "completed", result.assistantMessage.content);
    assert.equal(searches, 1);
    assert.equal(completions, 2);
    assert.match(f.prompts[1]!.prompt, /Apple macOS guidance/);
    assert.match(result.assistantMessage.content, /Public web sources/);
  } finally { await f.cleanup(); }
});

it("answers indirect spoken device counts without investigating or dropping filters", async () => {
  const f = await fixture();
  try {
    for (const content of [
      "Hi, can you tell me how many devices I have in my tenant",
      "Tell me how many devices I have in my tenant",
      "Hello Nova, I want you to tell me how many devices do I have in my tenant?",
      "How many Intune devices are in our tenant?",
    ]) {
      const result = await f.store.streamIntuneChatMessage({ content }, () => {}, {
        ...options, webSearch: async () => { assert.fail("Count must not search"); },
      });
      assert.equal(result.assistantMessage.status, "completed");
      assert.match(result.assistantMessage.content, /1 Intune managed devices/);
    }
    assert.equal(f.prompts.length, 0);
    for (const content of [
      "How many Windows devices I have in my tenant",
      "How many devices I have in my tenant and what is the latest macOS version?",
      "How many devices I have in my tenant that are not compliant",
    ]) await f.store.streamIntuneChatMessage({ content }, () => {}, options);
    assert.equal(f.prompts.length, 3, "filters and compound requests still need reasoning");
  } finally { await f.cleanup(); }
});


it("answers the real multi-turn Nova sequence from cache with no reasoning or research calls", async () => {
  const f = await fixture();
  try {
    const transcript = new NovaTranscript();
    let time = 0;
    const say = (role: "input" | "output", delta: string) => {
      transcript.append({ type: `session.${role}_transcript.delta`, delta, start_ms: time, end_ms: time + 900 });
      time += 1000;
    };
    say("input", "Hello girl"); say("output", "Hi! What would you like to know?");
    say("input", "Who are you and what can you do"); say("output", "I'm Nova, the voice of OpenAdminOS.");
    say("input", "How many devices do I have in my tenant");
    let conversationId: string | undefined;
    for (let round = 0; round < 2; round++) {
      const request = transcript.capture(time)!;
      const result = await f.store.streamIntuneChatMessage({ content: request.text, conversationId }, () => {}, {
        ...options, voiceHistory: request.history,
        webSearch: async () => { assert.fail("Device count must not search the web"); },
      });
      conversationId = result.conversation.id;
      assert.equal(result.assistantMessage.status, "completed");
      assert.match(result.assistantMessage.content, /1 Intune managed devices/);
      assert.doesNotMatch(result.assistantMessage.content, /joke|let me check|Detected matching agent|Public web sources/i);
      say("output", "There is one Intune managed device.");
      say("input", "Still there"); say("output", "Yes.");
      say("input", "Can you tell me a joke while we wait"); say("output", "A joke.");
      say("input", "All right, how many devices do I have");
    }
    assert.equal(f.prompts.length, 0);
    assert.equal(f.calls.length, 2, "fresh cache reused across both questions");
  } finally { await f.cleanup(); }
});

it('answers the reported Windows encryption question through both Chat and Nova without model guesses', async () => {
  for (const voice of [false, true]) {
    const f = await fixture(false, [
      { id: 'win-false', deviceName: 'WIN-FALSE', operatingSystem: 'Windows', isEncrypted: false },
      { id: 'win-true', deviceName: 'WIN-TRUE', operatingSystem: 'Windows', isEncrypted: true },
      { id: 'win-missing', deviceName: 'WIN-UNKNOWN', operatingSystem: 'Windows' },
      { id: 'mac-false', deviceName: 'MAC-FALSE', operatingSystem: 'macOS', isEncrypted: false },
    ]);
    try {
      const result = await f.store.streamIntuneChatMessage({ content: 'Which Windows devices are not encrypted?' }, () => {}, { ...options, voice });
      assert.match(result.assistantMessage.content, /1 Windows device reports not encrypted/);
      assert.match(result.assistantMessage.content, /- WIN-FALSE/);
      assert.doesNotMatch(result.assistantMessage.content, /WIN-TRUE|WIN-UNKNOWN|MAC-FALSE/);
      assert.equal(result.assistantMessage.status, 'completed');
      assert.equal(f.prompts.length, 0);
      assert.ok(result.assistantMessage.sources?.some(source => source.resource === 'managedDevices'));
      assert.deepEqual(f.calls, ['/deviceManagement/managedDevices']);
      const nonstreaming = await f.store.sendIntuneChatMessage({ content: 'Which Windows devices are not encrypted?' });
      assert.match(nonstreaming.assistantMessage.content, /- WIN-FALSE/);
      assert.equal(f.prompts.length, 0);
    } finally { await f.cleanup(); }
  }
});
