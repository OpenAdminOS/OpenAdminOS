export { MsgraphClient } from "./msgraph-client.js";
export { loadAgentManifests } from "./load-agents.js";
export {
  runAgentChecks,
  checkFixtureAgainstResource,
  type CheckResult,
  type Severity,
  type FixtureSpec,
} from "./checks.js";
export { formatReport, reportExitCode, type ProjectReport, type AgentReport } from "./report.js";
export { managedDeviceFixture } from "./fixtures.js";
