import type { FixtureSpec } from "./checks.js";

// Mirrors `ManagedDeviceRecord` in `@openadminos/agent-sdk`. When the SDK
// adds or removes a field on `ManagedDeviceRecord`, update this list so the
// QA gate keeps tracking the actual fixture surface against Graph.
export const managedDeviceFixture: FixtureSpec = {
  resourceName: "managedDevice",
  fixtureName: "ManagedDeviceRecord",
  fields: [
    { name: "id", primitiveKind: "string" },
    { name: "deviceName", primitiveKind: "string" },
    { name: "userPrincipalName", primitiveKind: "string" },
    { name: "operatingSystem", primitiveKind: "string" },
    { name: "osVersion", primitiveKind: "string" },
    { name: "lastSyncDateTime", primitiveKind: "string-date" },
    { name: "enrolledDateTime", primitiveKind: "string-date" },
    { name: "complianceState", primitiveKind: "complex" },
  ],
};
