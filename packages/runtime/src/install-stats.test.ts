import assert from "node:assert/strict";
import test from "node:test";

import { createRegistryInstallCountPayload } from "./install-stats.js";

test("public install counts send only the slug, version and platform", () => {
  const input = { slug: "sample-agent", version: "0.8.0", platform: "linux" } as const;
  const legacy = { ...input, installId: "legacy-identifier" };
  assert.deepEqual(createRegistryInstallCountPayload(legacy), input);
});
