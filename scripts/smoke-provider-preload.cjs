// Electron loads this synchronously before importing the development app.
const assert = require("node:assert/strict");
const { appendFileSync, writeFileSync } = require("node:fs");
const { installSmokeProviderGuard } = require("../tests/provider-test-guard.mjs");

assert.equal(process.type, "browser");
const { origins, logPath } = JSON.parse(process.env.OPENADMINOS_SMOKE_PROVIDER_GUARD);
installSmokeProviderGuard({
  origins,
  onBlocked: (message) => appendFileSync(logPath, JSON.stringify(message) + "\n"),
});
writeFileSync(logPath, "");
