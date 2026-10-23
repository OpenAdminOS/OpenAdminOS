import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export const SIDEBAR_COLLAPSED_KEY = "openadminos:sidebar-collapsed:v1";

interface ShellChromeContextValue {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  titleTarget: HTMLElement | null;
  actionsTarget: HTMLElement | null;
  setTitleTarget: (target: HTMLElement | null) => void;
  setActionsTarget: (target: HTMLElement | null) => void;
}

const ShellChromeContext = createContext<ShellChromeContextValue | undefined>(undefined);

function initialCollapsed(): boolean {
  const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
  if (stored === "true") return true;
  if (stored === "false") return false;
  return window.innerWidth < 1000;
}

export function ShellChromeProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [titleTarget, setTitleTarget] = useState<HTMLElement | null>(null);
  const [actionsTarget, setActionsTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  const value = useMemo<ShellChromeContextValue>(
    () => ({
      collapsed,
      setCollapsed,
      toggleSidebar: () => setCollapsed((current) => !current),
      titleTarget,
      actionsTarget,
      setTitleTarget,
      setActionsTarget,
    }),
    [actionsTarget, collapsed, titleTarget],
  );
  return <ShellChromeContext.Provider value={value}>{children}</ShellChromeContext.Provider>;
}

export function useShellChrome(): ShellChromeContextValue {
  const value = useContext(ShellChromeContext);
  if (!value) throw new Error("useShellChrome must be used within ShellChromeProvider.");
  return value;
}

export function useShellChromeOptional(): ShellChromeContextValue | undefined {
  return useContext(ShellChromeContext);
}

export function TopBarTitle({ children }: { children: ReactNode }) {
  const shell = useShellChromeOptional();
  return shell?.titleTarget ? createPortal(children, shell.titleTarget) : <>{children}</>;
}

export function TopBarActions({ children }: { children: ReactNode }) {
  const shell = useShellChromeOptional();
  return shell?.actionsTarget ? createPortal(children, shell.actionsTarget) : <>{children}</>;
}
