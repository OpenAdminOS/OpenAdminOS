import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "../components/Button";
import { Modal, ModalHeader } from "../components/Modal";
import { Pill } from "../components/Pill";
import {
  IconChat,
  IconChevronRight,
  IconDownload,
  IconHardDrive,
  IconPlus,
  IconSearch,
  IconStar,
} from "../components/icons";
import { useAppState } from "../state";
import type {
  IntuneChatConversation,
  RunRecord,
  WorkspaceDetail,
  WorkspaceSummary,
} from "../shared/openAdminOS";

const focusRingClass =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]";

export default function Workspaces() {
  const { state } = useAppState();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [conversations, setConversations] = useState<IntuneChatConversation[]>([]);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createTenantId, setCreateTenantId] = useState(state.activeTenantId ?? "");
  const [noteText, setNoteText] = useState("");
  const [instructions, setInstructions] = useState("");
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");

  const loadWorkspaces = async (preferredId?: string | null) => {
    const api = window.openAdminOS;
    if (!api) return;
    const [nextWorkspaces, nextConversations] = await Promise.all([
      api.listWorkspaces(),
      api.listIntuneChatConversations(),
    ]);
    setWorkspaces(nextWorkspaces);
    setConversations(nextConversations);
    const nextId =
      preferredId !== undefined
        ? preferredId
        : activeWorkspaceId && nextWorkspaces.some((workspace) => workspace.id === activeWorkspaceId)
          ? activeWorkspaceId
          : nextWorkspaces[0]?.id ?? null;
    setActiveWorkspaceId(nextId);
    if (nextId) {
      const nextDetail = await api.getWorkspace(nextId);
      setDetail(nextDetail ?? null);
      setInstructions(nextDetail?.instructions ?? "");
    } else {
      setDetail(null);
      setInstructions("");
    }
  };

  useEffect(() => {
    void loadWorkspaces().catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeTenantId]);

  useEffect(() => {
    const api = window.openAdminOS;
    if (!api || !activeWorkspaceId) return;
    void api
      .getWorkspace(activeWorkspaceId)
      .then((nextDetail) => {
        setDetail(nextDetail ?? null);
        setInstructions(nextDetail?.instructions ?? "");
      })
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  }, [activeWorkspaceId]);

  const filteredWorkspaces = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return workspaces;
    return workspaces.filter((workspace) =>
      `${workspace.title} ${workspace.tenantName ?? ""}`.toLowerCase().includes(needle),
    );
  }, [search, workspaces]);

  const tenantRuns = useMemo(() => {
    if (!detail) return [];
    return state.runs.filter((run) => !run.tenantId || run.tenantId === detail.tenantId);
  }, [detail, state.runs]);

  const tenantConversations = useMemo(() => {
    if (!detail) return [];
    return conversations.filter(
      (conversation) =>
        conversation.scopeKind !== "multi-tenant" &&
        (!conversation.tenantId || conversation.tenantId === detail.tenantId),
    );
  }, [conversations, detail]);

  const handleCreate = async () => {
    const api = window.openAdminOS;
    if (!api || !createTitle.trim()) return;
    setError(null);
    try {
      const workspace = await api.createWorkspace({
        title: createTitle,
        tenantId: createTenantId || undefined,
      });
      setCreateOpen(false);
      setCreateTitle("");
      setNotice(`Created workspace ${workspace.title}.`);
      await loadWorkspaces(workspace.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleAddNote = async () => {
    const api = window.openAdminOS;
    if (!api || !detail || !noteText.trim()) return;
    try {
      await api.addWorkspaceNote(detail.id, noteText);
      setNoteText("");
      await loadWorkspaces(detail.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleSaveInstructions = async () => {
    const api = window.openAdminOS;
    if (!api || !detail) return;
    try {
      const updated = await api.updateWorkspace(detail.id, { instructions });
      setDetail(updated);
      setNotice("Workspace instructions saved locally.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleExport = async () => {
    const api = window.openAdminOS;
    if (!api || !detail) return;
    try {
      const markdown = await api.exportWorkspaceDossier(detail.id);
      const result = await api.saveTextFile({
        suggestedName: `${safeFileName(detail.title)}.md`,
        content: markdown,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!result.canceled) {
        setNotice(result.filePath ? `Exported workspace to ${result.filePath}.` : "Exported workspace.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleArchive = async () => {
    const api = window.openAdminOS;
    if (!api || !detail) return;
    try {
      await api.archiveWorkspace(detail.id);
      setNotice("Workspace archived. Chat history, run history, and Graph cache were not deleted.");
      await loadWorkspaces(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleDelete = async () => {
    const api = window.openAdminOS;
    if (!api || !detail) return;
    try {
      await api.deleteWorkspace(detail.id);
      setDeleteOpen(false);
      setNotice("Workspace metadata deleted locally. Underlying chats, runs, and cache were left intact.");
      await loadWorkspaces(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleLinkConversation = async () => {
    const api = window.openAdminOS;
    if (!api || !detail || !selectedConversationId) return;
    try {
      await api.linkWorkspaceConversation(detail.id, selectedConversationId);
      setSelectedConversationId("");
      await loadWorkspaces(detail.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleLinkRun = async () => {
    const api = window.openAdminOS;
    if (!api || !detail || !selectedRunId) return;
    try {
      await api.linkWorkspaceRun(detail.id, selectedRunId);
      setSelectedRunId("");
      await loadWorkspaces(detail.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-[var(--color-bg)]">
      <aside className="flex w-[320px] shrink-0 flex-col border-r border-[var(--color-border-soft)] bg-[var(--color-sidebar-solid)]">
        <div className="border-b border-[var(--color-border-soft)] px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                Workspaces
              </div>
              <div className="mt-1 text-[13px] text-[var(--color-text-soft)]">
                Single-tenant investigations
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<IconPlus size={12} />}
              onClick={() => {
                setCreateTenantId(state.activeTenantId ?? state.tenants[0]?.id ?? "");
                setCreateOpen(true);
              }}
            >
              New
            </Button>
          </div>
          <div className="relative mt-3">
            <IconSearch
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search workspaces"
              className="h-8 w-full rounded-md bg-[var(--color-bg-raised)] pl-8 pr-2 text-[12px] text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] placeholder:text-[var(--color-text-muted)] focus:ring-[var(--color-accent)]"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {filteredWorkspaces.length === 0 ? (
            <div className="rounded-lg px-3 py-5 text-[12px] leading-5 text-[var(--color-text-muted)]">
              No workspaces yet. Create one from an investigation, split a multi-tenant result, or start with a note.
            </div>
          ) : (
            filteredWorkspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                onClick={() => setActiveWorkspaceId(workspace.id)}
                className={`mb-1 w-full rounded-lg px-3 py-2.5 text-left transition-colors ${focusRingClass} ${
                  activeWorkspaceId === workspace.id
                    ? "bg-[var(--color-surface-hover)] text-[var(--color-text)]"
                    : "text-[var(--color-text-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <IconHardDrive size={13} className="text-[var(--color-accent)]" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                    {workspace.title}
                  </span>
                  <IconChevronRight size={11} />
                </div>
                <div className="mt-1 truncate text-[10.5px] text-[var(--color-text-muted)]">
                  {workspace.tenantName ?? workspace.tenantId}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <MiniStat label="evidence" value={workspace.evidenceCount} />
                  <MiniStat label="chats" value={workspace.conversationCount} />
                  <MiniStat label="runs" value={workspace.runCount} />
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border-soft)] px-6">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-[var(--color-text)]">
              {detail?.title ?? "No workspace selected"}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">
              {detail
                ? `${detail.tenantName ?? detail.tenantId} · updated ${formatDateTime(detail.updatedAt)}`
                : "Workspace evidence stays local and tenant-scoped."}
            </div>
          </div>
          {detail && (
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="ghost" leadingIcon={<IconDownload size={12} />} onClick={() => void handleExport()}>
                Export
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void handleArchive()}>
                Archive
              </Button>
              <Button size="sm" variant="danger" onClick={() => setDeleteOpen(true)}>
                Delete
              </Button>
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {error && (
            <div className="mb-3 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
              {error}
            </div>
          )}
          {notice && (
            <div className="mb-3 rounded-lg bg-[var(--color-success-soft)] px-3 py-2 text-[12px] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25">
              {notice}
            </div>
          )}
          {!detail ? (
            <EmptyWorkspaceState onCreate={() => setCreateOpen(true)} />
          ) : (
            <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
              <div className="min-w-0 space-y-4">
                <WorkspaceSection
                  title="Pinned evidence"
                  badge={`${detail.evidence.length}`}
                >
                  {detail.evidence.length === 0 ? (
                    <EmptyInline text="Evidence pinned from chat, runs, and split multi-tenant results appears here." />
                  ) : (
                    <div className="grid gap-2">
                      {detail.evidence.map((evidence) => (
                        <div key={evidence.id} className="rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-[12.5px] font-medium text-[var(--color-text)]">
                                {evidence.title}
                              </div>
                              <div className="mt-0.5 text-[10.5px] text-[var(--color-text-muted)]">
                                {evidence.sourceType} · {formatDateTime(evidence.createdAt)}
                              </div>
                            </div>
                            <Pill tone={evidence.freshness?.cacheStatus === "stale" ? "warning" : "default"}>
                              {evidence.freshness?.refreshedAt
                                ? formatDateTime(evidence.freshness.refreshedAt)
                                : "freshness unknown"}
                            </Pill>
                          </div>
                          <pre className="mt-3 max-h-48 overflow-auto rounded-md bg-[var(--color-bg)] p-3 font-mono text-[10.5px] leading-5 text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
                            {JSON.stringify(evidence.content, null, 2)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )}
                </WorkspaceSection>

                <WorkspaceSection title="Notes" badge={`${detail.notes.length}`}>
                  <div className="flex gap-2">
                    <textarea
                      value={noteText}
                      onChange={(event) => setNoteText(event.target.value)}
                      placeholder="Add a local investigation note"
                      className="min-h-20 flex-1 resize-y rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 text-[12.5px] text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] placeholder:text-[var(--color-text-muted)] focus:ring-[var(--color-accent)]"
                    />
                    <Button variant="secondary" disabled={!noteText.trim()} onClick={() => void handleAddNote()}>
                      Add
                    </Button>
                  </div>
                  <div className="mt-3 grid gap-2">
                    {detail.notes.length === 0 ? (
                      <EmptyInline text="No notes recorded for this workspace." />
                    ) : (
                      detail.notes.map((note) => (
                        <div key={note.id} className="rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]">
                          <div className="text-[12.5px] leading-5 text-[var(--color-text-soft)]">
                            {note.content}
                          </div>
                          <div className="mt-1 text-[10.5px] text-[var(--color-text-muted)]">
                            {formatDateTime(note.updatedAt)}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </WorkspaceSection>
              </div>

              <div className="space-y-4">
                <WorkspaceSection title="Linked context" badge={`${detail.links.length}`}>
                  <div className="space-y-3">
                    <LinkPicker
                      label="Conversation"
                      value={selectedConversationId}
                      onChange={setSelectedConversationId}
                      options={tenantConversations.map((conversation) => ({
                        value: conversation.id,
                        label: conversation.title,
                      }))}
                      onLink={() => void handleLinkConversation()}
                    />
                    <LinkPicker
                      label="Run"
                      value={selectedRunId}
                      onChange={setSelectedRunId}
                      options={tenantRuns.map((run) => ({
                        value: run.id,
                        label: runTitle(run),
                      }))}
                      onLink={() => void handleLinkRun()}
                    />
                    {detail.links.length === 0 ? (
                      <EmptyInline text="No linked chats or agent runs." />
                    ) : (
                      detail.links.map((link) => (
                        <div key={link.id} className="flex items-center gap-2 rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]">
                          {link.type === "conversation" ? <IconChat size={13} /> : <IconStar size={13} />}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[12px] text-[var(--color-text)]">{link.title}</div>
                            <div className="text-[10.5px] text-[var(--color-text-muted)]">{link.type}</div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </WorkspaceSection>

                <WorkspaceSection title="Local instructions">
                  <textarea
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                    placeholder="Approved local instructions for this workspace"
                    className="min-h-40 w-full resize-y rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 text-[12.5px] leading-5 text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] placeholder:text-[var(--color-text-muted)] focus:ring-[var(--color-accent)]"
                  />
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <div className="text-[10.5px] leading-4 text-[var(--color-text-muted)]">
                      Instructions affect explicit prompt context only. They cannot add scopes or bypass confirmation.
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => void handleSaveInstructions()}>
                      Save
                    </Button>
                  </div>
                </WorkspaceSection>
              </div>
            </div>
          )}
        </div>
      </section>

      <CreateWorkspaceModal
        open={createOpen}
        title={createTitle}
        tenantId={createTenantId}
        tenants={state.tenants}
        onTitleChange={setCreateTitle}
        onTenantChange={setCreateTenantId}
        onClose={() => setCreateOpen(false)}
        onConfirm={() => void handleCreate()}
      />
      <DeleteWorkspaceModal
        open={deleteOpen}
        workspace={detail}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}

function WorkspaceSection({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg bg-[var(--color-bg)] p-3 ring-1 ring-[var(--color-border-soft)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          {title}
        </div>
        {badge && <Pill>{badge}</Pill>}
      </div>
      {children}
    </section>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
      {value} {label}
    </span>
  );
}

function EmptyWorkspaceState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex min-h-[420px] items-center justify-center">
      <div className="max-w-[520px] text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <IconHardDrive size={20} />
        </div>
        <h1 className="mt-5 text-[22px] font-semibold tracking-tight text-[var(--color-text)]">
          No workspace selected
        </h1>
        <p className="mt-2 text-[13px] leading-6 text-[var(--color-text-soft)]">
          Workspaces keep tenant-specific evidence, notes, linked chats, runs, and local instructions together.
        </p>
        <div className="mt-5">
          <Button variant="primary" leadingIcon={<IconPlus size={13} />} onClick={onCreate}>
            Create workspace
          </Button>
        </div>
      </div>
    </div>
  );
}

function EmptyInline({ text }: { text: string }) {
  return (
    <div className="rounded-lg bg-[var(--color-bg-raised)] px-3 py-3 text-[12px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
      {text}
    </div>
  );
}

function LinkPicker({
  label,
  value,
  options,
  onChange,
  onLink,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  onLink: () => void;
}) {
  return (
    <div className="flex gap-2">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 flex-1 rounded-md bg-[var(--color-bg-raised)] px-2 text-[12px] text-[var(--color-text-soft)] outline-none ring-1 ring-[var(--color-border-soft)] focus:ring-[var(--color-accent)]"
        aria-label={`Link ${label}`}
      >
        <option value="">Link {label.toLowerCase()}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Button size="sm" variant="secondary" disabled={!value} onClick={onLink}>
        Link
      </Button>
    </div>
  );
}

function CreateWorkspaceModal({
  open,
  title,
  tenantId,
  tenants,
  onTitleChange,
  onTenantChange,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  tenantId: string;
  tenants: { id: string; displayName: string }[];
  onTitleChange: (title: string) => void;
  onTenantChange: (tenantId: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} size="md">
      <ModalHeader title="Create workspace" subtitle="Single-tenant local investigation" onClose={onClose} />
      <div className="space-y-4 p-6">
        <label className="block">
          <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Title
          </span>
          <input
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            autoFocus
            className="mt-2 h-10 w-full rounded-lg bg-[var(--color-bg-raised)] px-3 text-[13px] text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] focus:ring-[var(--color-accent)]"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Tenant
          </span>
          <select
            value={tenantId}
            onChange={(event) => onTenantChange(event.target.value)}
            className="mt-2 h-10 w-full rounded-lg bg-[var(--color-bg-raised)] px-3 text-[13px] text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] focus:ring-[var(--color-accent)]"
          >
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.displayName}
              </option>
            ))}
          </select>
        </label>
        <div className="rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 text-[12px] leading-5 text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
          Workspaces cannot mix tenant evidence. Multi-tenant chat results must be split into tenant-specific evidence entries.
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!title.trim() || !tenantId} onClick={onConfirm}>
            Create
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DeleteWorkspaceModal({
  open,
  workspace,
  onClose,
  onConfirm,
}: {
  open: boolean;
  workspace: WorkspaceDetail | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} size="md">
      <ModalHeader
        title="Delete workspace metadata"
        subtitle={workspace?.title ?? "Workspace"}
        badge={<Pill tone="danger">Local delete</Pill>}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <div className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-[12px] leading-5 text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
          This removes workspace notes, pinned evidence, local instructions, and links. Chat history, run history, tenant configuration, Graph cache, connector audit records, and self-training records are left intact.
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            Delete metadata
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function runTitle(run: RunRecord): string {
  return `${run.agentSlug} · ${run.status}`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function safeFileName(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || "workspace";
}
