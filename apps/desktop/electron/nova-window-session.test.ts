import assert from "node:assert/strict";
import { test } from "node:test";
import { NovaWindowShortcut } from "./nova-window-shortcut.js";
import { NovaWindowSession } from "./nova-window-session.js";
import { novaKeyProblem, parseNovaKey, recordNovaKey } from "../src/shared/nova-keyboard.js";

test("Nova accepts a normalized accelerator or off, and rejects incomplete or unsupported combinations", () => {
  assert.equal(parseNovaKey("Alt+Control+Space"), "Control+Alt+Space");
  assert.equal(parseNovaKey(null), null);
  for (const invalid of ["Space", "Shift+A", "Ctrl+Alt+A", "Alt+Alt+A", "Super+A+B", "Control+Escape", {}]) {
    assert.equal(parseNovaKey(invalid), undefined);
  }
  assert.equal(recordNovaKey({ code: "KeyV", ctrlKey: true, altKey: true, metaKey: false, shiftKey: false }), "Control+Alt+V");
});

test("handoff waits for the previous renderer to release the microphone", async () => {
  const session = new NovaWindowSession();
  await session.claim(1, () => assert.fail("no previous owner"));
  let notified: number | undefined;
  const handoff = session.claim(2, owner => { notified = owner; });
  assert.equal(notified, 1);
  assert.equal(session.owner, 1);
  session.release(2, () => assert.fail("only the current owner can stop Nova"));
  session.release(1, () => assert.equal(session.owner, 1));
  await assert.rejects(handoff, /could not switch windows/);
  await session.claim(2, () => assert.fail("no previous owner"));
  const next = session.claim(1, () => session.release(2, () => {}));
  await next;
  assert.equal(session.owner, 1);
});


test("a taken key exposes recovery and can be replaced or turned off", () => {
  const unregistered: string[] = [];
  let toggle: (() => void) | undefined;
  const shortcut = new NovaWindowShortcut({
    register: (key, callback) => {
      if (key === "Control+Alt+Space") return false;
      toggle = callback;
      return true;
    },
    unregister: key => unregistered.push(key),
  }, () => { toggled++; });
  let toggled = 0;
  shortcut.update(undefined);
  assert.match(shortcut.error ?? "", /Record a different shortcut or turn it off/);
  shortcut.update("Control+Alt+F9");
  assert.equal(shortcut.error, undefined);
  toggle?.();
  assert.equal(toggled, 1);
  shortcut.update(null);
  assert.deepEqual(unregistered, ["Control+Alt+F9"]);
});

test("an unsuccessful replacement keeps the previous shortcut registered", () => {
  const unregistered: string[] = [];
  const shortcut = new NovaWindowShortcut({
    register: key => key !== "Control+Alt+F9",
    unregister: key => { unregistered.push(key); },
  }, () => {}, true);
  shortcut.update(undefined);
  shortcut.update("Control+Alt+F9");
  assert.match(shortcut.error ?? "", /Wayland global shortcuts portal/);
  assert.equal(shortcut.activeKey, "Control+Alt+Space");
  assert.deepEqual(unregistered, []);
  shortcut.update("Control+Alt+F10");
  assert.equal(shortcut.activeKey, "Control+Alt+F10");
  assert.deepEqual(unregistered, ["Control+Alt+Space"]);
});

test("common system and editing keys are reserved", () => {
  for (const combination of ["Control+C", "Super+V", "Super+X", "Control+Z", "Control+A", "Super+S",
    "Super+Q", "Control+W", "Control+Tab", "Alt+F4", "Super+L", "Super+Space", "Control+Alt+Delete"]) {
    assert.match(novaKeyProblem(combination) ?? "", /reserved/);
  }
  assert.match(novaKeyProblem("Alt+B") ?? "", /at least two modifiers/);
  assert.equal(novaKeyProblem("Control+Alt+B"), undefined);
});
