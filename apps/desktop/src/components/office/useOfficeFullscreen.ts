import { useCallback, useEffect, useRef, useState } from "react";
import { overlayStackSize } from "../../shared/overlay-stack";

export function useOfficeFullscreen() {
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const returnFocus = useRef<HTMLElement | null>(null);
  const change = useCallback(async (value: boolean) => {
    const api = window.openAdminOS;
    if (!api?.setOfficeFullscreen) {
      setError(
        "Full screen needs the desktop app. Reopen Agent Team in OpenAdminOS.",
      );
      return;
    }
    if (value) returnFocus.current = document.activeElement as HTMLElement;
    setPending(true);
    setError("");
    try {
      const result = await api.setOfficeFullscreen(value);
      if (mounted.current) setActive(result);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setPending(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const api = window.openAdminOS;
    const unsubscribe = api?.onOfficeFullscreenChanged?.(setActive);
    return () => {
      mounted.current = false;
      unsubscribe?.();
      void api
        ?.setOfficeFullscreen?.(false)
        .catch((e) => console.error("Could not restore office window", e));
    };
  }, []);
  useEffect(() => {
    document.documentElement.toggleAttribute("data-team-fullscreen", active);
    if (!active) returnFocus.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (
        active &&
        event.key === "Escape" &&
        !event.defaultPrevented &&
        overlayStackSize() === 0
      ) {
        event.preventDefault();
        void change(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.documentElement.removeAttribute("data-team-fullscreen");
      window.removeEventListener("keydown", onKey);
    };
  }, [active, change]);
  return { active, pending, error, change };
}
