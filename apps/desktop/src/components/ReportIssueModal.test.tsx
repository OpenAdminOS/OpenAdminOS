import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { installMockBridge, makeMockBridge } from "../test/test-utils";
import {
  SUPPORT_DIAGNOSTICS_TOO_LARGE,
  SUPPORT_PREVIEW_MISMATCH,
} from "../shared/support-issue-errors";
import { ReportIssueProvider, useReportIssue } from "./ReportIssueModal";

const draft = {
  title: "Cache shows a blank page",
  description: "Opening Data settings gives a blank page.",
};

function ReportButton() {
  const report = useReportIssue();
  return <button onClick={() => report(draft)}>Open report</button>;
}

it("shows the prepared title and body and submits only the reviewed diagnostics snapshot", async () => {
  const user = userEvent.setup();
  const preview = {
    previewId: "reviewed-report",
    title: "[Support] Cache shows a blank page",
    body: "### Diagnostics\n```json\n{ \"rows\": \"11-100\" }\n```\n",
  };
  const previewSupportIssue = vi.fn().mockResolvedValue(preview);
  const submitSupportIssue = vi.fn().mockResolvedValue({ issueNumber: 123, issueUrl: "https://example.invalid/123" });
  installMockBridge(makeMockBridge({ previewSupportIssue, submitSupportIssue }));
  render(<ReportIssueProvider><ReportButton /></ReportIssueProvider>);

  await user.click(screen.getByRole("button", { name: "Open report" }));
  const dialog = within(screen.getByRole("dialog", { name: "Report issue" }));
  const submit = dialog.getByRole("button", { name: "Submit public issue" });
  const consent = dialog.getByRole("checkbox", { name: /I understand this creates a public GitHub issue/ });
  expect(dialog.getByRole("checkbox", { name: /Include diagnostics/ })).toBeChecked();
  await user.click(consent);
  expect(submit).toBeDisabled();
  expect(submit).toHaveAccessibleDescription("Open the preview before submitting with diagnostics.");

  await user.click(dialog.getByRole("button", { name: "Preview public issue" }));
  const region = await dialog.findByRole("region", { name: "Public issue preview" });
  expect(dialog.getByText("Public issue preview is ready.")).toHaveAttribute("aria-live", "polite");
  expect(Array.from(region.querySelectorAll("pre"), (text) => text.textContent)).toEqual([
    preview.title,
    preview.body,
  ]);
  expect(previewSupportIssue).toHaveBeenCalledWith(expect.objectContaining({ ...draft, includeDiagnostics: true }));
  expect(submit).toBeEnabled();

  await user.click(dialog.getByRole("button", { name: "Hide public issue preview" }));
  expect(submit).toBeEnabled();
  await user.type(dialog.getByRole("textbox", { name: /Title/ }), " again");
  expect(submit).toBeDisabled();

  await user.click(dialog.getByRole("button", { name: "Preview public issue" }));
  await dialog.findByRole("region", { name: "Public issue preview" });
  await user.click(submit);
  expect(submitSupportIssue).toHaveBeenCalledWith(expect.objectContaining({
    title: `${draft.title} again`,
    description: draft.description,
    confirmPublic: true,
    includeDiagnostics: true,
    previewId: preview.previewId,
  }));
  await dialog.findByText("Public GitHub issue #123 created.");
  expect(submit).toBeDisabled();
  expect(consent).not.toBeChecked();
});

it("lets a confirmed report be submitted without diagnostics or a preview", async () => {
  const user = userEvent.setup();
  const submitSupportIssue = vi.fn().mockResolvedValue({ issueNumber: 123, issueUrl: "https://example.invalid/123" });
  installMockBridge(makeMockBridge({ submitSupportIssue }));
  render(<ReportIssueProvider><ReportButton /></ReportIssueProvider>);

  await user.click(screen.getByRole("button", { name: "Open report" }));
  const dialog = within(screen.getByRole("dialog", { name: "Report issue" }));
  const submit = dialog.getByRole("button", { name: "Submit public issue" });
  await user.click(dialog.getByRole("checkbox", { name: /Include diagnostics/ }));
  expect(submit).toBeDisabled();
  await user.click(dialog.getByRole("checkbox", { name: /I understand this creates a public GitHub issue/ }));
  await user.click(submit);
  expect(submitSupportIssue).toHaveBeenCalledWith(expect.objectContaining({
    confirmPublic: true,
    includeDiagnostics: false,
  }));
});


it("marks the preview button busy until the report is ready", async () => {
  const user = userEvent.setup();
  const preview = { previewId: "id", title: "Title", body: "Body" };
  let finishPreview: (result: typeof preview) => void = () => undefined;
  const previewSupportIssue = vi.fn(() => new Promise<typeof preview>((resolve) => {
    finishPreview = resolve;
  }));
  installMockBridge(makeMockBridge({ previewSupportIssue }));
  render(<ReportIssueProvider><ReportButton /></ReportIssueProvider>);

  await user.click(screen.getByRole("button", { name: "Open report" }));
  const dialog = within(screen.getByRole("dialog", { name: "Report issue" }));
  await user.click(dialog.getByRole("button", { name: "Preview public issue" }));
  expect(dialog.getByRole("button", { name: "Preparing preview..." })).toHaveAttribute("aria-busy", "true");
  finishPreview(preview);
  await dialog.findByRole("region", { name: "Public issue preview" });
  expect(dialog.getByRole("button", { name: "Hide public issue preview" })).toHaveAttribute("aria-busy", "false");
});

it("offers recovery when a preview cannot be prepared because diagnostics are too large", async () => {
  const user = userEvent.setup();
  const previewSupportIssue = vi.fn().mockRejectedValue(new Error("Diagnostics payload is too large."));
  installMockBridge(makeMockBridge({ previewSupportIssue }));
  render(<ReportIssueProvider><ReportButton /></ReportIssueProvider>);

  await user.click(screen.getByRole("button", { name: "Open report" }));
  const dialog = within(screen.getByRole("dialog", { name: "Report issue" }));
  await user.click(dialog.getByRole("button", { name: "Preview public issue" }));
  await dialog.findByText(SUPPORT_DIAGNOSTICS_TOO_LARGE);
  expect(dialog.getByRole("button", { name: "Preview public issue" })).toHaveAttribute("aria-busy", "false");
  expect(dialog.getByRole("button", { name: "Submit public issue" })).toBeDisabled();
});

it.each([
  ["a preview mismatch", SUPPORT_PREVIEW_MISMATCH, SUPPORT_PREVIEW_MISMATCH, true],
  ["oversized diagnostics", "Diagnostics payload is too large.", SUPPORT_DIAGNOSTICS_TOO_LARGE, true],
  [
    "a duplicate report",
    "A matching report was already submitted. Look for it in recent OpenAdminOS GitHub issues.",
    "A matching report was already submitted. Look for it in recent OpenAdminOS GitHub issues.",
    false,
  ],
  [
    "a rate limit",
    "The support server received too many reports. Wait an hour before trying again.",
    "The support server received too many reports. Wait an hour before trying again.",
    false,
  ],
])("handles %s and keeps the draft available", async (_label, error, recovery, reset) => {
  const user = userEvent.setup();
  const previewSupportIssue = vi.fn().mockResolvedValue({ previewId: "id", title: "Title", body: "Body" });
  const submitSupportIssue = vi.fn()
    .mockRejectedValueOnce(new Error(`Error invoking remote method 'openadminos:submit-support-issue': Error: ${error}`))
    .mockResolvedValue({ issueNumber: 123, issueUrl: "https://example.invalid/123" });
  installMockBridge(makeMockBridge({ previewSupportIssue, submitSupportIssue }));
  render(<ReportIssueProvider><ReportButton /></ReportIssueProvider>);

  await user.click(screen.getByRole("button", { name: "Open report" }));
  const dialog = within(screen.getByRole("dialog", { name: "Report issue" }));
  await user.click(dialog.getByRole("checkbox", { name: /I understand this creates a public GitHub issue/ }));
  await user.click(dialog.getByRole("button", { name: "Preview public issue" }));
  await dialog.findByRole("region", { name: "Public issue preview" });
  const submit = dialog.getByRole("button", { name: "Submit public issue" });
  await user.click(submit);
  const errorMessage = await dialog.findByText(recovery);
  expect(errorMessage.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
  expect(dialog.getByRole("textbox", { name: /Title/ })).toHaveValue(draft.title);
  if (reset) {
    expect(dialog.queryByRole("region", { name: "Public issue preview" })).toBeNull();
    expect(submit).toBeDisabled();
    await user.click(dialog.getByRole("checkbox", { name: /Include diagnostics/ }));
    await user.click(submit);
    expect(submitSupportIssue).toHaveBeenLastCalledWith(expect.objectContaining({
      confirmPublic: true, includeDiagnostics: false,
    }));
    expect(submitSupportIssue.mock.lastCall?.[0]).not.toHaveProperty("previewId");
  } else {
    expect(dialog.getByRole("region", { name: "Public issue preview" })).toBeVisible();
    expect(submit).toBeEnabled();
  }
});
