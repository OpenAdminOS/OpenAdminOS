import test from "node:test";
import assert from "node:assert/strict";

const { __agentDraftTestUtils } = await import("./state.js");

const validReadAgent = `# yaml-language-server: $schema=../../schemas/agent-template.schema.json
descriptor:
  id: local-device-review
  name: Local device review
  description: Reviews managed devices and summarizes the result.
  version: 0.1.0
  author:
    name: Local admin
  category: devices
  mode: read
skills:
  - id: load_devices
    format: graph
    label: Load devices
    settings:
      method: GET
      path: /deviceManagement/managedDevices
      scopes:
        - DeviceManagementManagedDevices.Read.All
  - id: summarize
    format: llm
    label: Summarize devices
    settings:
      prompt: "Summarize {{ load_devices.output | size }} devices."
definition:
  triggers:
    - id: manual
      kind: manual
  result:
    summary: '{{ summarize.output.text | default("Summary unavailable.") }}'
`;

test("agent draft validation suggests a replacement slug on collision", () => {
  const result = __agentDraftTestUtils.validateAgentDraftSource(validReadAgent, [
    "local-device-review",
  ]);

  assert.equal(result.manifest, undefined);
  assert.match(result.validationErrors.join("\n"), /local-device-review-2/);
});

test("agent draft validation rejects path-like slugs", () => {
  const source = validReadAgent.replace(
    "id: local-device-review",
    "id: ../outside",
  );
  const result = __agentDraftTestUtils.validateAgentDraftSource(source, []);

  assert.equal(result.manifest, undefined);
  assert.match(result.validationErrors.join("\n"), /invalid/i);
});

test("agent draft validation catches connector steps missing descriptor requirements", () => {
  const source = validReadAgent.replace(
    `  - id: summarize
    format: llm`,
    `  - id: post_to_teams
    format: connector
    label: Post to Teams
    settings:
      connector: teams
      capability: post-channel-message
      version: 1
      args:
        markdown: "{{ summarize.output.text }}"
  - id: summarize
    format: llm`,
  );

  const result = __agentDraftTestUtils.validateAgentDraftSource(source, []);

  assert.equal(result.manifest, undefined);
  assert.match(result.validationErrors.join("\n"), /descriptor\.connectors/);
});

test("agent draft prompt includes current builder patterns", () => {
  const prompt = __agentDraftTestUtils.buildNl2AgentSystemPrompt([], [], [
    "find-inactive-devices",
  ]);

  assert.match(prompt, /reserved slug/i);
  assert.match(prompt, /map step/i);
  assert.match(prompt, /definition\.settings/);
  assert.match(prompt, /post-channel-message/);
  assert.match(prompt, /0\.1\.0/);
});

test("community submission QA blocks missing metadata and license", () => {
  const draft = __agentDraftTestUtils.validateAgentDraftSource(validReadAgent, []);
  const review = __agentDraftTestUtils.buildAgentCommunitySubmissionReview(
    validReadAgent,
    {
      name: "",
      description: "",
      category: "devices",
      maintainerName: "",
      supportUrl: "",
      licenseConfirmed: false,
      privacyNotes: "",
      changelog: "",
    },
    draft,
  );

  assert.equal(review.ok, false);
  assert.ok(review.checks.some((check) => check.id === "metadata-name" && check.status === "fail"));
  assert.ok(review.checks.some((check) => check.id === "license" && check.status === "fail"));
});

test("community submission QA flags write agents and connector egress for review", () => {
  const source = validReadAgent
    .replace("mode: read", "mode: write")
    .replace(
      `  - id: summarize
    format: llm`,
      `  - id: plan_disable
    format: write
    label: Plan disable
    settings:
      kind: graph-write
      source: "{{ load_devices.output }}"
      confirmationPhrase: "DISABLE {{ actions | size }} ITEMS"
      scopes:
        - User.ReadWrite.All
      actionTemplate:
        label: "Disable item"
        severity: destructive
        request:
          method: PATCH
          path: "/users/{{ item.id }}"
          body:
            accountEnabled: false
  - id: summarize
    format: llm`,
    );
  const draft = __agentDraftTestUtils.validateAgentDraftSource(source, []);
  const review = __agentDraftTestUtils.buildAgentCommunitySubmissionReview(
    source,
    validMetadata(),
    draft,
  );

  assert.equal(review.ok, true);
  assert.ok(review.checks.some((check) => check.id === "write-confirmation" && check.status === "pass"));
  assert.ok(review.checks.some((check) => check.id === "security-scopes" && check.status === "warn"));
});

test("community submission QA blocks obvious secret-like values", () => {
  const source = `${validReadAgent}\n# api_key: sk-test-12345678901234567890\n`;
  const draft = __agentDraftTestUtils.validateAgentDraftSource(source, []);
  const review = __agentDraftTestUtils.buildAgentCommunitySubmissionReview(
    source,
    validMetadata(),
    draft,
  );

  assert.equal(review.ok, false);
  assert.ok(review.checks.some((check) => check.id === "secrets" && check.status === "fail"));
});

function validMetadata() {
  return {
    name: "Local device review",
    description: "Reviews managed devices and summarizes operational risk for administrators.",
    category: "devices" as const,
    maintainerName: "Local admin",
    supportUrl: "@local-admin",
    licenseConfirmed: true,
    privacyNotes: "Reads Microsoft Graph device data only. No tenant data is included in the submission.",
    changelog: "Initial community submission.",
  };
}
