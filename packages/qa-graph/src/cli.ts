#!/usr/bin/env node
import {
  checkFixtureAgainstResource,
  formatReport,
  loadAgentManifests,
  managedDeviceFixture,
  MsgraphClient,
  reportExitCode,
  runAgentChecks,
  runManifestSchemaChecks,
  runStatsChecks,
  type AgentReport,
  type ProjectReport,
} from "./index.js";

async function main(): Promise<void> {
  const client = new MsgraphClient();
  process.stderr.write(`Using msgraph skill at ${client.getSkillDir()}\n`);

  const manifests = loadAgentManifests();
  const agents: AgentReport[] = [];
  for (const manifest of manifests) {
    const results = await runAgentChecks(manifest, client);
    agents.push({ slug: manifest.slug, name: manifest.name, results });
  }

  const fixtureResults = await checkFixtureAgainstResource(managedDeviceFixture, client);
  const schemas = runManifestSchemaChecks();
  const stats = runStatsChecks();

  const report: ProjectReport = {
    agents,
    fixtures: [{ name: managedDeviceFixture.fixtureName, results: fixtureResults }],
    schemas,
    stats,
  };

  process.stdout.write(`${formatReport(report)}\n`);
  process.exit(reportExitCode(report));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`qa-graph failed: ${message}\n`);
  process.exit(2);
});
