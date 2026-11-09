import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ProviderId } from "../shared/openAdminOS";
import { ProviderLogo, providerLogoKind } from "./ProviderLogo";
import { ServiceLogo, ServiceMark, serviceLogoKind } from "./ServiceMark";

// Every ProviderId: a provider added to the union without a logo fails to type-check here.
const PROVIDERS: Record<ProviderId, true> = {
  ollama: true,
  "apple-foundation": true,
  "lm-studio": true,
  anthropic: true,
  openai: true,
  "azure-openai": true,
  copilot: true,
  gemini: true,
};
const PROVIDER_IDS = Object.keys(PROVIDERS);
const SERVICES = ["intune", "entra", "defender"] as const;

/** Provider and service logos (assets/provider-logos/NOTICE.md, assets/service-logos/NOTICE.md; maintainer decision, 2026-11-09). */
describe("ProviderLogo", () => {
  it("shows the vendor's logo for every provider, and a neutral mark only for an unknown one", () => {
    for (const id of PROVIDER_IDS) {
      expect(providerLogoKind(id), id).toBe("logo");
      const { container, unmount } = render(<ProviderLogo provider={id} />);
      const mark = container.querySelector(`[data-provider-logo='${id}']`)!;
      expect(mark, id).toHaveAttribute("data-kind", "logo");
      expect(mark.querySelector("img")?.getAttribute("src"), id).toBeTruthy();
      unmount();
    }
    expect(providerLogoKind("someday-provider")).toBe("neutral");
    const { container } = render(<ProviderLogo provider="someday-provider" />);
    expect(container.querySelector("[data-kind='neutral']")).toHaveTextContent("so");
  });

  it("switches a vendor's light and dark variants with the appearance, and shows a single official file in both", () => {
    for (const id of ["ollama", "lm-studio", "copilot", "openai"]) {
      const { container, unmount } = render(<ProviderLogo provider={id} size={20} />);
      const images = container.querySelectorAll("img");
      expect(images, id).toHaveLength(2);
      // Vite may inline the files; the two variants are distinct and switch on the appearance.
      expect(images[0]).toHaveClass("provider-logo-light");
      expect(images[1]).toHaveClass("provider-logo-dark");
      expect(images[0]!.getAttribute("src")).not.toBe(images[1]!.getAttribute("src"));
      unmount();
    }
    for (const id of ["anthropic", "gemini", "azure-openai", "apple-foundation"]) {
      const { container, unmount } = render(<ProviderLogo provider={id} size={20} />);
      const images = container.querySelectorAll("img");
      expect(images, id).toHaveLength(1);
      expect(images[0]).not.toHaveClass("provider-logo-light");
      expect(images[0]).not.toHaveClass("provider-logo-dark");
      unmount();
    }
  });

  it("is decorative next to a visible name, and named when it stands alone", () => {
    const { container } = render(<ProviderLogo provider="anthropic" />);
    expect(container.querySelector("[data-provider-logo='anthropic']")).toHaveAttribute("aria-hidden", "true");
    for (const image of container.querySelectorAll("img")) expect(image).toHaveAttribute("alt", "");
    render(<ProviderLogo provider="openai" label="Codex" />);
    expect(screen.getByRole("img", { name: "Codex" })).toBeInTheDocument();
  });
});

describe("ServiceMark", () => {
  it("shows Microsoft's icon for Intune, Entra and Defender, in both appearances, and letters for another service", () => {
    for (const id of SERVICES) {
      expect(serviceLogoKind(id), id).toBe("logo");
      const { container, unmount } = render(<ServiceMark service={id} title={id} size={22} />);
      const logo = container.querySelector(`[data-service-logo='${id}']`)!;
      expect(logo, id).toHaveAttribute("data-kind", "logo");
      const images = logo.querySelectorAll("img");
      // One official colour file that Microsoft provides for light and dark surfaces alike.
      expect(images, id).toHaveLength(1);
      expect(images[0]!.getAttribute("src"), id).toBeTruthy();
      expect(images[0]).toHaveAttribute("alt", "");
      unmount();
    }
    expect(serviceLogoKind("jamf")).toBe("neutral");
    const { container } = render(<ServiceLogo service="jamf" title="Jamf Pro" size={16} />);
    expect(container.querySelector("[data-kind='neutral']")).toHaveTextContent("Ja");
  });

  it("keeps a service that is not connected dashed, with the icon unchanged inside", () => {
    const { container } = render(<ServiceMark service="intune" title="Intune" size={30} off />);
    const mark = container.querySelector(".service-mark")!;
    expect(mark).toHaveAttribute("data-off", "true");
    expect(mark.querySelector("img")).not.toBeNull();
  });

  it("is decorative next to a visible name, and named when it stands alone", () => {
    const { container } = render(<ServiceMark service="entra" title="Entra" />);
    expect(container.querySelector(".service-mark")).toHaveAttribute("aria-hidden", "true");
    render(<ServiceMark service="defender" title="Defender" label="Defender" />);
    expect(screen.getByRole("img", { name: "Defender" })).toBeInTheDocument();
  });
});
