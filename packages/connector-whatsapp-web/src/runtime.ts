import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "baileys";
import pino from "pino";
import QRCode from "qrcode";

import type {
  SendWhatsAppWebMessageArgs,
  WhatsAppWebGroupRef,
  WhatsAppWebHealth,
  WhatsAppWebMessageRef,
  WhatsAppWebStatus,
} from "./capabilities.js";

type BaileysSocket = ReturnType<typeof makeWASocket>;
type StatusListener = (status: WhatsAppWebStatus) => void;

export class WhatsAppWebNotLinkedError extends Error {
  constructor(message = "WhatsApp Web is not linked. Open Connectors and scan the QR code.") {
    super(message);
    this.name = "WhatsAppWebNotLinkedError";
  }
}

export class WhatsAppWebValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppWebValidationError";
  }
}

export interface WhatsAppWebClientOptions {
  authDir: string;
}

const clients = new Map<string, WhatsAppWebClient>();
const silentLogger = pino({ level: "silent" });
const POST_PAIRING_RESTART_STATUS = 515;
const CONNECTION_TIMEOUT_STATUS = 408;
const QR_AUTO_REFRESH_MS = 55_000;
const QR_STABILIZE_MS = 800;
const MAX_QR_STABILIZE_ATTEMPTS = 3;
const SUPPRESSED_CONSOLE_PREFIXES = [
  "Closing session:",
  "Opening session:",
  "Removing old closed session:",
  "Session already closed",
  "Session already open",
] as const;
const SOCKET_TIMING = {
  keepAliveIntervalMs: 25_000,
  connectTimeoutMs: 60_000,
  defaultQueryTimeoutMs: 60_000,
} as const;
let consoleSuppressionInstalled = false;

export const WHATSAPP_WEB_QR_AUTO_REFRESH_MS = QR_AUTO_REFRESH_MS;

export function getWhatsAppWebClient(
  options: WhatsAppWebClientOptions,
): WhatsAppWebClient {
  installWhatsAppConsoleSuppression();
  const authDir = resolve(options.authDir);
  let client = clients.get(authDir);
  if (!client) {
    client = new WhatsAppWebClient({ authDir });
    clients.set(authDir, client);
  }
  return client;
}

export class WhatsAppWebClient {
  private readonly authDir: string;
  private socket: BaileysSocket | undefined;
  private opening: Promise<void> | undefined;
  private qrVersion = 0;
  private socketGeneration = 0;
  private qrRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private status: WhatsAppWebStatus;
  private readonly listeners = new Set<StatusListener>();

  constructor(options: WhatsAppWebClientOptions) {
    this.authDir = resolve(options.authDir);
    this.status = this.hasAuthState()
      ? {
          state: "reconnecting",
          message: "Restoring the saved WhatsApp Web session.",
        }
      : {
          state: "not-linked",
          message: "WhatsApp Web is not linked on this device.",
        };
    this.restoreSessionInBackground();
  }

  getStatus(): WhatsAppWebStatus {
    this.restoreSessionInBackground();
    return { ...this.status };
  }

  hasAuthState(): boolean {
    return existsSync(join(this.authDir, "creds.json"));
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async startLogin(): Promise<WhatsAppWebStatus> {
    if (this.status.state === "connected") {
      return this.getStatus();
    }
    if (this.status.state === "qr") {
      await this.replaceSocketForFreshLogin("Refreshing WhatsApp Web QR code.");
    } else {
      await this.ensureSocket();
    }
    const status = await this.waitForStatus(
      (status) =>
        status.state === "qr" ||
        status.state === "connected" ||
        status.state === "logged-out" ||
        status.state === "error",
      20_000,
      "Timed out waiting for WhatsApp Web to produce a QR code.",
    );
    return this.waitForStableQr(status);
  }

  async checkHealth(timeoutMs = 25_000): Promise<WhatsAppWebHealth> {
    if (!this.hasAuthState()) {
      return {
        healthy: false,
        message: "WhatsApp Web is not linked. Open Connectors and scan the QR code.",
      };
    }
    try {
      await this.waitForConnected(timeoutMs);
      return { healthy: true, message: "Connected to WhatsApp Web." };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async restoreSession(timeoutMs = 0): Promise<WhatsAppWebStatus> {
    if (!this.hasAuthState()) {
      if (
        this.status.state !== "not-linked" &&
        this.status.state !== "logged-out"
      ) {
        this.setStatus({
          state: "not-linked",
          message: "WhatsApp Web is not linked on this device.",
        });
      }
      return this.getStatus();
    }
    if (this.status.state === "connected" || this.status.state === "qr") {
      return this.getStatus();
    }
    await this.ensureSocket();
    if (timeoutMs <= 0) {
      return this.getStatus();
    }
    try {
      return await this.waitForStatus(
        (status) =>
          status.state === "connected" ||
          status.state === "qr" ||
          status.state === "logged-out" ||
          status.state === "not-linked" ||
          status.state === "error",
        timeoutMs,
        "Timed out waiting for WhatsApp Web to restore the saved session.",
      );
    } catch {
      return this.getStatus();
    }
  }

  async sendMessage(
    args: SendWhatsAppWebMessageArgs,
  ): Promise<WhatsAppWebMessageRef> {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) {
      throw new WhatsAppWebValidationError(
        "sendMessage requires a non-empty text body.",
      );
    }
    await this.waitForConnected(30_000);
    if (!this.socket) {
      throw new Error("WhatsApp Web socket was not available after connection.");
    }
    const to = resolveWhatsAppRecipient(args.to, this.socket);
    const response = await this.socket.sendMessage(to.toJid, { text });
    const messageId = readWhatsAppMessageId(response);
    return {
      messageId,
      to: to.display,
      targetType: to.targetType,
    };
  }

  async listGroups(): Promise<WhatsAppWebGroupRef[]> {
    await this.waitForConnected(30_000);
    if (!this.socket) {
      throw new Error("WhatsApp Web socket was not available after connection.");
    }
    const groups = await this.socket.groupFetchAllParticipating();
    return Object.values(groups)
      .map((group) => {
        const participantCount =
          typeof group.size === "number"
            ? group.size
            : Array.isArray(group.participants)
              ? group.participants.length
              : undefined;
        return {
          id: group.id,
          subject: group.subject?.trim() || "Untitled group",
          ...(participantCount !== undefined ? { participantCount } : {}),
          ...(typeof group.announce === "boolean"
            ? { announce: group.announce }
            : {}),
        };
      })
      .filter((group) => group.id.endsWith("@g.us"))
      .sort((a, b) => a.subject.localeCompare(b.subject));
  }

  async disconnect(): Promise<WhatsAppWebStatus> {
    this.socketGeneration += 1;
    this.qrVersion += 1;
    this.clearQrRefreshTimer();
    const socket = this.socket;
    this.socket = undefined;
    this.opening = undefined;
    try {
      await socket?.logout();
    } catch {
      // Local removal below is the source of truth for this device.
    }
    await rm(this.authDir, { recursive: true, force: true });
    this.setStatus({
      state: "not-linked",
      message: "WhatsApp Web was disconnected on this device.",
    });
    return this.getStatus();
  }

  dispose(): void {
    this.socketGeneration += 1;
    this.qrVersion += 1;
    this.clearQrRefreshTimer();
    try {
      this.socket?.end(new Error("WhatsApp Web client disposed."));
    } catch {
      // Baileys can already be closed during app shutdown.
    }
    this.socket = undefined;
    this.opening = undefined;
  }

  private restoreSessionInBackground(): void {
    if (!this.hasAuthState()) return;
    if (this.status.state === "connected" || this.status.state === "qr") return;
    if (this.socket || this.opening) return;
    void this.restoreSession().catch((error) => {
      this.setStatus({
        state: "error",
        message: "WhatsApp Web saved session restore failed.",
        lastError: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async waitForConnected(timeoutMs: number): Promise<WhatsAppWebStatus> {
    if (this.status.state === "connected") return this.getStatus();
    if (!this.hasAuthState()) {
      throw new WhatsAppWebNotLinkedError();
    }
    await this.ensureSocket();
    const current = this.getStatus();
    if (current.state === "connected") return current;
    const status = await this.waitForStatus(
      (next) =>
        next.state === "connected" ||
        next.state === "qr" ||
        next.state === "not-linked" ||
        next.state === "logged-out" ||
        next.state === "error",
      timeoutMs,
      "Timed out waiting for WhatsApp Web to reconnect.",
    );
    if (status.state === "connected") return status;
    if (
      status.state === "qr" ||
      status.state === "not-linked" ||
      status.state === "logged-out"
    ) {
      throw new WhatsAppWebNotLinkedError(status.message);
    }
    throw new Error(status.lastError ?? status.message);
  }

  private async ensureSocket(): Promise<void> {
    if (this.socket && this.status.state !== "logged-out" && this.status.state !== "error") {
      return;
    }
    if (this.opening) return this.opening;
    this.opening = this.createSocket().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async createSocket(): Promise<void> {
    const socketGeneration = this.socketGeneration + 1;
    this.socketGeneration = socketGeneration;
    await mkdir(this.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    this.setStatus({
      state: this.hasAuthState() ? "reconnecting" : "connecting",
      message: this.hasAuthState()
        ? "Reconnecting to WhatsApp Web."
        : "Waiting for WhatsApp Web to provide a QR code.",
    });
    const { version } = await fetchLatestBaileysVersion();
    const socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
      },
      browser: ["OpenAdminOS", "Desktop", "0.2.3"],
      logger: silentLogger,
      markOnlineOnConnect: false,
      printQRInTerminal: false,
      syncFullHistory: false,
      version,
      ...SOCKET_TIMING,
    });
    this.socket = socket;
    socket.ev.on("creds.update", () => {
      if (this.socketGeneration !== socketGeneration) return;
      void saveCreds();
    });
    socket.ev.on("connection.update", (update) => {
      if (this.socketGeneration !== socketGeneration) return;
      void this.handleConnectionUpdate(update).catch((error) => {
        if (this.socketGeneration !== socketGeneration) return;
        this.setStatus({
          state: "error",
          message: "WhatsApp Web connection update failed.",
          lastError: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  private async replaceSocketForFreshLogin(message: string): Promise<void> {
    this.socketGeneration += 1;
    this.qrVersion += 1;
    this.clearQrRefreshTimer();
    const socket = this.socket;
    this.socket = undefined;
    this.opening = undefined;
    try {
      socket?.end(new Error("Refreshing WhatsApp Web QR code."));
    } catch {
      // The old socket can already be closed by Baileys.
    }
    await rm(this.authDir, { recursive: true, force: true });
    this.setStatus({
      state: "connecting",
      message,
    });
    await this.ensureSocket();
  }

  private scheduleQrRefresh(qrVersion: number): void {
    this.clearQrRefreshTimer();
    this.qrRefreshTimer = setTimeout(() => {
      if (this.status.state !== "qr" || this.qrVersion !== qrVersion) return;
      void this.replaceSocketForFreshLogin(
        "QR code expired before it was scanned. Generating a fresh code.",
      ).catch((error) => {
        this.setStatus({
          state: "error",
          message: "WhatsApp Web QR refresh failed.",
          lastError: error instanceof Error ? error.message : String(error),
        });
      });
    }, QR_AUTO_REFRESH_MS);
    this.qrRefreshTimer.unref?.();
  }

  private clearQrRefreshTimer(): void {
    if (!this.qrRefreshTimer) return;
    clearTimeout(this.qrRefreshTimer);
    this.qrRefreshTimer = undefined;
  }

  private async handleConnectionUpdate(update: {
    connection?: string;
    qr?: string;
    lastDisconnect?: { error?: unknown };
  }): Promise<void> {
    if (update.qr) {
      const qrVersion = this.qrVersion + 1;
      this.qrVersion = qrVersion;
      const qrDataUrl = await QRCode.toDataURL(update.qr, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 280,
        color: { dark: "#0f172a", light: "#ffffff" },
      });
      if (this.qrVersion !== qrVersion) {
        return;
      }
      const qrIssuedAt = new Date();
      const status = createWhatsAppQrStatus({
        qrDataUrl,
        issuedAt: qrIssuedAt,
      });
      this.setStatus(status);
      this.scheduleQrRefresh(qrVersion);
    }

    if (update.connection === "connecting" && this.status.state !== "qr") {
      this.setStatus({
        state: this.hasAuthState() ? "reconnecting" : "connecting",
        message: this.hasAuthState()
          ? "Reconnecting to WhatsApp Web."
          : "Connecting to WhatsApp Web.",
      });
    }

    if (update.connection === "open") {
      const status: WhatsAppWebStatus = {
        state: "connected",
        message: "Linked and ready to send WhatsApp notifications.",
        lastConnectedAt: new Date().toISOString(),
      };
      this.setStatus(status);
    }

    if (update.connection === "close") {
      const statusCode = readDisconnectStatus(update.lastDisconnect?.error);
      const rawMessage = readErrorMessage(update.lastDisconnect?.error);
      this.socket = undefined;
      const restartAfterPairing =
        statusCode === POST_PAIRING_RESTART_STATUS ||
        statusCode === CONNECTION_TIMEOUT_STATUS;
      if (statusCode === DisconnectReason.loggedOut) {
        await rm(this.authDir, { recursive: true, force: true });
        this.setStatus({
          state: "logged-out",
          message: "WhatsApp logged out this device. Scan a new QR code to link again.",
          ...(rawMessage ? { lastError: rawMessage } : {}),
        });
        return;
      }

      const hasAuth = this.hasAuthState();
      this.setStatus({
        state: hasAuth ? "reconnecting" : "not-linked",
        message: restartAfterPairing
          ? "WhatsApp Web asked for a fresh socket after pairing. Reconnecting."
          : hasAuth
            ? "WhatsApp Web disconnected. Reconnecting in the background."
            : "WhatsApp Web is not linked on this device.",
        ...(rawMessage ? { lastError: rawMessage } : {}),
      });
      if (hasAuth || restartAfterPairing) {
        const reconnectGeneration = this.socketGeneration;
        setTimeout(() => {
          if (this.socketGeneration !== reconnectGeneration) return;
          void this.ensureSocket().catch((error) => {
            this.setStatus({
              state: "error",
              message: "WhatsApp Web reconnect failed.",
              lastError: error instanceof Error ? error.message : String(error),
            });
          });
        }, 2_000);
      }
    }
  }

  private waitForStatus(
    predicate: (status: WhatsAppWebStatus) => boolean,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<WhatsAppWebStatus> {
    const current = this.getStatus();
    if (predicate(current)) return Promise.resolve(current);
    return new Promise((resolveWait, rejectWait) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(listener);
        rejectWait(new Error(timeoutMessage));
      }, timeoutMs);
      const listener: StatusListener = (status) => {
        if (!predicate(status)) return;
        clearTimeout(timeout);
        this.listeners.delete(listener);
        resolveWait({ ...status });
      };
      this.listeners.add(listener);
    });
  }

  private async waitForStableQr(status: WhatsAppWebStatus): Promise<WhatsAppWebStatus> {
    let current = status;
    if (current.state !== "qr") return current;

    for (let attempt = 0; attempt < MAX_QR_STABILIZE_ATTEMPTS; attempt += 1) {
      const version = this.qrVersion;
      await sleep(QR_STABILIZE_MS);
      const next = this.getStatus();
      if (next.state !== "qr") return next;
      current = next;
      if (this.qrVersion === version) return current;
    }

    return current;
  }

  private setStatus(status: WhatsAppWebStatus): void {
    if (status.state !== "qr") {
      this.clearQrRefreshTimer();
    }
    this.status = status;
    for (const listener of this.listeners) {
      listener(this.getStatus());
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function resolveWhatsAppRecipient(
  input: string | undefined,
  socket: { user?: { id?: string | undefined } | undefined },
): {
  toJid: string;
  display: string;
  targetType: WhatsAppWebMessageRef["targetType"];
} {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) {
    throw new WhatsAppWebValidationError("WhatsApp recipient is required.");
  }
  if (value.toLowerCase() === "self" || value.toLowerCase() === "me") {
    const selfJid = jidNormalizedUser(socket.user?.id);
    if (!selfJid) {
      throw new WhatsAppWebValidationError(
        "WhatsApp Web is linked, but the current account id was not available yet. Try again in a few seconds.",
      );
    }
    return {
      toJid: selfJid,
      display: "My WhatsApp",
      targetType: "self",
    };
  }
  if (value.endsWith("@s.whatsapp.net") || value.endsWith("@g.us")) {
    return {
      toJid: value,
      display: value.endsWith("@g.us") ? "WhatsApp group" : "WhatsApp recipient",
      targetType: value.endsWith("@g.us") ? "group" : "manual",
    };
  }
  const digits = value.replace(/[^\d]/g, "");
  if (digits.length < 6) {
    throw new WhatsAppWebValidationError(
      "WhatsApp recipient must include a country code, for example +15551234567.",
    );
  }
  return {
    toJid: `${digits}@s.whatsapp.net`,
    display: "WhatsApp recipient",
    targetType: "manual",
  };
}

export function createWhatsAppQrStatus(input: {
  qrDataUrl: string;
  issuedAt: Date;
  refreshMs?: number;
}): WhatsAppWebStatus {
  const refreshMs = input.refreshMs ?? QR_AUTO_REFRESH_MS;
  return {
    state: "qr",
    message:
      "Scan this QR code with WhatsApp on your phone. It refreshes automatically.",
    qrDataUrl: input.qrDataUrl,
    qrIssuedAt: input.issuedAt.toISOString(),
    qrRefreshesAt: new Date(input.issuedAt.getTime() + refreshMs).toISOString(),
  };
}

export function readWhatsAppMessageId(response: unknown): string {
  const id =
    response &&
    typeof response === "object" &&
    "key" in response &&
    response.key &&
    typeof response.key === "object" &&
    "id" in response.key &&
    typeof response.key.id === "string" &&
    response.key.id.trim().length > 0
      ? response.key.id.trim()
      : undefined;
  if (!id) {
    throw new Error("WhatsApp Web returned a send response without a message id.");
  }
  return id;
}

function readDisconnectStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const output = (error as { output?: { statusCode?: unknown } }).output;
  return typeof output?.statusCode === "number" ? output.statusCode : undefined;
}

function readErrorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof Error) return error.message;
  return String(error);
}

function installWhatsAppConsoleSuppression(): void {
  if (consoleSuppressionInstalled) return;
  consoleSuppressionInstalled = true;
  const originalInfo = console.info.bind(console);
  console.info = (...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (SUPPRESSED_CONSOLE_PREFIXES.some((prefix) => first.startsWith(prefix))) {
      return;
    }
    originalInfo(...args);
  };
}
