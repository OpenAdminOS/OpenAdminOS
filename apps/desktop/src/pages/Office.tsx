import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type {
  OfficeMission,
  OfficeFinding,
  OfficePersona,
  RunRecord,
} from "../shared/openAdminOS";
import { useAppState } from "../state";
import { Button } from "../components/Button";
import { Modal, ModalHeader } from "../components/Modal";
import { OfficeScene, PersonaAvatar } from "../components/office/OfficeScene";
import "../styles/office.css";
import { PersonaEditor } from "../components/office/PersonaEditor";
import { useOfficeFullscreen } from "../components/office/useOfficeFullscreen";
import { TeamInbox, PersonaConversation } from "../components/office/TeamInbox";

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
  const fullscreen = useOfficeFullscreen();
  const [inboxOpen, setInboxOpen] = useState(false);
  const selectedId = params.get("persona");
  const view =
    !fullscreen.active && params.get("view") === "list" ? "list" : "room";
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
  const focusedOffice = expanded || fullscreen.active;
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
    <div
      className={`office-page ${focusedOffice ? "office-expanded" : ""} ${fullscreen.active ? "office-fullscreen" : ""}`}
    >
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
          Add teammate
        </Button>
      </header>
      {(error || stateError || office.error || fullscreen.error) && (
        <div className="office-error" role="alert">
          {error || stateError?.message || office.error || fullscreen.error}
          <Button size="sm" onClick={() => void act(refresh)}>
            Refresh team
          </Button>
        </div>
      )}
      {!fullscreen.active && (
        <div className="team-attention-summary">
          <span>
            <strong>{attention}</strong>{" "}
            {attention === 1 ? "teammate needs" : "teammates need"} attention ·{" "}
            <strong>{running}</strong> assignments in progress
          </span>
          <button type="button" onClick={() => setInboxOpen(true)}>
            Review inbox
          </button>
        </div>
      )}
      <Modal
        open={inboxOpen && !presentation}
        onClose={() => setInboxOpen(false)}
        size="lg"
        ariaLabel="Team briefing"
      >
        <ModalHeader
          title="Team briefing"
          subtitle="Approvals, findings and operational issues"
          onClose={() => setInboxOpen(false)}
        />
        <div className="team-inbox-dialog">
          <TeamInbox state={state} act={act} busy={busy} />
        </div>
      </Modal>
      <div className="office-toolbar">
        <div>
          <strong>{office.personas.length}</strong> teammates <span>·</span>{" "}
          <strong>{running}</strong> assignments in progress <span>·</span>{" "}
          <strong>{attention}</strong> need attention
        </div>
        <div className="office-view" aria-label="Team view">
          {fullscreen.active && !presentation && (
            <button onClick={() => setInboxOpen(true)}>Review inbox</button>
          )}
          <button
            aria-pressed={expanded}
            disabled={fullscreen.active}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Restore layout" : "Expand office"}
          </button>
          {focusedOffice && !presentation && (
            <button
              aria-pressed={showDetails}
              onClick={() => setShowDetails((v) => !v)}
            >
              {showDetails ? "Close assignment" : "Assignment details"}
            </button>
          )}
          <button
            disabled={fullscreen.pending}
            aria-pressed={fullscreen.active}
            onClick={() => void fullscreen.change(!fullscreen.active)}
          >
            {fullscreen.pending
              ? "Changing view…"
              : fullscreen.active
                ? "Exit full screen"
                : "Full screen"}
          </button>
          <button
            aria-pressed={presentation}
            onClick={() => {
              setPresentation((v) => !v);
              setView("room");
            }}
          >
            {presentation ? "Show details" : "Hide details"}
          </button>
          <button
            aria-pressed={view === "room"}
            onClick={() => setView("room")}
          >
            Office
          </button>
          <button
            aria-pressed={view === "list"}
            disabled={presentation || fullscreen.active}
            onClick={() => setView("list")}
          >
            List
          </button>
        </div>
      </div>
      <div className="office-layout">
        <section
          className={`office-room ${view === "list" ? "office-list" : ""}`}
          aria-label="Teammates"
        >
          {view === "room" && office.personas.length > 0 && (
            <OfficeScene
              immersive={fullscreen.active}
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
              <Button variant="primary" onClick={() => setEditing("new")}>
                Add your first teammate
              </Button>
              <ol className="team-empty-steps">
                <li>Choose a role</li>
                <li>Prepare its workspace</li>
                <li>Review its schedule</li>
              </ol>
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
        <aside
          className="office-panel"
          aria-label="Assignment details"
          hidden={presentation || (focusedOffice && !showDetails)}
        >
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
              {!mission && (
                <div className="team-first-result">
                  <strong>Your first result starts with an assignment.</strong>
                  <p>
                    {selected.nextRunAt
                      ? `Scheduled for ${date(selected.nextRunAt)}. You can also run it now.`
                      : "Run when ready. Completed work will link to its evidence below."}
                  </p>
                </div>
              )}
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
                  {mission ? "Run assignment" : "Run first assignment"}
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
                      mission?.runIds.includes(r.id) && r.agentSlug === slug,
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
                          {run?.status.replaceAll("-", " ") ??
                            (mission?.skippedAgentSlugs?.includes(slug)
                              ? "Skipped by assignment plan"
                              : "Not started")}
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
                Selected workflows run in assignment-plan order. Each next step
                waits for success and any required approval. Configure each
                workflow on its agent page.
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
                Remove teammate
              </Button>
            </>
          ) : (
            <div className="office-panel-empty">
              <div className="office-eyebrow">HOW IT WORKS</div>
              <h2>A small team. Clear responsibilities.</h2>
              <ol>
                <li>Choose a role for your first teammate.</li>
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
      {selected && !fullscreen.active && (!expanded || showDetails) && (
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
              placeholder="Teammate, status, or task…"
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
            let savedId = input.id;
            if (
              await act(async () => {
                const result = await api!.saveOfficePersona!(input);
                savedId ??= result.personas.find(
                  (p) =>
                    !office.personas.some((previous) => previous.id === p.id),
                )?.id;
              })
            ) {
              if (savedId) setSelectedId(savedId);
              setShowDetails(true);
              setEditing(undefined);
            }
          }}
        />
      )}
      <Modal
        open={Boolean(removeId)}
        onClose={() => {
          if (!busy) setRemoveId(undefined);
        }}
        ariaLabel="Remove teammate"
      >
        <ModalHeader
          title="Remove this teammate?"
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
              Keep teammate
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
              Remove teammate
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
