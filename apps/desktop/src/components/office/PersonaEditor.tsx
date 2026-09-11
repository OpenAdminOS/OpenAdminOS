import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  AppState,
  OfficePersona,
  OfficePersonaInput,
  RegistryAgentSummary,
} from "../../shared/openAdminOS";
import { useAppState } from "../../state";
import { useSetupFlow } from "../../setup/SetupFlowContext";
import { Button } from "../Button";
import { Modal, ModalHeader } from "../Modal";
import { ProviderNotReadyCard } from "../provider-setup/ProviderNotReadyCard";
import { PersonaAvatar } from "./OfficeScene";
import { PersonaOptions, TEAM_ROLES } from "./PersonaOptions";
import { PersonaWorkflowInstall } from "./PersonaWorkflowInstall";

export function PersonaEditor({
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
  const { registryAgents, refreshRegistry, refresh } = useAppState();
  const { openSetup } = useSetupFlow();
  const [step, setStep] = useState(0);
  const [validationError, setValidationError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [customRole, setCustomRole] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [installingWorkflow, setInstallingWorkflow] =
    useState<RegistryAgentSummary>();
  const [startingRole, setStartingRole] = useState<string>(TEAM_ROLES[0].name);
  const roleDefaults = (
    role: (typeof TEAM_ROLES)[number],
  ): Partial<OfficePersonaInput> => ({
    name: role.name,
    responsibility: role.description,
    avatar: role.avatar,
    color: role.color,
    agentSlugs: [...role.slugs],
    intervalMinutes: role.name === "Policy Watcher" ? 60 : null,
    assessment:
      "metric" in role ? { metricPath: role.metric, threshold: 1 } : undefined,
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
    try {
      await refreshRegistry();
    } catch (e) {
      setCatalogError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshingCatalog(false);
    }
  };
  useEffect(() => {
    heading.current?.focus();
    if (content.current) content.current.scrollTop = 0;
  }, [step]);
  const provider = state.providers.find((p) => p.id === form.providerId);
  const missingWorkflows = form.agentSlugs.filter(
    (slug) => !state.installedAgents.some((a) => a.slug === slug),
  );
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
  const readyProvider = Boolean(
    provider &&
      (provider.status === "connected" ||
        (provider.id === "azure-openai" && provider.status === "available")),
  );
  const readyModel =
    !form.model ||
    !provider?.models.length ||
    provider.models.includes(form.model);
  const prerequisites = [
    {
      label: "Tenant",
      ready: Boolean(state.tenants.some((t) => t.id === form.tenantId)),
      detail:
        state.tenants.find((t) => t.id === form.tenantId)?.displayName ??
        "Connect a tenant",
    },
    {
      label: "Model provider",
      ready: readyProvider && readyModel,
      detail:
        readyProvider && readyModel
          ? `${provider?.name} · ${form.model ?? "Provider default"}`
          : "Choose an available provider and model",
    },
    {
      label: "Agent workflows",
      ready: form.agentSlugs.length > 0 && missingWorkflows.length === 0,
      detail: missingWorkflows.length
        ? `${missingWorkflows.length} missing`
        : `${form.agentSlugs.length} selected and installed`,
    },
  ];
  const scheduleText = !form.enabled
    ? "Paused. No assignments will start."
    : form.calendar
      ? `${form.calendar.time} on ${form.calendar.weekdays.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(", ")} (${form.calendar.timeZone}). First run at the next eligible calendar slot.`
      : form.intervalMinutes
        ? `Every ${form.intervalMinutes < 60 ? `${form.intervalMinutes} minutes` : `${form.intervalMinutes / 60} hours`}. First scheduled run one interval after adding.`
        : "Manual only. Starts when you choose Run first assignment.";
  const problem = (stage: number) => {
    if (!form.name.trim() || !form.responsibility.trim())
      return "Enter a name and responsibility for your teammate.";
    if (stage >= 1 && !cosmeticOnly && prerequisites.some((p) => !p.ready))
      return "Complete the workspace checklist before continuing.";
    if (
      stage >= 2 &&
      (!Number.isFinite(form.maxMinutes) ||
        form.maxMinutes < 5 ||
        form.maxMinutes > 120)
    )
      return "Choose an execution budget between 5 and 120 minutes.";
    if (stage >= 2 && form.calendar && !form.calendar.weekdays.length)
      return "Choose at least one weekday for the calendar schedule.";
    if (
      stage >= 3 &&
      !provider?.isLocal &&
      !form.confirmHosted &&
      !cosmeticOnly
    )
      return "Review and approve the hosted-provider data destination before adding this teammate.";
    return "";
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const invalid = problem(persona ? 3 : step);
    setValidationError(invalid);
    if (invalid) return;
    if (!persona && step < 3) {
      setStep(step + 1);
      return;
    }
    void onSave(form);
  };
  const stageNames = [
    "Choose a role",
    "Prepare workspace",
    "Choose schedule",
    "Review and add",
  ];
  return (
    <>
      <Modal
        open
        onClose={onClose}
        ariaLabel={persona ? "Edit teammate" : "Add teammate"}
        closeOnScrim={false}
        size="lg"
      >
        <ModalHeader
          onClose={onClose}
          title={persona ? `Edit ${persona.name}` : "Add a teammate"}
          subtitle="An AI teammate runs the agent workflows you assign, in your chosen tenant."
        />
        {!persona && (
          <ol className="team-setup-progress" aria-label="Setup progress">
            {stageNames.map((name, i) => (
              <li key={name} aria-current={step === i ? "step" : undefined}>
                <span>{i + 1}</span>
                {name}
              </li>
            ))}
          </ol>
        )}
        <form
          onSubmit={submit}
          className="office-editor team-editor"
          autoComplete="off"
        >
          <div className="team-editor-body" ref={content}>
            <h3 ref={heading} tabIndex={-1} className="team-step-heading">
              {persona ? "Teammate settings" : stageNames[step]}
            </h3>
            <fieldset disabled={busy}>
              {(persona || step === 0) && (
                <>
                  {!persona && (
                    <>
                      <p className="team-step-intro">
                        Start with a responsibility. Each role lists what it can
                        actually do.
                      </p>
                      <div
                        className="office-presets team-role-grid"
                        aria-label="Starting roles"
                      >
                        {TEAM_ROLES.map((role) => (
                          <button
                            key={role.name}
                            type="button"
                            aria-label={role.name}
                            aria-pressed={
                              !customRole && startingRole === role.name
                            }
                            onClick={() => {
                              setCustomRole(false);
                              setStartingRole(role.name);
                              setForm((f) => ({ ...f, ...roleDefaults(role) }));
                            }}
                          >
                            <PersonaAvatar
                              avatar={role.avatar}
                              color={role.color}
                            />
                            <strong>{role.name}</strong>
                            <span>{role.description}</span>
                            <small>
                              Workflows:{" "}
                              {role.slugs
                                .map(
                                  (slug) =>
                                    state.installedAgents.find(
                                      (a) => a.slug === slug,
                                    )?.name ??
                                    registryAgents.find((a) => a.slug === slug)
                                      ?.name ??
                                    slug,
                                )
                                .join(" → ")}
                            </small>
                          </button>
                        ))}
                        <button
                          type="button"
                          aria-pressed={customRole}
                          onClick={() => {
                            setCustomRole(true);
                            setStartingRole("Custom role");
                            setForm((f) => ({
                              ...f,
                              name: "My teammate",
                              responsibility: "",
                              agentSlugs: [],
                              assessment: undefined,
                              planning: "ordered",
                              intervalMinutes: null,
                            }));
                          }}
                        >
                          <PersonaAvatar avatar="robot" color="sage" />
                          <strong>Custom role</strong>
                          <span>
                            Choose your own responsibility and installed agent
                            workflows.
                          </span>
                          <small>You define the work order.</small>
                        </button>
                      </div>
                    </>
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
                          change(
                            "avatar",
                            e.target.value as OfficePersona["avatar"],
                          )
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
                          change(
                            "color",
                            e.target.value as OfficePersona["color"],
                          )
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
                      A description for your team. The workflows below define
                      what actually runs.
                    </small>
                  </label>
                </>
              )}
              {(persona || step === 1) && (
                <>
                  <ul
                    className="team-readiness"
                    aria-label="Workspace checklist"
                  >
                    {prerequisites.map((p) => (
                      <li key={p.label} data-ready={p.ready}>
                        <strong>
                          {p.ready ? "✓" : "○"} {p.label}
                        </strong>
                        <span>{p.detail}</span>
                      </li>
                    ))}
                  </ul>
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
                            providerId: e.target
                              .value as OfficePersona["providerId"],
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
                      onChange={(e) =>
                        change("model", e.target.value || undefined)
                      }
                    >
                      <option value="">Provider default</option>
                      {form.model && !provider?.models.includes(form.model) && (
                        <option value={form.model}>
                          {form.model}
                          {provider?.models.length ? " · unavailable" : ""}
                        </option>
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
                      Assign installed agents{" "}
                      <span>{form.agentSlugs.length}/8</span>
                    </h3>
                    <p>
                      Select workflows in execution order. Agent settings and
                      delivery rules apply.
                    </p>
                    {missingWorkflows.length > 0 && (
                      <div role="status">
                        <p className="office-error">
                          Install the missing workflows below or remove them
                          from this assignment before saving.
                        </p>
                        {missingWorkflows.map((slug) => {
                          const agent = registryAgents.find(
                            (a) => a.slug === slug,
                          );
                          return (
                            <div key={slug}>
                              <label className="office-check">
                                <input
                                  type="checkbox"
                                  checked
                                  onChange={() => toggleAgent(slug)}
                                />
                                <span>
                                  {agent?.name ?? slug}
                                  <small>Not installed</small>
                                </span>
                              </label>
                              {agent ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  onClick={() => setInstallingWorkflow(agent)}
                                >
                                  Review and install {agent.name}
                                </Button>
                              ) : (
                                <p>
                                  Unavailable in the current catalog. Refresh
                                  available workflows below to retry.
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <details>
                      <summary>Browse available workflows</summary>
                      {registryAgents
                        .filter(
                          (a) =>
                            !state.installedAgents.some(
                              (installed) => installed.slug === a.slug,
                            ) && !missingWorkflows.includes(a.slug),
                        )
                        .map((a) => (
                          <div key={a.slug}>
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => setInstallingWorkflow(a)}
                            >
                              Review and install {a.name}
                            </Button>
                          </div>
                        ))}
                      {registryAgents.length === 0 && (
                        <p>
                          No catalog available. Refresh available workflows to
                          retry.
                        </p>
                      )}
                    </details>
                    <Button
                      type="button"
                      size="sm"
                      disabled={refreshingCatalog}
                      onClick={() => void refreshWorkflows()}
                    >
                      {refreshingCatalog
                        ? "Refreshing workflows…"
                        : "Refresh available workflows"}
                    </Button>
                    {(catalogError || state.registryRefreshError) && (
                      <p role="alert" className="office-error">
                        {catalogError || state.registryRefreshError} Refresh
                        available workflows to retry.
                      </p>
                    )}
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
                            {state.installedAgents.find((a) => a.slug === slug)
                              ?.name ?? slug}
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

                  {!form.tenantId && (
                    <div className="team-setup-recovery">
                      <p>
                        Connect a tenant to continue. Your draft stays open
                        during setup.
                      </p>
                      <Button type="button" onClick={openSetup}>
                        Connect tenant
                      </Button>
                    </div>
                  )}
                  {provider && !readyProvider && (
                    <ProviderNotReadyCard
                      provider={provider}
                      onRecheck={async () => {
                        try {
                          await refresh();
                        } catch (e) {
                          setValidationError(
                            e instanceof Error ? e.message : String(e),
                          );
                        }
                      }}
                    />
                  )}
                  {!readyModel && (
                    <p role="status">
                      The selected model is unavailable. Choose another model or
                      Provider default.
                    </p>
                  )}
                  <p className="team-data-boundary">
                    {provider?.isLocal
                      ? "Local provider · Tenant context stays on this device."
                      : `${provider?.name ?? "Hosted provider"} · Assigned tenant context leaves this device. You will review this before adding your teammate.`}
                  </p>
                </>
              )}
              {(persona || step === 2) && (
                <>
                  <div className="office-form-row">
                    <label>
                      Schedule
                      <select
                        value={form.intervalMinutes ?? "manual"}
                        onChange={(e) =>
                          change(
                            "intervalMinutes",
                            e.target.value === "manual"
                              ? null
                              : Number(e.target.value),
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
                        onChange={(e) =>
                          change("maxMinutes", Number(e.target.value))
                        }
                      />
                    </label>
                  </div>
                  <details className="team-advanced">
                    <summary>
                      Advanced instructions, handoffs and schedules
                    </summary>
                    <PersonaOptions form={form} change={change} state={state} />
                  </details>
                  <label className="office-check">
                    <input
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(e) => change("enabled", e.target.checked)}
                    />
                    <span>
                      Enable this teammate
                      <small>
                        Schedules begin at the next interval or calendar slot.
                        Event triggers watch completed findings.
                      </small>
                    </span>
                  </label>

                  <p className="team-schedule-preview">{scheduleText}</p>
                  {form.watch && (
                    <p>
                      Also watches completed findings from{" "}
                      {state.office?.personas.find(
                        (p) => p.id === form.watch?.personaId,
                      )?.name ?? "the selected teammate"}
                      . Event triggers can start work independently of the
                      interval.
                    </p>
                  )}
                  {form.quietHours && (
                    <p>
                      Scheduled and event-triggered work waits outside quiet
                      hours: {form.quietHours.start}:00–{form.quietHours.end}:00
                      ({form.quietHours.timeZone}).
                    </p>
                  )}
                  <p className="team-step-intro">
                    {window.openAdminOS?.platform === "linux"
                      ? "Keep the app open on Linux for scheduled work."
                      : "Scheduled work needs this computer awake, a signed-in user session, and the app or background scheduler running."}{" "}
                    Missed checks coalesce into one eligible run after wake.
                  </p>
                </>
              )}
              {(persona || step === 3) && (
                <>
                  {!persona && (
                    <div className="team-review">
                      <div className="team-review-heading">
                        <PersonaAvatar
                          avatar={form.avatar}
                          color={form.color}
                        />
                        <div>
                          <h4>{form.name}</h4>
                          <p>{form.responsibility}</p>
                        </div>
                      </div>
                      <dl>
                        <div>
                          <dt>Tenant</dt>
                          <dd>
                            {state.tenants.find((t) => t.id === form.tenantId)
                              ?.displayName ?? "Not connected"}
                          </dd>
                        </div>
                        <div>
                          <dt>Data destination</dt>
                          <dd>
                            {provider?.name} ·{" "}
                            {provider?.isLocal
                              ? "Local, stays on this device"
                              : "Hosted, leaves this device"}
                          </dd>
                        </div>
                        <div>
                          <dt>Model</dt>
                          <dd>{form.model ?? "Provider default"}</dd>
                        </div>
                        <div>
                          <dt>Schedule</dt>
                          <dd>{scheduleText}</dd>
                        </div>
                        {form.watch && (
                          <div>
                            <dt>Handoff trigger</dt>
                            <dd>
                              {
                                state.office?.personas.find(
                                  (p) => p.id === form.watch?.personaId,
                                )?.name
                              }{" "}
                              · {form.watch.event}
                            </dd>
                          </div>
                        )}
                        <div>
                          <dt>Execution budget</dt>
                          <dd>{form.maxMinutes} minutes per assignment</dd>
                        </div>
                      </dl>
                      <h4>Approved work order</h4>
                      <ol>
                        {form.agentSlugs.map((slug) => {
                          const a = state.installedAgents.find(
                            (a) => a.slug === slug,
                          );
                          return (
                            <li key={slug}>
                              <strong>{a?.name ?? slug}</strong> ·{" "}
                              {a?.mode === "write"
                                ? "Writes, approval required every time"
                                : "Read-only"}
                            </li>
                          );
                        })}
                      </ol>
                      <p>
                        Adding a teammate does not complete a check. Its first
                        result will link to run evidence. Writes always wait for
                        your approval.
                      </p>
                    </div>
                  )}
                  {!provider?.isLocal && (
                    <label className="office-check office-hosted">
                      <input
                        type="checkbox"
                        checked={form.confirmHosted === true}
                        required={!cosmeticOnly}
                        onChange={(e) =>
                          change("confirmHosted", e.target.checked)
                        }
                      />
                      <span>
                        I approve sending context from{" "}
                        {state.tenants.find((t) => t.id === form.tenantId)
                          ?.displayName ?? "the selected tenant"}{" "}
                        to {provider?.name ?? "this provider"}, including
                        watched evidence, planning, and teammate questions.
                        <small>
                          This applies to manual and scheduled assignments until
                          the teammate or provider configuration changes.
                        </small>
                      </span>
                    </label>
                  )}
                </>
              )}
            </fieldset>
          </div>
          <footer className="team-editor-footer">
            {(error || validationError) && (
              <p className="office-error" role="alert">
                {error || validationError}
              </p>
            )}
            <div className="office-actions">
              <Button type="button" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              {!persona && step > 0 && (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setValidationError("");
                    setStep(step - 1);
                  }}
                >
                  Back
                </Button>
              )}
              <span className="team-step-count">
                {persona
                  ? "Review changes before saving"
                  : `Step ${step + 1} of 4`}
              </span>
              <Button
                type="submit"
                variant="primary"
                disabled={
                  busy ||
                  (!persona &&
                    step === 1 &&
                    prerequisites.some((p) => !p.ready))
                }
              >
                {busy
                  ? "Saving…"
                  : persona
                    ? "Save teammate"
                    : step === 3
                      ? "Add teammate"
                      : "Continue"}
              </Button>
            </div>
            {!persona && step === 1 && prerequisites.some((p) => !p.ready) && (
              <p className="team-step-intro">
                Complete the workspace checklist to continue.
              </p>
            )}
          </footer>
        </form>
      </Modal>
      {installingWorkflow && (
        <PersonaWorkflowInstall
          key={installingWorkflow.slug}
          agent={installingWorkflow}
          tenantId={form.tenantId}
          onClose={() => setInstallingWorkflow(undefined)}
        />
      )}
    </>
  );
}
