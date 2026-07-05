import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ChatInvestigationMode,
  ChatInvestigationSettings,
  GraphCacheResourceKind,
  GraphCacheResourceStatus,
  GraphCacheRefreshScheduleSettings,
  ImportMultiTenantResultToWorkspacesResult,
  IntuneChatConversation,
  IntuneChatInvestigationToolName,
  IntuneChatMessage,
  IntuneChatToolCall,
  IntuneChatToolTraceEntry,
  LocalDataSummary,
  MultiTenantAgentBatch,
  MultiTenantChatJob,
  SavedMultiTenantQuery,
  SelfTrainingSettings,
  SelfTrainingSuggestion,
  SelfTrainingSuggestionStatus,
  TenantGroup,
  TenantScope,
  WorkspaceDetail,
  WorkspaceEvidence,
  WorkspaceLink,
  WorkspaceNote,
  WorkspaceStatus,
  WorkspaceSummary,
} from "@openadminos/agent-sdk";
import { driftContentHash } from "./drift/canonical.js";
import { DRIFT_TRACKED_RESOURCES } from "./drift/tracked-resources.js";

interface ConversationRow {
  id: string;
  title: string;
  tenant_id: string | null;
  scope_kind: string | null;
  scope_json: string | null;
  multi_tenant_job_id: string | null;
  created_at: string;
  updated_at: string;
  pinned_at: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: IntuneChatMessage["role"];
  content: string;
  status: IntuneChatMessage["status"];
  provider_id: string | null;
  model: string | null;
  sources_json: string | null;
  agent_suggestions_json: string | null;
  error: string | null;
  created_at: string;
}

interface ResourceStatusRow {
  resource: GraphCacheResourceKind;
  label: string;
  row_count: number;
  page_count: number | null;
  page_limit_reached: number | null;
  refreshed_at: string | null;
  scope_set_json: string;
  last_error: string | null;
}

interface ResourceRow {
  raw_json: string;
  refreshed_at?: string;
}

interface CachedGraphResourceRow {
  resource: GraphCacheResourceKind;
  graph_id: string;
  raw_json: string;
  display_name: string | null;
  refreshed_at: string;
}

interface NormalizedGraphObject {
  graphId: string;
  searchText: string;
  displayName: string | null;
  userPrincipalName: string | null;
  operatingSystem: string | null;
  complianceState: string | null;
  lastSeenAt: string | null;
}

interface NormalizedGraphResourceRow {
  row: unknown;
  rawJson: string;
  normalized: NormalizedGraphObject;
}

interface DriftSnapshotRow {
  id: string;
  tenant_id: string;
  resource: GraphCacheResourceKind;
  captured_at: string;
  row_count: number;
  changes_added: number;
  changes_removed: number;
  changes_modified: number;
}

interface DriftObjectVersionRow {
  tenant_id: string;
  resource: GraphCacheResourceKind;
  graph_id: string;
  version: number;
  content_hash: string;
  raw_json: string;
  display_name: string | null;
  first_seen_snapshot_id: string;
  first_seen_at: string;
  removed_snapshot_id: string | null;
  removed_at: string | null;
}

interface QueryCacheRow extends ResourceRow {
  total_count: number;
}

interface SettingRow {
  value: string;
  updated_at: string;
}

export interface HostedProviderConsentAuditRecord {
  id: string;
  tenantId: string;
  source: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface ToolCallRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  type: string;
  status: IntuneChatToolCall["status"];
  input_json: string | null;
  output_json: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

interface SuggestionRow {
  id: string;
  tenant_id: string;
  agent_slug: string;
  status: SelfTrainingSuggestionStatus;
  text: string;
  reason: string;
  source: SelfTrainingSuggestion["source"];
  created_at: string;
  decided_at: string | null;
}

interface TenantGroupRow {
  id: string;
  name: string;
  tenant_ids_json: string;
  created_at: string;
  updated_at: string;
}

interface SavedQueryRow {
  id: string;
  title: string;
  prompt: string;
  resource_hints_json: string;
  default_scope_json: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface MultiTenantJobRow {
  id: string;
  conversation_id: string | null;
  prompt: string;
  saved_query_id: string | null;
  tenant_scope_json: string;
  resolved_tenant_ids_json: string;
  provider_id: string;
  provider_name: string;
  provider_is_local: number;
  model: string | null;
  status: MultiTenantChatJob["status"];
  preflight_json: string;
  progress_json: string;
  summary_json: string;
  comparisons_json: string;
  device_rows_json: string;
  assistant_text: string;
  export_dossier_markdown: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface MultiTenantAgentBatchRow {
  id: string;
  agent_slug: string;
  agent_name: string;
  agent_mode: MultiTenantAgentBatch["agentMode"];
  tenant_scope_json: string;
  resolved_tenant_ids_json: string;
  status: MultiTenantAgentBatch["status"];
  run_ids_json: string;
  preflight_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkspaceRow {
  id: string;
  tenant_id: string;
  title: string;
  status: WorkspaceStatus;
  instructions: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkspaceEvidenceRow {
  id: string;
  workspace_id: string;
  tenant_id: string;
  title: string;
  source_type: WorkspaceEvidence["sourceType"];
  source_ref_json: string | null;
  content_json: string;
  freshness_json: string | null;
  created_at: string;
}

interface WorkspaceNoteRow {
  id: string;
  workspace_id: string;
  tenant_id: string;
  content: string;
  created_at: string;
  updated_at: string;
}

interface WorkspaceLinkRow {
  id: string;
  workspace_id: string;
  tenant_id: string;
  type: WorkspaceLink["type"];
  ref_id: string;
  title: string;
  created_at: string;
}

export interface GraphCacheResourceDefinition {
  resource: GraphCacheResourceKind;
  label: string;
  scopes: string[];
}

export type GraphCacheQueryOperator =
  | "eq"
  | "neq"
  | "contains"
  | "startsWith"
  | "in"
  | "lt"
  | "lte"
  | "gt"
  | "gte";

export interface GraphCacheQueryPredicate {
  field: string;
  op: GraphCacheQueryOperator;
  value: string | number | boolean | Array<string | number | boolean>;
}

export interface GraphCacheQueryResult {
  resource: GraphCacheResourceKind;
  totalCount: number;
  returnedRows: number;
  limit: number;
  rows: { row: unknown; refreshedAt?: string }[];
}

export interface DriftSnapshotRecord {
  id: string;
  tenantId: string;
  resource: GraphCacheResourceKind;
  capturedAt: string;
  rowCount: number;
  changesAdded: number;
  changesRemoved: number;
  changesModified: number;
}

export interface DriftSnapshotChangeRecord {
  kind: "added" | "removed" | "modified";
  resource: GraphCacheResourceKind;
  graphId: string;
  displayName?: string;
  previousRawJson?: string;
  currentRawJson?: string;
}

export interface DriftObjectVersionRecord {
  tenantId: string;
  resource: GraphCacheResourceKind;
  graphId: string;
  version: number;
  contentHash: string;
  rawJson: string;
  displayName?: string;
  firstSeenSnapshotId: string;
  firstSeenAt: string;
  removedSnapshotId?: string;
  removedAt?: string;
}

export interface DriftPruneResult {
  snapshotsDeleted: number;
  versionsDeleted: number;
}

export interface CachedGraphResourceRecord {
  resource: GraphCacheResourceKind;
  graphId: string;
  row: unknown;
  rawJson: string;
  displayName?: string;
  refreshedAt: string;
}

export interface DriftResourceStatsRecord {
  resource: GraphCacheResourceKind;
  baselineSnapshotId?: string;
  baselineCapturedAt?: string;
  lastSnapshotAt?: string;
  snapshotCount: number;
  totalTrackedVersions: number;
  currentObjectCount: number;
}

export class IntelligenceSqliteStore {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  listConversations(): IntuneChatConversation[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, tenant_id, scope_kind, scope_json, multi_tenant_job_id,
                created_at, updated_at, pinned_at
         FROM chat_conversations
         ORDER BY pinned_at IS NULL, pinned_at DESC, updated_at DESC`,
      )
      .all() as unknown as ConversationRow[];
    return rows.map(readConversation);
  }

  searchConversations(query: string): IntuneChatConversation[] {
    const trimmed = query.trim();
    if (!trimmed) return this.listConversations();
    const like = `%${escapeSqlLike(trimmed)}%`;
    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.tenant_id, c.scope_kind, c.scope_json,
                c.multi_tenant_job_id, c.created_at, c.updated_at, c.pinned_at
         FROM chat_conversations c
         WHERE c.title LIKE ? ESCAPE '\\'
            OR EXISTS (
              SELECT 1
              FROM chat_messages m
              WHERE m.conversation_id = c.id
                AND m.content LIKE ? ESCAPE '\\'
            )
         ORDER BY c.pinned_at IS NULL, c.pinned_at DESC, c.updated_at DESC`,
      )
      .all(like, like) as unknown as ConversationRow[];
    return rows.map(readConversation);
  }

  getConversation(id: string): IntuneChatConversation | undefined {
    const row = this.db
      .prepare(
        `SELECT id, title, tenant_id, scope_kind, scope_json, multi_tenant_job_id,
                created_at, updated_at, pinned_at
         FROM chat_conversations
         WHERE id = ?`,
      )
      .get(id) as unknown as ConversationRow | undefined;
    return row ? readConversation(row) : undefined;
  }

  createConversation(input: {
    id: string;
    title: string;
    tenantId: string;
    now: string;
    scopeKind?: IntuneChatConversation["scopeKind"];
    tenantScope?: TenantScope;
    multiTenantJobId?: string;
  }): IntuneChatConversation {
    this.db
      .prepare(
        `INSERT INTO chat_conversations (
          id, title, tenant_id, scope_kind, scope_json, multi_tenant_job_id,
          created_at, updated_at
        )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.title,
        input.tenantId,
        input.scopeKind ?? "single-tenant",
        input.tenantScope ? JSON.stringify(input.tenantScope) : null,
        input.multiTenantJobId ?? null,
        input.now,
        input.now,
      );
    return {
      id: input.id,
      title: input.title,
      tenantId: input.tenantId,
      scopeKind: input.scopeKind ?? "single-tenant",
      ...(input.tenantScope ? { tenantScope: input.tenantScope } : {}),
      ...(input.multiTenantJobId ? { multiTenantJobId: input.multiTenantJobId } : {}),
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  renameConversation(id: string, title: string, now: string): IntuneChatConversation {
    const result = this.db
      .prepare(
        `UPDATE chat_conversations
         SET title = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(title, now, id);
    if (result.changes === 0) {
      throw new Error(`Chat conversation not found: ${id}`);
    }
    const conversation = this.getConversation(id);
    if (!conversation) {
      throw new Error(`Chat conversation not found: ${id}`);
    }
    return conversation;
  }

  setConversationPinned(
    id: string,
    pinned: boolean,
    now: string,
  ): IntuneChatConversation {
    const result = this.db
      .prepare(
        `UPDATE chat_conversations
         SET pinned_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(pinned ? now : null, now, id);
    if (result.changes === 0) {
      throw new Error(`Chat conversation not found: ${id}`);
    }
    const conversation = this.getConversation(id);
    if (!conversation) {
      throw new Error(`Chat conversation not found: ${id}`);
    }
    return conversation;
  }

  deleteConversation(id: string): void {
    const result = this.db
      .prepare(`DELETE FROM chat_conversations WHERE id = ?`)
      .run(id);
    if (result.changes === 0) {
      throw new Error(`Chat conversation not found: ${id}`);
    }
  }

  clearChatHistory(): void {
    this.db.prepare(`DELETE FROM chat_conversations`).run();
  }

  touchConversation(id: string, title: string | undefined, now: string): void {
    if (title) {
      this.db
        .prepare(
          `UPDATE chat_conversations
           SET title = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(title, now, id);
      return;
    }
    this.db
      .prepare(
        `UPDATE chat_conversations
         SET updated_at = ?
         WHERE id = ?`,
      )
      .run(now, id);
  }

  insertMessage(message: IntuneChatMessage): void {
    this.db
      .prepare(
        `INSERT INTO chat_messages (
          id, conversation_id, role, content, status, provider_id, model,
          sources_json, agent_suggestions_json, error, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.conversationId,
        message.role,
        message.content,
        message.status,
        message.providerId ?? null,
        message.model ?? null,
        message.sources ? JSON.stringify(message.sources) : null,
        message.agentSuggestions ? JSON.stringify(message.agentSuggestions) : null,
        message.error ?? null,
        message.createdAt,
      );
  }

  listMessages(conversationId: string): IntuneChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, role, content, status, provider_id, model,
                sources_json, agent_suggestions_json, error, created_at
         FROM chat_messages
         WHERE conversation_id = ?
         ORDER BY created_at ASC`,
      )
      .all(conversationId) as unknown as MessageRow[];
    const messages = rows.map(readMessage);
    const traceByMessage = this.listInvestigationToolTraces(conversationId);
    return messages.map((message) => {
      const toolTrace = traceByMessage.get(message.id);
      return toolTrace && toolTrace.length > 0 ? { ...message, toolTrace } : message;
    });
  }

  listToolCalls(conversationId: string): IntuneChatToolCall[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, message_id, type, status, input_json, output_json,
                error, created_at, completed_at
         FROM chat_tool_calls
         WHERE conversation_id = ?
         ORDER BY created_at ASC`,
      )
      .all(conversationId) as unknown as ToolCallRow[];
    return rows.map(readToolCall);
  }

  insertToolCall(toolCall: IntuneChatToolCall): void {
    this.db
      .prepare(
        `INSERT INTO chat_tool_calls (
          id, conversation_id, message_id, type, status, input_json, output_json,
          error, created_at, completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        toolCall.id,
        toolCall.conversationId,
        toolCall.messageId ?? null,
        toolCall.type,
        toolCall.status,
        toolCall.input === undefined ? null : JSON.stringify(toolCall.input),
        toolCall.output === undefined ? null : JSON.stringify(toolCall.output),
        toolCall.error ?? null,
        toolCall.createdAt,
        toolCall.completedAt ?? null,
      );
  }

  replaceGraphResources(input: {
    tenantId: string;
    resource: GraphCacheResourceKind;
    label: string;
    scopeSet: string[];
    rows: unknown[];
    pageCount?: number;
    pageLimitReached?: boolean;
    refreshedAt: string;
  }): void {
    const snapshotId = `${input.resource}-${input.refreshedAt}-${randomUUID().slice(0, 8)}`;
    this.db.exec("BEGIN");
    try {
      const normalizedRows = input.rows.map((row) => ({
        row,
        rawJson: JSON.stringify(row) ?? "null",
        normalized: normalizeGraphObject(row),
      }));
      if (DRIFT_TRACKED_RESOURCES.has(input.resource)) {
        this.captureDriftSnapshot({
          tenantId: input.tenantId,
          resource: input.resource,
          rows: normalizedRows,
          snapshotId,
          refreshedAt: input.refreshedAt,
        });
      }
      this.db
        .prepare(
          `DELETE FROM graph_resources
           WHERE tenant_id = ? AND resource = ?`,
        )
        .run(input.tenantId, input.resource);
      const insert = this.db.prepare(
        `INSERT INTO graph_resources (
          tenant_id, resource, graph_id, snapshot_id, raw_json, search_text,
          display_name, user_principal_name, operating_system, compliance_state,
          last_seen_at, refreshed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const entry of normalizedRows) {
        insert.run(
          input.tenantId,
          input.resource,
          entry.normalized.graphId,
          snapshotId,
          entry.rawJson,
          entry.normalized.searchText,
          entry.normalized.displayName,
          entry.normalized.userPrincipalName,
          entry.normalized.operatingSystem,
          entry.normalized.complianceState,
          entry.normalized.lastSeenAt,
          input.refreshedAt,
        );
      }
      this.db
        .prepare(
          `INSERT INTO graph_cache_status (
            tenant_id, resource, label, row_count, page_count, page_limit_reached,
            refreshed_at, scope_set_json, last_error
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(tenant_id, resource) DO UPDATE SET
            label = excluded.label,
            row_count = excluded.row_count,
            page_count = excluded.page_count,
            page_limit_reached = excluded.page_limit_reached,
            refreshed_at = excluded.refreshed_at,
            scope_set_json = excluded.scope_set_json,
            last_error = NULL`,
        )
        .run(
          input.tenantId,
          input.resource,
          input.label,
          input.rows.length,
          input.pageCount ?? 1,
          input.pageLimitReached ? 1 : 0,
          input.refreshedAt,
          JSON.stringify(input.scopeSet),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private captureDriftSnapshot(input: {
    tenantId: string;
    resource: GraphCacheResourceKind;
    rows: NormalizedGraphResourceRow[];
    snapshotId: string;
    refreshedAt: string;
  }): void {
    const previousRows = this.db
      .prepare(
        `SELECT graph_id, raw_json, display_name
         FROM graph_resources
         WHERE tenant_id = ? AND resource = ?`,
      )
      .all(input.tenantId, input.resource) as unknown as Array<{
        graph_id: string;
        raw_json: string;
        display_name: string | null;
      }>;
    const previousById = new Map<string, { rawJson: string; contentHash: string }>();
    for (const row of previousRows) {
      previousById.set(row.graph_id, {
        rawJson: row.raw_json,
        contentHash: driftContentHash(readJson<unknown>(row.raw_json, row.raw_json), input.resource),
      });
    }

    const currentById = new Map<
      string,
      { rawJson: string; contentHash: string; displayName: string | null }
    >();
    for (const entry of input.rows) {
      currentById.set(entry.normalized.graphId, {
        rawJson: entry.rawJson,
        contentHash: driftContentHash(entry.row, input.resource),
        displayName: entry.normalized.displayName,
      });
    }

    const latestById = this.readLatestDriftVersions(input.tenantId, input.resource);
    const hasPreviousSnapshot =
      this.countRows("drift_snapshots", "tenant_id = ? AND resource = ?", [
        input.tenantId,
        input.resource,
      ]) > 0;

    if (!hasPreviousSnapshot) {
      this.insertDriftSnapshot({
        id: input.snapshotId,
        tenantId: input.tenantId,
        resource: input.resource,
        capturedAt: input.refreshedAt,
        rowCount: input.rows.length,
        changesAdded: 0,
        changesRemoved: 0,
        changesModified: 0,
      });
      for (const [graphId, current] of currentById) {
        this.insertDriftObjectVersion({
          tenantId: input.tenantId,
          resource: input.resource,
          graphId,
          version: 1,
          contentHash: current.contentHash,
          rawJson: current.rawJson,
          displayName: current.displayName,
          firstSeenSnapshotId: input.snapshotId,
          firstSeenAt: input.refreshedAt,
        });
      }
      return;
    }

    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    for (const graphId of currentById.keys()) {
      if (!previousById.has(graphId)) {
        added.push(graphId);
        continue;
      }
      const previous = previousById.get(graphId);
      const current = currentById.get(graphId);
      if (previous && current && previous.contentHash !== current.contentHash) {
        modified.push(graphId);
      }
    }
    for (const graphId of previousById.keys()) {
      if (!currentById.has(graphId)) removed.push(graphId);
    }

    // The first refresh is a baseline snapshot. Later zero-change refreshes are
    // intentionally skipped so the drift timeline does not accumulate noise.
    if (added.length === 0 && removed.length === 0 && modified.length === 0) return;

    this.insertDriftSnapshot({
      id: input.snapshotId,
      tenantId: input.tenantId,
      resource: input.resource,
      capturedAt: input.refreshedAt,
      rowCount: input.rows.length,
      changesAdded: added.length,
      changesRemoved: removed.length,
      changesModified: modified.length,
    });

    for (const graphId of added) {
      const current = currentById.get(graphId);
      if (!current) continue;
      const latest = latestById.get(graphId);
      this.insertDriftObjectVersion({
        tenantId: input.tenantId,
        resource: input.resource,
        graphId,
        version: (latest?.version ?? 0) + 1,
        contentHash: current.contentHash,
        rawJson: current.rawJson,
        displayName: current.displayName,
        firstSeenSnapshotId: input.snapshotId,
        firstSeenAt: input.refreshedAt,
      });
    }

    for (const graphId of modified) {
      const current = currentById.get(graphId);
      if (!current) continue;
      const latest = latestById.get(graphId);
      this.insertDriftObjectVersion({
        tenantId: input.tenantId,
        resource: input.resource,
        graphId,
        version: (latest?.version ?? 0) + 1,
        contentHash: current.contentHash,
        rawJson: current.rawJson,
        displayName: current.displayName,
        firstSeenSnapshotId: input.snapshotId,
        firstSeenAt: input.refreshedAt,
      });
    }

    for (const graphId of removed) {
      const latest = latestById.get(graphId);
      if (!latest || latest.removed_at) continue;
      this.db
        .prepare(
          `UPDATE drift_object_versions
           SET removed_snapshot_id = ?, removed_at = ?
           WHERE tenant_id = ? AND resource = ? AND graph_id = ? AND version = ?`,
        )
        .run(
          input.snapshotId,
          input.refreshedAt,
          input.tenantId,
          input.resource,
          graphId,
          latest.version,
        );
    }
  }

  recordGraphResourceError(input: {
    tenantId: string;
    resource: GraphCacheResourceKind;
    label: string;
    scopeSet: string[];
    error: string;
    now: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO graph_cache_status (
          tenant_id, resource, label, row_count, page_count, page_limit_reached,
          refreshed_at, scope_set_json, last_error
        )
        VALUES (?, ?, ?, 0, 0, 0, NULL, ?, ?)
        ON CONFLICT(tenant_id, resource) DO UPDATE SET
          label = excluded.label,
          scope_set_json = excluded.scope_set_json,
          last_error = excluded.last_error`,
      )
      .run(
        input.tenantId,
        input.resource,
        input.label,
        JSON.stringify(input.scopeSet),
        `${input.now}: ${input.error}`,
      );
  }

  getGraphCacheStatus(
    tenantId: string,
    definitions: GraphCacheResourceDefinition[],
  ): GraphCacheResourceStatus[] {
    const rows = this.db
      .prepare(
        `SELECT resource, label, row_count, page_count, page_limit_reached,
                refreshed_at, scope_set_json, last_error
         FROM graph_cache_status
         WHERE tenant_id = ?`,
      )
      .all(tenantId) as unknown as ResourceStatusRow[];
    const byResource = new Map(rows.map((row) => [row.resource, row]));
    return definitions.map((definition) => {
      const row = byResource.get(definition.resource);
      if (!row) {
        return {
          resource: definition.resource,
          label: definition.label,
          rows: 0,
          scopeSet: definition.scopes,
        };
      }
      return {
        resource: row.resource,
        label: row.label,
        rows: row.row_count,
        pages: row.page_count ?? undefined,
        pageLimitReached: row.page_limit_reached === 1,
        refreshedAt: row.refreshed_at ?? undefined,
        scopeSet: readJson<string[]>(row.scope_set_json, definition.scopes),
        lastError: row.last_error ?? undefined,
      };
    });
  }

  listDriftSnapshots(
    tenantId: string,
    options: {
      resource?: GraphCacheResourceKind;
      from?: string;
      to?: string;
      limit?: number;
    } = {},
  ): DriftSnapshotRecord[] {
    const where = ["tenant_id = ?"];
    const args: Array<string | number> = [tenantId];
    if (options.resource) {
      where.push("resource = ?");
      args.push(options.resource);
    }
    if (options.from) {
      where.push("captured_at >= ?");
      args.push(options.from);
    }
    if (options.to) {
      where.push("captured_at <= ?");
      args.push(options.to);
    }
    const limit = normalizeDriftLimit(options.limit, 100);
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, resource, captured_at, row_count,
                changes_added, changes_removed, changes_modified
         FROM drift_snapshots
         WHERE ${where.join(" AND ")}
         ORDER BY captured_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...args, limit) as unknown as DriftSnapshotRow[];
    return rows.map(readDriftSnapshot);
  }

  getDriftSnapshot(
    tenantId: string,
    snapshotId: string,
  ): DriftSnapshotRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, resource, captured_at, row_count,
                changes_added, changes_removed, changes_modified
         FROM drift_snapshots
         WHERE tenant_id = ? AND id = ?`,
      )
      .get(tenantId, snapshotId) as unknown as DriftSnapshotRow | undefined;
    return row ? readDriftSnapshot(row) : undefined;
  }

  listDriftChangesForSnapshot(
    tenantId: string,
    snapshotId: string,
  ): DriftSnapshotChangeRecord[] {
    const snapshot = this.db
      .prepare(
        `SELECT id, tenant_id, resource, captured_at, row_count,
                changes_added, changes_removed, changes_modified
         FROM drift_snapshots
         WHERE tenant_id = ? AND id = ?`,
      )
      .get(tenantId, snapshotId) as unknown as DriftSnapshotRow | undefined;
    if (!snapshot) return [];
    if (
      snapshot.changes_added === 0 &&
      snapshot.changes_removed === 0 &&
      snapshot.changes_modified === 0
    ) {
      return [];
    }

    const changes: DriftSnapshotChangeRecord[] = [];
    const firstSeenRows = this.db
      .prepare(
        `SELECT tenant_id, resource, graph_id, version, content_hash, raw_json,
                display_name, first_seen_snapshot_id, first_seen_at,
                removed_snapshot_id, removed_at
         FROM drift_object_versions
         WHERE tenant_id = ? AND resource = ? AND first_seen_snapshot_id = ?
         ORDER BY graph_id ASC, version ASC`,
      )
      .all(tenantId, snapshot.resource, snapshotId) as unknown as DriftObjectVersionRow[];

    for (const row of firstSeenRows) {
      if (row.version === 1) {
        changes.push({
          kind: "added",
          resource: row.resource,
          graphId: row.graph_id,
          ...(row.display_name ? { displayName: row.display_name } : {}),
          currentRawJson: row.raw_json,
        });
        continue;
      }
      const previous = this.getDriftObjectVersionRow(
        tenantId,
        row.resource,
        row.graph_id,
        row.version - 1,
      );
      if (!previous || previous.removed_at) {
        changes.push({
          kind: "added",
          resource: row.resource,
          graphId: row.graph_id,
          ...(row.display_name ? { displayName: row.display_name } : {}),
          currentRawJson: row.raw_json,
        });
        continue;
      }
      changes.push({
        kind: "modified",
        resource: row.resource,
        graphId: row.graph_id,
        ...(row.display_name ? { displayName: row.display_name } : {}),
        previousRawJson: previous.raw_json,
        currentRawJson: row.raw_json,
      });
    }

    const removedRows = this.db
      .prepare(
        `SELECT tenant_id, resource, graph_id, version, content_hash, raw_json,
                display_name, first_seen_snapshot_id, first_seen_at,
                removed_snapshot_id, removed_at
         FROM drift_object_versions
         WHERE tenant_id = ? AND resource = ? AND removed_snapshot_id = ?
         ORDER BY graph_id ASC, version ASC`,
      )
      .all(tenantId, snapshot.resource, snapshotId) as unknown as DriftObjectVersionRow[];
    for (const row of removedRows) {
      changes.push({
        kind: "removed",
        resource: row.resource,
        graphId: row.graph_id,
        ...(row.display_name ? { displayName: row.display_name } : {}),
        previousRawJson: row.raw_json,
      });
    }

    return changes.sort((a, b) => {
      const byGraphId = a.graphId.localeCompare(b.graphId);
      return byGraphId === 0 ? a.kind.localeCompare(b.kind) : byGraphId;
    });
  }

  getDriftObjectHistory(
    tenantId: string,
    resource: GraphCacheResourceKind,
    graphId: string,
    options: { limit?: number } = {},
  ): DriftObjectVersionRecord[] {
    const limit = normalizeDriftLimit(options.limit, 50);
    const rows = this.db
      .prepare(
        `SELECT tenant_id, resource, graph_id, version, content_hash, raw_json,
                display_name, first_seen_snapshot_id, first_seen_at,
                removed_snapshot_id, removed_at
         FROM drift_object_versions
         WHERE tenant_id = ? AND resource = ? AND graph_id = ?
         ORDER BY version DESC
         LIMIT ?`,
      )
      .all(tenantId, resource, graphId, limit) as unknown as DriftObjectVersionRow[];
    return rows.map(readDriftObjectVersion);
  }

  listCachedGraphResourceRows(input: {
    tenantId: string;
    resource: GraphCacheResourceKind;
    limit?: number;
  }): CachedGraphResourceRecord[] {
    const limit = normalizeCachedRowLimit(input.limit, 1000);
    const rows = this.db
      .prepare(
        `SELECT resource, graph_id, raw_json, display_name, refreshed_at
         FROM graph_resources
         WHERE tenant_id = ? AND resource = ?
         ORDER BY COALESCE(last_seen_at, refreshed_at) DESC, graph_id ASC
         LIMIT ?`,
      )
      .all(input.tenantId, input.resource, limit) as unknown as CachedGraphResourceRow[];
    return rows.map((row) => ({
      resource: row.resource,
      graphId: row.graph_id,
      row: readJson<unknown>(row.raw_json, {}),
      rawJson: row.raw_json,
      ...(row.display_name ? { displayName: row.display_name } : {}),
      refreshedAt: row.refreshed_at,
    }));
  }

  getDriftResourceStats(
    tenantId: string,
    resources: readonly GraphCacheResourceKind[],
  ): DriftResourceStatsRecord[] {
    return resources.map((resource) => {
      const firstSnapshot = this.db
        .prepare(
          `SELECT id, captured_at
           FROM drift_snapshots
           WHERE tenant_id = ? AND resource = ?
           ORDER BY captured_at ASC, id ASC
           LIMIT 1`,
        )
        .get(tenantId, resource) as unknown as
        | { id: string; captured_at: string }
        | undefined;
      const lastSnapshot = this.db
        .prepare(
          `SELECT captured_at
           FROM drift_snapshots
           WHERE tenant_id = ? AND resource = ?
           ORDER BY captured_at DESC, id DESC
           LIMIT 1`,
        )
        .get(tenantId, resource) as unknown as
        | { captured_at: string }
        | undefined;
      const currentRow = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM drift_object_versions v
           INNER JOIN (
             SELECT graph_id, MAX(version) AS version
             FROM drift_object_versions
             WHERE tenant_id = ? AND resource = ?
             GROUP BY graph_id
           ) latest
             ON latest.graph_id = v.graph_id
            AND latest.version = v.version
           WHERE v.tenant_id = ?
             AND v.resource = ?
             AND v.removed_at IS NULL`,
        )
        .get(tenantId, resource, tenantId, resource) as
        | { count?: number }
        | undefined;
      return {
        resource,
        ...(firstSnapshot
          ? {
              baselineSnapshotId: firstSnapshot.id,
              baselineCapturedAt: firstSnapshot.captured_at,
            }
          : {}),
        ...(lastSnapshot ? { lastSnapshotAt: lastSnapshot.captured_at } : {}),
        snapshotCount: this.countRows(
          "drift_snapshots",
          "tenant_id = ? AND resource = ?",
          [tenantId, resource],
        ),
        totalTrackedVersions: this.countRows(
          "drift_object_versions",
          "tenant_id = ? AND resource = ?",
          [tenantId, resource],
        ),
        currentObjectCount:
          typeof currentRow?.count === "number" ? currentRow.count : 0,
      };
    });
  }

  pruneDriftHistory(tenantId: string | null, retentionDays: number): DriftPruneResult {
    const days = Number.isFinite(retentionDays) ? Math.max(0, retentionDays) : 0;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    let snapshotsDeleted = 0;
    let versionsDeleted = 0;
    this.db.exec("BEGIN");
    try {
      const rows = tenantId
        ? this.db
            .prepare(
              `SELECT tenant_id, resource, graph_id, version, content_hash, raw_json,
                      display_name, first_seen_snapshot_id, first_seen_at,
                      removed_snapshot_id, removed_at
               FROM drift_object_versions
               WHERE tenant_id = ?
               ORDER BY tenant_id, resource, graph_id, version ASC`,
            )
            .all(tenantId)
        : this.db
            .prepare(
              `SELECT tenant_id, resource, graph_id, version, content_hash, raw_json,
                      display_name, first_seen_snapshot_id, first_seen_at,
                      removed_snapshot_id, removed_at
               FROM drift_object_versions
               ORDER BY tenant_id, resource, graph_id, version ASC`,
            )
            .all();
      const grouped = groupDriftVersions(rows as unknown as DriftObjectVersionRow[]);
      const deleteVersion = this.db.prepare(
        `DELETE FROM drift_object_versions
         WHERE tenant_id = ? AND resource = ? AND graph_id = ? AND version = ?`,
      );
      for (const versions of grouped.values()) {
        const latest = versions.at(-1);
        if (!latest) continue;
        const objectRemovedBeforeCutoff =
          latest.removed_at !== null && latest.removed_at < cutoff;
        for (const version of versions) {
          const isLiveCurrent =
            latest.version === version.version && latest.removed_at === null;
          if (isLiveCurrent) continue;
          const shouldDelete =
            objectRemovedBeforeCutoff ||
            (version.version < latest.version && version.first_seen_at < cutoff) ||
            (version.removed_at !== null && version.removed_at < cutoff);
          if (!shouldDelete) continue;
          const result = deleteVersion.run(
            version.tenant_id,
            version.resource,
            version.graph_id,
            version.version,
          );
          versionsDeleted += Number(result.changes ?? 0);
        }
      }

      const snapshotWhere = ["captured_at < ?"];
      const snapshotArgs: string[] = [cutoff];
      if (tenantId) {
        snapshotWhere.push("tenant_id = ?");
        snapshotArgs.push(tenantId);
      }
      const snapshotResult = this.db
        .prepare(`DELETE FROM drift_snapshots WHERE ${snapshotWhere.join(" AND ")}`)
        .run(...snapshotArgs);
      snapshotsDeleted = Number(snapshotResult.changes ?? 0);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { snapshotsDeleted, versionsDeleted };
  }

  clearGraphCache(tenantId: string): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(`DELETE FROM graph_resources WHERE tenant_id = ?`)
        .run(tenantId);
      this.db
        .prepare(`DELETE FROM graph_cache_status WHERE tenant_id = ?`)
        .run(tenantId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getLocalDataSummary(input: {
    tenantId?: string;
    definitions?: GraphCacheResourceDefinition[];
  } = {}): LocalDataSummary {
    const summary: LocalDataSummary = {
      sqliteBytes: sqliteFileBytes(this.dbPath),
      chatConversationCount: this.countRows("chat_conversations"),
      chatMessageCount: this.countRows("chat_messages"),
      chatToolCallCount: this.countRows("chat_tool_calls"),
      graphRowCount: this.countRows("graph_resources"),
      graphCacheStatusCount: this.countRows("graph_cache_status"),
      learningEventCount: this.countRows("learning_events"),
      selfTrainingSuggestionCount: this.countRows("self_training_suggestions"),
    };

    if (input.tenantId) {
      summary.activeTenantId = input.tenantId;
      summary.activeTenantGraphRowCount = this.countRows(
        "graph_resources",
        "tenant_id = ?",
        [input.tenantId],
      );
      if (input.definitions) {
        summary.activeTenantCacheResources = this.getGraphCacheStatus(
          input.tenantId,
          input.definitions,
        );
      }
    }

    return summary;
  }

  readGraphRows(input: {
    tenantId: string;
    resources: GraphCacheResourceKind[];
    searchTerms: string[];
    limitPerResource: number;
  }): Record<GraphCacheResourceKind, unknown[]> {
    const out = {} as Record<GraphCacheResourceKind, unknown[]>;
    for (const resource of input.resources) {
      const terms = input.searchTerms.filter((term) => term.length >= 3);
      const where: string[] = ["tenant_id = ?", "resource = ?"];
      const args: (string | number)[] = [input.tenantId, resource];
      for (const term of terms.slice(0, 5)) {
        where.push("search_text LIKE ?");
        args.push(`%${term}%`);
      }
      const rows = this.db
        .prepare(
          `SELECT raw_json
           FROM graph_resources
           WHERE ${where.join(" AND ")}
           ORDER BY COALESCE(last_seen_at, refreshed_at) DESC
           LIMIT ?`,
        )
        .all(...args, input.limitPerResource) as unknown as ResourceRow[];
      let parsed = rows.map((row) => readJson<unknown>(row.raw_json, {}));
      if (parsed.length === 0 && terms.length > 0) {
        const fallback = this.db
          .prepare(
            `SELECT raw_json
             FROM graph_resources
             WHERE tenant_id = ? AND resource = ?
             ORDER BY COALESCE(last_seen_at, refreshed_at) DESC
             LIMIT ?`,
          )
          .all(input.tenantId, resource, input.limitPerResource) as unknown as ResourceRow[];
        parsed = fallback.map((row) => readJson<unknown>(row.raw_json, {}));
      }
      out[resource] = parsed;
    }
    return out;
  }

  queryGraphCache(input: {
    tenantId: string;
    resource: GraphCacheResourceKind;
    filters?: GraphCacheQueryPredicate[];
    sort?: { field: string; direction?: "asc" | "desc" };
    limit?: number;
  }): GraphCacheQueryResult {
    const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 25)));
    const where: string[] = ["tenant_id = ?", "resource = ?"];
    const args: Array<string | number> = [input.tenantId, input.resource];

    for (const predicate of input.filters ?? []) {
      const built = buildGraphCachePredicateSql(predicate);
      where.push(built.sql);
      args.push(...built.args);
    }

    const sortField = input.sort?.field
      ? graphCacheFieldSql(input.sort.field)
      : "COALESCE(last_seen_at, refreshed_at)";
    const sortDirection = input.sort?.direction === "asc" ? "ASC" : "DESC";
    const sql = `
      SELECT raw_json, refreshed_at, COUNT(*) OVER () AS total_count
      FROM graph_resources
      WHERE ${where.join(" AND ")}
      ORDER BY ${sortField} ${sortDirection}
      LIMIT ?`;
    const rows = this.db
      .prepare(sql)
      .all(...args, limit) as unknown as QueryCacheRow[];
    return {
      resource: input.resource,
      totalCount: rows[0]?.total_count ?? 0,
      returnedRows: rows.length,
      limit,
      rows: rows.map((row) => ({
        row: readJson<unknown>(row.raw_json, {}),
        ...(row.refreshed_at ? { refreshedAt: row.refreshed_at } : {}),
      })),
    };
  }

  readManagedDevicesLastSyncBefore(input: {
    tenantId: string;
    thresholdIso: string;
    limit: number;
  }): unknown[] {
    const rows = this.db
      .prepare(
        `SELECT raw_json
         FROM graph_resources
         WHERE tenant_id = ?
           AND resource = 'managedDevices'
           AND last_seen_at IS NOT NULL
           AND last_seen_at < ?
         ORDER BY last_seen_at ASC
         LIMIT ?`,
      )
      .all(input.tenantId, input.thresholdIso, input.limit) as unknown as ResourceRow[];
    return rows.map((row) => readJson<unknown>(row.raw_json, {}));
  }

  readManagedDeviceRowsForTenant(input: {
    tenantId: string;
    limit?: number;
  }): { row: unknown; refreshedAt?: string }[] {
    const rows = this.db
      .prepare(
        `SELECT raw_json, refreshed_at
         FROM graph_resources
         WHERE tenant_id = ? AND resource = 'managedDevices'
         ORDER BY COALESCE(last_seen_at, refreshed_at) DESC
         LIMIT ?`,
      )
      .all(input.tenantId, input.limit ?? 10_000) as unknown as ResourceRow[];
    return rows.map((row) => ({
      row: readJson<unknown>(row.raw_json, {}),
      ...(row.refreshed_at ? { refreshedAt: row.refreshed_at } : {}),
    }));
  }

  listTenantGroups(): TenantGroup[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, tenant_ids_json, created_at, updated_at
         FROM tenant_groups
         ORDER BY name COLLATE NOCASE ASC`,
      )
      .all() as unknown as TenantGroupRow[];
    return rows.map(readTenantGroup);
  }

  saveTenantGroup(input: {
    id: string;
    name: string;
    tenantIds: string[];
    now: string;
  }): TenantGroup {
    const existing = this.db
      .prepare(
        `SELECT id, name, tenant_ids_json, created_at, updated_at
         FROM tenant_groups
         WHERE id = ?`,
      )
      .get(input.id) as unknown as TenantGroupRow | undefined;
    const createdAt = existing?.created_at ?? input.now;
    this.db
      .prepare(
        `INSERT INTO tenant_groups (id, name, tenant_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           tenant_ids_json = excluded.tenant_ids_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.name,
        JSON.stringify([...new Set(input.tenantIds)]),
        createdAt,
        input.now,
      );
    return {
      id: input.id,
      name: input.name,
      tenantIds: [...new Set(input.tenantIds)],
      createdAt,
      updatedAt: input.now,
    };
  }

  deleteTenantGroup(id: string): void {
    const result = this.db.prepare(`DELETE FROM tenant_groups WHERE id = ?`).run(id);
    if (result.changes === 0) {
      throw new Error(`Tenant group not found: ${id}`);
    }
  }

  listSavedMultiTenantQueries(): SavedMultiTenantQuery[] {
    this.ensureDefaultSavedQueries(new Date().toISOString());
    const rows = this.db
      .prepare(
        `SELECT id, title, prompt, resource_hints_json, default_scope_json,
                sort_order, created_at, updated_at
         FROM saved_multi_tenant_queries
         ORDER BY sort_order ASC, title COLLATE NOCASE ASC`,
      )
      .all() as unknown as SavedQueryRow[];
    return rows.map(readSavedQuery);
  }

  upsertMultiTenantJob(job: MultiTenantChatJob): MultiTenantChatJob {
    this.db
      .prepare(
        `INSERT INTO multi_tenant_jobs (
          id, conversation_id, prompt, saved_query_id, tenant_scope_json,
          resolved_tenant_ids_json, provider_id, provider_name, provider_is_local,
          model, status, preflight_json, progress_json, summary_json,
          comparisons_json, device_rows_json, assistant_text, export_dossier_markdown,
          error, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          status = excluded.status,
          progress_json = excluded.progress_json,
          summary_json = excluded.summary_json,
          comparisons_json = excluded.comparisons_json,
          device_rows_json = excluded.device_rows_json,
          assistant_text = excluded.assistant_text,
          export_dossier_markdown = excluded.export_dossier_markdown,
          error = excluded.error,
          updated_at = excluded.updated_at`,
      )
      .run(
        job.id,
        job.conversationId ?? null,
        job.prompt,
        job.savedQueryId ?? null,
        JSON.stringify(job.tenantScope),
        JSON.stringify(job.resolvedTenantIds),
        job.providerId,
        job.providerName,
        job.providerIsLocal ? 1 : 0,
        job.model ?? null,
        job.status,
        JSON.stringify(job.preflight),
        JSON.stringify(job.progress),
        JSON.stringify(job.summary),
        JSON.stringify(job.comparisons),
        JSON.stringify(job.deviceRows),
        job.assistantText,
        job.exportDossierMarkdown,
        job.error ?? null,
        job.createdAt,
        job.updatedAt,
      );
    return job;
  }

  listMultiTenantJobs(): MultiTenantChatJob[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, prompt, saved_query_id, tenant_scope_json,
                resolved_tenant_ids_json, provider_id, provider_name, provider_is_local,
                model, status, preflight_json, progress_json, summary_json,
                comparisons_json, device_rows_json, assistant_text,
                export_dossier_markdown, error, created_at, updated_at
         FROM multi_tenant_jobs
         ORDER BY updated_at DESC`,
      )
      .all() as unknown as MultiTenantJobRow[];
    return rows.map(readMultiTenantJob);
  }

  getMultiTenantJob(id: string): MultiTenantChatJob | undefined {
    const row = this.db
      .prepare(
        `SELECT id, conversation_id, prompt, saved_query_id, tenant_scope_json,
                resolved_tenant_ids_json, provider_id, provider_name, provider_is_local,
                model, status, preflight_json, progress_json, summary_json,
                comparisons_json, device_rows_json, assistant_text,
                export_dossier_markdown, error, created_at, updated_at
         FROM multi_tenant_jobs
         WHERE id = ?`,
      )
      .get(id) as unknown as MultiTenantJobRow | undefined;
    return row ? readMultiTenantJob(row) : undefined;
  }

  upsertMultiTenantAgentBatch(batch: MultiTenantAgentBatch): MultiTenantAgentBatch {
    this.db
      .prepare(
        `INSERT INTO multi_tenant_agent_batches (
          id, agent_slug, agent_name, agent_mode, tenant_scope_json,
          resolved_tenant_ids_json, status, run_ids_json, preflight_json,
          error, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          run_ids_json = excluded.run_ids_json,
          preflight_json = excluded.preflight_json,
          error = excluded.error,
          updated_at = excluded.updated_at`,
      )
      .run(
        batch.id,
        batch.agentSlug,
        batch.agentName,
        batch.agentMode,
        JSON.stringify(batch.tenantScope),
        JSON.stringify(batch.resolvedTenantIds),
        batch.status,
        JSON.stringify(batch.runIds),
        JSON.stringify(batch.preflight),
        batch.error ?? null,
        batch.createdAt,
        batch.updatedAt,
      );
    return batch;
  }

  listMultiTenantAgentBatches(): MultiTenantAgentBatch[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_slug, agent_name, agent_mode, tenant_scope_json,
                resolved_tenant_ids_json, status, run_ids_json, preflight_json,
                error, created_at, updated_at
         FROM multi_tenant_agent_batches
         ORDER BY updated_at DESC`,
      )
      .all() as unknown as MultiTenantAgentBatchRow[];
    return rows.map(readMultiTenantAgentBatch);
  }

  getMultiTenantAgentBatch(id: string): MultiTenantAgentBatch | undefined {
    const row = this.db
      .prepare(
        `SELECT id, agent_slug, agent_name, agent_mode, tenant_scope_json,
                resolved_tenant_ids_json, status, run_ids_json, preflight_json,
                error, created_at, updated_at
         FROM multi_tenant_agent_batches
         WHERE id = ?`,
      )
      .get(id) as unknown as MultiTenantAgentBatchRow | undefined;
    return row ? readMultiTenantAgentBatch(row) : undefined;
  }

  listWorkspaces(tenantNames: Map<string, string>, tenantId?: string): WorkspaceSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, title, status, instructions, created_at, updated_at
         FROM workspaces
         WHERE status != 'archived'
           ${tenantId ? "AND tenant_id = ?" : ""}
         ORDER BY updated_at DESC`,
      )
      .all(...(tenantId ? [tenantId] : [])) as unknown as WorkspaceRow[];
    return rows.map((row) => this.readWorkspaceSummary(row, tenantNames));
  }

  getWorkspace(id: string, tenantNames: Map<string, string>): WorkspaceDetail | undefined {
    const row = this.getWorkspaceRow(id);
    if (!row) return undefined;
    return {
      ...this.readWorkspaceSummary(row, tenantNames),
      ...(row.instructions ? { instructions: row.instructions } : {}),
      evidence: this.listWorkspaceEvidence(id),
      notes: this.listWorkspaceNotes(id),
      links: this.listWorkspaceLinks(id),
    };
  }

  listWorkspaceReferencedRunIds(): string[] {
    const ids = new Set<string>();
    const linkRows = this.db
      .prepare(
        `SELECT ref_id
         FROM workspace_links
         WHERE type = 'run'`,
      )
      .all() as unknown as Array<{ ref_id: string }>;
    for (const row of linkRows) {
      if (row.ref_id) ids.add(row.ref_id);
    }

    const evidenceRows = this.db
      .prepare(
        `SELECT source_ref_json
         FROM workspace_evidence
         WHERE source_type = 'run-result'
           AND source_ref_json IS NOT NULL`,
      )
      .all() as unknown as Array<{ source_ref_json: string }>;
    for (const row of evidenceRows) {
      const sourceRef = readJson<Record<string, unknown> | undefined>(
        row.source_ref_json,
        undefined,
      );
      const runId = sourceRef?.runId;
      if (typeof runId === "string" && runId.trim()) {
        ids.add(runId);
      }
    }

    return [...ids];
  }

  createWorkspace(input: {
    id: string;
    tenantId: string;
    tenantName?: string;
    title: string;
    instructions?: string;
    now: string;
    conversationId?: string;
  }): WorkspaceDetail {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO workspaces (
            id, tenant_id, title, status, instructions, created_at, updated_at
          )
          VALUES (?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          input.id,
          input.tenantId,
          input.title,
          input.instructions ?? null,
          input.now,
          input.now,
        );
      if (input.conversationId) {
        this.linkWorkspaceConversation({
          id: `wlink_${input.id}`,
          workspaceId: input.id,
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          title: input.title,
          now: input.now,
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const tenantNames = new Map([[input.tenantId, input.tenantName ?? ""]]);
    const workspace = this.getWorkspace(input.id, tenantNames);
    if (!workspace) throw new Error(`Workspace was not created: ${input.id}`);
    return workspace;
  }

  updateWorkspace(input: {
    id: string;
    title?: string;
    instructions?: string;
    status?: WorkspaceStatus;
    now: string;
    tenantNames: Map<string, string>;
  }): WorkspaceDetail {
    const row = this.getWorkspaceRow(input.id);
    if (!row) throw new Error(`Workspace not found: ${input.id}`);
    const nextTitle = input.title ?? row.title;
    const nextInstructions =
      input.instructions !== undefined ? input.instructions : row.instructions;
    const nextStatus = input.status ?? row.status;
    this.db
      .prepare(
        `UPDATE workspaces
         SET title = ?, instructions = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(nextTitle, nextInstructions ?? null, nextStatus, input.now, input.id);
    const workspace = this.getWorkspace(input.id, input.tenantNames);
    if (!workspace) throw new Error(`Workspace not found: ${input.id}`);
    return workspace;
  }

  archiveWorkspace(id: string, now: string, tenantNames: Map<string, string>): WorkspaceSummary {
    const detail = this.updateWorkspace({
      id,
      status: "archived",
      now,
      tenantNames,
    });
    return detail;
  }

  deleteWorkspace(id: string): void {
    const result = this.db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
    if (result.changes === 0) {
      throw new Error(`Workspace not found: ${id}`);
    }
  }

  addWorkspaceNote(input: {
    id: string;
    workspaceId: string;
    content: string;
    now: string;
  }): WorkspaceNote {
    const workspace = this.requireWorkspaceRow(input.workspaceId);
    this.db
      .prepare(
        `INSERT INTO workspace_notes (
          id, workspace_id, tenant_id, content, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.workspaceId, workspace.tenant_id, input.content, input.now, input.now);
    return {
      id: input.id,
      workspaceId: input.workspaceId,
      tenantId: workspace.tenant_id,
      content: input.content,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  updateWorkspaceNote(id: string, content: string, now: string): WorkspaceNote {
    const result = this.db
      .prepare(
        `UPDATE workspace_notes
         SET content = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(content, now, id);
    if (result.changes === 0) throw new Error(`Workspace note not found: ${id}`);
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, tenant_id, content, created_at, updated_at
         FROM workspace_notes
         WHERE id = ?`,
      )
      .get(id) as unknown as WorkspaceNoteRow | undefined;
    if (!row) throw new Error(`Workspace note not found: ${id}`);
    return readWorkspaceNote(row);
  }

  pinWorkspaceEvidence(input: Omit<WorkspaceEvidence, "createdAt"> & { now: string }): WorkspaceEvidence {
    const workspace = this.requireWorkspaceRow(input.workspaceId);
    if (workspace.tenant_id !== input.tenantId) {
      throw new Error("Workspace evidence tenant does not match the workspace tenant.");
    }
    this.db
      .prepare(
        `INSERT INTO workspace_evidence (
          id, workspace_id, tenant_id, title, source_type, source_ref_json,
          content_json, freshness_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.tenantId,
        input.title,
        input.sourceType,
        input.sourceRef ? JSON.stringify(input.sourceRef) : null,
        JSON.stringify(input.content),
        input.freshness ? JSON.stringify(input.freshness) : null,
        input.now,
      );
    this.touchWorkspace(input.workspaceId, input.now);
    return {
      id: input.id,
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      title: input.title,
      sourceType: input.sourceType,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      content: input.content,
      ...(input.freshness ? { freshness: input.freshness } : {}),
      createdAt: input.now,
    };
  }

  linkWorkspaceConversation(input: {
    id: string;
    workspaceId: string;
    tenantId: string;
    conversationId: string;
    title: string;
    now: string;
  }): WorkspaceLink {
    return this.insertWorkspaceLink({
      id: input.id,
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      type: "conversation",
      refId: input.conversationId,
      title: input.title,
      now: input.now,
    });
  }

  linkWorkspaceRun(input: {
    id: string;
    workspaceId: string;
    tenantId: string;
    runId: string;
    title: string;
    now: string;
  }): WorkspaceLink {
    return this.insertWorkspaceLink({
      id: input.id,
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      type: "run",
      refId: input.runId,
      title: input.title,
      now: input.now,
    });
  }

  importMultiTenantResultToWorkspaces(input: {
    job: MultiTenantChatJob;
    tenantNames: Map<string, string>;
    mappings: { tenantId: string; workspaceId?: string; title?: string }[];
    createWorkspaceId: () => string;
    createEvidenceId: () => string;
    now: string;
  }): ImportMultiTenantResultToWorkspacesResult {
    const workspaces: WorkspaceSummary[] = [];
    const evidence: WorkspaceEvidence[] = [];
    this.db.exec("BEGIN");
    try {
      for (const mapping of input.mappings) {
        const tenantRows = input.job.deviceRows.filter(
          (row) => row.tenantId === mapping.tenantId,
        );
        const comparison = input.job.comparisons.find(
          (row) => row.tenantId === mapping.tenantId,
        );
        if (!comparison && tenantRows.length === 0) continue;
        let workspaceId = mapping.workspaceId;
        if (!workspaceId) {
          workspaceId = input.createWorkspaceId();
          const title =
            mapping.title ??
            `${input.tenantNames.get(mapping.tenantId) ?? "Tenant"} · ${input.job.prompt.slice(0, 64)}`;
          this.db
            .prepare(
              `INSERT INTO workspaces (
                id, tenant_id, title, status, instructions, created_at, updated_at
              )
              VALUES (?, ?, ?, 'active', NULL, ?, ?)`,
            )
            .run(workspaceId, mapping.tenantId, title, input.now, input.now);
        }
        const title = `Multi-tenant chat · ${input.job.prompt.slice(0, 80)}`;
        const pinned = this.pinWorkspaceEvidence({
          id: input.createEvidenceId(),
          workspaceId,
          tenantId: mapping.tenantId,
          title,
          sourceType: "multi-tenant-chat-result",
          sourceRef: { jobId: input.job.id, prompt: input.job.prompt },
          content: {
            comparison,
            rows: tenantRows,
          },
          freshness: {
            resource: "managedDevices",
            refreshedAt: comparison?.lastRefresh,
            rowCount: tenantRows.length,
            cacheStatus: comparison?.status === "stale" ? "stale" : "cache",
          },
          now: input.now,
        });
        evidence.push(pinned);
        const row = this.requireWorkspaceRow(workspaceId);
        workspaces.push(this.readWorkspaceSummary(row, input.tenantNames));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { workspaces, evidence };
  }

  exportWorkspaceDossier(id: string, tenantNames: Map<string, string>): string {
    const workspace = this.getWorkspace(id, tenantNames);
    if (!workspace) throw new Error(`Workspace not found: ${id}`);
    return buildWorkspaceDossier(workspace);
  }

  getSelfTrainingSettings(): SelfTrainingSettings {
    const row = this.db
      .prepare(`SELECT value, updated_at FROM app_settings WHERE key = 'selfTrainingEnabled'`)
      .get() as SettingRow | undefined;
    if (!row) return { enabled: false };
    return { enabled: row.value === "true", updatedAt: row.updated_at };
  }

  getChatInvestigationSettings(): ChatInvestigationSettings {
    const row = this.db
      .prepare(`SELECT value, updated_at FROM app_settings WHERE key = 'chatInvestigationMode'`)
      .get() as SettingRow | undefined;
    const mode = isChatInvestigationMode(row?.value) ? row.value : "auto";
    return {
      mode,
      ...(row?.updated_at ? { updatedAt: row.updated_at } : {}),
    };
  }

  getGraphCacheRefreshSchedule(
    tenantId: string,
    now: string = new Date().toISOString(),
  ): GraphCacheRefreshScheduleSettings {
    const row = this.db
      .prepare(`SELECT value, updated_at FROM app_settings WHERE key = ?`)
      .get(graphCacheScheduleKey(tenantId)) as SettingRow | undefined;
    const parsed = row
      ? readJson<Partial<GraphCacheRefreshScheduleSettings>>(row.value, {})
      : {};
    const intervalMinutes = normalizeScheduleInterval(parsed.intervalMinutes);
    const lastRunAt = typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : undefined;
    const nextRunAt = parsed.enabled
      ? nextRefreshDueAt(lastRunAt ?? row?.updated_at ?? now, intervalMinutes)
      : undefined;
    return {
      enabled: parsed.enabled === true,
      intervalMinutes,
      updatedAt: row?.updated_at,
      ...(lastRunAt ? { lastRunAt } : {}),
      ...(typeof parsed.lastSuccessAt === "string"
        ? { lastSuccessAt: parsed.lastSuccessAt }
        : {}),
      ...(typeof parsed.lastError === "string" && parsed.lastError
        ? { lastError: parsed.lastError }
        : {}),
      ...(nextRunAt ? { nextRunAt } : {}),
    };
  }

  setGraphCacheRefreshSchedule(input: {
    tenantId: string;
    enabled: boolean;
    intervalMinutes: number;
    now: string;
  }): GraphCacheRefreshScheduleSettings {
    const previous = this.getGraphCacheRefreshSchedule(input.tenantId, input.now);
    const intervalMinutes = normalizeScheduleInterval(input.intervalMinutes);
    const next: GraphCacheRefreshScheduleSettings = {
      enabled: input.enabled,
      intervalMinutes,
      updatedAt: input.now,
      ...(previous.lastRunAt ? { lastRunAt: previous.lastRunAt } : {}),
      ...(previous.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
      ...(previous.lastError ? { lastError: previous.lastError } : {}),
      ...(input.enabled
        ? { nextRunAt: nextRefreshDueAt(previous.lastRunAt ?? input.now, intervalMinutes) }
        : {}),
    };
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(graphCacheScheduleKey(input.tenantId), JSON.stringify(next), input.now);
    return next;
  }

  markGraphCacheRefreshScheduleRun(input: {
    tenantId: string;
    startedAt: string;
    success: boolean;
    error?: string;
  }): GraphCacheRefreshScheduleSettings {
    const previous = this.getGraphCacheRefreshSchedule(input.tenantId, input.startedAt);
    const next: GraphCacheRefreshScheduleSettings = {
      enabled: previous.enabled,
      intervalMinutes: previous.intervalMinutes,
      updatedAt: input.startedAt,
      lastRunAt: input.startedAt,
      ...(input.success ? { lastSuccessAt: input.startedAt } : {}),
      ...(input.success
        ? {}
        : { lastError: input.error ?? "Scheduled Graph cache refresh failed." }),
      ...(previous.enabled
        ? { nextRunAt: nextRefreshDueAt(input.startedAt, previous.intervalMinutes) }
        : {}),
    };
    if (!input.success && previous.lastSuccessAt) {
      next.lastSuccessAt = previous.lastSuccessAt;
    }
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(graphCacheScheduleKey(input.tenantId), JSON.stringify(next), input.startedAt);
    return next;
  }

  isGraphCacheRefreshDue(tenantId: string, nowMs: number = Date.now()): boolean {
    const schedule = this.getGraphCacheRefreshSchedule(
      tenantId,
      new Date(nowMs).toISOString(),
    );
    if (!schedule.enabled) return false;
    const anchor = schedule.lastRunAt ?? schedule.updatedAt;
    if (!anchor) return true;
    const anchorMs = new Date(anchor).getTime();
    if (!Number.isFinite(anchorMs)) return true;
    return nowMs >= anchorMs + schedule.intervalMinutes * 60 * 1000;
  }

  setSelfTrainingEnabled(enabled: boolean, now: string): SelfTrainingSettings {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ('selfTrainingEnabled', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(enabled ? "true" : "false", now);
    return { enabled, updatedAt: now };
  }

  setChatInvestigationMode(
    mode: ChatInvestigationMode,
    now: string,
  ): ChatInvestigationSettings {
    if (!isChatInvestigationMode(mode)) {
      throw new Error(`Unknown chat investigation mode: ${mode}`);
    }
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ('chatInvestigationMode', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(mode, now);
    return { mode, updatedAt: now };
  }

  recordLearningEvent(input: {
    id: string;
    tenantId: string;
    agentSlug?: string;
    eventType: string;
    source: string;
    payload: unknown;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO learning_events (
          id, tenant_id, agent_slug, event_type, source, payload_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.tenantId,
        input.agentSlug ?? null,
        input.eventType,
        input.source,
        JSON.stringify(input.payload),
        input.createdAt,
      );
  }

  recordHostedProviderConsentAuditEvent(input: HostedProviderConsentAuditRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO audit_events (
          id, type, tenant_id, source, payload_json, created_at
        )
        VALUES (?, 'hosted-provider.consent', ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.tenantId,
        input.source,
        JSON.stringify(input.payload),
        input.createdAt,
      );
  }

  listHostedProviderConsentAuditEvents(): HostedProviderConsentAuditRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, source, payload_json, created_at
         FROM audit_events
         WHERE type = 'hosted-provider.consent'
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as Array<{
        id: string;
        tenant_id: string;
        source: string;
        payload_json: string;
        created_at: string;
      }>;
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      source: row.source,
      payload: readJson<Record<string, unknown>>(row.payload_json, {}),
      createdAt: row.created_at,
    }));
  }

  createSelfTrainingSuggestion(input: SelfTrainingSuggestion): SelfTrainingSuggestion {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO self_training_suggestions (
          id, tenant_id, agent_slug, status, text, reason, source, created_at, decided_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.tenantId,
        input.agentSlug,
        input.status,
        input.text,
        input.reason,
        input.source,
        input.createdAt,
        input.decidedAt ?? null,
      );
    return input;
  }

  listSelfTrainingSuggestions(
    status?: SelfTrainingSuggestionStatus,
  ): SelfTrainingSuggestion[] {
    const rows = status
      ? this.db
          .prepare(
            `SELECT id, tenant_id, agent_slug, status, text, reason, source, created_at, decided_at
             FROM self_training_suggestions
             WHERE status = ?
             ORDER BY created_at DESC`,
          )
          .all(status)
      : this.db
          .prepare(
            `SELECT id, tenant_id, agent_slug, status, text, reason, source, created_at, decided_at
             FROM self_training_suggestions
             ORDER BY created_at DESC`,
          )
          .all();
    return (rows as unknown as SuggestionRow[]).map(readSuggestion);
  }

  decideSelfTrainingSuggestion(
    id: string,
    status: "accepted" | "rejected",
    now: string,
  ): SelfTrainingSuggestion {
    this.db
      .prepare(
        `UPDATE self_training_suggestions
         SET status = ?, decided_at = ?
         WHERE id = ?`,
      )
      .run(status, now, id);
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, agent_slug, status, text, reason, source, created_at, decided_at
         FROM self_training_suggestions
         WHERE id = ?`,
      )
      .get(id) as unknown as SuggestionRow | undefined;
    if (!row) {
      throw new Error(`Self-training suggestion ${id} was not found.`);
    }
    return readSuggestion(row);
  }

  resetAcceptedSelfTrainingSuggestions(input: {
    tenantId: string;
    agentSlug: string;
    now: string;
  }): SelfTrainingSuggestion[] {
    this.db
      .prepare(
        `UPDATE self_training_suggestions
         SET status = 'reset', decided_at = ?
         WHERE tenant_id = ? AND agent_slug = ? AND status = 'accepted'`,
      )
      .run(input.now, input.tenantId, input.agentSlug);
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, agent_slug, status, text, reason, source, created_at, decided_at
         FROM self_training_suggestions
         WHERE tenant_id = ? AND agent_slug = ? AND status = 'reset'
         ORDER BY decided_at DESC, created_at DESC`,
      )
      .all(input.tenantId, input.agentSlug) as unknown as SuggestionRow[];
    return rows.map(readSuggestion);
  }

  listAcceptedSelfTrainingSuggestions(input: {
    tenantId: string;
    agentSlug: string;
  }): SelfTrainingSuggestion[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, agent_slug, status, text, reason, source, created_at, decided_at
         FROM self_training_suggestions
         WHERE tenant_id = ? AND agent_slug = ? AND status = 'accepted'
         ORDER BY created_at ASC`,
      )
      .all(input.tenantId, input.agentSlug) as unknown as SuggestionRow[];
    return rows.map(readSuggestion);
  }

  private readLatestDriftVersions(
    tenantId: string,
    resource: GraphCacheResourceKind,
  ): Map<string, DriftObjectVersionRow> {
    const rows = this.db
      .prepare(
        `SELECT v.tenant_id, v.resource, v.graph_id, v.version, v.content_hash,
                v.raw_json, v.display_name, v.first_seen_snapshot_id,
                v.first_seen_at, v.removed_snapshot_id, v.removed_at
         FROM drift_object_versions v
         INNER JOIN (
           SELECT graph_id, MAX(version) AS version
           FROM drift_object_versions
           WHERE tenant_id = ? AND resource = ?
           GROUP BY graph_id
         ) latest
           ON latest.graph_id = v.graph_id
          AND latest.version = v.version
         WHERE v.tenant_id = ? AND v.resource = ?`,
      )
      .all(tenantId, resource, tenantId, resource) as unknown as DriftObjectVersionRow[];
    return new Map(rows.map((row) => [row.graph_id, row]));
  }

  private getDriftObjectVersionRow(
    tenantId: string,
    resource: GraphCacheResourceKind,
    graphId: string,
    version: number,
  ): DriftObjectVersionRow | undefined {
    return this.db
      .prepare(
        `SELECT tenant_id, resource, graph_id, version, content_hash, raw_json,
                display_name, first_seen_snapshot_id, first_seen_at,
                removed_snapshot_id, removed_at
         FROM drift_object_versions
         WHERE tenant_id = ? AND resource = ? AND graph_id = ? AND version = ?`,
      )
      .get(tenantId, resource, graphId, version) as unknown as
      | DriftObjectVersionRow
      | undefined;
  }

  private insertDriftSnapshot(snapshot: DriftSnapshotRecord): void {
    this.db
      .prepare(
        `INSERT INTO drift_snapshots (
          id, tenant_id, resource, captured_at, row_count,
          changes_added, changes_removed, changes_modified
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.tenantId,
        snapshot.resource,
        snapshot.capturedAt,
        snapshot.rowCount,
        snapshot.changesAdded,
        snapshot.changesRemoved,
        snapshot.changesModified,
      );
  }

  private insertDriftObjectVersion(
    version: Omit<
      DriftObjectVersionRecord,
      "displayName" | "removedSnapshotId" | "removedAt"
    > & {
      displayName: string | null;
      removedSnapshotId?: string;
      removedAt?: string;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO drift_object_versions (
          tenant_id, resource, graph_id, version, content_hash, raw_json,
          display_name, first_seen_snapshot_id, first_seen_at,
          removed_snapshot_id, removed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version.tenantId,
        version.resource,
        version.graphId,
        version.version,
        version.contentHash,
        version.rawJson,
        version.displayName,
        version.firstSeenSnapshotId,
        version.firstSeenAt,
        version.removedSnapshotId ?? null,
        version.removedAt ?? null,
      );
  }

  private countRows(
    tableName: string,
    where?: string,
    args: (string | number)[] = [],
  ): number {
    const sql = `SELECT COUNT(*) AS count FROM ${tableName}${where ? ` WHERE ${where}` : ""}`;
    const row = this.db.prepare(sql).get(...args) as { count?: number } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        tenant_id TEXT,
        scope_kind TEXT,
        scope_json TEXT,
        multi_tenant_job_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pinned_at TEXT
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_id TEXT,
        model TEXT,
        sources_json TEXT,
        agent_suggestions_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_tool_calls (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        message_id TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT,
        output_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS graph_resources (
        tenant_id TEXT NOT NULL,
        resource TEXT NOT NULL,
        graph_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        search_text TEXT NOT NULL,
        display_name TEXT,
        user_principal_name TEXT,
        operating_system TEXT,
        compliance_state TEXT,
        last_seen_at TEXT,
        refreshed_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, resource, graph_id)
      );

      CREATE INDEX IF NOT EXISTS idx_graph_resources_lookup
        ON graph_resources (tenant_id, resource, refreshed_at);
      CREATE INDEX IF NOT EXISTS idx_graph_resources_search
        ON graph_resources (tenant_id, resource, search_text);

      CREATE TABLE IF NOT EXISTS graph_cache_status (
        tenant_id TEXT NOT NULL,
        resource TEXT NOT NULL,
        label TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        page_count INTEGER NOT NULL DEFAULT 0,
        page_limit_reached INTEGER NOT NULL DEFAULT 0,
        refreshed_at TEXT,
        scope_set_json TEXT NOT NULL,
        last_error TEXT,
        PRIMARY KEY (tenant_id, resource)
      );

      CREATE TABLE IF NOT EXISTS drift_snapshots (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        resource TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        changes_added INTEGER NOT NULL,
        changes_removed INTEGER NOT NULL,
        changes_modified INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_drift_snapshots_lookup
        ON drift_snapshots (tenant_id, resource, captured_at);

      CREATE TABLE IF NOT EXISTS drift_object_versions (
        tenant_id TEXT NOT NULL,
        resource TEXT NOT NULL,
        graph_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        display_name TEXT,
        first_seen_snapshot_id TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        removed_snapshot_id TEXT,
        removed_at TEXT,
        PRIMARY KEY (tenant_id, resource, graph_id, version)
      );

      CREATE INDEX IF NOT EXISTS idx_drift_versions_lookup
        ON drift_object_versions (tenant_id, resource, first_seen_at);

      CREATE TABLE IF NOT EXISTS learning_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        agent_slug TEXT,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        tenant_id TEXT,
        source TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_events_created
        ON audit_events (created_at ASC, id ASC);

      CREATE TABLE IF NOT EXISTS self_training_suggestions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        agent_slug TEXT NOT NULL,
        status TEXT NOT NULL,
        text TEXT NOT NULL,
        reason TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_self_training_suggestions_status
        ON self_training_suggestions (status, tenant_id, agent_slug);

      CREATE TABLE IF NOT EXISTS tenant_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tenant_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS saved_multi_tenant_queries (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        resource_hints_json TEXT NOT NULL,
        default_scope_json TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS multi_tenant_jobs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        prompt TEXT NOT NULL,
        saved_query_id TEXT,
        tenant_scope_json TEXT NOT NULL,
        resolved_tenant_ids_json TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        provider_is_local INTEGER NOT NULL,
        model TEXT,
        status TEXT NOT NULL,
        preflight_json TEXT NOT NULL,
        progress_json TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        comparisons_json TEXT NOT NULL,
        device_rows_json TEXT NOT NULL,
        assistant_text TEXT NOT NULL,
        export_dossier_markdown TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_multi_tenant_jobs_updated
        ON multi_tenant_jobs (updated_at DESC);

      CREATE TABLE IF NOT EXISTS multi_tenant_agent_batches (
        id TEXT PRIMARY KEY,
        agent_slug TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        agent_mode TEXT NOT NULL,
        tenant_scope_json TEXT NOT NULL,
        resolved_tenant_ids_json TEXT NOT NULL,
        status TEXT NOT NULL,
        run_ids_json TEXT NOT NULL,
        preflight_json TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_multi_tenant_agent_batches_updated
        ON multi_tenant_agent_batches (updated_at DESC);

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        instructions TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workspaces_tenant_updated
        ON workspaces (tenant_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS workspace_evidence (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL,
        title TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_ref_json TEXT,
        content_json TEXT NOT NULL,
        freshness_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_evidence_workspace
        ON workspace_evidence (workspace_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS workspace_notes (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_notes_workspace
        ON workspace_notes (workspace_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS workspace_links (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL,
        type TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(workspace_id, type, ref_id)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_links_workspace
        ON workspace_links (workspace_id, type, created_at DESC);
    `);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id, name, applied_at)
         VALUES (1, 'intune-chat-cache-and-learning', ?)`,
      )
      .run(new Date().toISOString());
    this.db
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id, name, applied_at)
         VALUES (2, 'tenant-drift-snapshots', ?)`,
      )
      .run(new Date().toISOString());
    ensureColumn(this.db, "graph_cache_status", "page_count", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(
      this.db,
      "graph_cache_status",
      "page_limit_reached",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(this.db, "chat_conversations", "pinned_at", "TEXT");
    ensureColumn(this.db, "chat_conversations", "scope_kind", "TEXT");
    ensureColumn(this.db, "chat_conversations", "scope_json", "TEXT");
    ensureColumn(this.db, "chat_conversations", "multi_tenant_job_id", "TEXT");
    this.ensureDefaultSavedQueries(new Date().toISOString());
  }

  private ensureDefaultSavedQueries(now: string): void {
    const defaults: Omit<SavedMultiTenantQuery, "createdAt" | "updatedAt">[] = [
      {
        id: "windows-compliance",
        title: "Windows compliance by tenant",
        prompt: "List all compliant and non-compliant Windows devices from every connected tenant.",
        resourceHints: ["managedDevices"],
        defaultScope: { kind: "all" },
        order: 10,
      },
      {
        id: "stale-windows-devices",
        title: "Stale Windows devices",
        prompt: "Which Windows devices have not synced in the last 7 days across selected tenants?",
        resourceHints: ["managedDevices"],
        defaultScope: { kind: "selected", tenantIds: [] },
        order: 20,
      },
      {
        id: "bitlocker-gaps",
        title: "BitLocker gaps",
        prompt: "Show Windows devices that appear unencrypted or unknown for BitLocker across selected tenants.",
        resourceHints: ["managedDevices", "managedDeviceEncryptionStates"],
        defaultScope: { kind: "selected", tenantIds: [] },
        order: 30,
      },
      {
        id: "risky-sign-ins",
        title: "Risky sign-ins",
        prompt: "Summarize recent risky or failed sign-ins across selected tenants.",
        resourceHints: ["signIns"],
        defaultScope: { kind: "selected", tenantIds: [] },
        order: 40,
      },
      {
        id: "conditional-access-gaps",
        title: "Conditional Access gaps",
        prompt: "Compare Conditional Access policy coverage across selected tenants.",
        resourceHints: ["conditionalAccessPolicies"],
        defaultScope: { kind: "selected", tenantIds: [] },
        order: 50,
      },
    ];
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO saved_multi_tenant_queries (
        id, title, prompt, resource_hints_json, default_scope_json,
        sort_order, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const query of defaults) {
      insert.run(
        query.id,
        query.title,
        query.prompt,
        JSON.stringify(query.resourceHints),
        query.defaultScope ? JSON.stringify(query.defaultScope) : null,
        query.order,
        now,
        now,
      );
    }
  }

  private getWorkspaceRow(id: string): WorkspaceRow | undefined {
    return this.db
      .prepare(
        `SELECT id, tenant_id, title, status, instructions, created_at, updated_at
         FROM workspaces
         WHERE id = ?`,
      )
      .get(id) as unknown as WorkspaceRow | undefined;
  }

  private requireWorkspaceRow(id: string): WorkspaceRow {
    const row = this.getWorkspaceRow(id);
    if (!row) throw new Error(`Workspace not found: ${id}`);
    return row;
  }

  private readWorkspaceSummary(
    row: WorkspaceRow,
    tenantNames: Map<string, string>,
  ): WorkspaceSummary {
    const evidenceCount = this.countRows("workspace_evidence", "workspace_id = ?", [row.id]);
    const noteCount = this.countRows("workspace_notes", "workspace_id = ?", [row.id]);
    const conversationCount = this.countRows(
      "workspace_links",
      "workspace_id = ? AND type = 'conversation'",
      [row.id],
    );
    const runCount = this.countRows("workspace_links", "workspace_id = ? AND type = 'run'", [row.id]);
    const freshnessRow = this.db
      .prepare(
        `SELECT freshness_json
         FROM workspace_evidence
         WHERE workspace_id = ? AND freshness_json IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(row.id) as { freshness_json?: string } | undefined;
    const freshness = freshnessRow?.freshness_json
      ? readJson<{ refreshedAt?: string }>(freshnessRow.freshness_json, {}).refreshedAt
      : undefined;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      tenantName: tenantNames.get(row.tenant_id),
      title: row.title,
      status: row.status,
      evidenceCount,
      conversationCount,
      runCount,
      noteCount,
      ...(freshness ? { freshness } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private listWorkspaceEvidence(workspaceId: string): WorkspaceEvidence[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, tenant_id, title, source_type, source_ref_json,
                content_json, freshness_json, created_at
         FROM workspace_evidence
         WHERE workspace_id = ?
         ORDER BY created_at DESC`,
      )
      .all(workspaceId) as unknown as WorkspaceEvidenceRow[];
    return rows.map(readWorkspaceEvidence);
  }

  private listWorkspaceNotes(workspaceId: string): WorkspaceNote[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, tenant_id, content, created_at, updated_at
         FROM workspace_notes
         WHERE workspace_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(workspaceId) as unknown as WorkspaceNoteRow[];
    return rows.map(readWorkspaceNote);
  }

  private listWorkspaceLinks(workspaceId: string): WorkspaceLink[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, tenant_id, type, ref_id, title, created_at
         FROM workspace_links
         WHERE workspace_id = ?
         ORDER BY created_at DESC`,
      )
      .all(workspaceId) as unknown as WorkspaceLinkRow[];
    return rows.map(readWorkspaceLink);
  }

  private listInvestigationToolTraces(
    conversationId: string,
  ): Map<string, IntuneChatToolTraceEntry[]> {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, message_id, type, status, input_json, output_json,
                error, created_at, completed_at
         FROM chat_tool_calls
         WHERE conversation_id = ?
           AND message_id IS NOT NULL
         ORDER BY created_at ASC`,
      )
      .all(conversationId) as unknown as ToolCallRow[];
    const byMessage = new Map<string, IntuneChatToolTraceEntry[]>();
    for (const row of rows) {
      if (!isInvestigationToolName(row.type) || !row.message_id) continue;
      const trace = readToolTrace(row);
      const existing = byMessage.get(row.message_id) ?? [];
      existing.push(trace);
      byMessage.set(row.message_id, existing);
    }
    return byMessage;
  }

  private insertWorkspaceLink(input: {
    id: string;
    workspaceId: string;
    tenantId: string;
    type: WorkspaceLink["type"];
    refId: string;
    title: string;
    now: string;
  }): WorkspaceLink {
    const workspace = this.requireWorkspaceRow(input.workspaceId);
    if (workspace.tenant_id !== input.tenantId) {
      throw new Error("Workspace link tenant does not match the workspace tenant.");
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workspace_links (
          id, workspace_id, tenant_id, type, ref_id, title, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.tenantId,
        input.type,
        input.refId,
        input.title,
        input.now,
      );
    this.touchWorkspace(input.workspaceId, input.now);
    return {
      id: input.id,
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      type: input.type,
      refId: input.refId,
      title: input.title,
      createdAt: input.now,
    };
  }

  private touchWorkspace(id: string, now: string): void {
    this.db.prepare(`UPDATE workspaces SET updated_at = ? WHERE id = ?`).run(now, id);
  }
}

function readConversation(row: ConversationRow): IntuneChatConversation {
  return {
    id: row.id,
    title: row.title,
    tenantId: row.tenant_id ?? undefined,
    scopeKind: row.scope_kind === "multi-tenant" ? "multi-tenant" : "single-tenant",
    tenantScope: row.scope_json ? readJson<TenantScope | undefined>(row.scope_json, undefined) : undefined,
    multiTenantJobId: row.multi_tenant_job_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pinnedAt: row.pinned_at ?? undefined,
  };
}

function readMessage(row: MessageRow): IntuneChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    status: row.status,
    providerId: row.provider_id as IntuneChatMessage["providerId"],
    model: row.model ?? undefined,
    sources: row.sources_json ? readJson(row.sources_json, []) : undefined,
    agentSuggestions: row.agent_suggestions_json
      ? readJson(row.agent_suggestions_json, [])
      : undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
  };
}

function readSuggestion(row: SuggestionRow): SelfTrainingSuggestion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentSlug: row.agent_slug,
    status: row.status,
    text: row.text,
    reason: row.reason,
    source: row.source,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined,
  };
}

function readTenantGroup(row: TenantGroupRow): TenantGroup {
  return {
    id: row.id,
    name: row.name,
    tenantIds: readJson<string[]>(row.tenant_ids_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readSavedQuery(row: SavedQueryRow): SavedMultiTenantQuery {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    resourceHints: readJson<GraphCacheResourceKind[]>(row.resource_hints_json, []),
    defaultScope: row.default_scope_json
      ? readJson<TenantScope | undefined>(row.default_scope_json, undefined)
      : undefined,
    order: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readDriftSnapshot(row: DriftSnapshotRow): DriftSnapshotRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    resource: row.resource,
    capturedAt: row.captured_at,
    rowCount: row.row_count,
    changesAdded: row.changes_added,
    changesRemoved: row.changes_removed,
    changesModified: row.changes_modified,
  };
}

function readDriftObjectVersion(row: DriftObjectVersionRow): DriftObjectVersionRecord {
  return {
    tenantId: row.tenant_id,
    resource: row.resource,
    graphId: row.graph_id,
    version: row.version,
    contentHash: row.content_hash,
    rawJson: row.raw_json,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    firstSeenSnapshotId: row.first_seen_snapshot_id,
    firstSeenAt: row.first_seen_at,
    ...(row.removed_snapshot_id ? { removedSnapshotId: row.removed_snapshot_id } : {}),
    ...(row.removed_at ? { removedAt: row.removed_at } : {}),
  };
}

function groupDriftVersions(
  rows: DriftObjectVersionRow[],
): Map<string, DriftObjectVersionRow[]> {
  const grouped = new Map<string, DriftObjectVersionRow[]>();
  for (const row of rows) {
    const key = `${row.tenant_id}\u0000${row.resource}\u0000${row.graph_id}`;
    const existing = grouped.get(key) ?? [];
    existing.push(row);
    grouped.set(key, existing);
  }
  for (const versions of grouped.values()) {
    versions.sort((a, b) => a.version - b.version);
  }
  return grouped;
}

function normalizeDriftLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(value)));
}

function normalizeCachedRowLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

function readMultiTenantJob(row: MultiTenantJobRow): MultiTenantChatJob {
  return {
    id: row.id,
    conversationId: row.conversation_id ?? undefined,
    prompt: row.prompt,
    savedQueryId: row.saved_query_id ?? undefined,
    tenantScope: readJson<TenantScope>(row.tenant_scope_json, { kind: "active" }),
    resolvedTenantIds: readJson<string[]>(row.resolved_tenant_ids_json, []),
    providerId: row.provider_id as MultiTenantChatJob["providerId"],
    providerName: row.provider_name,
    providerIsLocal: row.provider_is_local === 1,
    model: row.model ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preflight: readJson<MultiTenantChatJob["preflight"]>(
      row.preflight_json,
      {} as MultiTenantChatJob["preflight"],
    ),
    progress: readJson<MultiTenantChatJob["progress"]>(row.progress_json, []),
    summary: readJson<MultiTenantChatJob["summary"]>(row.summary_json, {
      tenantsScanned: 0,
      failedTenants: 0,
      skippedTenants: 0,
      staleTenants: 0,
      windowsDevices: 0,
      compliant: 0,
      nonCompliant: 0,
      unknown: 0,
    }),
    comparisons: readJson<MultiTenantChatJob["comparisons"]>(row.comparisons_json, []),
    deviceRows: readJson<MultiTenantChatJob["deviceRows"]>(row.device_rows_json, []),
    assistantText: row.assistant_text,
    exportDossierMarkdown: row.export_dossier_markdown,
    error: row.error ?? undefined,
  };
}

function readMultiTenantAgentBatch(
  row: MultiTenantAgentBatchRow,
): MultiTenantAgentBatch {
  return {
    id: row.id,
    agentSlug: row.agent_slug,
    agentName: row.agent_name,
    agentMode: row.agent_mode,
    tenantScope: readJson<TenantScope>(row.tenant_scope_json, { kind: "active" }),
    resolvedTenantIds: readJson<string[]>(row.resolved_tenant_ids_json, []),
    status: row.status,
    runIds: readJson<string[]>(row.run_ids_json, []),
    preflight: readJson<MultiTenantAgentBatch["preflight"]>(
      row.preflight_json,
      {} as MultiTenantAgentBatch["preflight"],
    ),
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readWorkspaceEvidence(row: WorkspaceEvidenceRow): WorkspaceEvidence {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    tenantId: row.tenant_id,
    title: row.title,
    sourceType: row.source_type,
    sourceRef: row.source_ref_json
      ? readJson<Record<string, unknown>>(row.source_ref_json, {})
      : undefined,
    content: readJson<unknown>(row.content_json, {}),
    freshness: row.freshness_json
      ? readJson<WorkspaceEvidence["freshness"]>(row.freshness_json, undefined)
      : undefined,
    createdAt: row.created_at,
  };
}

function readWorkspaceNote(row: WorkspaceNoteRow): WorkspaceNote {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    tenantId: row.tenant_id,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readWorkspaceLink(row: WorkspaceLinkRow): WorkspaceLink {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    tenantId: row.tenant_id,
    type: row.type,
    refId: row.ref_id,
    title: row.title,
    createdAt: row.created_at,
  };
}

function buildWorkspaceDossier(workspace: WorkspaceDetail): string {
  const lines = [
    `# ${workspace.title}`,
    "",
    `Tenant: ${workspace.tenantName ?? workspace.tenantId}`,
    `Status: ${workspace.status}`,
    `Updated: ${workspace.updatedAt}`,
    "",
    "## Notes",
    "",
  ];
  if (workspace.notes.length === 0) {
    lines.push("No notes recorded.", "");
  } else {
    for (const note of workspace.notes) {
      lines.push(`- ${note.updatedAt}: ${note.content.replace(/\s+/g, " ").trim()}`);
    }
    lines.push("");
  }
  lines.push("## Pinned Evidence", "");
  if (workspace.evidence.length === 0) {
    lines.push("No evidence pinned.", "");
  } else {
    for (const evidence of workspace.evidence) {
      lines.push(`### ${evidence.title}`);
      lines.push(`- Source: ${evidence.sourceType}`);
      lines.push(`- Created: ${evidence.createdAt}`);
      if (evidence.freshness?.refreshedAt) {
        lines.push(`- Refreshed: ${evidence.freshness.refreshedAt}`);
      }
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(evidence.content, null, 2));
      lines.push("```", "");
    }
  }
  lines.push("## Linked Context", "");
  if (workspace.links.length === 0) {
    lines.push("No linked conversations or runs.");
  } else {
    for (const link of workspace.links) {
      lines.push(`- ${link.type}: ${link.title} (${link.refId})`);
    }
  }
  if (workspace.instructions) {
    lines.push("", "## Local Instructions", "", workspace.instructions);
  }
  return `${lines.join("\n")}\n`;
}

function graphCacheScheduleKey(tenantId: string): string {
  return `graphCacheRefreshSchedule:${tenantId}`;
}

function sqliteFileBytes(dbPath: string): number {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].reduce((total, path) => {
    if (!existsSync(path)) return total;
    try {
      return total + statSync(path).size;
    } catch {
      return total;
    }
  }, 0);
}

function normalizeScheduleInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 360;
  return Math.max(15, Math.min(24 * 60, Math.floor(value)));
}

function nextRefreshDueAt(anchor: string, intervalMinutes: number): string | undefined {
  const anchorMs = new Date(anchor).getTime();
  if (!Number.isFinite(anchorMs)) return undefined;
  return new Date(anchorMs + intervalMinutes * 60 * 1000).toISOString();
}

function readJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function readToolCall(row: ToolCallRow): IntuneChatToolCall {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id ?? undefined,
    type: row.type as IntuneChatToolCall["type"],
    status: row.status,
    input: row.input_json ? readJson<unknown>(row.input_json, undefined) : undefined,
    output: row.output_json ? readJson<unknown>(row.output_json, undefined) : undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function readToolTrace(row: ToolCallRow): IntuneChatToolTraceEntry {
  const output = row.output_json
    ? readJson<Partial<IntuneChatToolTraceEntry>>(row.output_json, {})
    : {};
  return {
    id: typeof output.id === "string" ? output.id : row.id,
    tool: isInvestigationToolName(output.tool) ? output.tool : row.type as IntuneChatInvestigationToolName,
    params:
      output.params !== undefined
        ? output.params
        : row.input_json
          ? readJson<unknown>(row.input_json, {})
          : {},
    resultSummary:
      typeof output.resultSummary === "string"
        ? output.resultSummary
        : row.error ?? "Tool call completed.",
    durationMs:
      typeof output.durationMs === "number" && Number.isFinite(output.durationMs)
        ? output.durationMs
        : durationBetween(row.created_at, row.completed_at ?? row.created_at),
    createdAt: typeof output.createdAt === "string" ? output.createdAt : row.created_at,
    completedAt:
      typeof output.completedAt === "string"
        ? output.completedAt
        : row.completed_at ?? row.created_at,
    error:
      typeof output.error === "string"
        ? output.error
        : row.error ?? undefined,
  };
}

function durationBetween(start: string, finish: string): number {
  const startMs = new Date(start).getTime();
  const finishMs = new Date(finish).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs)) return 0;
  return Math.max(0, Math.round(finishMs - startMs));
}

function isInvestigationToolName(value: unknown): value is IntuneChatInvestigationToolName {
  return (
    value === "list_cached_resources" ||
    value === "query_cache" ||
    value === "graph_get" ||
    value === "refresh_resource"
  );
}

function isChatInvestigationMode(value: unknown): value is ChatInvestigationMode {
  return value === "auto" || value === "always-agentic" || value === "always-deterministic";
}

function buildGraphCachePredicateSql(predicate: GraphCacheQueryPredicate): {
  sql: string;
  args: Array<string | number>;
} {
  const field = graphCacheFieldSql(predicate.field);
  const value = predicate.value;
  switch (predicate.op) {
    case "eq":
      return { sql: `${field} = ?`, args: [sqlScalar(value)] };
    case "neq":
      return { sql: `${field} != ?`, args: [sqlScalar(value)] };
    case "contains":
      return {
        sql: `CAST(${field} AS TEXT) LIKE ? ESCAPE '\\'`,
        args: [`%${escapeSqlLike(String(sqlScalar(value)))}%`],
      };
    case "startsWith":
      return {
        sql: `CAST(${field} AS TEXT) LIKE ? ESCAPE '\\'`,
        args: [`${escapeSqlLike(String(sqlScalar(value)))}%`],
      };
    case "lt":
      return { sql: `${field} < ?`, args: [sqlScalar(value)] };
    case "lte":
      return { sql: `${field} <= ?`, args: [sqlScalar(value)] };
    case "gt":
      return { sql: `${field} > ?`, args: [sqlScalar(value)] };
    case "gte":
      return { sql: `${field} >= ?`, args: [sqlScalar(value)] };
    case "in": {
      if (!Array.isArray(value)) {
        throw new Error("query_cache predicate 'in' requires an array value.");
      }
      const values = value.slice(0, 20).map(sqlScalar);
      if (values.length === 0) return { sql: "1 = 0", args: [] };
      return {
        sql: `${field} IN (${values.map(() => "?").join(", ")})`,
        args: values,
      };
    }
    default:
      throw new Error(`Unsupported query_cache operator: ${String(predicate.op)}`);
  }
}

function sqlScalar(value: unknown): string | number {
  if (Array.isArray(value)) return sqlScalar(value[0]);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function graphCacheFieldSql(field: string): string {
  const normalized = field.trim();
  const mapped: Record<string, string> = {
    graphId: "graph_id",
    id: "graph_id",
    searchText: "search_text",
    displayName: "display_name",
    userPrincipalName: "user_principal_name",
    operatingSystem: "operating_system",
    complianceState: "compliance_state",
    lastSeenAt: "last_seen_at",
    refreshedAt: "refreshed_at",
  };
  if (mapped[normalized]) return mapped[normalized];
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error(`Unsupported cache field: ${field}`);
  }
  return `json_extract(raw_json, '$.${normalized}')`;
}

function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("duplicate column")) {
      throw error;
    }
  }
}

function normalizeGraphObject(value: unknown): NormalizedGraphObject {
  const obj = isRecord(value) ? value : {};
  const graphId = readString(obj.id) ?? readString(obj.deviceId) ?? randomSyntheticId(value);
  const displayName = readString(obj.displayName) ?? readString(obj.deviceName);
  const userPrincipalName = readString(obj.userPrincipalName);
  const operatingSystem = readString(obj.operatingSystem);
  const complianceState = readString(obj.complianceState);
  const lastSeenAt =
    readString(obj.lastSyncDateTime) ??
    readString(obj.approximateLastSignInDateTime) ??
    readString(obj.createdDateTime);
  const searchText = [
    displayName,
    userPrincipalName,
    operatingSystem,
    complianceState,
    readString(obj.mail),
    readString(obj.manufacturer),
    readString(obj.model),
    JSON.stringify(value),
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .toLowerCase();
  return {
    graphId,
    searchText,
    displayName: displayName ?? null,
    userPrincipalName: userPrincipalName ?? null,
    operatingSystem: operatingSystem ?? null,
    complianceState: complianceState ?? null,
    lastSeenAt: lastSeenAt ?? null,
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomSyntheticId(value: unknown): string {
  const json = JSON.stringify(value);
  let hash = 0;
  for (let i = 0; i < json.length; i += 1) {
    hash = (hash * 31 + json.charCodeAt(i)) >>> 0;
  }
  return `row-${hash.toString(16)}`;
}
