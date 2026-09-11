import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import type {
  AppState,
  OfficeMission,
  OfficeFinding,
  OfficePersona,
  OfficePersonaInput,
  RunRecord,
  RegistryAgentSummary,
} from "../shared/openAdminOS";
import { useAppState } from "../state";
import { useSetupFlow } from "../setup/SetupFlowContext";
import { Button } from "../components/Button";
import { Modal, ModalHeader } from "../components/Modal";
import { OfficeScene, PersonaAvatar } from "../components/office/OfficeScene";
import "../styles/office.css";
import { PersonaWorkflowInstall } from "../components/office/PersonaWorkflowInstall";
import { TeamInbox, PersonaConversation } from "../components/office/TeamInbox";
import {
  PersonaOptions,
  TEAM_ROLES,
} from "../components/office/PersonaOptions";

const isActive = (r?: RunRecord) =>
  r && ["queued", "running", "awaiting-confirmation"].includes(r.status);
const date = (value?: string) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Not yet";
function status(
  p: OfficePersona,
  m: OfficeMission | undefined,
  runs: RunRecord[],
  findings?: OfficeFinding[],
) {
  const current = runs.find((r) => m?.runIds.includes(r.id) && isActive(r));
  if (current?.status === "awaiting-confirmation") return "Needs approval";
  if (current?.status === "running") return "Working";
  if (
    ["queued", "running", "executing", "awaiting-review"].includes(
      m?.status ?? "",
    )
  )
    return "Queued";
  if (
    p.lastError ||
    findings?.some((f) => f.personaId === p.id && f.state === "open")
  )
    return "Needs attention";
  if (!p.enabled) return "Paused";
  return p.nextRunAt ? "Scheduled" : "Ready";
}
export default function Office() {
  const { state, refresh, loading, error: stateError } = useAppState();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("persona");
  const view = params.get("view") === "list" ? "list" : "room";
  const setParam = (key: string, value: string) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set(key, value);
        return next;
      },
      { replace: true },
    );
  const setSelectedId = (id: string) => setParam("persona", id);
  const setView = (view: string) => setParam("view", view);
  const [editing, setEditing] = useState<OfficePersona | "new">();
  const [removeId, setRemoveId] = useState<string>();
  const [historyQuery, setHistoryQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [presentation, setPresentation] = useState(false);
  useEffect(() => {
    document.documentElement.toggleAttribute(
      "data-team-presentation",
      presentation,
    );
    return () =>
      document.documentElement.removeAttribute("data-team-presentation");
  }, [presentation]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const office = state.office ?? { personas: [], missions: [] };
  const selected =
    office.personas.find((p) => p.id === selectedId) ?? office.personas[0];
  const selectedMissions = office.missions.filter(
    (m) => m.personaId === selected?.id,
  );
  const mission = selectedMissions[0];
  const running = office.missions.filter((m) =>
    ["queued", "running", "executing", "awaiting-review"].includes(m.status),
  ).length;
  const attention = office.personas.filter(
    (p) =>
      p.lastError ||
      office.findings?.some(
        (f) => f.personaId === p.id && f.state === "open",
      ) ||
      state.runs.some(
        (r) =>
          r.office?.personaId === p.id && r.status === "awaiting-confirmation",
      ),
  ).length;
  const api = window.openAdminOS;
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  // Keep the scene and editor mounted during background run-state refreshes.
  if (loading && !state.office)
    return (
      <div className="office-loading" role="status">
        Opening your team…
      </div>
    );
  return (
    <div className={`office-page ${expanded ? "office-expanded" : ""}`}>
      <header className="office-header">
        <div>
          <div className="office-eyebrow">YOUR LOCAL TEAM</div>
          <h1>Agent Team</h1>
          <p>Give your agents a place, a purpose, and a schedule.</p>
        </div>
        <Button
          variant="primary"
          disabled={busy || !api?.saveOfficePersona}
          onClick={() => setEditing("new")}
        >
          Add persona
        </Button>
      </header>
      {(error || stateError || office.error) && (
        <div className="office-error" role="alert">
          {error || stateError?.message || office.error}
          <Button size="sm" onClick={() => void act(refresh)}>
            Refresh team
          </Button>
        </div>
      )}
      <TeamInbox state={state} act={act} busy={busy} />
      <div className="office-toolbar">
        <div>
          <strong>{office.personas.length}</strong> personas <span>·</span>{" "}
          <strong>{running}</strong> assignments in progress <span>·</span>{" "}
          <strong>{attention}</strong> need attention
        </div>
        <div className="office-view" aria-label="Team view">
          <button
            aria-pressed={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            Expand office
          </button>
          {expanded && !presentation && (
            <button
              aria-pressed={showDetails}
              onClick={() => setShowDetails((v) => !v)}
            >
              Assignment details
            </button>
          )}
          {expanded && !presentation && (
            <button onClick={() => setExpanded(false)}>Review inbox</button>
          )}
          <button
            aria-pressed={presentation}
            onClick={() => {
              setPresentation((v) => !v);
              setExpanded(true);
              setView("room");
            }}
          >
            Hide details
          </button>
          <button
            aria-pressed={view === "room"}
            onClick={() => setView("room")}
          >
            Office
          </button>
          <button
            aria-pressed={view === "list"}
            disabled={presentation}
            onClick={() => setView("list")}
          >
            List
          </button>
        </div>
      </div>
      <div className="office-layout">
        <section
          className={`office-room ${view === "list" ? "office-list" : ""}`}
          aria-label="Personas"
        >
          {view === "room" && (
            <OfficeScene
              personas={
                presentation
                  ? office.personas.map((p, i) => ({
                      ...p,
                      name: `Teammate ${i + 1}`,
                    }))
                  : office.personas
              }
              events={
                presentation
                  ? undefined
                  : Object.fromEntries(
                      office.personas
                        .map((p) => {
                          const m = office.missions.find(
                            (m) => m.personaId === p.id,
                          );
                          const run = state.runs.find((r) =>
                            m?.runIds.includes(r.id),
                          );
                          const handoff = office.handoffs?.find(
                            (h) => h.id === m?.handoffId,
                          );
                          const outgoing = office.handoffs?.find(
                            (h) =>
                              h.sourcePersonaId === p.id &&
                              Date.now() - Date.parse(h.createdAt) < 5000,
                          );
                          const event = outgoing
                            ? {
                                text: "Evidence handed over",
                                at: outgoing.createdAt,
                                runId: outgoing.sourceRunIds[0],
                                handoff: true,
                                handoffAt: outgoing.createdAt,
                              }
                            : run
                              ? {
                                  text:
                                    run.status === "awaiting-confirmation"
                                      ? "Waiting for your approval"
                                      : run.status === "running"
                                        ? handoff
                                          ? "Investigating handed-over evidence"
                                          : "Running assigned workflow"
                                        : run.status === "completed"
                                          ? "Assignment evidence ready"
                                          : run.status === "failed"
                                            ? "Assignment needs attention"
                                            : "Task queued",
                                  at:
                                    run.finishedAt ??
                                    run.startedAt ??
                                    run.queuedAt,
                                  runId: run.id,
                                  handoff: Boolean(handoff),
                                  handoffAt: handoff?.createdAt,
                                }
                              : handoff
                                ? {
                                    text: "Evidence received",
                                    at: handoff.createdAt,
                                    handoff: true,
                                    handoffAt: handoff.createdAt,
                                  }
                                : undefined;
                          return [p.id, event] as const;
                        })
                        .filter(
                          (
                            entry,
                          ): entry is [
                            string,
                            NonNullable<(typeof entry)[1]>,
                          ] => Boolean(entry[1]),
                        ),
                    )
              }
              selectedId={selected?.id}
              onSelect={setSelectedId}
              statuses={Object.fromEntries(
                office.personas.map((p) => [
                  p.id,
                  status(
                    p,
                    office.missions.find((m) => m.personaId === p.id),
                    state.runs,
                    office.findings,
                  ),
                ]),
              )}
            />
          )}
          {office.personas.length === 0 ? (
            <div className="office-empty">
              <div className="office-empty-avatar">
                <PersonaAvatar avatar="robot" color="amber" />
              </div>
              <div className="office-eyebrow">A DESK IS WAITING</div>
              <h2>Your first teammate starts here.</h2>
              <p>
                Choose a responsibility, assign installed agents, and decide
                when the work should run.
              </p>
              {state.tenants.length === 0 ? (
                <Link to="/settings/tenants">
                  Connect a tenant to get started →
                </Link>
              ) : state.installedAgents.length === 0 ? (
                <Link to="/agents/hub">Install an agent from the Hub →</Link>
              ) : (
                <Button onClick={() => setEditing("new")}>
                  Create your first persona
                </Button>
              )}
            </div>
          ) : view === "list" ? (
            <div className="office-stations">
              {office.personas.map((p) => {
                const m = office.missions.find((m) => m.personaId === p.id);
                const label = status(p, m, state.runs, office.findings);
                const current = state.runs.find(
                  (r) => m?.runIds.includes(r.id) && isActive(r),
                );
                return (
                  <button
                    key={p.id}
                    className={`office-station ${label === "Working" ? "is-working" : ""}`}
                    aria-pressed={selected?.id === p.id}
                    aria-label={`${p.name}, ${label}`}
                    onClick={() => setSelectedId(p.id)}
                  >
                    <span
                      className={`office-station-status ${label === "Needs approval" || label === "Needs attention" ? "attention" : ""}`}
                    >
                      {label}
                    </span>
                    <span className="office-desk-scene">
                      <span className="office-chair" />
                      <PersonaAvatar avatar={p.avatar} color={p.color} />
                      <span className="office-desk">
                        <span className="office-monitor">
                          <i />
                          <i />
                          <i />
                        </span>
                        <span className="office-keyboard" />
                        <span className="office-mug" />
                      </span>
                    </span>
                    <strong>{p.name}</strong>
                    <span className="office-station-task">
                      {current
                        ? (state.installedAgents.find(
                            (a) => a.slug === current.agentSlug,
                          )?.name ?? current.agentSlug)
                        : p.responsibility}
                    </span>
                    <span className="office-station-tenant">
                      {state.tenants.find((t) => t.id === p.tenantId)
                        ?.displayName ?? "Tenant disconnected"}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
          <footer className="office-room-footer">
            <span>
              {view === "list"
                ? "Status reflects actual agent runs."
                : "Desks: working · Lounge & games: idle"}
            </span>
            <span>Stored on this device</span>
          </footer>
        </section>
        <aside className="office-panel" aria-label="Assignment details">
          {selected ? (
            <>
              <div className="office-persona-heading">
                <PersonaAvatar
                  avatar={selected.avatar}
                  color={selected.color}
                />
                <div>
                  <div className="office-eyebrow">ASSIGNMENT</div>
                  <h2>{selected.name}</h2>
                </div>
              </div>
              <p className="office-responsibility">{selected.responsibility}</p>
              <dl className="office-facts">
                <div>
                  <dt>Tenant</dt>
                  <dd>
                    {state.tenants.find((t) => t.id === selected.tenantId)
                      ?.displayName ?? "Disconnected"}
                  </dd>
                </div>
                <div>
                  <dt>Provider</dt>
                  <dd>
                    {state.providers.find((p) => p.id === selected.providerId)
                      ?.name ?? selected.providerId}{" "}
                    ·{" "}
                    {state.providers.find((p) => p.id === selected.providerId)
                      ?.isLocal
                      ? "Local"
                      : "Hosted"}
                  </dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{selected.model ?? "Provider default"}</dd>
                </div>
                <div>
                  <dt>Next run</dt>
                  <dd>
                    {selected.nextRunAt
                      ? date(selected.nextRunAt)
                      : selected.enabled
                        ? selected.watch
                          ? "Watching local findings"
                          : "Manual only"
                        : "Paused"}
                  </dd>
                </div>
                <div>
                  <dt>Last completed</dt>
                  <dd>
                    {date(
                      selectedMissions.find((m) => m.status === "completed")
                        ?.finishedAt,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Time budget</dt>
                  <dd>{selected.maxMinutes} minutes</dd>
                </div>
              </dl>
              <p className="office-footnote">
                {mission
                  ? `${mission.status.replaceAll("-", " ")} · ${Math.round((mission.executionMs ?? 0) / 1000)}s execution used`
                  : "No assignment has run yet."}
                {mission?.approvalExpiresAt
                  ? ` · Approval expires ${date(mission.approvalExpiresAt)}`
                  : ""}
                {selected.lastMissedAt
                  ? ` · One overdue check was coalesced after ${date(selected.lastMissedAt)}`
                  : ""}
              </p>
              <p className="office-footnote">
                {mission?.planningReason}{" "}
                {mission?.skippedAgentSlugs?.length
                  ? `Skipped: ${mission.skippedAgentSlugs.join(", ")}.`
                  : ""}
              </p>
              <p className="office-footnote">
                One team workflow executes at a time.{" "}
                {mission?.status === "queued"
                  ? `Queue position ${
                      office.missions
                        .filter((m) => m.status === "queued")
                        .reverse()
                        .findIndex((m) => m.id === mission.id) + 1
                    }.`
                  : ""}
                {selected.calendar
                  ? ` ${selected.calendar.time} · ${selected.calendar.timeZone}.`
                  : ""}
                {selected.quietHours
                  ? ` Quiet hours ${selected.quietHours.start}:00–${selected.quietHours.end}:00 (${selected.quietHours.timeZone}).`
                  : ""}{" "}
                Missed checks run once after wake, outside quiet hours. Token
                usage is available in source runs; monetary cost is unavailable.
              </p>
              <div className="office-actions">
                <Button
                  variant="primary"
                  disabled={
                    busy ||
                    !selected.enabled ||
                    [
                      "queued",
                      "running",
                      "executing",
                      "awaiting-review",
                    ].includes(mission?.status ?? "")
                  }
                  onClick={() =>
                    void act(() => api!.startOfficePersona!(selected.id))
                  }
                >
                  Run assignment
                </Button>
                <Button
                  disabled={
                    busy ||
                    [
                      "queued",
                      "running",
                      "executing",
                      "awaiting-review",
                    ].includes(mission?.status ?? "")
                  }
                  onClick={() => setEditing(selected)}
                >
                  Edit
                </Button>
                <Button
                  disabled={
                    busy || (!selected.enabled && mission?.status !== "running")
                  }
                  onClick={() =>
                    void act(() => api!.stopOfficePersona!(selected.id))
                  }
                >
                  Stop & pause
                </Button>
              </div>
              {selected.lastError && (
                <p className="office-error" role="alert">
                  {selected.lastError}
                </p>
              )}
              <h3>
                Work order <span>{selected.agentSlugs.length} steps</span>
              </h3>
              <ol className="office-work-order">
                {selected.agentSlugs.map((slug, i) => {
                  const run = state.runs.find(
                    (r) =>
                      mission?.runIds.includes(r.id) && r.office?.step === i,
                  );
                  const agent = state.installedAgents.find(
                    (a) => a.slug === slug,
                  );
                  return (
                    <li key={slug}>
                      <span className="office-step-number">{i + 1}</span>
                      <div>
                        <strong>{agent?.name ?? slug}</strong>
                        <small>
                          {run?.status.replaceAll("-", " ") ?? "Not started"}
                          {agent?.mode === "write"
                            ? " · Approval required"
                            : ""}
                        </small>
                        {run && (
                          <Link to={`/runs/${run.id}`}>
                            {run.status === "awaiting-confirmation"
                              ? "Review proposed changes →"
                              : "View evidence →"}
                          </Link>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
              <p className="office-footnote">
                Agents run in this order. The next step waits for success and
                any required approval. Configure each workflow on its agent
                page.
              </p>
              <Button
                size="sm"
                variant="ghost"
                disabled={
                  busy ||
                  [
                    "queued",
                    "running",
                    "executing",
                    "awaiting-review",
                  ].includes(mission?.status ?? "")
                }
                onClick={() => setRemoveId(selected.id)}
              >
                Remove persona
              </Button>
            </>
          ) : (
            <div className="office-panel-empty">
              <div className="office-eyebrow">HOW IT WORKS</div>
              <h2>A small team. Clear responsibilities.</h2>
              <ol>
                <li>Give a persona a name and avatar.</li>
                <li>Choose its tenant and provider.</li>
                <li>Assign up to eight installed agents.</li>
                <li>Run once or set a recurring schedule.</li>
              </ol>
              <p>
                A Chief of Staff can coordinate an ordered set of checks. Every
                result remains linked to its source run.
              </p>
            </div>
          )}
        </aside>
      </div>
      {selected && (!expanded || showDetails) && (
        <PersonaConversation
          key={selected.id}
          persona={selected}
          state={state}
          act={act}
          busy={busy}
        />
      )}
      <section className="office-briefing" aria-label="Team briefing">
        <div className="office-briefing-title">
          <div>
            <div className="office-eyebrow">THE WORK, WITH EVIDENCE</div>
            <h2>Assignment history</h2>
          </div>
          <label className="team-search">
            Search assignments
            <input
              value={historyQuery}
              onChange={(e) => setHistoryQuery(e.target.value)}
              placeholder="Persona, status, or task…"
            />
          </label>
        </div>
        {office.missions.length === 0 ? (
          <p className="office-briefing-empty">
            Completed work, failed checks, and approval requests will appear
            here after your first assignment.
          </p>
        ) : (
          <div className="office-briefing-grid">
            {office.missions
              .filter((m) =>
                `${m.personaName} ${m.status} ${m.agentSlugs.join(" ")}`
                  .toLowerCase()
                  .includes(historyQuery.toLowerCase()),
              )
              .map((m) => (
                <article key={m.id} className="office-briefing-entry">
                  <div>
                    <strong>{m.personaName}</strong>
                    <span>{m.status}</span>
                  </div>
                  <small>
                    {state.tenants.find((t) => t.id === m.tenantId)
                      ?.displayName ?? "Disconnected tenant"}{" "}
                    · {date(m.startedAt)}
                  </small>
                  {m.error && <p className="office-error">{m.error}</p>}
                  {m.runIds.map((id) => {
                    const r = state.runs.find((r) => r.id === id);
                    return r ? (
                      <div className="office-evidence" key={id}>
                        <Link to={`/runs/${id}`}>
                          {state.installedAgents.find(
                            (a) => a.slug === r.agentSlug,
                          )?.name ?? r.agentSlug}{" "}
                          →
                        </Link>
                        <span>
                          {r.status.replaceAll("-", " ")}
                          {r.changeState ? ` · ${r.changeState} findings` : ""}
                        </span>
                        <p>
                          {r.error ??
                            r.summary ??
                            (isActive(r)
                              ? "Work is in progress. Open the run for live steps."
                              : "Open the run to inspect its output.")}
                        </p>
                      </div>
                    ) : (
                      <p key={id}>Run removed by history retention.</p>
                    );
                  })}
                  {m.runIds.length === 0 && (
                    <p>
                      {[
                        "queued",
                        "running",
                        "executing",
                        "awaiting-review",
                      ].includes(m.status)
                        ? "Waiting for an available execution slot."
                        : "No agent runs were started."}
                    </p>
                  )}
                </article>
              ))}
          </div>
        )}
      </section>
      <p className="office-availability">
        Schedules require this computer and a signed-in user session.{" "}
        <Link to="/settings/general">Check background scheduler settings</Link>.
        Hosted providers receive the assigned tenant context. Writes always wait
        for approval.
      </p>
      {editing && (
        <PersonaEditor
          persona={editing === "new" ? undefined : editing}
          state={state}
          busy={busy}
          error={error}
          onClose={() => {
            if (!busy) {
              setEditing(undefined);
              setError("");
            }
          }}
          onSave={async (input) => {
            if (await act(() => api!.saveOfficePersona!(input)))
              setEditing(undefined);
          }}
        />
      )}
      <Modal
        open={Boolean(removeId)}
        onClose={() => {
          if (!busy) setRemoveId(undefined);
        }}
        ariaLabel="Remove persona"
      >
        <ModalHeader
          title="Remove this persona?"
          onClose={() => {
            if (!busy) setRemoveId(undefined);
          }}
        />
        <div className="office-modal-content">
          <p>
            This removes its assignment and Team briefings. Agent run history
            remains available in Activity.
          </p>
          <div className="office-actions">
            <Button disabled={busy} onClick={() => setRemoveId(undefined)}>
              Keep persona
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  if (await act(() => api!.deleteOfficePersona!(removeId!)))
                    setRemoveId(undefined);
                })()
              }
            >
              Remove persona
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function PersonaEditor({
  persona,
  state,
  busy,
  error,
  onClose,
  onSave,
}: {
  persona?: OfficePersona;
  state: AppState;
  busy: boolean;
  error: string;
  onClose(): void;
  onSave(input: OfficePersonaInput): Promise<void>;
}) {
  const { registryAgents, refreshRegistry } = useAppState();
  const { openSetup } = useSetupFlow();
  const [catalogError, setCatalogError] = useState("");
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [installingWorkflow, setInstallingWorkflow] = useState<RegistryAgentSummary>();
  const [startingRole, setStartingRole] = useState<string>(TEAM_ROLES[0].name);
  const roleDefaults = (role: (typeof TEAM_ROLES)[number]): Partial<OfficePersonaInput> => ({
    name: role.name,
    responsibility: role.description,
    avatar: role.avatar,
    color: role.color,
    agentSlugs: [...role.slugs],
    intervalMinutes: role.name === "Policy Watcher" ? 60 : null,
    assessment: "metric" in role ? { metricPath: role.metric, threshold: 1 } : undefined,
    planning: role.name === "Chief of Staff" ? "on-change" : "ordered",
  });
  const [form, setForm] = useState<OfficePersonaInput>(() => ({
    name: TEAM_ROLES[0].name,
    responsibility: TEAM_ROLES[0].description,
    avatar: TEAM_ROLES[0].avatar,
    color: TEAM_ROLES[0].color,
    tenantId: state.activeTenantId ?? state.tenants[0]?.id ?? "",
    providerId: state.activeProviderId,
    model: persona
      ? persona.model
      : state.providers
            .find((p) => p.id === state.activeProviderId)
            ?.models.includes(
              state.activeModelByProviderId?.[state.activeProviderId] ?? "",
            )
        ? state.activeModelByProviderId?.[state.activeProviderId]
        : undefined,
    agentSlugs: [],
    intervalMinutes: null,
    maxMinutes: 30,
    enabled: true,
    ...(persona ? {} : roleDefaults(TEAM_ROLES[0])),
    ...persona,
    confirmHosted: false,
  }));
  useEffect(() => {
    if (!form.tenantId && state.activeTenantId) {
      setForm((f) => ({ ...f, tenantId: state.activeTenantId! }));
    }
  }, [form.tenantId, state.activeTenantId]);
  const refreshWorkflows = async () => {
    setRefreshingCatalog(true);
    setCatalogError("");
    try { await refreshRegistry(); }
    catch (e) { setCatalogError(e instanceof Error ? e.message : String(e)); }
    finally { setRefreshingCatalog(false); }
  };
  const provider = state.providers.find((p) => p.id === form.providerId);
  const missingWorkflows = form.agentSlugs.filter((slug) => !state.installedAgents.some((a) => a.slug === slug));
  const executionKeys = [
    "tenantId",
    "providerId",
    "model",
    "agentSlugs",
    "intervalMinutes",
    "maxMinutes",
    "approvalMinutes",
    "enabled",
    "instructions",
    "planning",
    "watch",
    "assessment",
    "calendar",
    "quietHours",
  ] as const;
  const cosmeticOnly = Boolean(
    persona &&
    executionKeys.every(
      (k) => JSON.stringify(form[k]) === JSON.stringify(persona[k]),
    ) &&
    ["name", "responsibility", "avatar", "color"].some(
      (k) =>
        form[k as keyof OfficePersonaInput] !==
        persona[k as keyof OfficePersona],
    ),
  );
  const change = <K extends keyof OfficePersonaInput>(
    key: K,
    value: OfficePersonaInput[K],
  ) => setForm((f) => ({ ...f, [key]: value }));
  const toggleAgent = (slug: string) =>
    change(
      "agentSlugs",
      form.agentSlugs.includes(slug)
        ? form.agentSlugs.filter((s) => s !== slug)
        : [...form.agentSlugs, slug],
    );
  const move = (index: number, delta: number) => {
    const order = [...form.agentSlugs];
    [order[index], order[index + delta]] = [order[index + delta], order[index]];
    change("agentSlugs", order);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void onSave(form);
  };
  return (
    <>
    <Modal
      open
      onClose={onClose}
      ariaLabel={persona ? "Edit persona" : "Create persona"}
    >
      <ModalHeader
        onClose={onClose}
        title={persona ? "Edit persona" : "Create a persona"}
        subtitle="A persistent responsibility, backed by installed agent workflows."
      />
      <form onSubmit={submit} className="office-editor" autoComplete="off">
        <fieldset disabled={busy}>
          {!persona && (
            <div className="office-presets" aria-label="Starting roles">
              {TEAM_ROLES.map((role) => (
                <button
                  key={role.name}
                  type="button"
                  aria-pressed={startingRole === role.name}
                  onClick={() => {
                    setStartingRole(role.name);
                    setForm((f) => ({ ...f, ...roleDefaults(role) }));
                  }}
                >
                  {role.name}
                </button>
              ))}
            </div>
          )}
          <div className="office-form-row">
            <label>
              Name
              <input
                required
                maxLength={60}
                value={form.name}
                onChange={(e) => change("name", e.target.value)}
              />
            </label>
            <label>
              Avatar
              <select
                value={form.avatar}
                onChange={(e) =>
                  change("avatar", e.target.value as OfficePersona["avatar"])
                }
              >
                <option value="robot">Robot</option>
                <option value="cat">Cat</option>
                <option value="fox">Fox</option>
                <option value="owl">Owl</option>
              </select>
            </label>
            <label>
              Color
              <select
                value={form.color}
                onChange={(e) =>
                  change("color", e.target.value as OfficePersona["color"])
                }
              >
                <option value="amber">Amber</option>
                <option value="sage">Sage</option>
                <option value="blue">Blue</option>
                <option value="lilac">Lilac</option>
              </select>
            </label>
          </div>
          <label>
            Responsibility
            <textarea
              required
              maxLength={400}
              rows={2}
              value={form.responsibility}
              onChange={(e) => change("responsibility", e.target.value)}
            />
            <small>
              A description for your team. The workflows below define what
              actually runs.
            </small>
          </label>
          <div className="office-form-row">
            <label>
              Tenant
              <select
                required
                value={form.tenantId}
                onChange={(e) => change("tenantId", e.target.value)}
              >
                <option value="" disabled>
                  Choose tenant
                </option>
                {state.tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Provider
              <select
                value={form.providerId}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    providerId: e.target.value as OfficePersona["providerId"],
                    model: undefined,
                    confirmHosted: false,
                  }))
                }
              >
                {state.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.isLocal ? "Local" : "Hosted"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Model
            <select
              value={form.model ?? ""}
              onChange={(e) => change("model", e.target.value || undefined)}
            >
              <option value="">Provider default</option>
              {form.model && !provider?.models.includes(form.model) && (
                <option value={form.model}>{form.model} · unavailable</option>
              )}
              {provider?.models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <div className="office-agent-picker">
            <h3>
              Assign installed agents <span>{form.agentSlugs.length}/8</span>
            </h3>
            <p>
              Select workflows in execution order. Agent settings and delivery
              rules apply.
            </p>
            {missingWorkflows.length > 0 && (
              <div role="status">
                <p className="office-error">Install the missing workflows below or remove them from this assignment before saving.</p>
                {missingWorkflows.map((slug) => {
                  const agent = registryAgents.find((a) => a.slug === slug);
                  return <div key={slug}>
                    <label className="office-check">
                      <input type="checkbox" checked onChange={() => toggleAgent(slug)} />
                      <span>{agent?.name ?? slug}<small>Not installed</small></span>
                    </label>
                    {agent ? <Button type="button" size="sm" onClick={() => setInstallingWorkflow(agent)}>Review and install {agent.name}</Button>
                      : <p>Unavailable in the current catalog. Refresh available workflows below to retry.</p>}
                  </div>;
                })}
              </div>
            )}
            <details>
              <summary>Browse available workflows</summary>
              {registryAgents.filter((a) => !state.installedAgents.some((installed) => installed.slug === a.slug) && !missingWorkflows.includes(a.slug)).map((a) => (
                <div key={a.slug}><Button type="button" size="sm" onClick={() => setInstallingWorkflow(a)}>Review and install {a.name}</Button></div>
              ))}
              {registryAgents.length === 0 && <p>No catalog available. Refresh available workflows to retry.</p>}
            </details>
            <Button type="button" size="sm" disabled={refreshingCatalog} onClick={() => void refreshWorkflows()}>{refreshingCatalog ? "Refreshing workflows…" : "Refresh available workflows"}</Button>
            {(catalogError || state.registryRefreshError) && <p role="alert" className="office-error">{catalogError || state.registryRefreshError} Refresh available workflows to retry.</p>}
            {state.installedAgents.map((a) => (
              <label className="office-check" key={a.slug}>
                <input
                  type="checkbox"
                  checked={form.agentSlugs.includes(a.slug)}
                  disabled={
                    !form.agentSlugs.includes(a.slug) &&
                    form.agentSlugs.length === 8
                  }
                  onChange={() => toggleAgent(a.slug)}
                />
                <span>
                  {a.name}
                  <small>
                    {a.mode === "write"
                      ? "Writes · Requires approval"
                      : "Reads"}
                  </small>
                </span>
              </label>
            ))}
          </div>
          {form.agentSlugs.length > 1 && (
            <ol className="office-reorder" aria-label="Execution order">
              {form.agentSlugs.map((slug, i) => (
                <li key={slug}>
                  <span>
                    {i + 1}.{" "}
                    {state.installedAgents.find((a) => a.slug === slug)?.name ??
                      slug}
                  </span>
                  <button
                    type="button"
                    disabled={i === 0}
                    aria-label={`Move ${slug} earlier`}
                    onClick={() => move(i, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={i === form.agentSlugs.length - 1}
                    aria-label={`Move ${slug} later`}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="office-form-row">
            <label>
              Schedule
              <select
                value={form.intervalMinutes ?? "manual"}
                onChange={(e) =>
                  change(
                    "intervalMinutes",
                    e.target.value === "manual" ? null : Number(e.target.value),
                  )
                }
              >
                <option value="manual">Manual only</option>
                <option value="5">Every 5 minutes</option>
                <option value="15">Every 15 minutes</option>
                <option value="60">Every hour</option>
                <option value="360">Every 6 hours</option>
                <option value="1440">Every day</option>
                <option value="10080">Every week</option>
              </select>
            </label>
            <label>
              Time budget (minutes)
              <input
                type="number"
                min={5}
                max={120}
                required
                value={form.maxMinutes}
                onChange={(e) => change("maxMinutes", Number(e.target.value))}
              />
            </label>
          </div>
          <PersonaOptions form={form} change={change} state={state} />
          <label className="office-check">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => change("enabled", e.target.checked)}
            />
            <span>
              Enable this persona
              <small>
                Schedules begin at the next interval or calendar slot. Event
                triggers watch completed findings.
              </small>
            </span>
          </label>
          {!provider?.isLocal && (
            <label className="office-check office-hosted">
              <input
                type="checkbox"
                checked={form.confirmHosted === true}
                required={!cosmeticOnly}
                onChange={(e) => change("confirmHosted", e.target.checked)}
              />
              <span>
                I approve sending context from{" "}
                {state.tenants.find((t) => t.id === form.tenantId)
                  ?.displayName ?? "the selected tenant"}{" "}
                to {provider?.name ?? "this provider"}, including watched
                evidence, planning, and persona questions.
                <small>
                  This applies to manual and scheduled assignments until the
                  persona or provider configuration changes.
                </small>
              </span>
            </label>
          )}
          {error && (
            <p className="office-error" role="alert">
              {error}
            </p>
          )}
          {!form.tenantId && <div><p role="status">Connect a tenant before deploying this persona. Your draft stays open during setup.</p><Button type="button" onClick={openSetup}>Connect tenant</Button></div>}
          {provider && provider.status !== "connected" && !(provider.id === "azure-openai" && provider.status === "available") && <p role="status">{provider.detail} Choose an available provider or configure it in Settings before deploying.</p>}
          <div className="office-actions">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                !form.agentSlugs.length ||
                (!cosmeticOnly && missingWorkflows.length > 0) ||
                !form.tenantId ||
                !provider ||
                (!persona &&
                  !(
                    provider.status === "connected" ||
                    (provider.id === "azure-openai" &&
                      provider.status === "available")
                  ))
              }
            >
              {busy ? "Saving…" : "Save persona"}
            </Button>
          </div>
        </fieldset>
      </form>
    </Modal>
    {installingWorkflow && <PersonaWorkflowInstall key={installingWorkflow.slug} agent={installingWorkflow} tenantId={form.tenantId} onClose={() => setInstallingWorkflow(undefined)} />}
    </>
  );
}
