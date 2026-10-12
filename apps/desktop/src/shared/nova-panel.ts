export const OPEN_NOVA_EVENT = "openadminos:open-nova";

export function openNovaPanel() {
  window.dispatchEvent(new CustomEvent(OPEN_NOVA_EVENT));
}
