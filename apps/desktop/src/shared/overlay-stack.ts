interface OverlayEntry {
  id: string;
  onEscape: () => void;
}
const stack: OverlayEntry[] = [];
let listening = false;

function handleKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  const top = stack.at(-1);
  if (!top) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  top.onEscape();
}

function syncListener(): void {
  if (stack.length > 0 && !listening) {
    window.addEventListener("keydown", handleKeyDown, true);
    listening = true;
  } else if (stack.length === 0 && listening) {
    window.removeEventListener("keydown", handleKeyDown, true);
    listening = false;
  }
}

export function registerOverlay(entry: OverlayEntry): () => void {
  const existing = stack.findIndex((candidate) => candidate.id === entry.id);
  if (existing >= 0) stack.splice(existing, 1);
  stack.push(entry);
  syncListener();
  return () => {
    const index = stack.findIndex((candidate) => candidate.id === entry.id);
    if (index >= 0) stack.splice(index, 1);
    syncListener();
  };
}

export function overlayStackSize(): number {
  return stack.length;
}
