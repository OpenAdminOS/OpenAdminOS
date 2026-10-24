import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import {
  ConversationWorkspaceProvider,
  useConversations,
} from "../state/conversations";
import { makeMockBridge, renderWithAppState } from "../test/test-utils";
import Workspaces from "./Workspaces";

describe("embedded Workspaces", () => {
  it("consumes a shell create request once", async () => {
    const user = userEvent.setup();
    renderWithAppState(
      <ConversationWorkspaceProvider>
        <WorkspaceCreateHarness />
      </ConversationWorkspaceProvider>,
      { route: "/chat?panel=workspaces", bridge: makeMockBridge() },
    );

    await user.click(screen.getByRole("button", { name: "Request create workspace" }));
    expect(screen.getByRole("dialog", { name: "Create workspace" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Hide workspaces" }));
    await user.click(screen.getByRole("button", { name: "Show workspaces" }));
    expect(screen.queryByRole("dialog", { name: "Create workspace" })).not.toBeInTheDocument();
  });
});

function WorkspaceCreateHarness() {
  const [visible, setVisible] = useState(true);
  const {
    workspaceCreateRequest,
    requestWorkspaceCreate,
    consumeWorkspaceCreateRequest,
  } = useConversations();
  return (
    <>
      <button type="button" onClick={requestWorkspaceCreate}>
        Request create workspace
      </button>
      <button type="button" onClick={() => setVisible((current) => !current)}>
        {visible ? "Hide workspaces" : "Show workspaces"}
      </button>
      {visible ? (
        <Workspaces
          embedded
          createRequest={workspaceCreateRequest}
          onCreateRequestConsumed={consumeWorkspaceCreateRequest}
        />
      ) : null}
    </>
  );
}
