import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import Cache from "../pages/Cache";
import { LocalResetIncomplete, LocalResetNotice } from "../setup/LocalReset";
import { installMockBridge, makeMockBridge, renderRoute } from "../test/test-utils";
import { ResetOpenAdminOSDialog } from "./ResetOpenAdminOSDialog";

const PHRASE = "RESET OPENADMINOS";
const DATA_FOLDER = "/Users/admin/Library/Application Support/OpenAdminOS";

function renderDialog(overrides: Parameters<typeof makeMockBridge>[0] = {}) {
  const bridge = installMockBridge(makeMockBridge(overrides));
  const onClose = vi.fn();
  render(<ResetOpenAdminOSDialog open onClose={onClose} />);
  return { bridge, onClose, user: userEvent.setup() };
}

describe("Reset OpenAdminOS dialog", () => {
  it("opens from Settings, Data", async () => {
    renderRoute(<Cache />, { route: "/cache", path: "/cache" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Reset OpenAdminOS" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Permanent local deletion");
  });

  it("names what is removed and what stays, including consent in Entra", async () => {
    renderDialog({
      getLocalResetInfo: vi.fn(async () => ({
        dataFolder: "/Users/admin/Library/Application Support/OpenAdminOS",
        packaged: true,
        platform: "macos" as const,
        policyFilePresent: true,
      })),
    });
    const dialog = await screen.findByRole("dialog");
    expect(await screen.findByText("/Users/admin/Library/Application Support/OpenAdminOS")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Every organization and its Microsoft sign-in tokens");
    expect(dialog).toHaveTextContent('The Keychain item "OpenAdminOS Safe Storage"');
    expect(dialog).toHaveTextContent("admin consent granted to it stay in each tenant");
    expect(dialog).toHaveTextContent("The IT policy file (policy.json)");
    expect(screen.getByRole("button", { name: "How to revoke access in Entra" })).toBeInTheDocument();
  });

  it("says a development build leaves the Keychain item and the installed app's caches alone", async () => {
    renderDialog({
      getLocalResetInfo: vi.fn(async () => ({ dataFolder: "/tmp/dev-profile", packaged: false, platform: "macos" as const, policyFilePresent: false })),
    });
    expect(await screen.findByText(/Development build: the Keychain item/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).not.toHaveTextContent('The Keychain item "OpenAdminOS Safe Storage"');
    expect(screen.getByRole("dialog")).not.toHaveTextContent("The IT policy file");
  });

  it("keeps Reset disabled until the exact phrase is typed", async () => {
    const { bridge, user } = renderDialog();
    await screen.findByText(DATA_FOLDER);
    const input = screen.getByLabelText(`Type ${PHRASE} to confirm`);
    const button = screen.getByRole("button", { name: "Reset and restart" });
    expect(button).toBeDisabled();
    for (const wrong of ["reset openadminos", "RESET OPENADMIN", `${PHRASE} `, ` ${PHRASE}`]) {
      await user.clear(input);
      await user.type(input, wrong);
      expect(button).toBeDisabled();
    }
    await user.keyboard("{Enter}");
    expect(bridge.resetOpenAdminOS).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, PHRASE);
    expect(button).toBeEnabled();
  });

  it("keeps Reset off until it can say what is removed, and loads it again on Try again", async () => {
    const getLocalResetInfo = vi.fn()
      .mockRejectedValueOnce(new Error("Error invoking remote method 'openadminos:get-local-reset-info': Error: gone"))
      .mockResolvedValue({ dataFolder: "/data", packaged: true, platform: "macos" as const, policyFilePresent: false });
    const { user } = renderDialog({ getLocalResetInfo });
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded, so Reset stays off");
    await user.type(screen.getByLabelText(`Type ${PHRASE} to confirm`), PHRASE);
    expect(screen.getByRole("button", { name: "Reset and restart" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("/data")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset and restart" })).toBeEnabled();
  });

  it("sends the phrase and shows that the app restarts", async () => {
    const { bridge, user } = renderDialog();
    await screen.findByText(DATA_FOLDER);
    await user.type(screen.getByLabelText(`Type ${PHRASE} to confirm`), PHRASE);
    await user.click(screen.getByRole("button", { name: "Reset and restart" }));
    expect(bridge.resetOpenAdminOS).toHaveBeenCalledWith(PHRASE);
    expect(await screen.findByText(/Reset started. OpenAdminOS is closing/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resetting" })).toBeDisabled();
  });

  it("shows why the reset did not start, with nothing removed, and allows another try", async () => {
    const { user } = renderDialog({
      resetOpenAdminOS: vi.fn(async () => {
        throw new Error("Error invoking remote method 'openadminos:reset-openadminos': LocalResetRequestError: Stale device cleanup is applying a confirmed change. Wait for it to finish, then reset. Nothing was removed.");
      }),
    });
    await screen.findByText(DATA_FOLDER);
    await user.type(screen.getByLabelText(`Type ${PHRASE} to confirm`), PHRASE);
    await user.click(screen.getByRole("button", { name: "Reset and restart" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Stale device cleanup is applying a confirmed change. Wait for it to finish, then reset. Nothing was removed.");
    expect(alert).not.toHaveTextContent("Error invoking remote method");
    expect(screen.getByRole("button", { name: "Reset and restart" })).toBeEnabled();
  });
});

describe("long refusals", () => {
  it("shows a refusal from the main process in full, however long", async () => {
    const reason = "The reset could not start: the data folder is a link, holds another mount, or could not be read in full, so emptying it could reach files elsewhere and OpenAdminOS does not empty it. Remove its files by hand, as described in Uninstall and reset. Nothing was removed.";
    expect(reason.length).toBeGreaterThan(240);
    const { user } = renderDialog({
      resetOpenAdminOS: vi.fn(async () => {
        throw new Error(`Error invoking remote method 'openadminos:reset-openadminos': LocalResetRequestError: ${reason}`);
      }),
    });
    await screen.findByText(DATA_FOLDER);
    await user.type(screen.getByLabelText(`Type ${PHRASE} to confirm`), PHRASE);
    await user.click(screen.getByRole("button", { name: "Reset and restart" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(reason);
  });
});

describe("after a reset", () => {
  it("shows what was removed and what could not be, and dismisses", async () => {
    const bridge = installMockBridge(makeMockBridge({
      getLocalResetReport: vi.fn(async () => ({
        status: "completed" as const,
        finishedAt: "2026-11-19T10:00:00.000Z",
        dataFolder: "/data",
        failed: [],
        warnings: [{ item: 'Keychain item "OpenAdminOS Safe Storage"', reason: "security exited with code 51" }],
      })),
    }));
    render(<LocalResetNotice />);
    expect(await screen.findByText("OpenAdminOS was reset")).toBeInTheDocument();
    expect(screen.getByText(/security exited with code 51/)).toBeInTheDocument();
    // The warnings scroll inside a bounded list that the keyboard can reach.
    const warnings = screen.getByRole("list", { name: "Could not remove" });
    expect(warnings).toHaveAttribute("tabindex", "0");
    expect(warnings.className).toMatch(/overflow-y-auto/);
    expect(warnings.className).toMatch(/max-h-/);
    expect(screen.getByRole("status")).toHaveTextContent("Admin consent stays in each tenant");
    await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("OpenAdminOS was reset")).not.toBeInTheDocument();
    expect(bridge.dismissLocalResetReport).toHaveBeenCalled();
  });

  it("shows nothing without a reset", async () => {
    const bridge = installMockBridge(makeMockBridge());
    render(<LocalResetNotice />);
    await act(async () => undefined);
    expect(bridge.getLocalResetReport).toHaveBeenCalled();
    expect(screen.queryByText("OpenAdminOS was reset")).not.toBeInTheDocument();
  });

  it("keeps the app closed when the reset did not finish, listing what is left", async () => {
    const retry = vi.fn(async () => undefined);
    const quit = vi.fn(async () => undefined);
    installMockBridge(makeMockBridge({
      getLocalResetReport: vi.fn(async () => ({
        status: "incomplete" as const,
        finishedAt: "2026-11-19T10:00:00.000Z",
        dataFolder: "C:\\Users\\admin\\AppData\\Roaming\\OpenAdminOS",
        failed: [{ item: "openadminos.db", reason: "the file is in use by another program or cannot be changed" }],
        warnings: [],
      })),
      retryLocalReset: retry,
      quitAfterIncompleteReset: quit,
    }));
    render(<LocalResetIncomplete />);
    expect(await screen.findByText("openadminos.db")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reset did not finish" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await user.click(screen.getByRole("button", { name: "Quit" }));
    await waitFor(() => expect(retry).toHaveBeenCalled());
    expect(quit).toHaveBeenCalled();
  });
});
