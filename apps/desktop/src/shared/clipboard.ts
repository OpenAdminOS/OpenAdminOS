import type { OpenAdminOSApi } from "./openAdminOS.js";

type ClipboardBridge = Pick<OpenAdminOSApi, "writeClipboardText">;

export async function copyTextToClipboard(text: string): Promise<void> {
  const bridge = (window as Window & { openAdminOS?: ClipboardBridge }).openAdminOS;
  if (bridge?.writeClipboardText) {
    await bridge.writeClipboardText(text);
    return;
  }

  let clipboardError: unknown;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (caught) {
      clipboardError = caught;
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) {
    throw clipboardError instanceof Error
      ? clipboardError
      : new Error("Clipboard write is not available in this window.");
  }
}
