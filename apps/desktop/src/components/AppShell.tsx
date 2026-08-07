import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Sidebar } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";
import { ConnectorConfirmModal } from "./ConnectorConfirmModal";
import { StatusStrip } from "./StatusStrip";
import { UpdateBanner } from "./UpdateBanner";
import { ReportIssueProvider } from "./ReportIssueModal";
import { matchesShortcut, OPEN_NEW_CONVERSATION_EVENT } from "../shared/shortcuts";
import { overlayStackSize } from "../shared/overlay-stack";

// Reserve space at the top of the window for the macOS traffic-light buttons
// (titleBarStyle: "hiddenInset" leaves them floating over the renderer) and
// make that strip draggable so users can move the window from the top edge.
// Harmless on Windows/Linux: just a thin extra header band.
const TITLE_BAR_HEIGHT = 32;

export function TitleBarInset() {
  return (
    <div
      aria-hidden
      className="app-region-drag shrink-0 bg-[var(--color-bg)]"
      style={{ height: TITLE_BAR_HEIGHT }}
    />
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const api = window.openAdminOS;
    if (!api) return;
    return api.onOpenCommandPalette(() => setPaletteOpen(true));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesShortcut(e, "commandPalette")) {
        if (!paletteOpen && overlayStackSize() > 0) return;
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (matchesShortcut(e, "newConversation") && overlayStackSize() === 0) {
        e.preventDefault();
        navigate("/chat");
        window.requestAnimationFrame(() =>
          window.dispatchEvent(new CustomEvent(OPEN_NEW_CONVERSATION_EVENT)),
        );
      } else if (matchesShortcut(e, "settings") && overlayStackSize() === 0) {
        e.preventDefault();
        navigate("/settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, paletteOpen]);

  return (
    <ReportIssueProvider>
      <div className="flex h-full w-full flex-col overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
        <a
          href="#main-content"
          className="fixed left-3 top-3 z-[200] -translate-y-24 rounded-md bg-[var(--color-accent)] px-3 py-2 text-[12px] font-semibold text-[var(--color-on-accent)] transition-transform focus:translate-y-0"
        >
          Skip to main content
        </a>
        <TitleBarInset />
        <UpdateBanner />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Sidebar onOpenPalette={() => setPaletteOpen(true)} />
          <main id="main-content" tabIndex={-1} className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
            {children}
          </main>
        </div>
        <StatusStrip />
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
        />
        <ConnectorConfirmModal />
      </div>
    </ReportIssueProvider>
  );
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 items-end justify-between gap-6 border-b border-[var(--color-border-soft)] px-10 pt-10 pb-6">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            {eyebrow}
          </div>
        )}
        <h1 className="text-[22px] font-semibold tracking-tight text-[var(--color-text)]">
          {title}
        </h1>
        {subtitle && (
          <div className="mt-1 text-[13px] text-[var(--color-text-soft)]">
            {subtitle}
          </div>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function PageBody({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto px-10 py-8 animate-fade-in">
      {children}
    </div>
  );
}
