import { classifyNetworkFailure } from "./network-failure.js";

function proxyAuthDetail(at: string, status?: number): string {
  return `A proxy asked for credentials while checking ${at}${status === undefined ? "" : ` (HTTP ${status})`}. Check proxy authentication and bypass settings, then try again.`;
}

interface ModelServerCheck {
  name: string;
  endpoint: string;
  endpointSetting?: string;
  defaultPort: string;
  isLocal: boolean;
  startHint: string;
}

export function describeModelServerCheckFailure(
  server: ModelServerCheck,
  error: unknown,
  options: { httpStatus?: number; stopped?: boolean } = {},
): { notRunning: boolean; detail: string } {
  const { name, endpoint, endpointSetting, defaultPort, isLocal, startHint } = server;
  const { httpStatus, stopped } = options;
  const at = `${name} on ${endpoint}`;
  const checkAddress = endpointSetting
    ? `Check ${endpointSetting}, then try again.`
    : "Check that the server is running at that address, then try again.";
  // JSON parse errors can contain excerpts of the answer. Never classify or display those excerpts.
  const kind = error instanceof SyntaxError && httpStatus !== undefined ? undefined : classifyNetworkFailure(error);
  const notRunning = kind === "refused" && isLocal && httpStatus === undefined && !stopped;
  const result = (detail: string) => ({ notRunning, detail });

  if (stopped) return result(`The check for ${at} was stopped. Try again to check the server.`);
  switch (kind) {
    case "refused":
      return result(`The connection to ${at} was refused. ${notRunning ? startHint : checkAddress}`);
    case "blocked-port": {
      const port = URL.parse(endpoint)?.port;
      const recovery = endpointSetting
        ? `Set ${endpointSetting} to the server's listening address on an allowed port, then try again.`
        : "Use the server's listening address on an allowed port, then try again.";
      return result(`OpenAdminOS could not check ${at} because ${port ? `port ${port} is blocked` : "the port is blocked"}. ${name}'s default port is ${defaultPort}. ${recovery}`);
    }
    case "dns":
      return result(`The host name for ${at} could not be resolved. Check DNS and ${endpointSetting ?? "the server address"}, then try again.`);
    case "unreachable":
      return result(`The network route to ${at} is unavailable. Check the address and network connection, then try again.`);
    case "reset":
      return result(`The connection to ${at} was interrupted. Check that the server is running and the network connection is stable, then try again.`);
    case "certificate":
      return result(`The TLS certificate for ${at} could not be verified. Check the certificate and this device's trust settings, then try again.`);
    case "tls":
      return result(`The TLS connection to ${at} failed. Check that the URL scheme matches the server and that HTTPS is configured correctly, then try again.`);
    case "proxy-auth":
      return result(proxyAuthDetail(at, httpStatus));
    case "proxy":
      return result(`A proxy connection failed while checking ${at}. Check proxy and bypass settings, then try again.`);
    case "offline":
      return result(`OpenAdminOS could not reach ${at} while this device is offline. Connect to a network, then try again.`);
    case "timeout":
      return result(`${at} did not answer in time. Check that the server is running and responsive, then try again.`);
    default:
      return result(httpStatus === undefined
        ? `OpenAdminOS could not connect to ${at}. ${checkAddress}`
        : `${at} answered with a response OpenAdminOS could not read (HTTP ${httpStatus}). Check that the endpoint serves the ${name} model list, then try again.`);
  }
}

export function modelServerHttpFailure(name: string, endpoint: string, status: number, recovery?: string): string {
  if (status === 407) {
    return proxyAuthDetail(`${name} on ${endpoint}`, status);
  }
  return `${name} on ${endpoint} responded with HTTP ${status}. ${recovery ?? "Check the server address and configuration, then try again."}`;
}
