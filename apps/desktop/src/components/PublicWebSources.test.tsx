import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { PublicWebSources } from "./PublicWebSources";
import type { IntuneChatToolTraceEntry } from "../shared/openAdminOS";
it("renders unique provider citations as accessible external links and rejects unsafe URLs", () => {
  const trace = [{ webSources: [
    { title: "Vendor guidance", url: "https://learn.microsoft.com/windows" },
    { title: "Duplicate", url: "https://learn.microsoft.com/windows" },
    { title: "Unsafe", url: "javascript:alert(1)" },
    { title: "Credentials", url: "https://user:pass@example.com" },
  ] }] as IntuneChatToolTraceEntry[];
  render(<PublicWebSources trace={trace} />);
  expect(screen.getByRole("region", { name: "Public web sources" })).toBeVisible();
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link")).toHaveAttribute("href", "https://learn.microsoft.com/windows");
  expect(screen.getByRole("link")).toHaveAttribute("target", "_blank");
});
