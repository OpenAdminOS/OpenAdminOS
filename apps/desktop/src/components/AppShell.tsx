import { Nova } from "../voice/Nova";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Sidebar } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";
import { ConnectorConfirmModal } from "./ConnectorConfirmModal";
import { ReportIssueProvider } from "./ReportIssueModal";
import { matchesShortcut } from "../shared/shortcuts";
import { overlayStackSize } from "../shared/overlay-stack";
import {
  ConversationWorkspaceProvider,
  DataBoundaryProvider,
  ShellChromeProvider,
  UpdateStateProvider,
  useDataBoundary,
  useShellChrome,
} from "../state";
import { TopBar } from "./TopBar";

export { PageHeader } from "./ui/PageHeader";

export function AppShell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const api = window.openAdminOS;
    if (!api) return;
    return api.onOpenCommandPalette(() => setPaletteOpen(true));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (matchesShortcut(e, "commandPalette")) {
        if (!paletteOpen && overlayStackSize() > 0) return;
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (matchesShortcut(e, "newConversation") && overlayStackSize() === 0) {
        e.preventDefault();
        navigateRef.current("/chat?new=1");
      } else if (matchesShortcut(e, "settings") && overlayStackSize() === 0) {
        e.preventDefault();
        navigateRef.current("/settings");
      } else if (matchesShortcut(e, "toggleSidebar") && overlayStackSize() === 0) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("openadminos:toggle-sidebar"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen]);

  return (
    <ReportIssueProvider>
      <UpdateStateProvider>
        <DataBoundaryProvider>
          <ShellChromeProvider>
            <ConversationWorkspaceProvider>
              <ShellLayout
                paletteOpen={paletteOpen}
                setPaletteOpen={setPaletteOpen}
              >
                {children}
              </ShellLayout>
            </ConversationWorkspaceProvider>
          </ShellChromeProvider>
        </DataBoundaryProvider>
      </UpdateStateProvider>
    </ReportIssueProvider>
  );
}

function ShellLayout({
  children,
  paletteOpen,
  setPaletteOpen,
}: {
  children: ReactNode;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
}) {
  const { setVoiceHosted } = useDataBoundary();
  const { toggleSidebar } = useShellChrome();

  useEffect(() => {
    const onToggle = () => toggleSidebar();
    window.addEventListener("openadminos:toggle-sidebar", onToggle);
    return () => window.removeEventListener("openadminos:toggle-sidebar", onToggle);
  }, [toggleSidebar]);

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[200] -translate-y-24 rounded-md bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-[var(--color-on-accent)] transition-transform focus:translate-y-0"
      >
        Skip to main content
      </a>
      <Sidebar onOpenPalette={() => setPaletteOpen(true)} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar />
        <main id="main-content" tabIndex={-1} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>
      </div>
      <Nova onHostedChange={setVoiceHosted} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ConnectorConfirmModal />
    </div>
  );
}

export function PageBody({ children }: { children: ReactNode }) {
  return (
    <div className="app-page-body min-w-0 flex-1 overflow-y-auto animate-fade-in">
      {children}
    </div>
  );
}
