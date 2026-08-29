import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { IntelligenceSqliteStore } from "./sqlite-store.js";
import {
  GRAPH_CACHE_RESOURCES,
  pathForResource,
  matchAgentsToQuestion,
  planChatContext,
  selfTrainingCandidateFromPrompt,
  staleManagedDeviceSyncThresholdDays,
  thresholdIsoDaysBefore,
} from "./planner.js";
import type {
  AgentSummary,
  GraphCacheResourceKind,
  MultiTenantAgentBatch,
  MultiTenantChatJob,
} from "@openadminos/agent-sdk";

describe("Intune Chat SQLite store", () => {
  it("does not infer removals from a capped Graph cache window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-capped-drift-"));
    try {
      const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
      const common = {
        tenantId: "tenant-1",
        resource: "configurationPolicies" as const,
        label: "Settings catalog policies",
        scopeSet: ["DeviceManagementConfiguration.Read.All"],
      };
      store.replaceGraphResources({
        ...common,
        refreshedAt: "2026-08-01T10:00:00.000Z",
        rows: [
          { id: "policy-1", displayName: "One", setting: "A" },
          { id: "policy-2", displayName: "Two", setting: "B" },
        ],
      });
      store.replaceGraphResources({
        ...common,
        refreshedAt: "2026-08-01T10:05:00.000Z",
        pageLimitReached: true,
        rows: [{ id: "policy-1", displayName: "One", setting: "A2" }],
      });

      const cappedSnapshot = store.listDriftSnapshots("tenant-1", {
        resource: "configurationPolicies",
      })[0];
      assert.ok(cappedSnapshot);
      assert.equal(cappedSnapshot.changesModified, 1);
      assert.equal(cappedSnapshot.changesRemoved, 0);

      store.replaceGraphResources({
        ...common,
        refreshedAt: "2026-08-01T10:10:00.000Z",
        rows: [
          { id: "policy-1", displayName: "One", setting: "A2" },
          { id: "policy-2", displayName: "Two", setting: "B" },
        ],
      });
      const history = store.getDriftObjectHistory(
        "tenant-1",
        "configurationPolicies",
        "policy-2",
      );
      assert.equal(history.length, 1);
      assert.equal(history[0]?.removedAt, undefined);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists conversations, messages, cache rows, and self-training decisions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-"));
    try {
      const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
      const now = "2026-06-01T10:00:00.000Z";
      const conversation = store.createConversation({
        id: "chat_1",
        title: "Stale devices",
        tenantId: "tenant-1",
        now,
      });
      store.insertMessage({
        id: "msg_1",
        conversationId: conversation.id,
        role: "user",
        content: "Which Windows devices are stale?",
        status: "completed",
        createdAt: now,
      });
      store.insertToolCall({
        id: "tool_1",
        conversationId: conversation.id,
        messageId: "msg_1",
        type: "graph-cache-refresh",
        status: "completed",
        createdAt: now,
        completedAt: now,
        input: { resources: ["managedDevices"] },
        output: { rows: 2 },
      });

      store.replaceGraphResources({
        tenantId: "tenant-1",
        resource: "managedDevices",
        label: "Intune managed devices",
        scopeSet: ["DeviceManagementManagedDevices.Read.All"],
        refreshedAt: now,
        pageCount: 2,
        rows: [
          {
            id: "device-1",
            deviceName: "WIN-01",
            operatingSystem: "Windows",
            complianceState: "noncompliant",
            lastSyncDateTime: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "device-2",
            deviceName: "WIN-OLD",
            operatingSystem: "Windows",
            complianceState: "compliant",
            lastSyncDateTime: "2025-12-01T00:00:00.000Z",
          },
        ],
      });

      assert.equal(store.listConversations().length, 1);
      assert.equal(store.listMessages(conversation.id)[0]?.content, "Which Windows devices are stale?");
      assert.equal(store.searchConversations("Windows")[0]?.id, conversation.id);
      const renamed = store.renameConversation(
        conversation.id,
        "Renamed stale device review",
        "2026-06-01T10:01:00.000Z",
      );
      assert.equal(renamed.title, "Renamed stale device review");
      const pinned = store.setConversationPinned(
        conversation.id,
        true,
        "2026-06-01T10:02:00.000Z",
      );
      assert.equal(Boolean(pinned.pinnedAt), true);
      const secondConversation = store.createConversation({
        id: "chat_2",
        title: "Later unpinned chat",
        tenantId: "tenant-1",
        now: "2026-06-01T10:03:00.000Z",
      });
      assert.equal(store.listConversations()[0]?.id, conversation.id);
      store.deleteConversation(secondConversation.id);
      assert.equal(store.getConversation(secondConversation.id), undefined);

      const status = store.getGraphCacheStatus("tenant-1", [...GRAPH_CACHE_RESOURCES]);
      const devices = status.find((entry) => entry.resource === "managedDevices");
      assert.equal(devices?.rows, 2);
      assert.equal(devices?.pages, 2);
      assert.equal(devices?.pageLimitReached, false);
      assert.equal(devices?.refreshedAt, now);

      const rows = store.readGraphRows({
        tenantId: "tenant-1",
        resources: ["managedDevices"],
        searchTerms: ["windows"],
        limitPerResource: 10,
      });
      assert.equal((rows.managedDevices?.[0] as { deviceName?: string }).deviceName, "WIN-01");

      const staleRows = store.readManagedDevicesLastSyncBefore({
        tenantId: "tenant-1",
        thresholdIso: "2025-12-15T00:00:00.000Z",
        limit: 10,
      });
      assert.deepEqual(
        staleRows.map((row) => (row as { deviceName?: string }).deviceName),
        ["WIN-OLD"],
      );

      const settings = store.setSelfTrainingEnabled(true, now);
      assert.equal(settings.enabled, true);
      const suggestion = store.createSelfTrainingSuggestion({
        id: "suggestion_1",
        tenantId: "tenant-1",
        agentSlug: "offboarding-agent",
        status: "pending",
        text: "Never offboard shared kiosk devices.",
        reason: "Repeated chat preference.",
        source: "chat",
        createdAt: now,
      });
      assert.equal(suggestion.status, "pending");
      assert.equal(store.listSelfTrainingSuggestions("pending").length, 1);
      assert.equal(store.decideSelfTrainingSuggestion("suggestion_1", "accepted", now).status, "accepted");
      assert.equal(
        store.listAcceptedSelfTrainingSuggestions({
          tenantId: "tenant-1",
          agentSlug: "offboarding-agent",
        }).length,
        1,
      );
      assert.equal(
        store.resetAcceptedSelfTrainingSuggestions({
          tenantId: "tenant-1",
          agentSlug: "offboarding-agent",
          now,
        })[0]?.status,
        "reset",
      );
      assert.equal(
        store.listAcceptedSelfTrainingSuggestions({
          tenantId: "tenant-1",
          agentSlug: "offboarding-agent",
        }).length,
        0,
      );
      const schedule = store.setGraphCacheRefreshSchedule({
        tenantId: "tenant-1",
        enabled: true,
        intervalMinutes: 60,
        now,
      });
      assert.equal(schedule.enabled, true);
      assert.equal(schedule.nextRunAt, "2026-06-01T11:00:00.000Z");
      assert.equal(
        store.isGraphCacheRefreshDue(
          "tenant-1",
          new Date("2026-06-01T10:30:00.000Z").getTime(),
        ),
        false,
      );
      assert.equal(
        store.isGraphCacheRefreshDue(
          "tenant-1",
          new Date("2026-06-01T11:00:01.000Z").getTime(),
        ),
        true,
      );
      const refreshed = store.markGraphCacheRefreshScheduleRun({
        tenantId: "tenant-1",
        startedAt: "2026-06-01T11:01:00.000Z",
        success: true,
      });
      assert.equal(refreshed.lastSuccessAt, "2026-06-01T11:01:00.000Z");
      assert.equal(refreshed.nextRunAt, "2026-06-01T12:01:00.000Z");

      const summary = store.getLocalDataSummary({
        tenantId: "tenant-1",
        definitions: [...GRAPH_CACHE_RESOURCES],
      });
      assert.ok(summary.sqliteBytes > 0);
      assert.equal(summary.chatConversationCount, 1);
      assert.equal(summary.chatMessageCount, 1);
      assert.equal(summary.chatToolCallCount, 1);
      assert.equal(summary.graphRowCount, 2);
      assert.equal(summary.activeTenantGraphRowCount, 2);
      assert.equal(
        summary.activeTenantCacheResources?.find(
          (resource) => resource.resource === "managedDevices",
        )?.rows,
        2,
      );
      assert.equal(summary.selfTrainingSuggestionCount, 1);

      store.clearGraphCache("tenant-1");
      const graphCleared = store.getLocalDataSummary({
        tenantId: "tenant-1",
        definitions: [...GRAPH_CACHE_RESOURCES],
      });
      assert.equal(graphCleared.graphRowCount, 0);
      assert.equal(graphCleared.activeTenantGraphRowCount, 0);
      assert.equal(
        graphCleared.activeTenantCacheResources?.find(
          (resource) => resource.resource === "managedDevices",
        )?.rows,
        0,
      );
      assert.equal(store.getGraphCacheRefreshSchedule("tenant-1").enabled, true);

      store.clearChatHistory();
      const chatCleared = store.getLocalDataSummary({
        tenantId: "tenant-1",
        definitions: [...GRAPH_CACHE_RESOURCES],
      });
      assert.equal(chatCleared.chatConversationCount, 0);
      assert.equal(chatCleared.chatMessageCount, 0);
      assert.equal(chatCleared.chatToolCallCount, 0);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists tenant groups, multi-tenant jobs, and tenant-scoped workspaces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-"));
    try {
      const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
      const now = "2026-06-01T10:00:00.000Z";
      const tenantNames = new Map([
        ["tenant-1", "Contoso"],
        ["tenant-2", "Fabrikam"],
      ]);

      const group = store.saveTenantGroup({
        id: "group_1",
        name: "Pilot tenants",
        tenantIds: ["tenant-1", "tenant-2", "tenant-1"],
        now,
      });
      assert.deepEqual(group.tenantIds, ["tenant-1", "tenant-2"]);
      assert.equal(store.listTenantGroups()[0]?.name, "Pilot tenants");
      assert.ok(
        store
          .listSavedMultiTenantQueries()
          .some((query) => query.id === "windows-compliance"),
      );

      const conversation = store.createConversation({
        id: "chat_1",
        title: "Compliance query",
        tenantId: "tenant-1",
        now,
      });
      store.insertMessage({
        id: "msg_1",
        conversationId: conversation.id,
        role: "assistant",
        content: "Contoso has one non-compliant Windows device.",
        status: "completed",
        createdAt: now,
      });

      const job: MultiTenantChatJob = {
        id: "mtjob_1",
        conversationId: conversation.id,
        prompt: "List Windows compliance across every connected tenant.",
        tenantScope: { kind: "all" },
        resolvedTenantIds: ["tenant-1", "tenant-2"],
        providerId: "ollama",
        providerName: "Ollama",
        providerIsLocal: true,
        status: "partial",
        createdAt: now,
        updatedAt: now,
        preflight: {
          id: "preflight_1",
          prompt: "List Windows compliance across every connected tenant.",
          tenantScope: { kind: "all" },
          resolvedTenantIds: ["tenant-1", "tenant-2"],
          resolvedGroups: [group],
          resources: ["managedDevices"],
          providerId: "ollama",
          providerName: "Ollama",
          providerIsLocal: true,
          generatedAt: now,
          tenants: [
            {
              tenantId: "tenant-1",
              tenantName: "Contoso",
              username: "admin@contoso.example",
              status: "ready",
              selected: true,
              cacheFreshness: now,
              staleResources: [],
              missingScopes: [],
              warnings: [],
              recovery: "Ready to run.",
            },
            {
              tenantId: "tenant-2",
              tenantName: "Fabrikam",
              username: "admin@fabrikam.example",
              status: "failed",
              selected: true,
              staleResources: ["managedDevices"],
              missingScopes: [],
              warnings: ["Graph request failed."],
              recovery: "Review the cached error or remove this tenant from the run.",
            },
          ],
          canRun: true,
        },
        progress: [
          {
            tenantId: "tenant-1",
            tenantName: "Contoso",
            status: "ready",
            detail: "1 Windows device row prepared.",
            updatedAt: now,
          },
          {
            tenantId: "tenant-2",
            tenantName: "Fabrikam",
            status: "failed",
            detail: "Graph request failed.",
            updatedAt: now,
          },
        ],
        summary: {
          tenantsScanned: 2,
          failedTenants: 1,
          skippedTenants: 0,
          staleTenants: 0,
          windowsDevices: 1,
          compliant: 0,
          nonCompliant: 1,
          unknown: 0,
        },
        comparisons: [
          {
            tenantId: "tenant-1",
            tenantName: "Contoso",
            status: "ready",
            windowsDevices: 1,
            compliant: 0,
            nonCompliant: 1,
            unknown: 0,
            lastRefresh: now,
            warnings: [],
          },
          {
            tenantId: "tenant-2",
            tenantName: "Fabrikam",
            status: "failed",
            windowsDevices: 0,
            compliant: 0,
            nonCompliant: 0,
            unknown: 0,
            warnings: ["Graph request failed."],
          },
        ],
        deviceRows: [
          {
            tenantId: "tenant-1",
            tenantName: "Contoso",
            deviceId: "device-1",
            deviceName: "WIN-01",
            complianceState: "noncompliant",
            operatingSystem: "Windows",
            osVersion: "11.0.1",
            lastSyncDateTime: now,
            owner: "owner@contoso.example",
            sourceRefreshedAt: now,
            stale: false,
          },
        ],
        assistantText: "Contoso has one non-compliant Windows device; Fabrikam failed.",
        exportDossierMarkdown: "# Multi-tenant Chat dossier\n",
      };
      store.upsertMultiTenantJob(job);
      assert.equal(store.getMultiTenantJob(job.id)?.summary.failedTenants, 1);

      const batch: MultiTenantAgentBatch = {
        id: "mtbatch_1",
        agentSlug: "retire-stale-devices",
        agentName: "Retire stale devices",
        agentMode: "write",
        tenantScope: { kind: "all" },
        resolvedTenantIds: ["tenant-1", "tenant-2"],
        status: "awaiting-confirmation",
        runIds: ["run_1", "run_2"],
        createdAt: now,
        updatedAt: now,
        preflight: job.preflight,
      };
      store.upsertMultiTenantAgentBatch(batch);
      assert.equal(
        store.getMultiTenantAgentBatch(batch.id)?.status,
        "awaiting-confirmation",
      );
      assert.deepEqual(
        store.listMultiTenantAgentBatches()[0]?.runIds,
        ["run_1", "run_2"],
      );

      const workspace = store.createWorkspace({
        id: "wksp_1",
        tenantId: "tenant-1",
        tenantName: "Contoso",
        title: "Contoso compliance review",
        instructions: "Use only locally pinned evidence.",
        now,
        conversationId: conversation.id,
      });
      assert.equal(workspace.links.length, 1);
      assert.equal(workspace.tenantId, "tenant-1");

      const note = store.addWorkspaceNote({
        id: "note_1",
        workspaceId: workspace.id,
        content: "Check the owner before any remediation.",
        now,
      });
      assert.equal(note.tenantId, "tenant-1");
      const evidence = store.pinWorkspaceEvidence({
        id: "ev_1",
        workspaceId: workspace.id,
        tenantId: "tenant-1",
        title: "WIN-01 compliance row",
        sourceType: "graph-cache-row",
        sourceRef: { resource: "managedDevices", id: "device-1" },
        content: { deviceName: "WIN-01", complianceState: "noncompliant" },
        freshness: {
          resource: "managedDevices",
          refreshedAt: now,
          rowCount: 1,
          cacheStatus: "cache",
        },
        now,
      });
      assert.equal(evidence.tenantId, "tenant-1");
      assert.throws(
        () =>
          store.pinWorkspaceEvidence({
            id: "ev_bad",
            workspaceId: workspace.id,
            tenantId: "tenant-2",
            title: "Wrong tenant",
            sourceType: "manual",
            content: {},
            now,
          }),
        /tenant does not match/,
      );

      const split = store.importMultiTenantResultToWorkspaces({
        job,
        tenantNames,
        mappings: [
          { tenantId: "tenant-1", workspaceId: workspace.id },
          { tenantId: "tenant-2", title: "Fabrikam compliance review" },
        ],
        createWorkspaceId: () => "wksp_2",
        createEvidenceId: (() => {
          let index = 1;
          return () => `split_ev_${index++}`;
        })(),
        now,
      });
      assert.equal(split.workspaces.length, 2);
      assert.equal(split.evidence.length, 2);
      assert.equal(
        store.getWorkspace("wksp_2", tenantNames)?.tenantId,
        "tenant-2",
      );

      const dossier = store.exportWorkspaceDossier(workspace.id, tenantNames);
      assert.match(dossier, /Contoso compliance review/);
      assert.match(dossier, /WIN-01 compliance row/);
      assert.match(dossier, /Check the owner/);

      store.deleteWorkspace(workspace.id);
      assert.equal(store.getWorkspace(workspace.id, tenantNames), undefined);
      assert.equal(store.getConversation(conversation.id)?.id, conversation.id);
      assert.equal(store.getMultiTenantJob(job.id)?.id, job.id);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Intune Chat planner", () => {
  it("only flags write intent for whole-word imperative verbs", () => {
    const readQuestions = [
      "Which required apps are assigned but not installed on targeted devices?",
      "Which endpoint security policies are assigned to all devices?",
      "Which devices have BitLocker enabled?",
      "Which accounts were disabled last week?",
      "Show recently deleted devices.",
    ];
    for (const question of readQuestions) {
      assert.equal(
        planChatContext(question).hasWriteIntent,
        false,
        `expected no write intent for: ${question}`,
      );
    }
    const writeQuestions = [
      "Retire stale Intune devices that have not synced",
      "Disable the accounts of departed users",
      "Assign the sales app to the field team",
    ];
    for (const question of writeQuestions) {
      assert.equal(
        planChatContext(question).hasWriteIntent,
        true,
        `expected write intent for: ${question}`,
      );
    }
  });

  it("plans device context and suggests matching agents", () => {
    const plan = planChatContext("Retire stale Intune devices that have not synced");
    assert.deepEqual(plan.resources.slice(0, 2), ["managedDevices", "entraDevices"]);
    assert.equal(plan.hasWriteIntent, true);

    const agent: AgentSummary = {
      id: "offboarding-agent",
      slug: "offboarding-agent",
      name: "Offboarding agent",
      description: "Builds a stale-device offboarding plan from Intune sync and Entra sign-in signals.",
      mode: "write",
      category: "devices",
      tier: "agent",
      requiresEntraTier: "free",
      scopes: ["DeviceManagementManagedDevices.Read.All"],
      author: { name: "OpenAdminOS" },
      version: "1.0.0",
      installedAt: "2026-06-01T10:00:00.000Z",
    };
    const suggestions = matchAgentsToQuestion("retire stale devices", [agent]);
    assert.equal(suggestions[0]?.agentSlug, "offboarding-agent");
    assert.ok(suggestions[0]?.matchedTerms?.includes("stale"));
    assert.ok(suggestions[0]?.matchedConcepts?.some((concept) => concept.includes("Write intent")));
    assert.deepEqual(
      suggestions[0]?.matchedResources?.slice(0, 2),
      ["managedDevices", "entraDevices"],
    );
    assert.equal(
      staleManagedDeviceSyncThresholdDays("Which managed devices have not synced in the last 7 days?"),
      7,
    );
    assert.equal(
      thresholdIsoDaysBefore("2026-06-02T00:00:00.000Z", 7),
      "2026-05-26T00:00:00.000Z",
    );

    const candidate = selfTrainingCandidateFromPrompt({
      question:
        "Always exclude user jane.doe@contoso.onmicrosoft.com and device 11111111-1111-4111-8111-111111111111 from offboarding.",
      agentSuggestions: suggestions,
    });
    assert.equal(candidate?.text.includes("jane.doe"), false);
    assert.equal(candidate?.text.includes("11111111-1111"), false);
    assert.ok(pathForResource("signIns").select?.includes("appliedConditionalAccessPolicies"));
    assert.ok(pathForResource("directoryAudits").select?.includes("targetResources"));
  });

  it("prefetches audit resources for tenant drift questions", () => {
    const plan = planChatContext("Who changed configuration policies since Friday?");
    assert.equal(plan.resources.includes("directoryAudits"), true);
    assert.equal(plan.resources.includes("intuneAuditEvents"), true);
    assert.equal(plan.hasWriteIntent, false);
  });

  it("keeps write agents out of read-only stale-sync recommendations", () => {
    const readAgent: AgentSummary = {
      id: "find-inactive-devices",
      slug: "find-inactive-devices",
      name: "Find inactive devices",
      description: "Reviews Intune-managed device inactivity by sync age and enrollment signals.",
      mode: "read",
      category: "devices",
      tier: "agent",
      requiresEntraTier: "free",
      scopes: ["DeviceManagementManagedDevices.Read.All"],
      author: { name: "OpenAdminOS" },
      version: "1.0.0",
      installedAt: "2026-06-01T10:00:00.000Z",
    };
    const offboardingAgent: AgentSummary = {
      ...readAgent,
      id: "offboarding-agent",
      slug: "offboarding-agent",
      name: "Offboarding agent",
      description: "Builds a stale-device offboarding plan from Intune sync and Entra sign-in signals.",
      mode: "write",
    };
    const staleGuestAgent: AgentSummary = {
      ...readAgent,
      id: "stale-guest-cleanup",
      slug: "stale-guest-cleanup",
      name: "Stale guest cleanup",
      description: "Builds a capped disable plan for enabled guest accounts with stale sign-in activity.",
      mode: "write",
      category: "policies",
    };

    const suggestions = matchAgentsToQuestion(
      "Which managed devices have not synced in the last 7 days?",
      [readAgent, offboardingAgent, staleGuestAgent],
    );

    assert.deepEqual(
      suggestions.map((suggestion) => suggestion.agentSlug),
      ["find-inactive-devices"],
    );
    assert.ok(
      suggestions[0]?.matchedConcepts?.some((concept) =>
        concept.includes("device investigation"),
      ),
    );
    assert.deepEqual(
      suggestions[0]?.matchedResources?.slice(0, 2),
      ["managedDevices", "entraDevices"],
    );
  });

  it("suppresses category-mismatched write agents even when write intent is present", () => {
    const offboardingAgent: AgentSummary = {
      id: "offboarding-agent",
      slug: "offboarding-agent",
      name: "Offboarding agent",
      description: "Builds a stale-device offboarding plan from Intune sync and Entra sign-in signals.",
      mode: "write",
      category: "devices",
      tier: "agent",
      requiresEntraTier: "free",
      scopes: ["DeviceManagementManagedDevices.Read.All"],
      author: { name: "OpenAdminOS" },
      version: "1.0.0",
      installedAt: "2026-06-01T10:00:00.000Z",
    };
    const staleGuestAgent: AgentSummary = {
      ...offboardingAgent,
      id: "stale-guest-cleanup",
      slug: "stale-guest-cleanup",
      name: "Stale guest cleanup",
      description: "Builds a capped disable plan for enabled guest accounts with stale sign-in activity.",
      category: "policies",
    };

    const suggestions = matchAgentsToQuestion(
      "Always retire stale Windows devices that have not synced.",
      [offboardingAgent, staleGuestAgent],
    );

    assert.deepEqual(
      suggestions.map((suggestion) => suggestion.agentSlug),
      ["offboarding-agent"],
    );
  });

  it("covers the 150 researched administrator questions", async () => {
    const source = await readFile(
      new URL("../../../../docs/research/intune-chat-question-bank.md", import.meta.url),
      "utf8",
    );
    const questionLines = source
      .split(/\r?\n/)
      .filter((line) => /^\d+\.\s+.+\[[^\]]+\]$/.test(line));
    const knownResources = new Set(GRAPH_CACHE_RESOURCES.map((entry) => entry.resource));

    assert.equal(questionLines.length, 150);

    for (const line of questionLines) {
      const match = line.match(/^\d+\.\s+(.+?)\s+\[([^\]]+)\]$/);
      assert.ok(match, `Question bank line did not parse: ${line}`);
      const question = match[1] ?? "";
      const expectedResources = (match[2] ?? "")
        .split(",")
        .map((resource) => resource.trim())
        .filter(Boolean) as GraphCacheResourceKind[];
      for (const resource of expectedResources) {
        assert.ok(knownResources.has(resource), `Unknown resource ${resource} in ${line}`);
      }
      const plan = planChatContext(question);
      for (const resource of expectedResources) {
        assert.ok(
          plan.resources.includes(resource),
          `${question} did not plan ${resource}; planned ${plan.resources.join(", ")}`,
        );
      }
    }
  });

  it("maps every chat cache resource to a known local Graph GET endpoint", async () => {
    const source = await readFile(
      new URL("../assets/graph-index/graph-api-index.json", import.meta.url),
      "utf8",
    );
    const index = JSON.parse(source) as {
      endpoints: Array<{ method: string; path: string }>;
    };
    const getPaths = new Set(
      index.endpoints
        .filter((endpoint) => endpoint.method === "GET")
        .map((endpoint) => endpoint.path),
    );

    for (const resource of GRAPH_CACHE_RESOURCES) {
      const request = pathForResource(resource.resource);
      assert.ok(
        getPaths.has(request.path),
        `${resource.resource} maps to unknown Graph path ${request.path}`,
      );
    }
  });

  it("uses Graph-documented delegated permissions for every chat cache endpoint", async () => {
    const source = await readFile(
      new URL("../assets/graph-index/api-docs-index.json", import.meta.url),
      "utf8",
    );
    const index = JSON.parse(source) as {
      endpoints: Array<{
        method: string;
        path: string;
        permissions?: { delegatedWork?: string[] };
      }>;
    };
    const initialConsentScopes = new Set(await readDefaultScopeNames());

    for (const resource of GRAPH_CACHE_RESOURCES) {
      const request = pathForResource(resource.resource);
      const endpoint = index.endpoints.find(
        (entry) => entry.method === "GET" && entry.path === request.path,
      );
      assert.ok(endpoint, `${resource.resource} has no Graph PM endpoint metadata.`);
      const delegatedScopes = endpoint.permissions?.delegatedWork ?? [];
      if (delegatedScopes.length > 0) {
        const hasDocumentedScope = resource.scopes.some((scope) =>
          delegatedScopes.includes(scope) ||
          isAcceptedPermissionSuperset(resource.resource, scope, delegatedScopes),
        );
        assert.ok(
          hasDocumentedScope,
          `${resource.resource} declares ${resource.scopes.join(", ")} but Graph PM documents ${delegatedScopes.join(", ")}`,
        );
      }
      for (const scope of resource.scopes) {
        assert.equal(
          scope.includes("ReadWrite"),
          false,
          `${resource.resource} must not request read-write scope ${scope} for chat cache.`,
        );
        assert.ok(
          initialConsentScopes.has(scope),
          `${resource.resource} requires ${scope}, but tenant connection does not request it up front.`,
        );
      }
    }
  });

  it("only selects fields that Graph PM documents for chat cache resources", async () => {
    const source = await readFile(
      new URL("../assets/graph-index/api-docs-index.json", import.meta.url),
      "utf8",
    );
    const index = JSON.parse(source) as {
      resources: Array<{ name: string; properties: Array<{ name: string }> }>;
    };

    for (const resource of GRAPH_CACHE_RESOURCES) {
      const request = pathForResource(resource.resource);
      if (!request.select || request.select.length === 0) continue;
      const resourceName = graphPmResourceName(resource.resource);
      const graphResource = index.resources.find((entry) => entry.name === resourceName);
      assert.ok(graphResource, `${resource.resource} maps to unknown Graph PM resource ${resourceName}.`);
      const properties = new Set(graphResource.properties.map((property) => property.name));
      for (const field of request.select) {
        assert.ok(
          properties.has(field) || isKnownGraphPmPropertyGap(resource.resource, field),
          `${resource.resource} selects ${field}, but Graph PM does not document it on ${resourceName}.`,
        );
      }
    }
  });
});

function isAcceptedPermissionSuperset(
  resource: GraphCacheResourceKind,
  scope: string,
  documentedScopes: string[],
): boolean {
  // The 2026-06-01 Graph PM index currently maps GET /groups to a read-write
  // nesting support scope. Keep the chat cache read-only: Microsoft's
  // permission reference describes GroupMember.Read.All as sufficient to list
  // groups and read basic group properties/membership signals.
  if (
    resource === "groups" &&
    scope === "GroupMember.Read.All" &&
    documentedScopes.includes("Group-NestingSupport.ReadWrite.All")
  ) {
    return true;
  }
  // Live Intune audit event checks for the D2 drift timeline confirmed that
  // DeviceManagementConfiguration.Read.All can read /deviceManagement/auditEvents
  // in v1.0. The bundled Graph PM index currently lists the Apps read family.
  if (
    (resource as string) === "intuneAuditEvents" &&
    scope === "DeviceManagementConfiguration.Read.All" &&
    documentedScopes.includes("DeviceManagementApps.Read.All")
  ) {
    return true;
  }
  // Microsoft's permissions reference lists Policy.Read.AuthenticationMethod
  // as least-privileged for GET /policies/authenticationMethodsPolicy and
  // Policy.Read.All as the documented higher-privileged alternative. The
  // initial consent set already carries Policy.Read.All, so requesting the
  // narrower duplicate would only add consent-screen noise.
  if (
    resource === "authenticationMethodsPolicy" &&
    scope === "Policy.Read.All" &&
    documentedScopes.includes("Policy.Read.AuthenticationMethod")
  ) {
    return true;
  }
  return scope === "User.Read.All" && documentedScopes.includes("User.ReadBasic.All");
}

function isKnownGraphPmPropertyGap(
  resource: GraphCacheResourceKind,
  field: string,
): boolean {
  // Microsoft Graph returns userPrincipalName for /users; the bundled Graph PM
  // resource index currently omits it from the user schema.
  if (resource === "users" && field === "userPrincipalName") return true;
  if ((resource as string) === "intuneAuditEvents") {
    return new Set([
      "displayName",
      "componentName",
      "activityType",
      "activityOperationType",
      "activityResult",
      "correlationId",
      "actor",
      "resources",
    ]).has(field);
  }
  return false;
}

function graphPmResourceName(
  resource: GraphCacheResourceKind | "intuneAuditEvents",
): string {
  const resourceNames: Record<GraphCacheResourceKind | "intuneAuditEvents", string> = {
    managedDevices: "managedDevice",
    entraDevices: "device",
    users: "user",
    groups: "group",
    deviceCompliancePolicies: "deviceCompliancePolicy",
    deviceConfigurations: "deviceConfiguration",
    configurationPolicies: "deviceManagementConfigurationPolicy",
    signIns: "signIn",
    directoryAudits: "directoryAudit",
    intuneAuditEvents: "auditEvent",
    conditionalAccessPolicies: "conditionalAccessPolicy",
    mobileApps: "mobileApp",
    detectedApps: "detectedApp",
    managedAppPolicies: "managedAppPolicy",
    iosManagedAppProtections: "iosManagedAppProtection",
    androidManagedAppProtections: "androidManagedAppProtection",
    mobileAppConfigurations: "managedDeviceMobileAppConfiguration",
    deviceHealthScripts: "deviceHealthScript",
    deviceManagementScripts: "deviceManagementScript",
    windowsAutopilotDevices: "windowsAutopilotDeviceIdentity",
    autopilotEvents: "deviceManagementAutopilotEvent",
    windowsAutopilotProfiles: "windowsAutopilotDeploymentProfile",
    deviceEnrollmentConfigurations: "deviceEnrollmentConfiguration",
    windowsQualityUpdateProfiles: "windowsQualityUpdateProfile",
    windowsFeatureUpdateProfiles: "windowsFeatureUpdateProfile",
    endpointSecurityIntents: "deviceManagementIntent",
    groupPolicyConfigurations: "groupPolicyConfiguration",
    assignmentFilters: "deviceAndAppManagementAssignmentFilter",
    roleScopeTags: "roleScopeTag",
    managedDeviceOverview: "managedDeviceOverview",
    managedDeviceEncryptionStates: "managedDeviceEncryptionState",
    troubleshootingEvents: "deviceManagementTroubleshootingEvent",
    namedLocations: "namedLocation",
    authenticationMethodsPolicy: "authenticationMethodsPolicy",
    authorizationPolicy: "authorizationPolicy",
    crossTenantAccessPolicy: "crossTenantAccessPolicy",
    directoryRoles: "directoryRole",
    administrativeUnits: "administrativeUnit",
    applications: "application",
    servicePrincipals: "servicePrincipal",
    domains: "domain",
    securityAlerts: "alert",
    securityIncidents: "incident",
    secureScores: "secureScore",
    secureScoreControlProfiles: "secureScoreControlProfile",
  };
  return resourceNames[resource];
}

async function readDefaultScopeNames(): Promise<string[]> {
  const source = await readFile(
    new URL("../../../../packages/runtime/src/msal.ts", import.meta.url),
    "utf8",
  );
  return [...source.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1] ?? "");
}
