import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Routes, Route, useLocation } from "react-router";

import { RERUN_COPY } from "../copy";
import RunResult from "./RunResult";
import Agents from "./Agents";
import {
  createAwaitingConfirmationRun,
  createMockAgent,
  createMockAppState,
  makeMockBridge,
  renderRoute,
  renderWithAppState,
} from "../test/test-utils";

describe("RunResult write confirmation", () => {
  it("requires danger acknowledgement and the exact phrase, and marks the affected action", async () => {
    const user = userEvent.setup();
    const run = createAwaitingConfirmationRun();
    run.riskAssessment = { status: "complete", flags: [{
      id: "managed-device-destructive", severity: "danger", title: "Destructive managed device action",
      explanation: "Retiring a device can interrupt access.", actionIds: [run.plan!.actions[0]!.id],
    }] };
    const bridge = makeMockBridge({}, createMockAppState({ installedAgents: [createMockAgent({ slug: run.agentSlug })], runs: [run] }));
    renderRoute(<RunResult />, { path: "/runs/:id", route: `/runs/${run.id}`, bridge });
    const acknowledgement = await screen.findByRole("checkbox", { name: "I have reviewed the flagged actions" });
    const apply = screen.getByRole("button", { name: "Apply 2 changes" });
    const phrase = screen.getByPlaceholderText("Type here to enable Apply");
    expect(screen.getByRole("region", { name: "Write plan risk flags" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: `Risk flags for ${run.plan!.actions[0]!.label}` })).getByText("Danger: Destructive managed device action")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: `Risk flags for ${run.plan!.actions[1]!.label}` })).not.toBeInTheDocument();
    await user.click(acknowledgement);
    expect(apply).toBeDisabled();
    await user.type(phrase, "OFFBOARD 2 DEVICES");
    expect(apply).toBeEnabled();
    await user.click(acknowledgement);
    expect(apply).toBeDisabled();
    expect(bridge.confirmRun).not.toHaveBeenCalled();
    await user.click(acknowledgement);
    await user.click(apply);
    await waitFor(() => expect(bridge.confirmRun).toHaveBeenCalledWith(run.id, "OFFBOARD 2 DEVICES"));
  });

  it("keeps warning flags informational", async () => {
    const user = userEvent.setup();
    const run = createAwaitingConfirmationRun();
    run.riskAssessment = { status: "complete", flags: [{ id: "unusual-plan-size", severity: "warn", title: "Unusual plan size", explanation: "This plan exceeds the usual count.", actionIds: run.plan!.actions.map((action) => action.id) }] };
    const bridge = makeMockBridge({}, createMockAppState({ runs: [run] }));
    renderRoute(<RunResult />, { path: "/runs/:id", route: `/runs/${run.id}`, bridge });
    expect(await screen.findByText("Unusual plan size")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Type here to enable Apply"), "OFFBOARD 2 DEVICES");
    expect(screen.getByRole("button", { name: "Apply 2 changes" })).toBeEnabled();
  });

  it("resets approval inputs only when the reviewed plan or assessment changes", async () => {
    const user = userEvent.setup();
    const run = createAwaitingConfirmationRun({ riskAssessment: { status: "complete", flags: [{ id: "danger", severity: "danger", title: "Review device action", explanation: "This changes a device.", actionIds: ["one"] }] } });
    let appState = createMockAppState({ runs: [run] });
    const bridge = makeMockBridge({ getAppState: vi.fn(async () => appState) }, appState);
    renderRoute(<RunResult />, { path: "/runs/:id", route: `/runs/${run.id}`, bridge });
    await user.click(await screen.findByRole("checkbox", { name: "I have reviewed the flagged actions" }));
    await user.type(screen.getByPlaceholderText("Type here to enable Apply"), "OFFBOARD 2 DEVICES");
    appState = structuredClone(appState);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("button", { name: "Apply 2 changes" })).toBeEnabled();
    appState = { ...appState, runs: [{ ...run, plan: { ...run.plan!, summary: "A changed proposal needs a fresh review." } }] };
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByPlaceholderText("Type here to enable Apply")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Apply 2 changes" })).toBeDisabled();
  });

  it.each([
    { status: "failed" as const, reason: "A proposed Graph request path contains invalid encoding" },
    undefined,
  ])("shows manual review when the risk check failed or was never recorded", async (riskAssessment) => {
    const user = userEvent.setup();
    const run = createAwaitingConfirmationRun({ riskAssessment });
    const bridge = makeMockBridge({}, createMockAppState({ runs: [run] }));
    renderRoute(<RunResult />, { path: "/runs/:id", route: `/runs/${run.id}`, bridge });
    expect(await screen.findByRole("alert")).toHaveTextContent(/Risk check could not run:.*Review every action manually/);
    expect(screen.queryByText(/No flags from the current rules/)).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Type here to enable Apply"), "OFFBOARD 2 DEVICES");
    await user.click(screen.getByRole("button", { name: "Apply 2 changes" }));
    await waitFor(() => expect(bridge.confirmRun).toHaveBeenCalledWith(run.id, "OFFBOARD 2 DEVICES"));
  });

  it("shows retained flags in terminal run history", async () => {
    const run = createAwaitingConfirmationRun({ status: "rejected", riskAssessment: { status: "complete", flags: [{ id: "privileged-role", severity: "danger", title: "Privileged role change", explanation: "This request changes privileged access.", actionIds: ["one"] }] } });
    const bridge = makeMockBridge({}, createMockAppState({ runs: [run] }));
    renderRoute(<RunResult />, { path: "/runs/:id", route: `/runs/${run.id}`, bridge });
    expect(await screen.findByText("Privileged role change")).toBeInTheDocument();
    expect(screen.getByText("This request changes privileged access.")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("does not report an unavailable risk check for a completed empty plan", async () => {
    const run = createAwaitingConfirmationRun({ status: "completed", plan: { summary: "No changes matched.", confirmationPhrase: "APPLY CHANGES", actions: [] } });
    const bridge = makeMockBridge({}, createMockAppState({ runs: [run] }));
    renderRoute(<RunResult />, { path: "/runs/:id", route: `/runs/${run.id}`, bridge });
    await screen.findByRole("region", { name: "Run status" });
    expect(screen.queryByText(/Risk check could not run/)).not.toBeInTheDocument();
  });

  it("keeps Apply disabled until the exact confirmation phrase is typed", async () => {
    const user = userEvent.setup();
    const run = createAwaitingConfirmationRun();
    const bridge = makeMockBridge(
      {},
      createMockAppState({
        installedAgents: [createMockAgent({ slug: run.agentSlug })],
        runs: [run],
      }),
    );

    renderRoute(<RunResult />, {
      path: "/runs/:id",
      route: `/runs/${run.id}`,
      bridge,
    });

    expect(
      await screen.findByRole("heading", {
        name: "Retire two stale Windows devices after offboarding review.",
      }),
    ).toBeInTheDocument();

    const applyButton = screen.getByRole("button", { name: "Apply 2 changes" });
    const phraseInput = screen.getByPlaceholderText("Type here to enable Apply");

    expect(applyButton).toBeDisabled();

    await user.type(phraseInput, "offboard 2 devices");
    expect(applyButton).toBeDisabled();

    await user.clear(phraseInput);
    await user.type(phraseInput, "OFFBOARD 2 DEVICES ");
    expect(applyButton).toBeDisabled();

    await user.clear(phraseInput);
    await user.type(phraseInput, "OFFBOARD 2 DEVICES");
    expect(applyButton).toBeEnabled();

    await user.click(applyButton);

    await waitFor(() => {
      expect(bridge.confirmRun).toHaveBeenCalledWith(run.id, "OFFBOARD 2 DEVICES");
    });
  });

  it("rejects an awaiting confirmation run through the bridge", async () => {
    const user = userEvent.setup();
    const run = createAwaitingConfirmationRun();
    const bridge = makeMockBridge(
      {},
      createMockAppState({
        installedAgents: [createMockAgent({ slug: run.agentSlug })],
        runs: [run],
      }),
    );

    renderRoute(<RunResult />, {
      path: "/runs/:id",
      route: `/runs/${run.id}`,
      bridge,
    });

    await screen.findByText("Type the phrase below to confirm");

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(bridge.rejectRun).toHaveBeenCalledWith(run.id);
    });
  });

  it("keeps paused confirmation focused by hiding empty telemetry and detail tabs", async () => {
    const run = createAwaitingConfirmationRun({ steps: [], logs: [] });
    const bridge = makeMockBridge(
      {},
      createMockAppState({
        installedAgents: [createMockAgent({ slug: run.agentSlug })],
        runs: [run],
      }),
    );

    renderRoute(<RunResult />, {
      path: "/runs/:id",
      route: `/runs/${run.id}`,
      bridge,
    });

    expect(await screen.findByText("Type the phrase below to confirm")).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Run detail views" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Telemetry" })).not.toBeInTheDocument();
  });

  it("describes arbitrary Graph writes without inventing a device-retirement impact", async () => {
    const run = createAwaitingConfirmationRun({
      id: "run-disable-user",
      plan: {
        summary: "Block one compromised user after review.",
        confirmationPhrase: "BLOCK 1 USER",
        actions: [
          {
            id: "action-disable-user",
            kind: "disable-user",
            label: "Block sign-in for Alex Wilber",
            description: "Sets accountEnabled to false.",
            severity: "destructive",
            request: {
              method: "PATCH",
              path: "/users/user-1",
              body: { accountEnabled: false },
            },
          },
        ],
      },
    });
    const bridge = makeMockBridge(
      {},
      createMockAppState({
        installedAgents: [createMockAgent({ slug: run.agentSlug })],
        runs: [run],
      }),
    );

    renderRoute(<RunResult />, {
      path: "/runs/:id",
      route: `/runs/${run.id}`,
      bridge,
    });

    expect(await screen.findByText(/1 planned change will be applied/)).toBeInTheDocument();
    expect(screen.getByText(/Microsoft Graph changes may not be reversible/)).toBeInTheDocument();
    expect(screen.queryByText(/will be retired/i)).not.toBeInTheDocument();
  });

  it("summarizes every PATCH field and a DELETE from the actual requests", async () => {
    const run = createAwaitingConfirmationRun({
      id: "run-request-summary",
      plan: {
        summary: "Review a multi-field update and deletion.",
        confirmationPhrase: "APPLY 2 CHANGES",
        actions: [
          {
            id: "action-patch",
            kind: "update-user",
            label: "Update Alex Wilber",
            request: {
              method: "PATCH",
              path: "/users/user-1",
              body: {
                accountEnabled: false,
                department: "Security Operations",
                employeeOrgData: { division: "Response" },
              },
            },
          },
          {
            id: "action-delete",
            kind: "delete-device",
            label: "Delete stale device",
            severity: "destructive",
            request: {
              method: "DELETE",
              path: "/deviceManagement/managedDevices/device-1",
            },
          },
        ],
      },
    });
    const bridge = makeMockBridge(
      {},
      createMockAppState({
        installedAgents: [createMockAgent({ slug: run.agentSlug })],
        runs: [run],
      }),
    );

    renderRoute(<RunResult />, {
      path: "/runs/:id",
      route: `/runs/${run.id}`,
      bridge,
    });

    expect(
      await screen.findByText(/PATCH \/users\/user-1.*accountEnabled: false/),
    ).toHaveTextContent("department: Security Operations");
    expect(screen.getByText(/employeeOrgData:.*division.*Response/)).toBeInTheDocument();
    expect(
      screen.getByText("DELETE /deviceManagement/managedDevices/device-1"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Current tenant state|Current value/)).not.toBeInTheDocument();
  });

  it("renders rollback runs without a rerun action and reports manual changes", async () => {
    const run = createAwaitingConfirmationRun({
      id: "run-baseline-rollback",
      agentSlug: "baseline-rollback",
      origin: "baseline-rollback",
      status: "completed",
      finishedAt: "2026-07-05T10:01:00.000Z",
      rollback: {
        baselineId: "baseline-1",
        requiredScopes: ["DeviceManagementConfiguration.ReadWrite.All"],
        manualCount: 3,
      },
    });
    const bridge = makeMockBridge(
      {},
      createMockAppState({ installedAgents: [], runs: [run] }),
    );

    renderRoute(<RunResult />, {
      path: "/runs/:id",
      route: `/runs/${run.id}`,
      bridge,
    });

    expect(
      await screen.findByRole("heading", { name: "Baseline rollback" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Run again" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "3 changes need manual review and are not part of this plan.",
      ),
    ).toBeInTheDocument();
  });

  it("labels external proposals with their client and scopes without a rerun action", async () => {
    const run = createAwaitingConfirmationRun({
      id: "run-external-proposal",
      agentSlug: "external-proposal",
      origin: "external-proposal",
      status: "completed",
      finishedAt: "2026-08-29T10:01:00.000Z",
      external: {
        clientName: "Claude Code",
        requiredScopes: [
          "Policy.ReadWrite.ConditionalAccess",
          "Directory.Read.All",
        ],
      },
    });
    const bridge = makeMockBridge(
      {},
      createMockAppState({ installedAgents: [], runs: [run] }),
    );

    renderRoute(<RunResult />, {
      path: "/runs/:id",
      route: `/runs/${run.id}`,
      bridge,
    });

    expect(
      await screen.findByRole("heading", {
        name: "External proposal from Claude Code",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Required scopes: Policy.ReadWrite.ConditionalAccess, Directory.Read.All",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Run again" }),
    ).not.toBeInTheDocument();
  });
});

it("opens terminal runs as a full run page with collapsible details", async () => {
  const user = userEvent.setup();
  const run = createAwaitingConfirmationRun({
    status: "completed",
    plan: undefined,
    startedAt: "2026-10-10T10:00:00.000Z",
    finishedAt: "2026-10-10T10:01:00.000Z",
    summary: "## Summary\n\nTwo stale devices were found.",
  });
  const bridge = makeMockBridge(
    {},
    createMockAppState({
      installedAgents: [createMockAgent({ slug: run.agentSlug })],
      runs: [run],
    }),
  );

  renderRoute(<RunResult />, {
    path: "/runs/:id",
    route: `/runs/${run.id}`,
    bridge,
  });

  expect(await screen.findByRole("heading", { level: 1, name: "Device Offboard" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Run status" })).getByRole("status")).toHaveTextContent("Completed in 1m 00s");
  expect(screen.getByRole("region", { name: "Report" })).toHaveTextContent("Two stale devices were found.");
  expect(screen.queryByRole("tablist", { name: "Run detail views" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Run details/ }));
  expect(screen.getByRole("tablist", { name: "Run detail views" })).toBeInTheDocument();
});

it("shows queued and running runs on the run page with live progress and cancel", async () => {
  const user = userEvent.setup();
  const run = createAwaitingConfirmationRun({
    status: "running",
    plan: undefined,
    steps: [
      { id: "step-1", runId: "run-write-1", label: "Load managed devices", status: "completed", startedAt: "2026-10-10T10:00:00.000Z", finishedAt: "2026-10-10T10:00:02.000Z" },
      { id: "step-2", runId: "run-write-1", label: "Write the report", status: "running", startedAt: "2026-10-10T10:00:02.000Z" },
      { id: "step-3", runId: "run-write-1", label: "Deliver report", status: "pending" },
    ],
  });
  const bridge = makeMockBridge(
    {},
    createMockAppState({
      installedAgents: [createMockAgent({ slug: run.agentSlug })],
      runs: [run],
    }),
  );

  renderRoute(<RunResult />, {
    path: "/runs/:id",
    route: `/runs/${run.id}`,
    bridge,
  });

  expect(await screen.findByRole("heading", { level: 1, name: "Device Offboard" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Run status" })).getByRole("status")).toHaveTextContent("Running step 2 of 3");
  expect(screen.getByRole("progressbar", { name: "Run progress" })).toHaveAttribute("aria-valuenow", "1");
  expect(within(screen.getByRole("region", { name: "Progress" })).getByText("Write the report")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Run in background" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Cancel run" }));
  await waitFor(() => expect(bridge.cancelRun).toHaveBeenCalledWith(run.id));
});

it('retries Team evidence by source ID without sending evidence through the renderer', async () => {
  const user = userEvent.setup();
  const run = createAwaitingConfirmationRun({ status: 'failed', plan: undefined, officeContext: { tenantId: 'tenant-1', question: 'Draft a diagnostic.', evidence: [] } });
  const bridge = makeMockBridge({}, createMockAppState({ installedAgents: [createMockAgent({ slug: run.agentSlug, mode: 'read' })], runs: [run] }));
  renderRoute(<RunResult />, { path: '/runs/:id', route: `/runs/${run.id}`, bridge });
  await user.click(await screen.findByRole('button', { name: 'Run again' }));
  await waitFor(() => expect(bridge.startRun).toHaveBeenCalledWith(run.agentSlug, expect.objectContaining({ retryOfRunId: run.id })));
  expect(bridge.startRun).toHaveBeenCalledWith(run.agentSlug, { retryOfRunId: run.id, tenantId: run.tenantId, providerId: run.providerId, model: run.model });
});

it('routes hosted Team retries to the owning assignment for review', async () => {
  const user = userEvent.setup();
  const run = createAwaitingConfirmationRun({ status: 'failed', plan: undefined, providerId: 'openai', office: { personaId: 'script-bot', missionId: 'mission-1', step: 0 }, officeContext: { tenantId: 'tenant-1', question: 'Draft a diagnostic.', evidence: [] } });
  const bridge = makeMockBridge({}, createMockAppState({ activeTenantId: 'another-tenant', installedAgents: [createMockAgent({ slug: run.agentSlug, mode: 'read' })], runs: [run] }));
  function TeamDestination() { const location = useLocation(); return <p>{`Team review ${location.search}`}</p>; }
  renderWithAppState(<Routes><Route path="/runs/:id" element={<RunResult />} /><Route path="/office" element={<TeamDestination />} /></Routes>, { route: `/runs/${run.id}`, bridge });
  await screen.findByRole('button', { name: 'Review in Agent Team' });
  expect(screen.queryByRole('button', { name: 'Re-run against current tenant' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Review in Agent Team' }));
  expect(await screen.findByText('Team review ?persona=script-bot')).toBeInTheDocument();
  expect(bridge.startRun).not.toHaveBeenCalled();
});



it("shows the complete dry-run plan without Apply and starts a fresh normal run", async () => {
  const user = userEvent.setup();
  const run = createAwaitingConfirmationRun({ status: "planned", dryRun: true, finishedAt: "2026-10-31T12:00:00Z" });
  const bridge = makeMockBridge({}, createMockAppState({ runs: [run] }));
  renderRoute(<RunResult />, { path: "/runs/:id", route: `/runs/${run.id}`, bridge });
  expect(await screen.findByText(/Dry run. Nothing was changed in Contoso/)).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: run.plan!.summary })).toBeInTheDocument();
  for (const action of run.plan!.actions) expect(screen.getByText(action.label)).toBeInTheDocument();
  expect(screen.queryByPlaceholderText("Type here to enable Apply")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Apply/ })).not.toBeInTheDocument();
  expect(screen.queryByText("Awaiting confirmation")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Run for real" }));
  await waitFor(() => expect(bridge.startRun).toHaveBeenCalledWith(run.agentSlug, expect.objectContaining({ runForRealOfRunId: run.id, tenantId: run.tenantId })));
  expect(vi.mocked(bridge.startRun).mock.calls[0]?.[1]?.dryRun).toBeUndefined();
  expect(bridge.confirmRun).not.toHaveBeenCalled();
});

it("does not present host status text as the report while a run is live", async () => {
  const run = createAwaitingConfirmationRun({
    status: "running",
    plan: undefined,
    summary: "Device Offboard is running.",
  });
  const bridge = makeMockBridge(
    {},
    createMockAppState({ installedAgents: [createMockAgent({ slug: run.agentSlug })], runs: [run] }),
  );
  renderRoute(<RunResult />, { path: "/runs/:id", route: `/runs/${run.id}`, bridge });

  const report = await screen.findByRole("region", { name: "Report" });
  expect(report).toHaveTextContent("The report appears here as the agent writes it.");
  expect(report).not.toHaveTextContent("Device Offboard is running.");
  expect(screen.queryByText(/Written by/)).not.toBeInTheDocument();
});

it("tells the admin when cancelling a live run fails instead of failing silently", async () => {
  const user = userEvent.setup();
  const run = createAwaitingConfirmationRun({ status: "running", plan: undefined });
  const bridge = makeMockBridge(
    { cancelRun: vi.fn(async () => { throw new Error("Run not found"); }) },
    createMockAppState({ installedAgents: [createMockAgent({ slug: run.agentSlug })], runs: [run] }),
  );
  renderRoute(<RunResult />, { path: "/runs/:id", route: `/runs/${run.id}`, bridge });

  await user.click(await screen.findByRole("button", { name: "Cancel run" }));
  expect(await screen.findByText(/The run could not be cancelled: Run not found/)).toBeInTheDocument();
});

it("does not cancel a live run when Escape is pressed on the page", async () => {
  const user = userEvent.setup();
  const run = createAwaitingConfirmationRun({ status: "running", plan: undefined });
  const bridge = makeMockBridge(
    {},
    createMockAppState({ installedAgents: [createMockAgent({ slug: run.agentSlug })], runs: [run] }),
  );
  renderRoute(<RunResult />, { path: "/runs/:id", route: `/runs/${run.id}`, bridge });

  await screen.findByRole("button", { name: "Cancel run" });
  await user.keyboard("{Escape}");
  expect(bridge.cancelRun).not.toHaveBeenCalled();
});

it("keeps a local run labelled local when its provider entry is no longer configured", async () => {
  const run = createAwaitingConfirmationRun({
    status: "completed",
    plan: undefined,
    providerId: "ollama",
    finishedAt: "2026-10-10T10:01:00.000Z",
  });
  const bridge = makeMockBridge(
    {},
    createMockAppState({ providers: [], installedAgents: [createMockAgent({ slug: run.agentSlug })], runs: [run] }),
  );
  renderRoute(<RunResult />, { path: "/runs/:id", route: `/runs/${run.id}`, bridge });

  const status = await screen.findByRole("region", { name: "Run status" });
  expect(status).toHaveTextContent("Local, not billed");
  expect(status).not.toHaveTextContent("Hosted");
});

it("opens run details on the Logs tab when a failed run has no error playbook", async () => {
  const run = createAwaitingConfirmationRun({
    status: "failed",
    plan: undefined,
    error: undefined,
    result: undefined,
    finishedAt: "2026-10-10T10:01:00.000Z",
  });
  const bridge = makeMockBridge(
    {},
    createMockAppState({ installedAgents: [createMockAgent({ slug: run.agentSlug })], runs: [run] }),
  );
  renderRoute(<RunResult />, { path: "/runs/:id", route: `/runs/${run.id}`, bridge });

  expect(await screen.findByText("Run failed before producing a result. See the Logs tab for details.")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("region", { name: "Run status" })).toHaveTextContent("Open Run details below for the logs.");
});

function renderWithPreflight(runId: string, bridge: ReturnType<typeof makeMockBridge>) {
  return renderWithAppState(
    <Routes>
      <Route path="/runs/:id" element={<RunResult />} />
      <Route path="/agents/:slug/confirm" element={<Agents startRunOnOpen />} />
    </Routes>,
    { route: `/runs/${runId}`, bridge },
  );
}

it("opens the preflight for Run again on a tenant-bound run, keeps its provider and model, and shows a failed start", async () => {
  const user = userEvent.setup();
  const run = createAwaitingConfirmationRun({ status: "failed", plan: undefined, providerId: "openai", model: "gpt-5", tenantId: "tenant-1" });
  const startRun = vi.fn(async () => { throw new Error("OpenAI Codex isn't ready. Open Settings to check the connection."); });
  const bridge = makeMockBridge({ startRun }, createMockAppState({ installedAgents: [createMockAgent({ slug: run.agentSlug, mode: "read" })], runs: [run] }));
  renderWithPreflight(run.id, bridge);
  await user.click(await screen.findByRole("button", { name: "Run again" }));
  const dialog = await screen.findByRole("dialog", { name: /Review run/ });
  expect(within(dialog).getByText("Contoso IT")).toBeInTheDocument();
  expect(within(dialog).getByText(/OpenAI.* · hosted/)).toBeInTheDocument();
  expect(within(dialog).getByText("gpt-5")).toBeInTheDocument();
  expect(startRun).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Start run" }));
  await waitFor(() => expect(startRun).toHaveBeenCalledWith(run.agentSlug, expect.objectContaining({ providerId: "openai", model: "gpt-5" })));
  expect(await screen.findByText(/OpenAI Codex isn't ready/)).toBeInTheDocument();
});

it("opens the preflight for Run again on a run with no organization and starts it without a tenant", async () => {
  const user = userEvent.setup();
  const run = { ...createAwaitingConfirmationRun({ status: "completed", plan: undefined }), tenantId: undefined };
  const { activeTenantId: _none, ...state } = createMockAppState({
    installedAgents: [createMockAgent({ slug: run.agentSlug, mode: "read", scopes: [], services: [] })],
    runs: [run],
  });
  const bridge = makeMockBridge({}, { ...state, tenants: [] });
  renderWithPreflight(run.id, bridge);
  await user.click(await screen.findByRole("button", { name: "Run again" }));
  const dialog = await screen.findByRole("dialog", { name: /Review run/ });
  expect(within(dialog).getByRole("status")).toHaveTextContent("No organization needed.");
  expect(screen.queryByRole("radio", { name: "OpenAdminOS app" })).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Start run" }));
  await waitFor(() => expect(bridge.startRun).toHaveBeenCalledOnce());
  expect(vi.mocked(bridge.startRun).mock.calls[0]?.[1]).not.toHaveProperty("tenantId");
});

describe("Run again for a run from another organization (review round 2)", () => {
  const fabrikam = { ...createMockAppState().tenants[0]!, id: "tenant-2", displayName: "Fabrikam" };

  it("offers to switch to the run's organization or run in the active one, instead of a raw refusal", async () => {
    const user = userEvent.setup();
    const run = createAwaitingConfirmationRun({ status: "failed", plan: undefined, tenantId: "tenant-2", providerId: "ollama", model: "llama3.1" });
    const state = createMockAppState({ tenants: [createMockAppState().tenants[0]!, fabrikam], installedAgents: [createMockAgent({ slug: run.agentSlug, mode: "read" })], runs: [run] });
    const bridge = makeMockBridge({}, state);
    renderWithPreflight(run.id, bridge);
    await user.click(await screen.findByRole("button", { name: "Run again" }));
    const dialog = await screen.findByRole("dialog", { name: /This run was in Fabrikam/ });
    expect(dialog).toHaveTextContent("Fabrikam is not the active organization. An agent runs only in the active organization.");
    await user.click(within(dialog).getByRole("button", { name: "Run in Contoso IT" }));
    const review = await screen.findByRole("dialog", { name: /Review run/ });
    expect(within(review).getByText("Contoso IT")).toBeInTheDocument();
    expect(bridge.startRun).not.toHaveBeenCalled();
  });

  it("switches to the run's organization and then opens the review there", async () => {
    const user = userEvent.setup();
    const run = createAwaitingConfirmationRun({ status: "failed", plan: undefined, tenantId: "tenant-2" });
    const state = createMockAppState({ tenants: [createMockAppState().tenants[0]!, fabrikam], installedAgents: [createMockAgent({ slug: run.agentSlug, mode: "read" })], runs: [run] });
    const bridge = makeMockBridge({}, state);
    renderWithPreflight(run.id, bridge);
    await user.click(await screen.findByRole("button", { name: "Run again" }));
    await user.click(within(await screen.findByRole("dialog", { name: /This run was in Fabrikam/ })).getByRole("button", { name: "Switch to Fabrikam" }));
    await waitFor(() => expect(bridge.setActiveOrganization).toHaveBeenCalledWith("org-tenant-2"));
    expect(await screen.findByRole("dialog", { name: /Review run/ })).toBeInTheDocument();
  });

  it("only offers the switch for Run for real of a dry run planned in another organization", async () => {
    const user = userEvent.setup();
    const run = createAwaitingConfirmationRun({ status: "planned", dryRun: true, tenantId: "tenant-2", finishedAt: "2026-10-31T12:00:00Z" });
    const state = createMockAppState({ tenants: [createMockAppState().tenants[0]!, fabrikam], installedAgents: [createMockAgent({ slug: run.agentSlug, mode: "write" })], runs: [run] });
    const bridge = makeMockBridge({}, state);
    renderWithPreflight(run.id, bridge);
    await user.click(await screen.findByRole("button", { name: /Run for real/ }));
    const dialog = await screen.findByRole("dialog", { name: /This run was in Fabrikam/ });
    expect(dialog).toHaveTextContent("Switch to Fabrikam to continue this run there.");
    expect(within(dialog).queryByRole("button", { name: /Run in/ })).not.toBeInTheDocument();
    expect(bridge.startRun).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Switch to Fabrikam" }));
    await waitFor(() => expect(bridge.startRun).toHaveBeenCalledWith(run.agentSlug, expect.objectContaining({ runForRealOfRunId: run.id, tenantId: "tenant-2" })));
    expect(screen.queryByText(/Error invoking remote method/)).not.toBeInTheDocument();
  });

  it("says when the run's organization was removed and offers the active one", async () => {
    const user = userEvent.setup();
    const run = createAwaitingConfirmationRun({ status: "failed", plan: undefined, tenantId: "tenant-gone" });
    const state = createMockAppState({ installedAgents: [createMockAgent({ slug: run.agentSlug, mode: "read" })], runs: [run] });
    renderWithPreflight(run.id, makeMockBridge({}, state));
    await user.click(await screen.findByRole("button", { name: "Run again" }));
    const dialog = await screen.findByRole("dialog", { name: /This run's organization is not on this device/ });
    expect(within(dialog).queryByRole("button", { name: /Switch to/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Run in Contoso IT" })).toBeInTheDocument();
  });
});

describe("applying a plan from another organization (review round 3)", () => {
  const fabrikam = { ...createMockAppState().tenants[0]!, id: "tenant-2", displayName: "Fabrikam" };

  for (const [label, activeTenantId] of [["No organization", undefined], ["another organization", "tenant-2"]] as const) {
    it(`keeps Apply disabled with ${label} active and offers to switch back`, async () => {
      const user = userEvent.setup();
      const run = createAwaitingConfirmationRun({ tenantId: "tenant-1" });
      const { activeTenantId: _active, ...base } = createMockAppState({
        tenants: [createMockAppState().tenants[0]!, fabrikam],
        installedAgents: [createMockAgent({ slug: run.agentSlug, mode: "write" })],
        runs: [run],
      });
      const state = activeTenantId ? { ...base, activeTenantId } : base;
      const bridge = makeMockBridge({}, state);
      renderRoute(<RunResult />, { path: "/runs/:id", route: `/runs/${run.id}`, bridge });
      const alert = (await screen.findAllByRole("alert")).find((element) => element.textContent?.includes("This plan was prepared in Contoso IT"))!;
      expect(alert).toHaveTextContent("Contoso IT is not the active organization, so the plan cannot be applied now. The plan is kept unchanged.");
      await user.type(screen.getByPlaceholderText("Type here to enable Apply"), run.plan!.confirmationPhrase);
      expect(screen.getByRole("button", { name: /^Apply / })).toBeDisabled();
      expect(bridge.confirmRun).not.toHaveBeenCalled();
      await user.click(within(alert).getByRole("button", { name: "Switch to Contoso IT" }));
      await waitFor(() => expect(bridge.setActiveOrganization).toHaveBeenCalledWith("org-tenant-1"));
      // Switching never retargets the plan: no approval or new run was sent.
      expect(bridge.confirmRun).not.toHaveBeenCalled();
      expect(bridge.startRun).not.toHaveBeenCalled();
    });
  }

  it("shows the host's designed refusal when the organization changed during approval", async () => {
    const user = userEvent.setup();
    const run = createAwaitingConfirmationRun({ tenantId: "tenant-1" });
    const message = "This plan was prepared in Contoso IT, which is not the active organization. The plan is kept unchanged. Switch to Contoso IT to review and apply it.";
    const bridge = makeMockBridge(
      { confirmRun: vi.fn(async () => { throw new Error(`Error invoking remote method 'openadminos:confirm-run': OrganizationBoundaryError: ${message}`); }) },
      createMockAppState({ installedAgents: [createMockAgent({ slug: run.agentSlug, mode: "write" })], runs: [run] }),
    );
    renderRoute(<RunResult />, { path: "/runs/:id", route: `/runs/${run.id}`, bridge });
    await user.type(await screen.findByPlaceholderText("Type here to enable Apply"), run.plan!.confirmationPhrase);
    await user.click(screen.getByRole("button", { name: /^Apply / }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText(/Error invoking remote method/)).not.toBeInTheDocument();
  });
});

it("shows a refused Run again start inside the review (review round 3)", async () => {
  const user = userEvent.setup();
  const run = createAwaitingConfirmationRun({ status: "failed", plan: undefined, tenantId: "tenant-1" });
  const startRun = vi.fn(async () => { throw new Error("Ollama isn't reachable. Start it with `ollama serve`, then try again."); });
  const bridge = makeMockBridge({ startRun }, createMockAppState({ installedAgents: [createMockAgent({ slug: run.agentSlug, mode: "read" })], runs: [run] }));
  renderWithPreflight(run.id, bridge);
  await user.click(await screen.findByRole("button", { name: "Run again" }));
  const dialog = await screen.findByRole("dialog", { name: /Review run/ });
  await user.click(within(dialog).getByRole("button", { name: "Start run" }));
  expect(await within(dialog).findByText("The run did not start.")).toBeInTheDocument();
  expect(within(dialog).getByText(/Ollama isn't reachable/)).toBeInTheDocument();
});

it("runs Run for real after Switch from No organization without opening setup (Muse round 3)", async () => {
  const user = userEvent.setup();
  const run = createAwaitingConfirmationRun({ status: "planned", dryRun: true, tenantId: "tenant-1", finishedAt: "2026-10-31T12:00:00Z" });
  const { activeTenantId: _none, ...state } = createMockAppState({
    installedAgents: [createMockAgent({ slug: run.agentSlug, mode: "write" })],
    runs: [run],
  });
  const bridge = makeMockBridge({}, state);
  renderWithPreflight(run.id, bridge);
  await user.click(await screen.findByRole("button", { name: /Run for real/ }));
  const dialog = await screen.findByRole("dialog", { name: /This run was in Contoso IT/ });
  await user.click(within(dialog).getByRole("button", { name: "Switch to Contoso IT" }));
  await waitFor(() => expect(bridge.setActiveOrganization).toHaveBeenCalledWith("org-tenant-1"));
  await waitFor(() =>
    expect(bridge.startRun).toHaveBeenCalledWith(run.agentSlug, expect.objectContaining({ runForRealOfRunId: run.id, tenantId: "tenant-1" })),
  );
  expect(screen.queryByRole("radio", { name: "OpenAdminOS app" })).not.toBeInTheDocument();
  expect(bridge.startRun).toHaveBeenCalledTimes(1);
});

describe("a plan prepared with no organization (Muse round 4)", () => {
  it("keeps Apply disabled under No organization and says the plan stays unchanged", async () => {
    const user = userEvent.setup();
    const { tenantId: _tenant, ...run } = createAwaitingConfirmationRun({});
    const { activeTenantId: _active, ...state } = createMockAppState({
      installedAgents: [createMockAgent({ slug: run.agentSlug, mode: "write" })],
      runs: [run],
    });
    const bridge = makeMockBridge({}, state);
    renderRoute(<RunResult />, { path: "/runs/:id", route: `/runs/${run.id}`, bridge });
    const alert = (await screen.findAllByRole("alert")).find((element) => element.textContent?.includes(RERUN_COPY.planNoOrganizationTitle))!;
    expect(alert).toHaveTextContent(RERUN_COPY.planNoOrganizationBody);
    expect(screen.queryByText(/Apply will be simulated/)).not.toBeInTheDocument();
    expect(screen.queryByText(/This plan was prepared in/)).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Type here to enable Apply"), run.plan!.confirmationPhrase);
    expect(screen.getByRole("button", { name: /^Apply / })).toBeDisabled();
    expect(bridge.confirmRun).not.toHaveBeenCalled();
  });
});

it("says Run again did not continue when the run page closes before the switch lands (Muse round 4)", async () => {
  const user = userEvent.setup();
  const run = createAwaitingConfirmationRun({ status: "planned", dryRun: true, tenantId: "tenant-1", finishedAt: "2026-10-31T12:00:00Z" });
  const { activeTenantId: _none, ...state } = createMockAppState({
    installedAgents: [createMockAgent({ slug: run.agentSlug, mode: "write" })],
    runs: [run],
  });
  // The switch never lands while the page is open.
  const bridge = makeMockBridge({ setActiveOrganization: vi.fn(() => new Promise<never>(() => undefined)) }, state);
  renderWithAppState(
    <Routes>
      <Route path="/runs/:id" element={<RunResult />} />
      <Route path="/runs" element={<div>Runs list</div>} />
    </Routes>,
    { route: `/runs/${run.id}`, bridge },
  );
  await user.click(await screen.findByRole("button", { name: /Run for real/ }));
  const dialog = await screen.findByRole("dialog", { name: /This run was in Contoso IT/ });
  await user.click(within(dialog).getByRole("button", { name: "Switch to Contoso IT" }));
  await waitFor(() => expect(bridge.setActiveOrganization).toHaveBeenCalledWith("org-tenant-1"));
  await user.click(screen.getByRole("button", { name: "Runs" }));
  expect(await screen.findByText("Runs list")).toBeInTheDocument();
  expect(await screen.findByText(RERUN_COPY.rerunNotContinued)).toBeInTheDocument();
  expect(bridge.startRun).not.toHaveBeenCalled();
});
