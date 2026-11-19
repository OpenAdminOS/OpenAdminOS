// Electron loads this synchronously before importing the development app.
const assert = require("node:assert/strict");
const { appendFileSync, writeFileSync } = require("node:fs");
const { installSmokeProviderGuard } = require("../tests/provider-test-guard.mjs");

// Install only for an explicit smoke launch. A development launch that inherits
// the harness environment without a smoke flag runs unguarded and writes no log,
// so the harness reports that the guard was never installed.
const smokeFlags = ["OPENADMINOS_INTUNE_CHAT_SMOKE", "OPENADMINOS_REPORT_ISSUE_SMOKE", "OPENADMINOS_OFFICE_SMOKE"];
if (!smokeFlags.some((name) => process.env[name] === "1")) return;
assert.equal(process.type, "browser");
const { origins, logPath } = JSON.parse(process.env.OPENADMINOS_SMOKE_PROVIDER_GUARD);
installSmokeProviderGuard({
  origins,
  onBlocked: (message) => appendFileSync(logPath, JSON.stringify(message) + "\n"),
});
writeFileSync(logPath, "");
