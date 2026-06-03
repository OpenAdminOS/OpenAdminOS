import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  APPLE_FOUNDATION_MODEL_ID,
  createAppleFoundationLlm,
  createAppleFoundationProcessEnv,
  listAppleFoundationHelperCandidates,
} from "./llm-apple-foundation.js";

describe("createAppleFoundationProcessEnv", () => {
  it("keeps only local helper environment fields", () => {
    const env = createAppleFoundationProcessEnv({
      source: {
        PATH: "/usr/local/bin:/usr/bin",
        HOME: "/Users/admin",
        TMPDIR: "/tmp/openadminos",
        LANG: "en_US.UTF-8",
        OPENAI_API_KEY: "sk-secret",
        AZURE_CLIENT_SECRET: "tenant-secret",
        CODEX_HOME: "/Users/admin/.codex",
        OPENADMINOS_OLLAMA_URL: "http://192.168.1.10:11434",
      },
    });

    assert.deepEqual(env, {
      HOME: "/Users/admin",
      LANG: "en_US.UTF-8",
      PATH: "/usr/local/bin:/usr/bin",
      TMPDIR: "/tmp/openadminos",
    });
  });
});

describe("listAppleFoundationHelperCandidates", () => {
  it("includes the packaged extraResources helper path", () => {
    const originalResourcesPath = (
      process as NodeJS.Process & { resourcesPath?: string }
    ).resourcesPath;
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath =
      "/Applications/OpenAdminOS.app/Contents/Resources";

    try {
      assert.ok(
        listAppleFoundationHelperCandidates().includes(
          "/Applications/OpenAdminOS.app/Contents/Resources/native/apple-foundation-helper/openadminos-apple-foundation-helper",
        ),
      );
    } finally {
      if (originalResourcesPath === undefined) {
        delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
      } else {
        (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath =
          originalResourcesPath;
      }
    }
  });
});

describe("createAppleFoundationLlm", () => {
  it("rejects model overrides because Apple exposes only the system model", async () => {
    const llm = createAppleFoundationLlm({
      helperPath: "/does/not/need/to/exist",
      defaultModel: APPLE_FOUNDATION_MODEL_ID,
    });

    await assert.rejects(
      async () => {
        for await (const _chunk of llm.stream({
          model: "other-model",
          prompt: "hello",
        })) {
          // unreachable
        }
      },
      /only exposes the system language model/,
    );
  });
});
