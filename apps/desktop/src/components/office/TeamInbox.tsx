import { useState } from "react";
import { Link } from "react-router";
import type {
  AppState,
  OfficeFinding,
  OfficePersona,
} from "../../shared/openAdminOS";
import { Button } from "../Button";

type Act = (action: () => Promise<unknown>) => Promise<unknown>;
export function TeamInbox({
  state,
  act,
  busy,
}: {
  state: AppState;
  act: Act;
  busy: boolean;
}) {
  const [tab, setTab] = useState("decisions");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const office = state.office;
  if (!office) return null;
  const approvals = state.runs.filter(
    (r) => r.office && r.status === "awaiting-confirmation",
  );
  const failures = office.personas.filter((p) => p.lastError);
  const findings = office.findings ?? [];
  const recent = office.missions.filter(
    (m) =>
      m.status === "completed" &&
      Date.now() - Date.parse(m.finishedAt ?? "") < 86400000,
  );
  const visible = findings.filter(
    (f) =>
      (tab === "history" ||
        (f.state === "open" && (kind === "all" || kind === "findings"))) &&
      `${f.title} ${f.summary} ${office.personas.find((p) => p.id === f.personaId)?.name ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const review = (f: OfficeFinding, next: OfficeFinding["state"]) =>
    void act(() =>
      window.openAdminOS!.reviewOfficeFinding!({
        id: f.id,
        state: next,
        ...(next === "snoozed" ? { snoozeMinutes: 1440 } : {}),
      }),
    );
  return (
    <section className="team-inbox" aria-label="Team action inbox">
      <header>
        <div>
          <div className="office-eyebrow">YOUR NEXT DECISION</div>
          <h2>Team briefing</h2>
        </div>
        <div className="office-view">
          <button
            aria-pressed={tab === "decisions"}
            onClick={() => setTab("decisions")}
          >
            Needs review (
            {approvals.length +
              failures.length +
              findings.filter((f) => f.state === "open").length}
            )
          </button>
          <button
            aria-pressed={tab === "history"}
            onClick={() => setTab("history")}
          >
            Finding history
          </button>
        </div>
      </header>
      <p className="team-day-summary">
        {recent.length} completed assignments in the past 24 hours ·{" "}
        {office.personas.filter((p) => p.enabled && p.nextRunAt).length}{" "}
        scheduled ·{" "}
        {
          office.personas.filter(
            (p) =>
              !office.missions.some(
                (m) => m.personaId === p.id && m.status === "completed",
              ),
          ).length
        }{" "}
        awaiting a first completed check
      </p>
      {tab === "decisions" && (
        <label className="team-inbox-filter">
          Show
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">All decisions</option>
            <option value="approvals">Approvals</option>
            <option value="findings">Findings</option>
            <option value="failures">Operational issues</option>
          </select>
        </label>
      )}
      {(findings.length > 0 || query) && (
        <label className="team-search">
          Search findings
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Teammate or finding…"
          />
        </label>
      )}
      <div className="team-inbox-grid">
        {tab === "decisions" &&
          (kind === "all" || kind === "approvals") &&
          approvals.map((r) => (
            <article key={r.id} className="team-decision">
              <span className="team-tag">Approval required</span>
              <h3>
                {office.personas.find((p) => p.id === r.office?.personaId)
                  ?.name ?? r.agentSlug}
              </h3>
              <p>
                {r.plan?.summary ??
                  "Review the proposed changes before applying."}
              </p>
              <Link to={`/runs/${r.id}`}>Review proposed changes →</Link>
            </article>
          ))}
        {tab === "decisions" &&
          (kind === "all" || kind === "failures") &&
          failures.map((p) => (
            <article key={p.id} className="team-decision">
              <span className="team-tag">Operational issue</span>
              <h3>{p.name}</h3>
              <p>{p.lastError}</p>
              <Link to={`/office?persona=${encodeURIComponent(p.id)}`}>
                Open assignment →
              </Link>
            </article>
          ))}
        {visible.slice(0, 50).map((f) => (
          <article key={f.id} className="team-decision">
            <span className="team-tag">
              {f.state} · {f.severity} · revision {f.revision}
            </span>
            <h3>{f.title}</h3>
            <p className="team-summary">{f.summary}</p>
            <details>
              <summary>Coverage and freshness</summary>
              <small>{f.coverage}</small>
              <small>
                Last checked {new Date(f.lastSeen).toLocaleString()} ·{" "}
                {state.tenants.find((t) => t.id === f.tenantId)?.displayName ??
                  "Disconnected"}
              </small>
            </details>
            <div className="team-evidence-links">
              {f.runIds.slice(0, 2).map((id, i) => (
                <Link key={id} to={`/runs/${id}`}>
                  {i === 0 ? "Current evidence" : "Previous evidence"} →
                </Link>
              ))}
            </div>
            <div className="office-actions">
              {f.state !== "acknowledged" && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => review(f, "acknowledged")}
                >
                  Acknowledge
                </Button>
              )}
              {f.state !== "snoozed" && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => review(f, "snoozed")}
                >
                  Snooze 1 day
                </Button>
              )}
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  review(f, f.state === "resolved" ? "open" : "resolved")
                }
              >
                {f.state === "resolved" ? "Reopen" : "Resolve"}
              </Button>
            </div>
          </article>
        ))}
      </div>
      {visible.length === 0 &&
        (tab === "history" || (!approvals.length && !failures.length)) && (
          <p className="team-quiet">
            {findings.length
              ? "No findings need review. Scheduled checks and their evidence remain available below."
              : "No completed assessments yet. Schedule a teammate or run an assignment to establish evidence."}
          </p>
        )}
      {visible.length > 50 && (
        <p>Showing 50 of {visible.length} findings. Narrow the search.</p>
      )}
    </section>
  );
}
export function PersonaConversation({
  persona,
  state,
  act,
  busy,
}: {
  persona: OfficePersona;
  state: AppState;
  act: Act;
  busy: boolean;
}) {
  const [question, setQuestion] = useState("");
  const messages = (state.office?.messages ?? [])
    .filter((m) => m.personaId === persona.id)
    .slice(0, 20)
    .reverse();
  const handoffs = (state.office?.handoffs ?? [])
    .filter(
      (h) =>
        h.targetPersonaId === persona.id || h.sourcePersonaId === persona.id,
    )
    .slice(0, 5);
  return (
    <section className="team-chat" aria-label="Teammate conversation">
      <h3>Ask {persona.name}</h3>
      <p>
        Answers use this teammate’s completed evidence and assigned provider.
        Standing instructions and schedules change only through Edit.
      </p>
      <div className="team-messages" aria-live="polite">
        {messages.map((m) => (
          <article key={m.id}>
            <strong>{m.role === "user" ? "You" : persona.name}</strong>
            <p>{m.content}</p>
            {m.runIds.map((id) => (
              <Link key={id} to={`/runs/${id}`}>
                Evidence {id.slice(-6)} →{" "}
              </Link>
            ))}
          </article>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(() =>
            window.openAdminOS!.askOfficePersona!({ id: persona.id, question }),
          );
        }}
      >
        <label>
          Question
          <textarea
            maxLength={2000}
            required
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Why was this finding flagged?"
          />
        </label>
        <Button
          type="submit"
          disabled={
            busy || !question.trim() || !window.openAdminOS?.askOfficePersona
          }
        >
          {busy ? "Working…" : "Ask teammate"}
        </Button>
      </form>
      {handoffs.length > 0 && (
        <div className="team-handoffs">
          <h3>Handoffs</h3>
          {handoffs.map((h) => (
            <p key={h.id}>
              {h.reason}{" "}
              <Link
                to={`/office?persona=${encodeURIComponent(h.targetPersonaId)}`}
              >
                Open specialist →
              </Link>
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
