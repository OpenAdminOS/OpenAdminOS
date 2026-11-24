import { novaPages } from "../src/shared/nova-command.js";
import { NOVA_DOCUMENTATION_SETTINGS } from "../src/shared/nova-session.js";

const novaRoutes = new Set<string>([...Object.values(novaPages), NOVA_DOCUMENTATION_SETTINGS]);

export function novaWindowRoute(value: unknown): string {
  if (typeof value === "string" && (novaRoutes.has(value) ||
    /^\/runs\/run_[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value))) return value;
  throw new Error("Nova cannot open this page because the destination is outside its supported app routes.");
}

export async function handleNovaWindow<T extends { id: number }>(sender: T, action: unknown, payload: unknown, host: {
  bubble?: T;
  main?: T;
  visible(): boolean;
  claim(id: number, microphone: boolean): Promise<void>;
  openMain(route?: string): Promise<void>;
  transfer(payload: string | undefined): void;
  hide(): void;
  other(action: unknown, fromBubble: boolean): Promise<string | undefined> | string | undefined;
}): Promise<string | undefined> {
  const fromBubble = sender === host.bubble;
  if (!fromBubble && sender !== host.main) throw new Error("Open Nova in the main window or the floating window.");
  if (action === "claim" || action === "claim-typed") {
    if (fromBubble && !host.visible()) throw new Error("Show the floating window before starting Nova.");
    await host.claim(sender.id, action === "claim");
    return;
  }
  if (fromBubble && (action === "open-main" || action === "open-page")) {
    const route = action === "open-page" ? novaWindowRoute(payload) : undefined;
    await host.openMain(route);
    if (action === "open-main") {
      host.transfer(typeof payload === "string" && payload.length <= 2_000_000 ? payload :
        payload === undefined ? undefined : JSON.stringify({ notice: "Conversation could not carry over because it is too long." }));
    }
    host.hide();
    return;
  }
  return host.other(action, fromBubble);
}

export async function showMainWindow<T extends { isDestroyed(): boolean; isMinimized(): boolean; restore(): void; show(): void; focus(): void }>(
  current: T | null, create: () => Promise<T>, navigate: () => void,
) {
  if (!current || current.isDestroyed()) {
    const opened = await create();
    if (opened.isDestroyed()) throw new Error("OpenAdminOS closed before the window could open. Try again.");
    opened.show();
    opened.focus();
    return;
  }
  if (current.isMinimized()) current.restore();
  current.show();
  current.focus();
  navigate();
}
