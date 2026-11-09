import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderLogo, providerLogoKind } from "./ProviderLogo";

/** Provider marks (assets/provider-logos/NOTICE.md). */
describe("ProviderLogo", () => {
  it("shows the vendor logo only where its guidelines allow a third party to, and a neutral mark otherwise", () => {
    for (const id of ["ollama", "lm-studio", "copilot"]) expect(providerLogoKind(id), id).toBe("logo");
    // Anthropic, OpenAI and Google need prior approval, Azure icons are for diagrams and docs, Apple does not allow its logo.
    for (const id of ["anthropic", "openai", "gemini", "azure-openai", "apple-foundation"]) expect(providerLogoKind(id), id).toBe("neutral");
  });

  it("gives a logo a light and a dark variant, decorative next to a visible name", () => {
    const { container } = render(<ProviderLogo provider="lm-studio" size={20} />);
    const mark = container.querySelector("[data-provider-logo='lm-studio']")!;
    expect(mark).toHaveAttribute("aria-hidden", "true");
    const images = mark.querySelectorAll("img");
    expect(images).toHaveLength(2);
    // Vite may inline the files; the two variants are distinct and switch on the appearance.
    expect(images[0]).toHaveClass("provider-logo-light");
    expect(images[1]).toHaveClass("provider-logo-dark");
    expect(images[0]!.getAttribute("src")).not.toBe(images[1]!.getAttribute("src"));
    for (const image of images) expect(image).toHaveAttribute("alt", "");
  });

  it("names the provider when no visible name sits next to the mark", () => {
    render(<ProviderLogo provider="copilot" label="GitHub Copilot CLI" />);
    expect(screen.getByRole("img", { name: "GitHub Copilot CLI" })).toBeInTheDocument();
  });

  it("keeps a neutral mark for Apple Intelligence, never the Apple logo", () => {
    const { container } = render(<ProviderLogo provider="apple-foundation" />);
    const mark = container.querySelector("[data-provider-logo='apple-foundation']")!;
    expect(mark).toHaveAttribute("data-kind", "neutral");
    expect(mark.textContent).toBe("Ai");
    expect(mark.querySelector("img")).toBeNull();
  });
});
