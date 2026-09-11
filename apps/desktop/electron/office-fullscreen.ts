import type { BrowserWindow } from "electron";

/** Own only the fullscreen transition requested by Office, preserving prior OS state. */
export function officeFullscreen(window: BrowserWindow) {
  let active = false;
  let prior = false;
  let changing = false;
  let queue: Promise<unknown> = Promise.resolve();
  const publish = () => {
    if (!window.isDestroyed())
      window.webContents.send("openadminos:office-fullscreen-changed", active);
  };
  let nativeExitTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelNativeExit = () => {
    clearTimeout(nativeExitTimer);
    nativeExitTimer = undefined;
  };
  window.on("enter-full-screen", cancelNativeExit);
  window.on("closed", cancelNativeExit);
  window.on("leave-full-screen", () => {
    cancelNativeExit();
    if (!changing && active) {
      // Linux window managers can report a transient leave/enter pair while
      // resizing into fullscreen. Confirm the settled state before releasing it.
      nativeExitTimer = setTimeout(() => {
        nativeExitTimer = undefined;
        if (
          !window.isDestroyed() &&
          !changing &&
          active &&
          !window.isFullScreen()
        ) {
          active = false;
          publish();
        }
      }, 150);
    }
  });
  const transition = async (value: boolean) => {
    if (window.isFullScreen() === value) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        cleanup();
        resolve();
      };
      const closed = () => {
        cleanup();
        reject(new Error("The office window was closed."));
      };
      const timer = setTimeout(() => {
        cleanup();
        if (!window.isDestroyed() && window.isFullScreen() === value) resolve();
        else
          reject(
            new Error(
              "Full screen did not finish. Try the window’s full screen control, then retry.",
            ),
          );
      }, 8000);
      const cleanup = () => {
        clearTimeout(timer);
        if (value) window.removeListener("enter-full-screen", done);
        else window.removeListener("leave-full-screen", done);
        window.removeListener("closed", closed);
      };
      if (value) window.once("enter-full-screen", done);
      else window.once("leave-full-screen", done);
      window.once("closed", closed);
      window.setFullScreen(value);
    });
  };
  const set = (value: boolean): Promise<boolean> => {
    const task = queue.then(async () => {
      if (window.isDestroyed()) return false;
      if (active === value) return active;
      changing = true;
      if (value) prior = window.isFullScreen();
      try {
        await transition(value || prior);
        active = value;
        publish();
        return active;
      } finally {
        changing = false;
      }
    });
    queue = task.catch(() => undefined);
    return task;
  };
  // A renderer reload must not leave an invisible Office fullscreen lease behind.
  window.webContents.on(
    "did-start-navigation",
    (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace)
        void set(false).catch((error) =>
          console.error("[office-fullscreen]", error),
        );
    },
  );
  return { set };
}
