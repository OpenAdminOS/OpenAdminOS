// Electron loads this synchronously before importing the development app.
//
// Install only for an explicit smoke launch, using the same flag combinations
// the app uses to enter its smoke modes (apps/desktop/electron/main.ts). A
// development launch that inherits the harness environment without them runs
// unguarded, loads nothing else from this file and writes no log, so the
// harness reports that the guard was never installed.
const env = process.env;
const smokeLaunch =
  env.OPENADMINOS_INTUNE_CHAT_SMOKE === "1" ||
  env.OPENADMINOS_REPORT_ISSUE_SMOKE === "1" ||
  (env.OPENADMINOS_OFFICE_SMOKE === "1" && env.OPENADMINOS_SCREENSHOT_CAPTURE === "1");
if (!smokeLaunch) return;

const assert = require("node:assert/strict");
const { appendFileSync, writeFileSync } = require("node:fs");
// The guard is an ES module; require() of it needs synchronous ESM loading,
// which only smoke launches rely on.
const { installSmokeProviderGuard } = require("../tests/provider-test-guard.mjs");

assert.equal(process.type, "browser");
const { origins, logPath } = JSON.parse(env.OPENADMINOS_SMOKE_PROVIDER_GUARD);
installSmokeProviderGuard({
  origins,
  onBlocked: (message) => appendFileSync(logPath, JSON.stringify(message) + "\n"),
});
writeFileSync(logPath, "");
