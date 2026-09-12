import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { AppStateStore } from "../state.js";
import type { RunGraphApi, RunLlmApi } from "@openadminos/agent-sdk";

async function fixture(empty = false) {
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
            : [
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
    cleanup: () => rm(dir, { recursive: true, force: true }),
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
