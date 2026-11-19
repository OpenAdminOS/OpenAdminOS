import assert from "node:assert/strict";

import { AppStateStore, type AppStateStoreOptions } from "../electron/state.js";

export function createTestAppStateStore(options: AppStateStoreOptions): AppStateStore {
  if ("providerListFactory" in options) {
    assert.equal(typeof options.providerListFactory, "function", "providerListFactory must be a stub function.");
  }
  return new AppStateStore({ providerListFactory: () => [], ...options });
}
