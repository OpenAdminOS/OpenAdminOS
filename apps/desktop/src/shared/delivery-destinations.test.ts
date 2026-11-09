import { describe, expect, it } from "vitest";

import { deliveryBlock } from "./delivery-destinations";

describe("deliveryBlock (review round 4)", () => {
  it("blocks only what the host refuses before anything leaves the device", () => {
    expect(deliveryBlock("slack", { slack: { enabled: false } }, {}, true)).toBe("rule-off");
    expect(deliveryBlock("teams", { teams: { enabled: true } }, {}, false)).toBe("no-organization");
    expect(deliveryBlock("outlook", { outlook: { enabled: true } }, {}, false)).toBe("no-organization");
    expect(deliveryBlock("teams", { teams: { enabled: true } }, { defaultTeamId: "t", defaultChannelId: "c" }, true)).toBeUndefined();
    expect(deliveryBlock("outlook", { outlook: { enabled: true, useDefaultRecipients: false, recipients: [" "] } }, {}, true)).toBe("no-target");
    expect(deliveryBlock("outlook", { outlook: { enabled: true } }, { defaultRecipients: "it@contoso.test" }, true)).toBeUndefined();
    expect(deliveryBlock("whatsappWeb", { whatsappWeb: { enabled: true, useDefaultRecipient: false } }, {}, true)).toBe("no-target");
    // The default WhatsApp recipient falls back to the linked account.
    expect(deliveryBlock("whatsappWeb", { whatsappWeb: { enabled: true } }, {}, true)).toBeUndefined();
    expect(deliveryBlock("signal", { signal: { enabled: true } }, {}, true)).toBe("no-default-target");
    expect(deliveryBlock("signal", { signal: { enabled: true, useDefaultRecipient: false, recipient: "+15550100" } }, {}, true)).toBeUndefined();
    expect(deliveryBlock("discord", { discord: { enabled: true } }, {}, true)).toBeUndefined();
    // Slack and Signal without a run organization still send.
    expect(deliveryBlock("slack", { slack: { enabled: true, useDefaultChannel: false, channel: "C1" } }, {}, false)).toBeUndefined();
  });

  it("does not rule out a saved default destination before the configuration is known", () => {
    expect(deliveryBlock("slack", { slack: { enabled: true } }, undefined, true)).toBeUndefined();
    expect(deliveryBlock("slack", { slack: { enabled: true } }, {}, true)).toBe("no-default-target");
  });
});

describe("deliveryBlock for Teams and Outlook targets (Muse round 5)", () => {
  it("needs a team and a channel for Teams", () => {
    const custom = (teamId?: string, channelId?: string) =>
      deliveryBlock("teams", { teams: { enabled: true, useDefaultTarget: false, ...(teamId ? { teamId } : {}), ...(channelId ? { channelId } : {}) } }, {}, true);
    expect(custom("team", "channel")).toBeUndefined();
    expect(custom("team")).toBe("no-target");
    expect(custom(undefined, "channel")).toBe("no-target");
    expect(custom(" ", "channel")).toBe("no-target");
    expect(deliveryBlock("teams", { teams: { enabled: true } }, {}, true)).toBe("no-default-target");
    expect(deliveryBlock("teams", { teams: { enabled: true } }, { defaultTeamId: "team" }, true)).toBe("no-default-target");
    // Before the configuration is known, a saved default is not ruled out.
    expect(deliveryBlock("teams", { teams: { enabled: true } }, undefined, true)).toBeUndefined();
  });

  it("needs a default recipient for Outlook's default recipients", () => {
    expect(deliveryBlock("outlook", { outlook: { enabled: true } }, {}, true)).toBe("no-default-target");
    expect(deliveryBlock("outlook", { outlook: { enabled: true } }, { defaultRecipients: " ;, \n" }, true)).toBe("no-default-target");
    expect(deliveryBlock("outlook", { outlook: { enabled: true } }, { defaultRecipients: "a@contoso.test; b@contoso.test" }, true)).toBeUndefined();
    expect(deliveryBlock("outlook", { outlook: { enabled: true } }, undefined, true)).toBeUndefined();
  });
});
