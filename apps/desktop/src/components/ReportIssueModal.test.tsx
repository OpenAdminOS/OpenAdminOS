import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { installMockBridge, makeMockBridge } from "../test/test-utils";
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
  expect(dialog.getByRole("checkbox", { name: /Include the sanitized diagnostics/ })).toBeChecked();
  await user.click(consent);
  expect(submit).toBeDisabled();

  await user.click(dialog.getByRole("button", { name: "Preview public issue" }));
  const region = await dialog.findByRole("region", { name: "Public issue preview" });
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
});

it("lets a confirmed report be submitted without diagnostics or a preview", async () => {
  const user = userEvent.setup();
  const submitSupportIssue = vi.fn().mockResolvedValue({ issueNumber: 123, issueUrl: "https://example.invalid/123" });
  installMockBridge(makeMockBridge({ submitSupportIssue }));
  render(<ReportIssueProvider><ReportButton /></ReportIssueProvider>);

  await user.click(screen.getByRole("button", { name: "Open report" }));
  const dialog = within(screen.getByRole("dialog", { name: "Report issue" }));
  const submit = dialog.getByRole("button", { name: "Submit public issue" });
  await user.click(dialog.getByRole("checkbox", { name: /Include the sanitized diagnostics/ }));
  expect(submit).toBeDisabled();
  await user.click(dialog.getByRole("checkbox", { name: /I understand this creates a public GitHub issue/ }));
  await user.click(submit);
  expect(submitSupportIssue).toHaveBeenCalledWith(expect.objectContaining({
    confirmPublic: true,
    includeDiagnostics: false,
  }));
});
