import { ENTERPRISE_INTERFACE_VERSION, type EnterpriseModule } from "./interface.js";

/**
 * The module a build from this repository uses. It registers nothing and
 * returns no handle, so the app stays exactly the free app.
 */
export const defaultEnterpriseModule: EnterpriseModule = Object.freeze({
  interfaceVersion: ENTERPRISE_INTERFACE_VERSION,
  activate: () => undefined,
});

/** A module that declares an interface version this host does not implement. */
export class EnterpriseInterfaceVersionError extends Error {
  readonly expected: number;
  readonly received: unknown;
  constructor(received: unknown) {
    super(
      `The team features module was built for interface version ${String(received)}, ` +
        `but this app implements version ${ENTERPRISE_INTERFACE_VERSION}. Team features stay off.`,
    );
    this.name = "EnterpriseInterfaceVersionError";
    this.expected = ENTERPRISE_INTERFACE_VERSION;
    this.received = received;
  }
}

/** Checks the shape of an imported module without calling it. */
export function isEnterpriseModule(value: unknown): value is EnterpriseModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { interfaceVersion?: unknown }).interfaceVersion === "number" &&
    typeof (value as { activate?: unknown }).activate === "function"
  );
}
