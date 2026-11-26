import { DEFAULT_NOVA_KEY, NOVA_KEY_TAKEN, novaKeyProblem } from "../src/shared/nova-keyboard.js";

export class NovaWindowShortcut {
  private registered?: string;
  error?: string;

  get activeKey(): string | null { return this.registered ?? null; }

  constructor(private readonly host: {
    register(accelerator: string, callback: () => void): boolean;
    unregister(accelerator: string): void;
  }, private readonly toggle: () => void, private readonly wayland = false) {}

  update(configuration: string | null | undefined): void {
    const key = configuration === undefined ? DEFAULT_NOVA_KEY : configuration;
    this.error = undefined;
    if (key === this.registered) return;
    if (key) {
      this.error = novaKeyProblem(key);
      if (this.error) return;
      try {
        if (!this.host.register(key, this.toggle)) {
          this.error = this.wayland
            ? "Nova could not bind this shortcut through the Wayland global shortcuts portal. Check your desktop shortcut permissions, record another shortcut, or use Alt+V in OpenAdminOS."
            : NOVA_KEY_TAKEN;
          return;
        }
      } catch (error) {
        console.warn("[nova] Shortcut registration failed", error);
        this.error = this.wayland
          ? "Nova could not bind this shortcut through the Wayland global shortcuts portal. Check your desktop shortcut permissions or use Alt+V in OpenAdminOS."
          : NOVA_KEY_TAKEN;
        return;
      }
    }
    const previous = this.registered;
    this.registered = key ?? undefined;
    if (previous) this.host.unregister(previous);
  }
}
