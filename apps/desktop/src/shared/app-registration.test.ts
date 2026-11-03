import { describe, expect, it } from "vitest";
import { tenantRegistrationSummary } from "./app-registration";
import type { TenantRecord } from "./openAdminOS";

const tenant = (appRegistration: TenantRecord["appRegistration"], kind?: "sample"): TenantRecord =>
  ({
    id: "tenant-1",
    displayName: "Contoso",
    username: "admin@contoso.example",
    homeAccountId: "home",
    addedAt: "2026-11-03T10:00:00.000Z",
    ...(kind ? { kind } : {}),
    ...(appRegistration ? { appRegistration } : {}),
  }) as TenantRecord;

describe("tenantRegistrationSummary", () => {
  it("names the OpenAdminOS app only for its own client ID", () => {
    expect(
      tenantRegistrationSummary(tenant({ kind: "openadminos", clientId: "d1de0a94-f67a-421d-8804-a235955ffd69" })),
    ).toEqual({
      text: "OpenAdminOS app",
      title: "OpenAdminOS app, client ID d1de0a94-f67a-421d-8804-a235955ffd69",
    });
  });

  it("names tenants pinned to the legacy Graph CLI client after that app", () => {
    const summary = tenantRegistrationSummary(
      tenant({ kind: "openadminos", clientId: "14d82eec-204b-4c2f-b7e8-296a70dab67e" }),
    );
    expect(summary?.text).toBe("Microsoft Graph Command Line Tools");
    expect(summary?.title).toContain("client ID 14d82eec-204b-4c2f-b7e8-296a70dab67e");
  });

  it("falls back to a neutral label for any other default-kind client", () => {
    expect(
      tenantRegistrationSummary(tenant({ kind: "openadminos", clientId: "99999999-8888-4777-8666-555555555555" })),
    ).toEqual({
      text: "App registration · 99999999…",
      title: "App registration, client ID 99999999-8888-4777-8666-555555555555",
    });
  });

  it("shows nothing for the pilot tenant or a tenant without a registration", () => {
    expect(tenantRegistrationSummary(tenant(undefined, "sample"))).toBeNull();
    expect(tenantRegistrationSummary(tenant(undefined))).toBeNull();
  });
});
