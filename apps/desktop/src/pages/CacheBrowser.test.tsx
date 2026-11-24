import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { cacheBrowserErrorCopy } from "../copy/errors";
import { makeMockBridge } from "../test/test-utils";
import { CacheBrowser } from "./CacheBrowser";

it("retries a failed row read and closes the preview when a refresh removes the row", async () => {
  const readGraphCacheRow = vi.fn()
    .mockRejectedValueOnce(new Error("Storage unavailable"))
    .mockResolvedValueOnce({ status: "unreadable" })
    .mockResolvedValueOnce({ status: "missing" });
  const browseGraphCache = vi.fn()
    .mockResolvedValueOnce({ offset: 0, total: 1, rows: [{ id: "a", name: "Sample", user: null }] })
    .mockResolvedValueOnce({ offset: 0, total: 0, rows: [] });
  vi.stubGlobal("openAdminOS", makeMockBridge({ readGraphCacheRow, browseGraphCache }));
  try {
    const resource = { resource: "users" as const, label: "Users", rows: 1, scopeSet: [] };
    const props = { tenantId: "tenant-1", tenantName: "Contoso", resource, onClose: vi.fn(),
      onConnections: vi.fn(), onClear: vi.fn(), formatDateTime: String };
    const view = render(<CacheBrowser {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: "View JSON for Sample" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not read this cached row");
    expect(screen.getByRole("button", { name: "Close details" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry row" }));
    expect(await screen.findByText("This row could not be read.")).toBeInTheDocument();
    view.rerender(<CacheBrowser {...props} resource={{ ...resource, rows: 0, refreshedAt: "2026-11-24T10:00:00Z" }} />);
    expect(await screen.findByText("This row is no longer in the cache.")).toBeInTheDocument();
    await screen.findByText("No rows cached");
    expect(screen.getByRole("searchbox")).toHaveFocus();
    expect(screen.queryByRole("region", { name: "Cached row JSON" })).not.toBeInTheDocument();
    expect(readGraphCacheRow).toHaveBeenCalledTimes(3);
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  ["Select the connected organization.", "Open connections", "Select or connect"],
  ["The organization is disconnecting or is not ready.", "Open connections", "disconnecting"],
  ["Unknown cache resource.", "Return to Data", "resource is unavailable"],
  ["Invalid cache page range.", "Return to Data", "request is invalid"],
  ["Storage unavailable", "Retry", "Local storage"],
])("maps wrapped IPC errors for %s", (reason, label, copy) => {
  const result = cacheBrowserErrorCopy(new Error(`Error invoking remote method 'cache:browse': Error: ${reason}`));
  expect(result.action.label).toBe(label);
  expect(result.what).toContain(copy);
});

it("keeps focus in the results when the next page fails", async () => {
  const browseGraphCache = vi.fn()
    .mockResolvedValueOnce({ offset: 0, total: 101, rows: [{ id: "a", name: "Sample", user: null }] })
    .mockRejectedValueOnce(new Error("Local storage unavailable"));
  vi.stubGlobal("openAdminOS", makeMockBridge({ browseGraphCache }));
  try {
    render(<CacheBrowser tenantId="tenant-1" tenantName="Contoso"
      resource={{ resource: "users", label: "Users", rows: 101, scopeSet: [] }}
      onClose={vi.fn()} onConnections={vi.fn()} onClear={vi.fn()} formatDateTime={String} />);
    await userEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Local storage could not return the cached rows");
    expect(screen.getByRole("region", { name: "Cache browser results" })).toHaveFocus();
  } finally {
    vi.unstubAllGlobals();
  }
});
