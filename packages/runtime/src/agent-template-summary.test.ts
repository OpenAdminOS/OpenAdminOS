import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import type { AgentTemplate, GraphOperation, TemplateStep } from "@openadminos/agent-sdk";

import {
  agentTemplateToRegistrySummary,
  parseAgentTemplate,
} from "./agent-template.js";

const agentsRoot = fileURLToPath(new URL("../../../agents/", import.meta.url));

describe("agent template Graph operation summaries", () => {
  it("includes read and write operations for every bundled write agent", () => {
    const writeAgents = readdirSync(agentsRoot).flatMap((slug) => {
      const manifestPath = join(agentsRoot, slug, "manifest.yaml");
      if (!existsSync(manifestPath)) return [];
      const manifest = parseAgentTemplate(readFileSync(manifestPath, "utf8"));
      return manifest.descriptor.mode === "write" ? [{ slug, manifest }] : [];
    });

    assert.ok(writeAgents.length > 0, "expected at least one bundled write agent");
    for (const { slug, manifest } of writeAgents) {
      const summary = agentTemplateToRegistrySummary(manifest);
      const expectedReads = collectExpectedReadOperations(manifest.skills);
      const expectedWrites = collectExpectedWriteOperations(manifest.skills);
      assert.ok(expectedReads.length > 0, `${slug} should declare at least one Graph read`);
      assert.ok(expectedWrites.length > 0, `${slug} should declare at least one Graph write`);
      for (const expected of [...expectedReads, ...expectedWrites]) {
        const operation = summary.graphOperations.find(
          (candidate) => candidate.method === expected.method && candidate.path === expected.path,
        );
        assert.ok(operation, `${slug} summary is missing ${expected.method} ${expected.path}`);
        if (expected.notes) assert.equal(operation.notes, expected.notes);
      }
    }
  });

  it("walks nested write steps and deduplicates equivalent declarations", () => {
    const manifest = parseAgentTemplate(`
descriptor:
  id: nested-write
  name: Nested write
  description: Exercises nested declaration collection.
  version: 1.0.0
  author:
    name: OpenAdminOS
  category: users
  mode: write
skills:
  - id: nested
    format: map
    label: Nested work
    settings:
      source: "{{ rows }}"
      as: row
      do:
        - id: read_user
          format: graph
          label: Read user
          detail: Reads the user before planning.
          settings:
            method: GET
            path: /users
            select: [id]
        - id: nested_write
          format: write
          label: Disable nested user
          detail: Disables one selected user.
          settings:
            kind: graph-write
            source: "{{ rows }}"
            confirmationPhrase: "DISABLE 1 USER"
            actionTemplate:
              label: Disable user
              request:
                method: PATCH
                path: "/users/{{ item.id }}"
                body:
                  accountEnabled: false
  - id: duplicate_read
    format: graph
    label: Read users again
    settings:
      method: GET
      path: /users
      select: [id]
  - id: duplicate_write
    format: write
    label: Disable user again
    settings:
      kind: graph-write
      source: "{{ rows }}"
      confirmationPhrase: "DISABLE 1 USER"
      actionTemplate:
        label: Disable user
        request:
          method: PATCH
          path: "/users/{{ item.id }}"
          body:
            accountEnabled: false
definition: {}
`);

    assert.deepEqual(agentTemplateToRegistrySummary(manifest).graphOperations, [
      {
        method: "GET",
        path: "/users",
        select: ["id"],
        notes: "Reads the user before planning.",
      },
      {
        method: "PATCH",
        path: "/users/{{ item.id }}",
        notes: "Disables one selected user.",
      },
    ]);
  });

  it("does not add write operations to bundled script agent policies", () => {
    const scriptManifests = readdirSync(agentsRoot).flatMap((slug) => {
      const manifestPath = join(agentsRoot, slug, "manifest.yaml");
      if (!existsSync(manifestPath)) return [];
      const manifest = parseAgentTemplate(readFileSync(manifestPath, "utf8"));
      return manifest.execution?.kind === "script" ? [manifest] : [];
    });
    assert.ok(scriptManifests.length > 0, "expected at least one bundled script agent");
    for (const manifest of scriptManifests) {
      assert.ok(
        agentTemplateToRegistrySummary(manifest).graphOperations.every(
          (operation) => operation.method === "GET",
        ),
      );
    }
  });
});

function collectExpectedReadOperations(skills: TemplateStep[]): GraphOperation[] {
  const operations: GraphOperation[] = [];
  walk(skills, (skill) => {
    if (skill.format !== "graph") return;
    operations.push({
      method: skill.settings.method,
      path: skill.settings.path,
      ...(skill.detail ? { notes: skill.detail } : {}),
    });
  });
  return operations;
}

function collectExpectedWriteOperations(skills: TemplateStep[]): GraphOperation[] {
  const operations: GraphOperation[] = [];
  walk(skills, (skill) => {
    if (skill.format !== "write") return;
    const notes = skill.detail ?? skill.label;
    if (skill.settings.kind === "graph-write" && skill.settings.actionTemplate.request) {
      operations.push({
        method: skill.settings.actionTemplate.request.method,
        path: skill.settings.actionTemplate.request.path,
        notes,
      });
    } else if (skill.settings.kind === "retire-managed-device") {
      operations.push({
        method: "POST",
        path: "/deviceManagement/managedDevices/{id}/retire",
        notes,
      });
    }
  });
  return operations;
}

function walk(skills: TemplateStep[], visit: (skill: TemplateStep) => void): void {
  for (const skill of skills) {
    visit(skill);
    if (skill.format === "map") walk(skill.settings.do, visit);
  }
}
