import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingIntent,
  createPendingIntent,
  readPendingIntent,
  writePendingIntent,
} from "./pending-intent";

describe("pending setup intents", () => {
  beforeEach(() => clearPendingIntent());

  it("persists only safe action metadata", () => {
    const intent = createPendingIntent(
      {
        kind: "chat-send",
        conversationId: "conversation-1",
        returnTo: "/chat/conversation-1",
      },
      new Date("2026-08-07T10:00:00.000Z"),
    );
    writePendingIntent(intent);

    expect(readPendingIntent(Date.parse("2026-08-07T10:01:00.000Z"))).toEqual(intent);
    expect(window.sessionStorage.getItem("openadminos:pending-intent:v1")).not.toContain(
      "question",
    );
  });

  it("drops expired, external, and over-specified values", () => {
    window.sessionStorage.setItem(
      "openadminos:pending-intent:v1",
      JSON.stringify({
        kind: "view-changes",
        returnTo: "https://example.com",
        createdAt: "2026-08-07T10:00:00.000Z",
        prompt: "must not survive validation",
      }),
    );
    expect(readPendingIntent(Date.parse("2026-08-07T10:01:00.000Z"))).toBeNull();

    writePendingIntent(
      createPendingIntent(
        { kind: "view-changes", returnTo: "/changes" },
        new Date("2026-08-07T10:00:00.000Z"),
      ),
    );
    expect(readPendingIntent(Date.parse("2026-08-07T10:31:00.000Z"))).toBeNull();
  });

  it("preserves validated run pinning without accepting unknown providers", () => {
    const intent = createPendingIntent(
      {
        kind: "agent-run",
        slug: "device-offboard",
        tenantId: "tenant-1",
        providerId: "ollama",
        model: "llama3.1",
        returnTo: "/runs/run-1",
      },
      new Date("2026-08-07T10:00:00.000Z"),
    );
    writePendingIntent(intent);
    expect(readPendingIntent(Date.parse("2026-08-07T10:01:00.000Z"))).toEqual(intent);

    window.sessionStorage.setItem(
      "openadminos:pending-intent:v1",
      JSON.stringify({ ...intent, providerId: "untrusted-provider" }),
    );
    expect(readPendingIntent(Date.parse("2026-08-07T10:01:00.000Z"))).toBeNull();
  });

  it("restores only a known scheduled batch mode", () => {
    const intent = createPendingIntent(
      { kind: "scheduled-batch", mode: "due", returnTo: "/agents/schedules" },
      new Date("2026-08-07T10:00:00.000Z"),
    );
    writePendingIntent(intent);
    expect(readPendingIntent(Date.parse("2026-08-07T10:01:00.000Z"))).toEqual(intent);

    window.sessionStorage.setItem(
      "openadminos:pending-intent:v1",
      JSON.stringify({ ...intent, mode: "write" }),
    );
    expect(readPendingIntent(Date.parse("2026-08-07T10:01:00.000Z"))).toBeNull();
  });

  it("rejects an unknown cache resource kind", () => {
    const intent = createPendingIntent(
      { kind: "refresh-cache", resourceKind: "managedDevices", returnTo: "/settings/chat" },
      new Date("2026-08-07T10:00:00.000Z"),
    );
    window.sessionStorage.setItem(
      "openadminos:pending-intent:v1",
      JSON.stringify({ ...intent, resourceKind: "tenantSecrets" }),
    );
    expect(readPendingIntent(Date.parse("2026-08-07T10:01:00.000Z"))).toBeNull();
  });
});
