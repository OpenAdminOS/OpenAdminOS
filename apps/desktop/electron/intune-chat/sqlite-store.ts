import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type {
  GraphCacheResourceKind,
  GraphCacheResourceStatus,
  GraphCacheRefreshScheduleSettings,
  IntuneChatConversation,
  IntuneChatMessage,
  IntuneChatToolCall,
  LocalDataSummary,
  SelfTrainingSettings,
  SelfTrainingSuggestion,
  SelfTrainingSuggestionStatus,
} from "@openadminos/agent-sdk";

interface ConversationRow {
  id: string;
  title: string;
  tenant_id: string | null;
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
}

interface SettingRow {
  value: string;
  updated_at: string;
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

export interface GraphCacheResourceDefinition {
  resource: GraphCacheResourceKind;
  label: string;
  scopes: string[];
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
        `SELECT id, title, tenant_id, created_at, updated_at, pinned_at
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
        `SELECT c.id, c.title, c.tenant_id, c.created_at, c.updated_at, c.pinned_at
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
        `SELECT id, title, tenant_id, created_at, updated_at, pinned_at
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
  }): IntuneChatConversation {
    this.db
      .prepare(
        `INSERT INTO chat_conversations (id, title, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.title, input.tenantId, input.now, input.now);
    return {
      id: input.id,
      title: input.title,
        tenantId: input.tenantId,
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
    return rows.map(readMessage);
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
    const snapshotId = `${input.resource}-${Date.now()}`;
    this.db.exec("BEGIN");
    try {
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
      for (const row of input.rows) {
        const normalized = normalizeGraphObject(row);
        insert.run(
          input.tenantId,
          input.resource,
          normalized.graphId,
          snapshotId,
          JSON.stringify(row),
          normalized.searchText,
          normalized.displayName,
          normalized.userPrincipalName,
          normalized.operatingSystem,
          normalized.complianceState,
          normalized.lastSeenAt,
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

  getSelfTrainingSettings(): SelfTrainingSettings {
    const row = this.db
      .prepare(`SELECT value, updated_at FROM app_settings WHERE key = 'selfTrainingEnabled'`)
      .get() as SettingRow | undefined;
    if (!row) return { enabled: false };
    return { enabled: row.value === "true", updatedAt: row.updated_at };
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

      CREATE TABLE IF NOT EXISTS learning_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        agent_slug TEXT,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

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
    `);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id, name, applied_at)
         VALUES (1, 'intune-chat-cache-and-learning', ?)`,
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
  }
}

function readConversation(row: ConversationRow): IntuneChatConversation {
  return {
    id: row.id,
    title: row.title,
    tenantId: row.tenant_id ?? undefined,
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

function normalizeGraphObject(value: unknown): {
  graphId: string;
  searchText: string;
  displayName: string | null;
  userPrincipalName: string | null;
  operatingSystem: string | null;
  complianceState: string | null;
  lastSeenAt: string | null;
} {
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
