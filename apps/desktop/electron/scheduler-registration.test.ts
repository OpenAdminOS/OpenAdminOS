import assert from "node:assert/strict";
import { test } from "node:test";
import {
  launchAgentState,
  macosSchedulerPlist,
  windowsTaskBinary,
  windowsTaskState,
} from "./scheduler-registration.js";

const packaged = {
  label: "com.openadminos.scheduler",
  programArguments: [
    "/Applications/OpenAdminOS.app/Contents/MacOS/OpenAdminOS",
    "--background-scheduler",
  ],
  logDir: "/Users/admin/Library/Application Support/OpenAdminOS/logs",
};

test("renders the scheduler LaunchAgent for the packaged app", () => {
  const plist = macosSchedulerPlist(packaged);
  assert.match(plist, /<key>Label<\/key>\n  <string>com\.openadminos\.scheduler<\/string>/);
  assert.match(
    plist,
    /<array>\n    <string>\/Applications\/OpenAdminOS\.app\/Contents\/MacOS\/OpenAdminOS<\/string>\n    <string>--background-scheduler<\/string>\n  <\/array>/,
  );
  assert.match(plist, /<key>StartInterval<\/key>\n  <integer>60<\/integer>/);
  assert.ok(
    plist.includes(
      "<string>/Users/admin/Library/Application Support/OpenAdminOS/logs/scheduler.error.log</string>",
    ),
  );
});

test("escapes XML characters in program paths", () => {
  const plist = macosSchedulerPlist({
    ...packaged,
    programArguments: ["/Users/a&b/<OpenAdminOS>.app/'x'\"", "--background-scheduler"],
  });
  assert.ok(plist.includes("<string>/Users/a&amp;b/&lt;OpenAdminOS&gt;.app/&apos;x&apos;&quot;</string>"));
});

test("an agent written by a development checkout does not match the packaged app", () => {
  const dev = macosSchedulerPlist({
    ...packaged,
    programArguments: [
      "/Users/admin/src/OpenAdminOS/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      "/Users/admin/src/OpenAdminOS/apps/desktop",
      "--background-scheduler",
    ],
  });
  assert.notEqual(dev, macosSchedulerPlist(packaged));
  assert.equal(macosSchedulerPlist(packaged), macosSchedulerPlist({ ...packaged }));
});

test("an agent that runs a development checkout or a missing binary is stale", () => {
  const dev = macosSchedulerPlist({
    ...packaged,
    programArguments: [
      "/Users/admin/src/OpenAdminOS/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      "/Users/admin/src/OpenAdminOS/apps/desktop",
      "--background-scheduler",
    ],
  });
  assert.equal(launchAgentState(dev, () => true), "stale");
  assert.equal(launchAgentState(macosSchedulerPlist(packaged), () => false), "stale");
  assert.equal(launchAgentState("not a plist", () => true), "stale");
  assert.equal(launchAgentState(undefined, () => true), "missing");
});

test("an agent for another installed copy stays registered for a copy run from a DMG", () => {
  // A copy running from /Volumes sees the /Applications agent as registered,
  // so saving a schedule there does not rewrite the agent to the DMG path.
  const seen: string[] = [];
  const state = launchAgentState(
    macosSchedulerPlist({
      ...packaged,
      programArguments: ["/Applications/A&B/OpenAdminOS.app/Contents/MacOS/OpenAdminOS", "--background-scheduler"],
    }),
    (path) => {
      seen.push(path);
      return true;
    },
  );
  assert.equal(state, "registered");
  assert.deepEqual(seen, ["/Applications/A&B/OpenAdminOS.app/Contents/MacOS/OpenAdminOS"]);
});

// Shape of `schtasks /Query /TN "OpenAdminOS Scheduler" /XML`, with the Exec
// block taken from a task a development checkout registered on Windows 11.
function taskXml(command: string, args: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Actions Context="Author">
    <Exec>
      <Command>${command}</Command>
      <Arguments>${args}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

test("a Windows task that runs a development checkout or a missing binary is stale", () => {
  const dev = taskXml(
    '"C:\\Users\\ugur\\AppData\\Local\\OpenAdminOS-review-061\\node_modules\\electron\\dist\\electron.exe"',
    '"C:\\Users\\ugur\\AppData\\Local\\OpenAdminOS-review-061\\apps\\desktop" "--background-scheduler"',
  );
  assert.equal(windowsTaskState(dev, () => true), "stale");
  assert.equal(
    windowsTaskBinary(dev),
    "C:\\Users\\ugur\\AppData\\Local\\OpenAdminOS-review-061\\node_modules\\electron\\dist\\electron.exe",
  );
  const installed = taskXml(
    '"C:\\Users\\ugur\\AppData\\Local\\Programs\\OpenAdminOS\\OpenAdminOS.exe"',
    '"--background-scheduler"',
  );
  assert.equal(windowsTaskState(installed, () => false), "stale");
  assert.equal(windowsTaskState("<Task/>", () => true), "stale");
  assert.equal(windowsTaskState(undefined, () => true), "missing");
});

test("a Windows task for an installed copy is registered", () => {
  const seen: string[] = [];
  const state = windowsTaskState(
    taskXml('"C:\\Program Files\\R&amp;D\\OpenAdminOS\\OpenAdminOS.exe"', '"--background-scheduler"'),
    (path) => {
      seen.push(path);
      return true;
    },
  );
  assert.equal(state, "registered");
  assert.deepEqual(seen, ["C:\\Program Files\\R&D\\OpenAdminOS\\OpenAdminOS.exe"]);
});
