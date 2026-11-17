// The named errors of the host APIs. Kept apart so the UI validation can use them without the host.

export type EnterpriseHostErrorCode =
  | "invalid-name"
  | "duplicate"
  | "limit"
  | "invalid-value"
  | "disposed"
  | "expired";

export class EnterpriseHostError extends Error {
  readonly code: EnterpriseHostErrorCode;
  constructor(code: EnterpriseHostErrorCode, message: string) {
    super(message);
    this.name = "EnterpriseHostError";
    this.code = code;
  }
}

/** The app keeps no more schedule placements, so a move away is refused before the module is asked. */
export class EnterprisePlacementsFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnterprisePlacementsFullError";
  }
}
