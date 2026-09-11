import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { BrowserWindow } from "electron";
import { officeFullscreen } from "./office-fullscreen.js";

function fixture(initial = false) {
  const window = new EventEmitter();
  let full = initial;
  const transitions: boolean[] = [];
  const notifications: boolean[] = [];
  const webContents = Object.assign(new EventEmitter(), {
    send: (_channel: string, active: boolean) => notifications.push(active),
  });
  Object.assign(window, {
    webContents,
    isDestroyed: () => false,
    isFullScreen: () => full,
    setFullScreen: (value: boolean) => {
      transitions.push(value);
      queueMicrotask(() => {
        full = value;
        window.emit(value ? "enter-full-screen" : "leave-full-screen");
      });
    },
  });
  return {
    window,
    native: (value: boolean) => {
      full = value;
      window.emit(value ? "enter-full-screen" : "leave-full-screen");
    },
    webContents,
    transitions,
    notifications,
    controller: officeFullscreen(window as unknown as BrowserWindow),
  };
}

test("Office restores a normal window after an asynchronous fullscreen transition", async () => {
  const f = fixture();
  assert.equal(await f.controller.set(true), true);
  assert.equal(await f.controller.set(false), false);
  assert.deepEqual(f.transitions, [true, false]);
  assert.deepEqual(f.notifications, [true, false]);
  assert.equal(f.window.listenerCount("enter-full-screen"), 1);
  assert.equal(f.window.listenerCount("closed"), 1);
});

test("leaving Office preserves fullscreen that the user had already entered", async () => {
  const f = fixture(true);
  await f.controller.set(true);
  await f.controller.set(false);
  assert.deepEqual(f.transitions, []);
  assert.deepEqual(f.notifications, [true, false]);
});

test("native OS exit clears the Office mode", async () => {
  const f = fixture();
  await f.controller.set(true);
  f.native(false);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(f.notifications.at(-1), false);
  assert.equal(await f.controller.set(false), false);
});

test("a quick route exit queues restoration behind the pending enter transition", async () => {
  const f = fixture();
  await Promise.all([f.controller.set(true), f.controller.set(false)]);
  assert.deepEqual(f.transitions, [true, false]);
  assert.equal(f.notifications.at(-1), false);
});

test("renderer reload restores the window but same-document navigation does not", async () => {
  const f = fixture();
  await f.controller.set(true);
  f.webContents.emit(
    "did-start-navigation",
    {},
    "app/#/office?persona=2",
    true,
    true,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.transitions, [true]);
  f.webContents.emit("did-start-navigation", {}, "app/", false, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.transitions, [true, false]);
});

test("a transient native leave/enter pair keeps Office focused", async () => {
  const f = fixture();
  await f.controller.set(true);
  f.native(false);
  f.native(true);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.deepEqual(f.notifications, [true]);
  await f.controller.set(false);
  assert.deepEqual(f.notifications, [true, false]);
});
