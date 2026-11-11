/**
 * The refusal when the gateway is asked to bind to an organization that is
 * not connected on this device, or is being disconnected. Shared by the
 * main process, which throws it, and Settings, which shows it as is.
 */
export const GATEWAY_TENANT_NOT_CONNECTED_COPY =
  "That organization is no longer connected on this device, so the gateway was not turned on. Select a connected organization, then turn on Enable gateway again.";
