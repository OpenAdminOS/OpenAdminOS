import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { SetByItBadge } from "../components/ManagedPolicy";
import { Button as UiButton, Switch } from "../components/ui";
import type {
  ConnectorSummary,
  NovaCapabilityName,
  NovaFollowUp,
  NovaInstructionRevision,
  NovaNote,
  NovaProfilePatch,
  NovaProfileView,
  NovaRecordsRequest,
  NovaRecordsView,
  NovaShortcut,
  NovaVoiceMode,
} from "../shared/openAdminOS";
import { useAppState } from "../state";
import { SettingRow } from "./SettingRow";

/** The connectors Nova can prepare sends through. */
const NOVA_SEND_CONNECTOR_IDS = ["outlook", "teams", "slack", "whatsapp-web", "discord", "signal"] as const;
const INSTRUCTIONS_MAX = 4000;
const ADDENDUM_MAX = 1000;
const NAME_MAX = 40;
const SHORTCUT_NAME_MAX = 40;
const SHORTCUT_PROMPT_MAX = 600;
const NOTE_MAX = 300;

/** What a follow-up state means, as the main process records it. */
const FOLLOW_UP_STATE_TEXT: Record<NovaFollowUp["status"], string> = {
  pending: "Pending",
  running: "Running now",
  completed: "Answered in Chat",
  cancelled: "Cancelled",
  "skipped-organization": "Not run: the organization it was set in was not active or not connected at that time.",
  "skipped-provider": "Not run: the agent provider or model changed after it was set.",
  missed: "Not run: OpenAdminOS was not running within an hour of its time.",
  failed: "Started, but Chat did not return an answer.",
};

function utc(value: string): string {
  return `${value.slice(0, 16).replace("T", " ")} UTC`;
}

const CAPABILITIES: { id: NovaCapabilityName; label: string; description: string }[] = [
  { id: "webSearch", label: "Web search", description: "Hosted voice may search the public web. Searches go to OpenAI." },
  { id: "navigation", label: "Open pages", description: "Nova may open app pages when you ask." },
  { id: "startAgents", label: "Start agents", description: "Nova may prepare agent runs. Each run still needs your click, and write plans their review." },
];

const VOICE_MODE_LABELS: Record<NovaVoiceMode, string> = {
  openai: "OpenAI · GPT-Live-1",
  local: "Local · whisper.cpp + Kokoro",
};

const inputClass =
  "w-full rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-3 py-2 text-sm text-[var(--color-text)] outline-none transition-colors focus:border-[var(--color-accent)] disabled:opacity-60";

function hostError(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : String(caught);
  return raw.replace(/^Error invoking remote method ['"][^'"]+['"]: (?:\w*Error: )?/, "").trim() || "Nova settings could not be saved. Try again.";
}

function versionLabel(revision: NovaInstructionRevision): string {
  const when = revision.at.slice(0, 16).replace("T", " ");
  const how = revision.via === "nova-proposal" ? "confirmed on a Nova card" : revision.via === "revert" ? "restored" : revision.via === "migration" ? "moved from this device" : "saved in Settings";
  return `${when} UTC · ${how}`;
}

function Counter({ value, max }: { value: string; max: number }) {
  const over = value.length > max;
  return (
    <span className={`text-xs tabular-nums ${over ? "text-[var(--color-danger)]" : "text-[var(--color-text-muted)]"}`}>
      {value.length} of {max}
    </span>
  );
}

/**
 * Settings, Nova: the profile Nova uses in every conversation on this
 * device. Values the IT policy sets are shown read-only; the main process
 * refuses them too.
 */
export function NovaSettingsSection() {
  const { state, refresh } = useAppState();
  const api = window.openAdminOS;
  const [view, setView] = useState<NovaProfileView>();
  const [connectors, setConnectors] = useState<ConnectorSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [addendum, setAddendum] = useState("");
  const [shortcutDraft, setShortcutDraft] = useState<{ id?: string; name: string; prompt: string }>();
  const [records, setRecords] = useState<NovaRecordsView>();
  const [noteDraft, setNoteDraft] = useState<{ id: string; text: string }>();
  // What was loaded is bound to the organization it was loaded for: after a
  // switch, the previous organization's instructions, notes and drafts are
  // neither shown nor saved under the new one.
  const [loadedFor, setLoadedFor] = useState<{ organizationId: string | undefined }>();
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null);
  const [recordsLoadError, setRecordsLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const activeOrganizationId = state.activeOrganizationId;
  const activeOrganization = useRef(activeOrganizationId);
  activeOrganization.current = activeOrganizationId;
  const organization = state.organizations?.find((entry) => entry.id === activeOrganizationId);
  const organizationReady = loadedFor !== undefined && loadedFor.organizationId === activeOrganizationId;

  const adopt = useCallback((next: NovaProfileView, organizationId: string | undefined) => {
    setView(next);
    setLoadedFor({ organizationId });
    setName(next.effective.greetingName);
    setInstructions(next.effective.instructions);
    setAddendum(next.effective.addendum);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const organizationId = activeOrganizationId;
    const current = () => !cancelled && activeOrganization.current === organizationId;
    setLoadedFor(undefined);
    setRecords(undefined);
    setNoteDraft(undefined);
    setAddendum("");
    setProfileLoadError(null);
    setRecordsLoadError(null);
    if (!api?.novaProfile) return;
    void api
      .novaProfile({ action: "get" })
      .then((next) => { if (current()) adopt(next, organizationId); })
      .catch((caught) => { if (current()) setProfileLoadError(hostError(caught)); });
    void api
      .novaRecords?.({ action: "list" })
      .then((next) => { if (current() && (next.organizationId ?? undefined) === organizationId) setRecords(next); })
      .catch((caught) => { if (current()) setRecordsLoadError(hostError(caught)); });
    void api
      .listConnectors?.()
      .then((list) => { if (!cancelled) setConnectors(list); })
      .catch(() => { if (!cancelled) setConnectors([]); });
    return () => { cancelled = true; };
  }, [api, adopt, activeOrganizationId, reload]);

  const run = async (request: Parameters<NonNullable<typeof api>["novaProfile"]>[0], done: string) => {
    if (!api?.novaProfile) return;
    const organizationId = activeOrganization.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await api.novaProfile(request);
      // A reply for an organization that is no longer active is not shown; the new one loads itself.
      if (activeOrganization.current === organizationId) adopt(next, organizationId);
      setNotice(done);
      await refresh();
      return true;
    } catch (caught) {
      setError(hostError(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = (patch: NovaProfilePatch, done = "Saved.") => run({ action: "save", patch }, done);
  const record = async (request: NovaRecordsRequest, done: string) => {
    if (!api?.novaRecords) return false;
    const organizationId = activeOrganization.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await api.novaRecords(request);
      if (activeOrganization.current === organizationId && (next.organizationId ?? undefined) === organizationId) setRecords(next);
      setNotice(done);
      await refresh();
      return true;
    } catch (caught) {
      setError(hostError(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!view) {
    return (
      <div className="max-w-[1040px] text-sm text-[var(--color-text-muted)]" role={profileLoadError ? "alert" : "status"}>
        {profileLoadError ? `Nova settings could not be loaded: ${profileLoadError}` : "Loading Nova settings."}
        {profileLoadError ? (
          <UiButton className="ml-2" size="sm" variant="ghost" onClick={() => setReload((count) => count + 1)}>Try again</UiButton>
        ) : null}
      </div>
    );
  }
  const retry = <UiButton size="sm" variant="ghost" onClick={() => setReload((count) => count + 1)}>Try again</UiButton>;
  /** The state of a panel for the active organization while its data is not loaded. */
  const notLoaded = (what: string, failure: string | null) =>
    failure ? (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-danger)]">
        <span>{what} for {organization?.name ?? "this organization"} could not be loaded: {failure}</span>
        {retry}
      </div>
    ) : (
      <span role="status" className="text-sm text-[var(--color-text-muted)]">Loading {what.toLowerCase()} for {organization?.name ?? "this organization"}.</span>
    );
  const recordsUnavailable = state.novaRecordsUnavailable;
  const { effective } = view;
  const locked = effective.locked;
  const userRevisions = view.revisions.filter((revision) => revision.scope === "user");
  const addendumRevisions = organizationReady ? view.revisions.filter((revision) => revision.scope === "organization") : [];
  const sendConnectors = NOVA_SEND_CONNECTOR_IDS.map((id) => connectors.find((connector) => connector.descriptor.id === id)).filter((connector): connector is ConnectorSummary => Boolean(connector));
  const sendsPolicy = effective.connectorSendsPolicy;
  const connectorAllowed = (id: string) => {
    if (sendsPolicy === false) return false;
    if (Array.isArray(sendsPolicy) && !sendsPolicy.includes(id)) return false;
    return effective.connectorSends[id] ?? true;
  };
  const connectorLocked = (id: string) => locked.connectorSends || sendsPolicy === false || (Array.isArray(sendsPolicy) && !sendsPolicy.includes(id));

  return (
    <div className="max-w-[1040px]">
      <p className="mb-3 text-sm leading-5 text-[var(--color-text-muted)]">
        Nova uses these settings in every conversation on this device. Instructions shape how it answers. They cannot approve
        actions, choose destinations or skip a confirmation.
        {effective.voiceMode === "openai" ? " In hosted voice, the instructions and the organization's confirmed notes go to OpenAI with the conversation." : ""}
      </p>
      <div className="overflow-hidden rounded-[10px] bg-[var(--color-surface)] ring-1 ring-[var(--color-border)]">
        <SettingRow
          id="nova-voice"
          stacked
          control={
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm text-[var(--color-text-soft)]">
                <span className="flex items-center gap-2">Voice provider {locked.voiceMode ? <SetByItBadge /> : null}</span>
                {effective.allowedVoiceModes.length === 0 ? (
                  <span className="text-sm text-[var(--color-text)]">Nova voice is turned off by your IT department.</span>
                ) : (
                  <select
                    aria-label="Nova voice provider"
                    className={inputClass}
                    value={effective.voiceMode}
                    disabled={busy || locked.voiceMode}
                    onChange={(event) => void save({ voiceMode: event.target.value as NovaVoiceMode })}
                  >
                    {effective.allowedVoiceModes.map((mode) => (
                      <option key={mode} value={mode}>{VOICE_MODE_LABELS[mode]}</option>
                    ))}
                  </select>
                )}
              </label>
              <label className="grid gap-1 text-sm text-[var(--color-text-soft)]">
                Greeting name
                <input
                  aria-label="Nova greeting name"
                  className={inputClass}
                  value={name}
                  maxLength={NAME_MAX}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                  onBlur={() => { if (name.trim() !== effective.greetingName) void save({ greetingName: name }); }}
                />
              </label>
            </div>
          }
        />
        <SettingRow
          id="nova-instructions"
          stacked
          description={
            effective.instructionsSource === "policy"
              ? locked.instructions
                ? "Your IT department set these instructions. They apply in every conversation."
                : "Your IT department suggests these instructions. Write your own to replace them."
              : "Tell Nova how to answer in every conversation, for example which language to use or what to name first."
          }
          control={
            <div className="grid gap-2">
              {locked.instructions ? <SetByItBadge className="justify-self-start" /> : null}
              <textarea
                aria-label="Nova standing instructions"
                className={`${inputClass} min-h-[120px] resize-y leading-5`}
                value={instructions}
                readOnly={locked.instructions}
                disabled={busy && !locked.instructions}
                onChange={(event) => setInstructions(event.target.value)}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Counter value={instructions} max={INSTRUCTIONS_MAX} />
                {!locked.instructions ? (
                  <div className="flex gap-2">
                    <UiButton
                      size="sm"
                      variant="ghost"
                      disabled={busy || instructions === effective.instructions}
                      onClick={() => setInstructions(effective.instructions)}
                    >
                      Discard changes
                    </UiButton>
                    <UiButton
                      size="sm"
                      disabled={busy || instructions === effective.instructions || instructions.length > INSTRUCTIONS_MAX}
                      onClick={() => void save({ instructions }, "Instructions saved. Nova uses them from the next conversation.")}
                    >
                      Save instructions
                    </UiButton>
                  </div>
                ) : null}
              </div>
            </div>
          }
        />
        <SettingRow
          id="nova-organization-addendum"
          stacked
          description={
            organization
              ? `Applies only while ${organization.name} is the active organization.`
              : "Select an organization to add instructions that apply to it only."
          }
          control={
            organization && !organizationReady ? (
              notLoaded("Nova instructions", profileLoadError)
            ) : organization ? (
              <div className="grid gap-2">
                <textarea
                  aria-label={`Nova instructions for ${organization.name}`}
                  className={`${inputClass} min-h-[72px] resize-y leading-5`}
                  value={addendum}
                  disabled={busy}
                  onChange={(event) => setAddendum(event.target.value)}
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Counter value={addendum} max={ADDENDUM_MAX} />
                  <UiButton
                    size="sm"
                    disabled={busy || addendum === effective.addendum || addendum.length > ADDENDUM_MAX}
                    onClick={() => void save({ addendum: { organizationId: organization.id, text: addendum } }, `Saved for ${organization.name}.`)}
                  >
                    Save for {organization.name}
                  </UiButton>
                </div>
              </div>
            ) : (
              <span className="text-sm text-[var(--color-text-muted)]">No organization is active.</span>
            )
          }
        />
        <SettingRow
          id="nova-abilities"
          stacked
          description="Turned-off abilities are refused when Nova prepares an action and again when you confirm it."
          control={
            <div className="grid gap-1">
              {CAPABILITIES.map((capability) => (
                <div key={capability.id} className="flex items-center justify-between gap-3">
                  <Switch
                    className="flex-1"
                    checked={effective.capabilities[capability.id]}
                    disabled={busy || locked.capabilities[capability.id]}
                    onCheckedChange={(checked) => void save({ capabilities: { [capability.id]: checked } })}
                    label={capability.label}
                    description={capability.description}
                  />
                  {locked.capabilities[capability.id] ? <SetByItBadge /> : null}
                </div>
              ))}
              {sendConnectors.length === 0 ? (
                <p className="py-2 text-sm text-[var(--color-text-muted)]">No messaging connectors are set up. Sends per connector appear here once one is.</p>
              ) : (
                sendConnectors.map((connector) => (
                  <div key={connector.descriptor.id} className="flex items-center justify-between gap-3">
                    <Switch
                      className="flex-1"
                      checked={connectorAllowed(connector.descriptor.id)}
                      disabled={busy || connectorLocked(connector.descriptor.id)}
                      onCheckedChange={(checked) => void save({ connectorSends: { [connector.descriptor.id]: checked } })}
                      label={`Send through ${connector.descriptor.name}`}
                      description={connector.status === "connected" ? "Each message still needs your click on its preview." : "Not set up yet. Open Connections to finish setup."}
                    />
                    {connectorLocked(connector.descriptor.id) ? <SetByItBadge /> : null}
                  </div>
                ))
              )}
            </div>
          }
        />
        <SettingRow
          id="nova-instruction-versions"
          stacked
          control={
            userRevisions.length + addendumRevisions.length === 0 ? (
              <span className="text-sm text-[var(--color-text-muted)]">No saved versions yet.</span>
            ) : (
              <ul className="grid gap-2" aria-label="Instruction versions">
                {[...userRevisions, ...addendumRevisions].map((revision) => {
                  const current = revision.scope === "user" ? effective.instructions : effective.addendum;
                  return (
                    <li key={revision.id} className="rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-[var(--color-text-muted)]">
                          {revision.scope === "user" ? "Standing instructions" : `Instructions for ${organization?.name ?? "this organization"}`} · {versionLabel(revision)}
                        </span>
                        <UiButton
                          size="sm"
                          variant="ghost"
                          disabled={busy || revision.text === current || (revision.scope === "user" && locked.instructions)}
                          onClick={() => void run({ action: "revert", revisionId: revision.id }, "Version restored.")}
                        >
                          {revision.text === current ? "Current" : "Restore"}
                        </UiButton>
                      </div>
                      <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-[var(--color-text)]">{revision.text || "Empty"}</p>
                    </li>
                  );
                })}
              </ul>
            )
          }
        />
        <SettingRow
          id="nova-shortcuts"
          stacked
          description="Say “run” and the name, or pick it from the command palette. A shortcut can only ask a read-only question."
          control={
            <ShortcutList
              shortcuts={effective.shortcuts}
              draft={shortcutDraft}
              busy={busy}
              onDraft={setShortcutDraft}
              onSave={async (draft) => {
                if (await save({ saveShortcut: draft }, draft.id ? "Shortcut saved." : "Shortcut added.")) setShortcutDraft(undefined);
              }}
              onDelete={(shortcut) => void save({ deleteShortcut: shortcut.id }, `Deleted ${shortcut.name}.`)}
            />
          }
        />
        <SettingRow
          id="nova-notes"
          stacked
          description={
            organization
              ? `Facts Nova keeps for ${organization.name}. A note Nova proposes waits here for review and reaches no conversation until you confirm it; unconfirmed notes are removed after 30 days. Disconnecting the organization deletes its notes.`
              : "Select an organization to see the notes Nova keeps for it."
          }
          control={
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <Switch
                  className="flex-1"
                  checked={effective.memoryEnabled}
                  disabled={busy || locked.memory}
                  onCheckedChange={(checked) => void save({ memoryPaused: !checked }, checked ? "Notes resumed." : "Notes paused. Nova reads and keeps none until you resume them.")}
                  label="Use notes"
                  description={locked.memory ? "Your IT department turned Nova notes off. Existing notes are kept and not used." : "While paused, Nova reads no notes and keeps no new ones."}
                />
                {locked.memory ? <SetByItBadge /> : null}
              </div>
              {organization && recordsUnavailable ? (
                <span role="alert" className="text-sm text-[var(--color-danger)]">{recordsUnavailable}</span>
              ) : organization && !records ? (
                notLoaded("Notes", recordsLoadError)
              ) : organization ? (
                <NoteList
                  notes={records?.notes ?? []}
                  draft={noteDraft}
                  busy={busy}
                  onDraft={setNoteDraft}
                  onConfirm={(note) => void record({ action: "note-confirm", id: note.id }, "Note confirmed.")}
                  onSave={async (draft) => {
                    if (await record({ action: "note-edit", id: draft.id, text: draft.text }, "Note saved.")) setNoteDraft(undefined);
                  }}
                  onForget={(note) => void record({ action: "note-forget", id: note.id }, "Note forgotten.")}
                />
              ) : null}
            </div>
          }
        />
        <SettingRow
          id="nova-follow-ups"
          stacked
          description={
            organization
              ? `Say “check compliance again in an hour” to Nova. Each runs once, read-only, in ${organization.name} with the provider and model set at the time, and its answer appears in Chat.`
              : "Select an organization to see its follow-ups."
          }
          control={
            organization && recordsUnavailable ? (
              <span role="alert" className="text-sm text-[var(--color-danger)]">{recordsUnavailable}</span>
            ) : organization && !records ? (
              notLoaded("Follow-ups", recordsLoadError)
            ) : organization ? (
              <FollowUpList
                followUps={records?.followUps ?? []}
                busy={busy}
                onCancel={(followUp) => void record({ action: "follow-up-cancel", id: followUp.id }, "Follow-up cancelled.")}
              />
            ) : (
              <span className="text-sm text-[var(--color-text-muted)]">No organization is active.</span>
            )
          }
        />
      </div>
      {error ? (
        <div role="alert" className="mt-3 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
          {error}
        </div>
      ) : notice ? (
        <p role="status" className="mt-3 text-sm text-[var(--color-text-muted)]">{notice}</p>
      ) : null}
    </div>
  );
}

function ShortcutList({
  shortcuts,
  draft,
  busy,
  onDraft,
  onSave,
  onDelete,
}: {
  shortcuts: NovaShortcut[];
  draft?: { id?: string; name: string; prompt: string };
  busy: boolean;
  onDraft: (draft?: { id?: string; name: string; prompt: string }) => void;
  onSave: (draft: { id?: string; name: string; prompt: string }) => Promise<void>;
  onDelete: (shortcut: NovaShortcut) => void;
}) {
  return (
    <div className="grid gap-2">
      {shortcuts.length === 0 && !draft ? <span className="text-sm text-[var(--color-text-muted)]">No shortcuts yet.</span> : null}
      {shortcuts.length > 0 ? (
        <ul className="grid gap-2" aria-label="Nova shortcuts">
          {shortcuts.map((shortcut) => (
            <li key={shortcut.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]">
              <div className="min-w-0">
                <div className="text-sm font-medium text-[var(--color-text)]">{shortcut.name}</div>
                <div className="text-sm text-[var(--color-text-muted)]">{shortcut.prompt}</div>
              </div>
              <div className="flex gap-1">
                <UiButton size="sm" variant="ghost" disabled={busy} onClick={() => onDraft({ id: shortcut.id, name: shortcut.name, prompt: shortcut.prompt })}>Edit</UiButton>
                <UiButton size="sm" variant="ghost" disabled={busy} onClick={() => onDelete(shortcut)}>Delete</UiButton>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {draft ? (
        <form
          className="grid gap-2 rounded-lg px-3 py-3 ring-1 ring-[var(--color-border-soft)]"
          aria-label={draft.id ? "Edit shortcut" : "New shortcut"}
          onSubmit={(event) => { event.preventDefault(); void onSave(draft); }}
        >
          <label className="grid gap-1 text-sm text-[var(--color-text-soft)]">
            Name
            <input className={inputClass} value={draft.name} maxLength={SHORTCUT_NAME_MAX} onChange={(event) => onDraft({ ...draft, name: event.target.value })} placeholder="Morning check" />
          </label>
          <label className="grid gap-1 text-sm text-[var(--color-text-soft)]">
            Question
            <textarea className={`${inputClass} min-h-[64px] resize-y`} value={draft.prompt} maxLength={SHORTCUT_PROMPT_MAX} onChange={(event) => onDraft({ ...draft, prompt: event.target.value })} placeholder="How many devices are noncompliant, and which policies fail most?" />
          </label>
          <div className="flex justify-end gap-2">
            <UiButton type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onDraft(undefined)}>Cancel</UiButton>
            <UiButton type="submit" size="sm" disabled={busy || !draft.name.trim() || !draft.prompt.trim()}>{draft.id ? "Save shortcut" : "Add shortcut"}</UiButton>
          </div>
        </form>
      ) : (
        <UiButton className="justify-self-start" size="sm" variant="secondary" disabled={busy || shortcuts.length >= 20} onClick={() => onDraft({ name: "", prompt: "" })}>
          Add shortcut
        </UiButton>
      )}
    </div>
  );
}

function NoteList({
  notes,
  draft,
  busy,
  onDraft,
  onConfirm,
  onSave,
  onForget,
}: {
  notes: NovaNote[];
  draft?: { id: string; text: string };
  busy: boolean;
  onDraft: (draft?: { id: string; text: string }) => void;
  onConfirm: (note: NovaNote) => void;
  onSave: (draft: { id: string; text: string }) => Promise<void>;
  onForget: (note: NovaNote) => void;
}) {
  if (notes.length === 0) return <span className="text-sm text-[var(--color-text-muted)]">No notes yet. Say “remember that …” to Nova.</span>;
  return (
    <ul className="grid gap-2" aria-label="Nova notes">
      {notes.map((note) => (
        <li key={note.id} className="rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]">
          {draft?.id === note.id ? (
            <form className="grid gap-2" aria-label="Edit note" onSubmit={(event) => { event.preventDefault(); void onSave(draft); }}>
              <textarea
                aria-label="Note"
                className={`${inputClass} min-h-[56px] resize-y`}
                value={draft.text}
                maxLength={NOTE_MAX}
                onChange={(event) => onDraft({ ...draft, text: event.target.value })}
              />
              <div className="flex items-center justify-between gap-2">
                <Counter value={draft.text} max={NOTE_MAX} />
                <div className="flex gap-1">
                  <UiButton type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onDraft(undefined)}>Cancel</UiButton>
                  <UiButton type="submit" size="sm" disabled={busy || !draft.text.trim() || draft.text.length > NOTE_MAX}>Save note</UiButton>
                </div>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="whitespace-pre-wrap text-sm text-[var(--color-text)]">{note.text}</p>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {note.reviewState === "proposed"
                    ? `Waiting for review · ${note.source === "user-said" ? "you asked for it" : "worded by Nova"} · ${utc(note.createdAt)}${note.expiresAt ? ` · removed ${utc(note.expiresAt)} unless confirmed` : ""}`
                    : `${note.reviewState === "edited" ? "Edited" : "Confirmed"} ${utc(note.reviewedAt ?? note.createdAt)} · ${note.source === "user-said" ? "you asked for it" : "worded by Nova"}`}
                </p>
              </div>
              <div className="flex gap-1">
                {note.reviewState === "proposed" ? <UiButton size="sm" disabled={busy} onClick={() => onConfirm(note)}>Confirm</UiButton> : null}
                <UiButton size="sm" variant="ghost" disabled={busy} onClick={() => onDraft({ id: note.id, text: note.text })}>Edit</UiButton>
                <UiButton size="sm" variant="ghost" disabled={busy} onClick={() => onForget(note)}>Forget</UiButton>
              </div>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function FollowUpList({ followUps, busy, onCancel }: { followUps: NovaFollowUp[]; busy: boolean; onCancel: (followUp: NovaFollowUp) => void }) {
  if (followUps.length === 0) return <span className="text-sm text-[var(--color-text-muted)]">No follow-ups.</span>;
  return (
    <ul className="grid gap-2" aria-label="Nova follow-ups">
      {followUps.map((followUp) => (
        <li key={followUp.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]">
          <div className="min-w-0">
            <p className="text-sm text-[var(--color-text)]">{followUp.question}</p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {followUp.status === "pending" ? `Due ${utc(followUp.dueAt)}` : `${FOLLOW_UP_STATE_TEXT[followUp.status]}${followUp.finishedAt ? ` · ${utc(followUp.finishedAt)}` : ""}`}
              {" · "}{followUp.providerId}{followUp.model ? ` · ${followUp.model}` : ""}
            </p>
            {followUp.status === "failed" && followUp.reason ? <p className="mt-1 text-xs text-[var(--color-danger)]">{followUp.reason}</p> : null}
          </div>
          <div className="flex gap-1">
            {followUp.conversationId ? (
              <Link className="text-sm text-[var(--color-accent)] underline-offset-2 hover:underline" to={`/chat/${followUp.conversationId}`}>Open in Chat</Link>
            ) : null}
            {followUp.status === "pending" ? <UiButton size="sm" variant="ghost" disabled={busy} onClick={() => onCancel(followUp)}>Cancel</UiButton> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
