/**
 * Every reason a sandbox refuses or stops a run. Each one has a designed
 * message with a recovery step; there is no generic failure.
 */
export type RefusalReason =
  | "config-invalid"
  | "file-permissions"
  | "certificate-unreadable"
  | "certificate-not-yet-valid"
  | "certificate-expired"
  | "agent-not-found"
  | "agent-not-bundled"
  | "agent-hash-mismatch"
  | "agent-manifest-invalid"
  | "agent-not-read"
  | "agent-not-template"
  | "agent-uses-connectors"
  | "agent-step-not-allowed"
  | "model-endpoint-not-local"
  | "model-unreachable"
  | "model-not-pulled"
  | "model-cloud"
  | "model-timeout"
  | "audit-failed"
  | "signin-certificate-not-registered"
  | "signin-app-disabled"
  | "signin-app-not-found"
  | "signin-blocked-by-conditional-access"
  | "signin-client-assertion-expired"
  | "signin-failed"
  | "token-undecodable"
  | "identity-not-app"
  | "identity-tenant-mismatch"
  | "identity-client-mismatch"
  | "identity-audience-not-graph"
  | "identity-has-directory-roles"
  | "identity-has-no-roles"
  | "identity-can-change-tenant"
  | "identity-holds-secret-permission"
  | "identity-holds-unneeded-permission"
  | "identity-allowlist-incomplete"
  | "identity-missing-permission"
  | "graph-request-refused"
  | "graph-unauthorized"
  | "graph-forbidden"
  | "graph-throttled"
  | "run-deadline"
  | "run-stopped"
  | "run-failed"
  | "already-running"
  | "storage-failed"
  | "platform-not-supported"
  | "model-endpoint-socket"
  | "delivery-failed";

export class SandboxRefusal extends Error {
  constructor(
    readonly reason: RefusalReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SandboxRefusal";
  }
}

export function isSandboxRefusal(error: unknown): error is SandboxRefusal {
  return error instanceof SandboxRefusal;
}

/** The named reason and message for a sign-in failure, by its AADSTS code. */
export function signInRefusal(aadsts: string | undefined, detail: string): SandboxRefusal {
  switch (aadsts) {
    case "AADSTS700027":
      return new SandboxRefusal(
        "signin-certificate-not-registered",
        "Microsoft sign-in did not accept the certificate (AADSTS700027): it is not registered on the app registration. Upload the certificate's public part under Certificates & secrets, then run the setup check again.",
      );
    case "AADSTS7000112":
      return new SandboxRefusal(
        "signin-app-disabled",
        "Microsoft sign-in refused the app (AADSTS7000112): the application is disabled. Enable the service principal under Enterprise applications, or ask the tenant admin why it was disabled.",
      );
    case "AADSTS700016":
      return new SandboxRefusal(
        "signin-app-not-found",
        "Microsoft sign-in did not find the app (AADSTS700016) in this tenant. Check clientId and tenantId in the sandbox config, and that the app has a service principal in the tenant.",
      );
    case "AADSTS53003":
      return new SandboxRefusal(
        "signin-blocked-by-conditional-access",
        "Conditional Access blocked the sandbox sign-in (AADSTS53003). Check the workload identity policy for this app and the network location of this machine.",
      );
    case "AADSTS700024":
      return new SandboxRefusal(
        "signin-client-assertion-expired",
        "Microsoft sign-in found the client assertion outside its validity (AADSTS700024). Check that the clock of this machine is synchronized, then run again.",
      );
    case undefined:
      return new SandboxRefusal(
        "signin-failed",
        `Microsoft sign-in did not return a token: ${detail} Check the network connection to login.microsoftonline.com, then run again.`,
      );
    default:
      return new SandboxRefusal(
        "signin-failed",
        `Microsoft sign-in refused the request with ${aadsts}. Look the code up in the Microsoft Entra error reference and check the app registration, then run again.`,
      );
  }
}
