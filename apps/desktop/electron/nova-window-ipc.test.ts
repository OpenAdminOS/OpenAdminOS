import assert from "node:assert/strict";
import { test } from "node:test";
import { handleNovaWindow, showMainWindow } from "./nova-window-ipc.js";
import { NovaWindowSession } from "./nova-window-session.js";

test("only the main or bubble sender can claim, and the bubble must be visible", async () => {
  const main = { id: 1 }, bubble = { id: 2 };
  const session = new NovaWindowSession();
  const host = {
    main, bubble, visible: () => false, claim: (id: number) => session.claim(id, () => assert.fail()),
    openMain: async () => {}, transfer: () => {}, hide: () => {}, other: () => undefined,
  };
  await handleNovaWindow(main, "claim", undefined, host);
  await assert.rejects(handleNovaWindow({ id: 2 }, "claim", undefined, host), /main window or the floating window/);
  await assert.rejects(handleNovaWindow(bubble, "claim-typed", undefined, host), /Show the floating window/);
  await handleNovaWindow(bubble, "ready", undefined, { ...host, visible: () => true });
  assert.equal(session.owner, main.id);
});

test("bubble navigation accepts app destinations and waits for the main window before hiding", async () => {
  const bubble = { id: 2 };
  const events: string[] = [];
  const host = {
    bubble, visible: () => true, claim: async () => {},
    openMain: async (route?: string) => { events.push(route ?? "main"); },
    transfer: () => { events.push("transfer"); },
    hide: () => { events.push("hide"); }, other: () => undefined,
  };
  for (const refused of ["//example.test", "/runs/../../settings", "/settings?unexpected=1", "/runs/something"]) {
    await assert.rejects(handleNovaWindow(bubble, "open-page", refused, host), /outside its supported app routes/);
  }
  assert.deepEqual(events, []);
  const run = "/runs/run_11111111-1111-1111-1111-111111111111";
  await handleNovaWindow(bubble, "open-page", "/settings/data", host);
  await handleNovaWindow(bubble, "open-page", run, host);
  await assert.rejects(handleNovaWindow(bubble, "open-main", "transcript", {
    ...host, openMain: async () => { throw new Error("window failed"); },
  }), /window failed/);
  assert.deepEqual(events, ["/settings/data", "hide", run, "hide"]);
});

test("open-main recreates a destroyed main window and transfers only after it opens", async () => {
  const bubble = { id: 2 };
  const events: string[] = [];
  const window = {
    isDestroyed: () => false, isMinimized: () => false, restore: () => assert.fail(),
    show: () => { events.push("show"); }, focus: () => { events.push("focus"); },
  };
  await handleNovaWindow(bubble, "open-main", "transcript", {
    bubble, visible: () => true, claim: async () => {},
    openMain: () => showMainWindow({ ...window, isDestroyed: () => true }, async () => {
      events.push("create");
      return window;
    }, () => assert.fail("initial route is applied by create")),
    transfer: payload => { assert.equal(payload, "transcript"); events.push("transfer"); },
    hide: () => { events.push("hide"); }, other: () => undefined,
  });
  assert.deepEqual(events, ["create", "show", "focus", "transfer", "hide"]);
});
