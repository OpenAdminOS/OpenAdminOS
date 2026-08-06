import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import RunResult from "./RunResult";
import {
  createAwaitingConfirmationRun,
  createMockAgent,
  createMockAppState,
  makeMockBridge,
  renderRoute,
} from "../test/test-utils";

describe("RunResult write confirmation", () => {
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
});
