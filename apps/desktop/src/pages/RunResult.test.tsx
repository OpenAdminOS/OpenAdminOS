import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Routes, Route, useLocation } from "react-router";

import RunResult from "./RunResult";
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
    await screen.findByRole("dialog");
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

it("opens terminal runs in the URL-addressable run drawer", async () => {
  const run = createAwaitingConfirmationRun({
    status: "completed",
    plan: undefined,
    finishedAt: "2026-10-10T10:01:00.000Z",
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

  expect(await screen.findByRole("dialog", { name: "Device Offboard" })).toBeInTheDocument();
  expect(screen.getByRole("tablist", { name: "Run detail views" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Telemetry" })).toBeInTheDocument();
});

it("opens queued and running runs in the live run modal", async () => {
  const run = createAwaitingConfirmationRun({
    status: "running",
    plan: undefined,
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

  expect(await screen.findByRole("dialog", { name: "Live run: Device Offboard" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Run in background" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel run" })).toBeInTheDocument();
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

it('shows a failed rerun reason instead of silently leaving the result unchanged', async () => {
  const user = userEvent.setup();
  const run = createAwaitingConfirmationRun({ status: 'failed', plan: undefined });
  const bridge = makeMockBridge({ startRun: vi.fn(async () => { throw new Error('Ollama is unavailable. Start Ollama and try again.'); }) }, createMockAppState({ installedAgents: [createMockAgent({ slug: run.agentSlug, mode: 'read' })], runs: [run] }));
  renderRoute(<RunResult />, { path: '/runs/:id', route: `/runs/${run.id}`, bridge });
  await user.click(await screen.findByRole('button', { name: 'Run again' }));
  expect(await screen.findByText('Ollama is unavailable. Start Ollama and try again.')).toBeInTheDocument();
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
