"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./ProductDemo.module.css";

const pages = [
  "Chat",
  "Agent Team",
  "Agents",
  "Changes",
  "Cache",
  "Settings",
  "Workspaces",
  "Connectors",
] as const;
type Page = (typeof pages)[number];
type DialogContent = { title: string; body: ReactNode; review?: boolean };
const devices = [
  {
    name: "WIN-LT-042",
    owner: "Alex Morgan",
    sync: "9 days ago",
    state: "Noncompliant",
  },
  {
    name: "WIN-LT-087",
    owner: "Sam Taylor",
    sync: "12 days ago",
    state: "Compliant",
  },
  {
    name: "WIN-DT-016",
    owner: "Unassigned",
    sync: "18 days ago",
    state: "Unknown",
  },
];
const agents = [
  {
    name: "Find inactive devices",
    description:
      "Review device inactivity with sync age, ownership, and compliance evidence.",
    scope: "DeviceManagementManagedDevices.Read.All",
    write: false,
  },
  {
    name: "Compliance overview",
    description: "Review compliance by state, operating system, and ownership.",
    scope: "DeviceManagementManagedDevices.Read.All",
    write: false,
  },
  {
    name: "Offboarding agent",
    description:
      "Prepare a device retirement proposal and review every target before approval.",
    scope: "DeviceManagementManagedDevices.PrivilegedOperations.All",
    write: true,
  },
];
const icons: Record<Page, string> = {
  Chat: "M4 4h16v12H9l-5 4V4m4 4h8m-8 4h5",
  "Agent Team":
    "M8 4h8v8H8zM4 20v-3a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v3M10 8h.01M14 8h.01",
  Agents: "m12 3 8 4v10l-8 4-8-4V7zM9 9h6v6H9z",
  Changes: "M6 3v18M18 3v5a4 4 0 0 1-4 4H6M3 5h6M15 5h6M3 19h6",
  Cache: "M4 6c0-4 16-4 16 0s-16 4-16 0v12c0 4 16 4 16 0V6M4 12c0 4 16 4 16 0",
  Settings:
    "M12 3v3m0 12v3M3 12h3m12 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
  Workspaces: "M3 7h7l2-3h9v16H3z",
  Connectors: "m8 3 4 4-5 5-4-4m13 13-4-4 5-5 4 4M9 15l6-6",
};
function Icon({ page }: { page: Page }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={icons[page]} />
    </svg>
  );
}
function Badge({
  children,
  amber = false,
}: {
  children: ReactNode;
  amber?: boolean;
}) {
  return (
    <span className={amber ? styles.amber : styles.badge}>{children}</span>
  );
}
function DeviceTable({ inspect }: { inspect?: (index: number) => void }) {
  return (
    <div className={styles.tableWrap}>
      <table>
        <caption className="sr-only">
          Synthetic devices with more than seven days since last sync
        </caption>
        <thead>
          <tr>
            <th scope="col">Device</th>
            <th scope="col">Owner</th>
            <th scope="col">Last sync</th>
            <th scope="col">Compliance</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d, i) => (
            <tr key={d.name}>
              <td>
                {inspect ? (
                  <button
                    className={styles.textButton}
                    onClick={() => inspect(i)}
                  >
                    {d.name} ↗
                  </button>
                ) : (
                  d.name
                )}
              </td>
              <td>{d.owner}</td>
              <td>{d.sync}</td>
              <td>{d.state}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A deterministic marketing simulation. Never imports desktop IPC, auth, Graph, or LLM clients. */
export function ProductDemo() {
  const [page, setPage] = useState<Page>("Chat");
  const [agentTab, setAgentTab] = useState("Installed");
  const [settingsTab, setSettingsTab] = useState("Providers");
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<DialogContent | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [approved, setApproved] = useState(false);
  const [proposal, setProposal] = useState(false);
  const [provider, setProvider] = useState("Ollama");
  const [question, setQuestion] = useState("stale");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [guided, setGuided] = useState(false);
  const [teammate, setTeammate] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [dark, setDark] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hosted = provider === "OpenAI";

  useEffect(() => {
    if (dialog && !dialogRef.current?.open) dialogRef.current?.showModal();
  }, [dialog]);

  function navigate(next: Page) {
    setPage(next);
    setNotice("");
    contentRef.current?.scrollTo({ top: 0 });
  }
  function info(title: string, body: ReactNode) {
    setDialog({ title, body });
  }
  function review() {
    setConfirmation("");
    setDialog({ title: "Review device retirement", review: true, body: null });
  }
  function closeDialog() {
    dialogRef.current?.close();
    setDialog(null);
  }
  function reset() {
    setPage("Chat");
    setAgentTab("Installed");
    setSettingsTab("Providers");
    setSearch("");
    setApproved(false);
    setProposal(false);
    setProvider("Ollama");
    setQuestion("stale");
    setDraft("");
    setNotice("Demo reset. All records are synthetic.");
    setGuided(false);
    setTeammate(false);
    setInstalled(false);
    setDark(false);
    contentRef.current?.scrollTo({ top: 0 });
  }
  function inspectDevice(index: number) {
    const device = devices[index]!;
    info(
      device.name,
      <>
        <p>Sample device record from the Contoso demo inventory.</p>
        <dl className={styles.record}>
          <dt>Owner</dt>
          <dd>{device.owner}</dd>
          <dt>Last sync</dt>
          <dd>{device.sync}</dd>
          <dt>Compliance</dt>
          <dd>{device.state}</dd>
          <dt>Source</dt>
          <dd>Intune managed devices</dd>
        </dl>
        <p>
          Inactivity alone is not a reason to retire a device. Confirm ownership
          and use before preparing an action.
        </p>
        <button
          className={styles.primary}
          onClick={() => {
            closeDialog();
            setProposal(true);
            navigate("Changes");
          }}
        >
          Prepare sample proposal
        </button>
      </>,
    );
  }
  const showSignIn = "Sign-in failure explainer"
    .toLowerCase()
    .includes(search.toLowerCase());
  const visibleAgents = agents.filter((a) =>
    `${a.name} ${a.description}`.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <section
      id="product-demo"
      className={`${styles.demo} ${dark ? styles.dark : ""}`}
      aria-label="Interactive OpenAdminOS product demo"
    >
      <div className={styles.demoBar}>
        <span>
          <span className={styles.liveDot} /> Interactive demo{" "}
          <span className={styles.muted}>· Synthetic data</span>
        </span>
        <div className={styles.actions}>
          <button
            onClick={() => {
              reset();
              setGuided(true);
            }}
          >
            Try a walkthrough
          </button>
          <button onClick={reset} aria-label="Reset interactive demo">
            Reset ↺
          </button>
        </div>
      </div>
      {guided && (
        <div className={styles.guide}>
          <span>
            <strong>{approved ? "3 / 3" : proposal ? "2 / 3" : "1 / 3"}</strong>{" "}
            {approved
              ? "Review complete. No tenant was changed."
              : proposal
                ? "Inspect the targets, then try typed confirmation."
                : "Start with the evidence. Select a device or prepare a proposal."}
          </span>
          <button
            onClick={() => setGuided(false)}
            aria-label="Close walkthrough"
          >
            ×
          </button>
        </div>
      )}
      <div className={styles.shell}>
        <aside className={styles.sidebar}>
          <div className={styles.logo}>
            <img src="/icon.svg" width="23" height="23" alt="" />
            <strong>OpenAdminOS</strong>
          </div>
          <button
            className={styles.tenant}
            onClick={() =>
              info(
                "Your active tenant",
                <>
                  <p>
                    <strong>Contoso IT</strong> is a fictional tenant for this
                    walkthrough.
                  </p>
                  <p>
                    The desktop app pins each investigation and proposed change
                    to an explicit tenant. Connecting your own tenant is
                    available in the desktop app.
                  </p>
                  <a href="/download">Get the desktop app ↗</a>
                </>,
              )
            }
          >
            <span className={styles.avatar}>CS</span>
            <span>
              <strong>Contoso IT</strong>
              <small>Sample tenant</small>
            </span>
            <span aria-hidden="true">⌄</span>
          </button>
          <p className={styles.navLabel}>Workspace</p>
          <nav aria-label="Demo screens">
            {pages.map((item, i) => (
              <button
                key={item}
                aria-current={page === item ? "page" : undefined}
                onClick={() => navigate(item)}
                className={i === 6 ? styles.more : undefined}
              >
                <Icon page={item} />
                <span>{item}</span>
                {item === "Changes" && proposal && !approved && (
                  <span className={styles.count}>1</span>
                )}
              </button>
            ))}
          </nav>
          <div className={styles.sideFoot}>
            <span className={styles.liveDot} /> Sample workspace
            <br />
            <span className={styles.muted}>
              Explore without connecting a tenant.
            </span>
          </div>
        </aside>
        <div className={styles.main}>
          <header className={styles.pageHeader}>
            <div>
              <span className={styles.eyebrow}>Contoso IT / Demo</span>
              <h2>{page === "Chat" ? "Devices needing attention" : page}</h2>
            </div>
            <Badge amber={hosted}>
              {provider} · {hosted ? "Hosted" : "Local"}
            </Badge>
          </header>
          <div
            ref={contentRef}
            className={styles.content}
            tabIndex={0}
            aria-label={`${page} demo content`}
          >
            <div key={page} className={styles.page}>
              {page === "Chat" && (
                <>
                  <div className={styles.chatQuestion}>
                    {question === "stale"
                      ? "Which Windows devices have not synced in the last 7 days?"
                      : "What should I check before retiring these devices?"}
                  </div>
                  <div className={styles.author}>
                    <img src="/icon.svg" width="22" height="22" alt="" />
                    <strong>OpenAdminOS</strong>
                    <span>Sample response · Read-only</span>
                  </div>
                  {question === "stale" ? (
                    <>
                      <h3>3 devices need a closer look.</h3>
                      <p>
                        These Windows devices last synced more than seven days
                        ago. Review their ownership and use before deciding what
                        to do next.
                      </p>
                      <div className={styles.metrics}>
                        <div>
                          <strong>128</strong>
                          <span>Windows devices</span>
                        </div>
                        <div>
                          <strong>3</strong>
                          <span>Over 7 days</span>
                        </div>
                        <div>
                          <strong>2.3%</strong>
                          <span>Of sample inventory</span>
                        </div>
                      </div>
                      <DeviceTable inspect={inspectDevice} />
                    </>
                  ) : (
                    <>
                      <h3>Check the context before making a change.</h3>
                      <ol className={styles.checklist}>
                        <li>
                          Confirm the device owner and whether the device is
                          still in use.
                        </li>
                        <li>
                          Compare Intune sync evidence with the relevant Entra
                          device record.
                        </li>
                        <li>
                          Check for leave, storage, repairs, or an expected
                          offline period.
                        </li>
                        <li>
                          Review the exact targets and effect of the proposed
                          operation.
                        </li>
                      </ol>
                      <p>
                        A stale sync time alone does not establish that
                        retirement is appropriate.
                      </p>
                    </>
                  )}
                  <details className={styles.evidence}>
                    <summary>Evidence and scope</summary>
                    <p>
                      Fictional snapshot: 128 Windows devices in Contoso IT,
                      filtered to last sync older than seven days. The three
                      rows above are synthetic examples, not live results.
                    </p>
                    <code>Intune managed devices · Entra devices</code>
                  </details>
                  <div className={styles.actions}>
                    <button
                      onClick={() =>
                        setQuestion(question === "stale" ? "review" : "stale")
                      }
                    >
                      {question === "stale"
                        ? "What should I check first?"
                        : "Show device results"}
                    </button>
                    <button
                      className={styles.primary}
                      onClick={() => {
                        setProposal(true);
                        navigate("Changes");
                      }}
                    >
                      Prepare sample proposal →
                    </button>
                  </div>
                  <form
                    className={styles.composer}
                    onSubmit={(e) => {
                      e.preventDefault();
                      setDraft("");
                      setQuestion("review");
                      setNotice(
                        "This demo uses scripted responses. Here is the sample follow-up; no model request was sent.",
                      );
                    }}
                  >
                    <label htmlFor="demo-question">Try a follow-up</label>
                    <input
                      id="demo-question"
                      name="demo-question"
                      autoComplete="off"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="What should I check before retirement?"
                      maxLength={300}
                    />
                    <div className={styles.composerFoot}>
                      <small>Scripted demo · No prompts are sent</small>
                      <button type="submit">Show sample answer ↑</button>
                    </div>
                  </form>
                </>
              )}
              {page === "Agent Team" && (
                <>
                  <div className={styles.actions}>
                    <p>
                      Give your agents a role, a workspace, and a
                      responsibility.
                    </p>
                    <button
                      className={styles.primary}
                      onClick={() => {
                        setTeammate(true);
                        setNotice(
                          "Sample teammate added for this visit. Nothing is scheduled.",
                        );
                      }}
                    >
                      Add sample teammate
                    </button>
                  </div>
                  <div className={styles.office}>
                    <div className={styles.officeDesk}>
                      <span className={styles.robot} aria-hidden="true">
                        ▣
                      </span>
                      <strong>Device specialist</strong>
                      <Badge>Evidence ready</Badge>
                      <button onClick={() => navigate("Chat")}>
                        Open investigation
                      </button>
                    </div>
                    <div className={styles.officeDesk}>
                      <span className={styles.robot} aria-hidden="true">
                        ▣
                      </span>
                      <strong>
                        {teammate ? "Compliance reviewer" : "A desk is waiting"}
                      </strong>
                      <span className={styles.muted}>
                        {teammate
                          ? "Ready for an assignment"
                          : "Add a teammate to explore"}
                      </span>
                      <button
                        onClick={() =>
                          teammate
                            ? info(
                                "Compliance reviewer",
                                <>
                                  <p>
                                    This sample teammate reviews device
                                    compliance evidence. In the desktop app,
                                    assign a tenant, provider, installed agents,
                                    and an optional schedule.
                                  </p>
                                  <button
                                    onClick={() => {
                                      closeDialog();
                                      navigate("Agents");
                                    }}
                                  >
                                    Browse agents
                                  </button>
                                </>,
                              )
                            : setTeammate(true)
                        }
                      >
                        {teammate ? "View assignment" : "Add teammate"}
                      </button>
                    </div>
                  </div>
                  <h3>Assignment history</h3>
                  <button
                    className={styles.listRow}
                    onClick={() => navigate("Chat")}
                  >
                    <span>
                      <strong>Review inactive Windows devices</strong>
                      <small>Device specialist · Contoso IT</small>
                    </span>
                    <Badge>Completed</Badge>
                    <span aria-hidden="true">↗</span>
                  </button>
                  <p className={styles.muted}>
                    Illustrative team state. Desktop schedules require the
                    computer and a signed-in session.
                  </p>
                </>
              )}
              {page === "Agents" && (
                <>
                  <div
                    className={styles.tabs}
                    role="group"
                    aria-label="Agent views"
                  >
                    {["Installed", "Hub", "Schedules", "Run history"].map(
                      (tab) => (
                        <button
                          key={tab}
                          aria-pressed={agentTab === tab}
                          onClick={() => {
                            setAgentTab(tab);
                            setSearch("");
                          }}
                        >
                          {tab}
                        </button>
                      ),
                    )}
                  </div>
                  {(agentTab === "Installed" || agentTab === "Hub") && (
                    <>
                      <div className={styles.actions}>
                        <label className={styles.search}>
                          <span className="sr-only">Search demo agents</span>
                          <input
                            type="search"
                            autoComplete="off"
                            name="demo-agent-search"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search sample agents…"
                          />
                        </label>
                        <span className={styles.muted}>
                          {agentTab === "Hub"
                            ? "Sample community catalog"
                            : `${3 + Number(installed)} installed · Demo`}
                        </span>
                      </div>
                      <div className={styles.cards}>
                        {visibleAgents.map((agent) => (
                          <article className={styles.card} key={agent.name}>
                            <div className={styles.actions}>
                              <Icon page="Agents" />
                              <Badge amber={agent.write}>
                                {agent.write
                                  ? "Approval required"
                                  : "Read-only"}
                              </Badge>
                            </div>
                            <h3>{agent.name}</h3>
                            <p>{agent.description}</p>
                            <div className={styles.actions}>
                              <button
                                onClick={() =>
                                  info(
                                    agent.name,
                                    <>
                                      <p>{agent.description}</p>
                                      <p>Example declared permission:</p>
                                      <code className={styles.scope}>
                                        {agent.scope}
                                      </code>
                                      <p>
                                        The desktop app shows the full manifest
                                        and required permissions before consent.
                                      </p>
                                      <button
                                        className={styles.primary}
                                        onClick={() => {
                                          closeDialog();
                                          if (agent.write) {
                                            setProposal(true);
                                            navigate("Changes");
                                          } else {
                                            setQuestion("stale");
                                            navigate("Chat");
                                          }
                                        }}
                                      >
                                        {agent.write
                                          ? "Preview proposal"
                                          : "Preview device investigation"}
                                      </button>
                                    </>,
                                  )
                                }
                              >
                                Details
                              </button>
                              <button
                                className={styles.primary}
                                onClick={() => {
                                  if (agent.write) {
                                    setProposal(true);
                                    navigate("Changes");
                                  } else {
                                    setQuestion("stale");
                                    navigate("Chat");
                                  }
                                }}
                              >
                                {agent.write
                                  ? "Prepare proposal"
                                  : "Preview sample run"}
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                      {visibleAgents.length === 0 &&
                        !(showSignIn && (agentTab === "Hub" || installed)) && (
                          <p role="status">
                            No matching sample agents. Try “device” or clear
                            your search.
                          </p>
                        )}
                      {agentTab === "Hub" && showSignIn && (
                        <article className={styles.card}>
                          <h3>Sign-in failure explainer</h3>
                          <p>
                            Trace a failed sign-in to its evidence and policy
                            context.
                          </p>
                          <button
                            onClick={() => {
                              setInstalled(true);
                              setNotice(
                                "Added to this demo catalog only. No files were installed.",
                              );
                            }}
                            disabled={installed}
                          >
                            {installed ? "Added to demo" : "Add to demo"}
                          </button>
                        </article>
                      )}
                      {agentTab === "Installed" && installed && showSignIn && (
                        <article className={styles.card}>
                          <h3>Sign-in failure explainer</h3>
                          <p>Added during this demo visit.</p>
                          <button
                            onClick={() =>
                              info(
                                "Sign-in failure explainer",
                                <p>
                                  The desktop agent brings together sign-in and
                                  policy evidence. This demo includes the device
                                  investigation only.
                                </p>,
                              )
                            }
                          >
                            View details
                          </button>
                        </article>
                      )}
                    </>
                  )}
                  {agentTab === "Schedules" && (
                    <>
                      <h3>Your recurring work</h3>
                      <article className={styles.card}>
                        <Badge>Example schedule</Badge>
                        <h3>Weekly device review</h3>
                        <p>Device specialist · Mondays at 09:00 · Contoso IT</p>
                        <button
                          onClick={() =>
                            info(
                              "Weekly device review",
                              <>
                                <p>
                                  Example configuration: run Find inactive
                                  devices weekly with a local provider. The
                                  desktop app requires the computer and a
                                  signed-in session to run a schedule.
                                </p>
                                <p>
                                  No background work is scheduled by this demo.
                                </p>
                              </>,
                            )
                          }
                        >
                          Inspect schedule
                        </button>
                      </article>
                    </>
                  )}
                  {agentTab === "Run history" && (
                    <>
                      <h3>Recent sample runs</h3>
                      <button
                        className={styles.listRow}
                        onClick={() => {
                          setQuestion("stale");
                          navigate("Chat");
                        }}
                      >
                        <span>
                          <strong>Find inactive devices</strong>
                          <small>3 findings · Contoso IT · Sample run</small>
                        </span>
                        <Badge>Completed</Badge>
                      </button>
                      {approved && (
                        <button
                          className={styles.listRow}
                          onClick={() => navigate("Changes")}
                        >
                          <span>
                            <strong>Device retirement review</strong>
                            <small>
                              Confirmation simulated · No operation sent
                            </small>
                          </span>
                          <Badge>Demo complete</Badge>
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
              {page === "Changes" && (
                <>
                  <p>Every proposed tenant change waits for your review.</p>
                  {proposal ? (
                    <article className={styles.card}>
                      <div className={styles.actions}>
                        <h3>Retire 3 Windows devices</h3>
                        <Badge amber={!approved}>
                          {approved ? "Demo complete" : "Awaiting review"}
                        </Badge>
                      </div>
                      <p>Contoso IT · Offboarding agent · Synthetic proposal</p>
                      <DeviceTable inspect={inspectDevice} />
                      <p>
                        {approved
                          ? "You completed the confirmation example. No devices were retired and no request was sent."
                          : "Review ownership, evidence, targets, and the proposed operation before approving."}
                      </p>
                      <div className={styles.actions}>
                        <button className={styles.primary} onClick={review}>
                          {approved ? "Replay confirmation" : "Review proposal"}
                        </button>
                        {approved && (
                          <button
                            onClick={() => {
                              setAgentTab("Run history");
                              navigate("Agents");
                            }}
                          >
                            View sample run history →
                          </button>
                        )}
                      </div>
                    </article>
                  ) : (
                    <div className={styles.empty}>
                      <Icon page="Changes" />
                      <h3>No sample proposal yet.</h3>
                      <p>
                        Start with the device evidence, then prepare a change
                        for review.
                      </p>
                      <button
                        onClick={() => {
                          setProposal(true);
                        }}
                      >
                        Load sample proposal
                      </button>
                    </div>
                  )}
                  <div className={styles.notice}>
                    Demo only. No tenant is connected and no changes can be
                    applied.
                  </div>
                </>
              )}
              {page === "Cache" && (
                <>
                  <p>Inspect the evidence an investigation uses.</p>
                  <div className={styles.metrics}>
                    <div>
                      <strong>128</strong>
                      <span>Windows devices</span>
                    </div>
                    <div>
                      <strong>3</strong>
                      <span>Inactive examples</span>
                    </div>
                    <div>
                      <strong>Local</strong>
                      <span>Sample snapshot</span>
                    </div>
                  </div>
                  <DeviceTable inspect={inspectDevice} />
                  <button
                    onClick={() =>
                      setNotice(
                        "Sample snapshot refreshed. The same synthetic records are shown; Microsoft Graph was not contacted.",
                      )
                    }
                  >
                    Refresh sample snapshot
                  </button>
                </>
              )}
              {page === "Settings" && (
                <>
                  <div
                    className={styles.tabs}
                    role="group"
                    aria-label="Demo settings"
                  >
                    {["Providers", "Appearance", "Tenants", "Privacy"].map(
                      (tab) => (
                        <button
                          aria-pressed={settingsTab === tab}
                          key={tab}
                          onClick={() => setSettingsTab(tab)}
                        >
                          {tab}
                        </button>
                      ),
                    )}
                  </div>
                  {settingsTab === "Providers" && (
                    <>
                      <h3>Choose where the model runs</h3>
                      <p>
                        Explore the disclosure shown for local and hosted
                        providers. This demo never sends prompts.
                      </p>
                      {["Ollama", "LM Studio", "OpenAI"].map((item) => (
                        <article key={item} className={styles.card}>
                          <div className={styles.actions}>
                            <h3>{item}</h3>
                            <Badge amber={item === "OpenAI"}>
                              {item === "OpenAI" ? "Hosted" : "Local"}
                            </Badge>
                          </div>
                          <p>
                            {item === "OpenAI"
                              ? "In the desktop app, tenant context is sent to OpenAI when this provider is selected."
                              : "With a local endpoint, tenant context and prompts stay on your device."}
                          </p>
                          <button
                            aria-pressed={provider === item}
                            onClick={() => {
                              setProvider(item);
                              setNotice(
                                `${item} selected for the demonstration. No provider connection was made.`,
                              );
                            }}
                          >
                            {provider === item
                              ? "Selected in demo"
                              : "Select in demo"}
                          </button>
                        </article>
                      ))}
                    </>
                  )}
                  {settingsTab === "Appearance" && (
                    <>
                      <h3>Appearance</h3>
                      <p>
                        Change the demo’s appearance. The website stays in light
                        mode.
                      </p>
                      <div className={styles.actions}>
                        <button
                          aria-pressed={!dark}
                          onClick={() => setDark(false)}
                        >
                          Light
                        </button>
                        <button
                          aria-pressed={dark}
                          onClick={() => setDark(true)}
                        >
                          Dark
                        </button>
                      </div>
                    </>
                  )}
                  {settingsTab === "Tenants" && (
                    <article className={styles.card}>
                      <h3>Contoso IT</h3>
                      <p>
                        Fictional tenant · Sample inventory · No credentials
                      </p>
                      <a href="/download">
                        Connect your tenant in the desktop app ↗
                      </a>
                    </article>
                  )}
                  {settingsTab === "Privacy" && (
                    <>
                      <h3>Local-first, with an explicit choice</h3>
                      <p>
                        Local providers keep prompts and tenant context
                        on-device. Hosted providers receive the context needed
                        to answer your question.
                      </p>
                      <p>
                        This interactive demo has no tenant, provider, or
                        sign-in connection. Demo state resets when the page
                        reloads.
                      </p>
                      <a href="/trust-model">Read the full trust model ↗</a>
                    </>
                  )}
                </>
              )}
              {page === "Workspaces" && (
                <>
                  <p>
                    Keep an investigation, its evidence, and related runs
                    together.
                  </p>
                  <article className={styles.card}>
                    <Badge>Contoso IT</Badge>
                    <h3>Device hygiene review</h3>
                    <p>
                      3 devices to investigate · 1 conversation · Sample
                      workspace
                    </p>
                    <div className={styles.actions}>
                      <button
                        className={styles.primary}
                        onClick={() => navigate("Chat")}
                      >
                        Open conversation
                      </button>
                      <button
                        onClick={() => {
                          setAgentTab("Run history");
                          navigate("Agents");
                        }}
                      >
                        View run history
                      </button>
                    </div>
                  </article>
                  <details className={styles.evidence}>
                    <summary>Workspace notes</summary>
                    <p>
                      Confirm device ownership before making a retirement
                      decision. All names and records shown here are fictional.
                    </p>
                  </details>
                </>
              )}
              {page === "Connectors" && (
                <>
                  <p>
                    Connect services in the desktop app. Delivery actions still
                    require review.
                  </p>
                  <div className={styles.cards}>
                    {["Microsoft Graph", "Microsoft Teams", "Outlook"].map(
                      (name) => (
                        <article className={styles.card} key={name}>
                          <Icon page="Connectors" />
                          <h3>{name}</h3>
                          <Badge>Not connected · Demo</Badge>
                          <p>
                            {name === "Microsoft Graph"
                              ? "Read tenant evidence through declared permissions."
                              : "Prepare reports for reviewed delivery."}
                          </p>
                          <button
                            onClick={() =>
                              info(
                                name,
                                <>
                                  <p>
                                    {name === "Microsoft Graph"
                                      ? "The desktop app signs in through Microsoft and requests the permissions required by your selected workflows."
                                      : "The desktop app lets you inspect the destination and message before confirming a delivery."}
                                  </p>
                                  <p>
                                    This demo does not sign in or send messages.
                                  </p>
                                  <a href="/download">
                                    Continue in the desktop app ↗
                                  </a>
                                </>,
                              )
                            }
                          >
                            Explore connector
                          </button>
                        </article>
                      ),
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
          <div className={styles.feedback} role="status">
            {notice ||
              "Click the sidebar to explore. All interactions use sample data."}
          </div>
        </div>
      </div>
      <footer className={styles.status}>
        <span>Tenant: Contoso IT · Synthetic data</span>
        <span>
          {hosted
            ? "Hosted provider preview · No data sent"
            : "Local provider preview · No live connection"}
        </span>
        <a href="/download">Get the real app ↗</a>
      </footer>
      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-labelledby="demo-dialog-title"
        onCancel={() => setDialog(null)}
        onClose={() => setDialog(null)}
      >
        <div className={styles.dialogHead}>
          <div>
            <span className={styles.eyebrow}>
              Interactive demo / Contoso IT
            </span>
            <h3 id="demo-dialog-title">{dialog?.title}</h3>
          </div>
          <button onClick={closeDialog} aria-label="Close demo dialog">
            ×
          </button>
        </div>
        <div className={styles.dialogBody}>
          {dialog?.review ? (
            <>
              <Badge amber>Destructive operation · Simulation only</Badge>
              <p>
                Retirement requests removal of company data and management
                settings when each device checks in. Re-enrollment may be needed
                to restore management.
              </p>
              <DeviceTable />
              <p>
                <strong>Proposed operation:</strong> Managed → Retirement
                requested
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (confirmation !== "RETIRE 3 DEVICES") return;
                  setApproved(true);
                  closeDialog();
                  navigate("Changes");
                  setNotice(
                    "Confirmation simulated. No devices were retired. View the sample record in Agents → Run history.",
                  );
                }}
              >
                <label htmlFor="demo-confirm">
                  Type <strong>RETIRE 3 DEVICES</strong> to try the
                  confirmation.
                </label>
                <input
                  id="demo-confirm"
                  name="demo-confirm"
                  autoComplete="off"
                  spellCheck={false}
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  aria-describedby="demo-confirm-help"
                />
                <p id="demo-confirm-help">
                  No Graph operation is sent. This is a demonstration of the
                  approval step.
                </p>
                <div className={styles.actions}>
                  <button type="button" onClick={closeDialog}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className={styles.danger}
                    disabled={confirmation !== "RETIRE 3 DEVICES"}
                  >
                    Confirm simulation
                  </button>
                </div>
              </form>
            </>
          ) : (
            dialog?.body
          )}
        </div>
      </dialog>
    </section>
  );
}
