import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReferenceLogo, ReferenceMark, referenceLogoId, referenceMarkText } from "./ServiceMark";
import { createMockMcpServers } from "../test/test-utils";

describe("reference marks (design round review)", () => {
  it("lead with the host's brand, so they never collide with provider marks", () => {
    expect(referenceMarkText("learn.microsoft.com")).toBe("ML");
    expect(referenceMarkText("www.kqlsearch.com")).toBe("KQ");
    expect(referenceMarkText("www.intuneautomation.com")).toBe("IN");
    // Microsoft Learn's host never takes LM, the letters of LM Studio.
    expect(referenceMarkText("LM Studio")).toBe("LS");
    expect(referenceMarkText("learn.microsoft.com")).not.toBe("LM");
    expect(referenceMarkText("Microsoft Teams")).toBe("MT");
  });
});

describe("reference logos", () => {
  it("shows the owner's logo for every public reference host in the Marketplace", () => {
    // A listing that names its own logo is drawn by ListingMark, not looked up by host.
    const hosts = createMockMcpServers().filter((server) => !server.logo).map((server) => server.host);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(referenceLogoId(host), host).toBeDefined();
    expect(referenceLogoId("learn.microsoft.com")).toBe("microsoft");
    expect(referenceLogoId("www.microsoft.com")).toBe("microsoft");
    expect(referenceLogoId(" Learn.Microsoft.com. ")).toBe("microsoft");
  });

  it("shows the service's logo for every result connector, by the name it goes by", () => {
    for (const name of ["Microsoft Teams", "Outlook", "Slack", "Discord", "Signal", "WhatsApp", "WhatsApp Web"]) {
      expect(referenceLogoId(name), name).toBeDefined();
    }
    expect(referenceLogoId("WhatsApp Web")).toBe(referenceLogoId("WhatsApp"));
  });

  it("keeps two letters for a host or connector it does not know, and for a lookalike domain", () => {
    for (const name of ["mcp.example.org", "learn-microsoft.com", "microsoft.com.example.org", "notsplashtop.com", "Webhook", "slack.example.org", "constructor", "__proto__", "toString", "learn.microsoft.com.example.org.", "learn.microsoft.com:443"]) {
      expect(referenceLogoId(name), name).toBeUndefined();
    }
    const { container } = render(<ReferenceMark name="mcp.example.org" />);
    const mark = container.querySelector(".svc-mark")!;
    expect(mark).toHaveTextContent("EM");
    expect(mark.querySelector("img")).toBeNull();
  });

  it("renders the logo as a decorative image on the reference tile, and nothing on a tile that is off", () => {
    const { container, rerender } = render(<ReferenceMark name="www.kqlsearch.com" />);
    const mark = container.querySelector('.svc-mark[data-service="reference"]')!;
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark.querySelector('[data-reference-logo="kqlsearch"][data-kind="logo"] img')).not.toBeNull();
    expect(mark.textContent).toBe("");
    rerender(<ReferenceMark name="www.kqlsearch.com" off />);
    const off = container.querySelector(".svc-mark")!;
    expect(off).toHaveAttribute("data-off", "true");
    expect(off.querySelector("img")).toBeNull();
  });

  it("switches to the owner's dark-surface file with the theme, except on a tile that is always white", () => {
    const { container, rerender } = render(<ReferenceLogo name="Signal" size={20} />);
    expect(container.querySelectorAll("img")).toHaveLength(2);
    expect(container.querySelector("img.provider-logo-light")).not.toBeNull();
    expect(container.querySelector("img.provider-logo-dark")).not.toBeNull();
    rerender(<ReferenceLogo name="Signal" size={30} surface="light" />);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img.provider-logo-dark")).toBeNull();
    // A reference whose icon needs a white tile keeps the tile white in both themes.
    rerender(<ReferenceMark name="www.kqlsearch.com" />);
    expect(container.querySelector(".svc-mark")).toHaveAttribute("data-tile", "white");
    rerender(<ReferenceMark name="Slack" />);
    expect(container.querySelector(".svc-mark")).not.toHaveAttribute("data-tile");
  });
});
