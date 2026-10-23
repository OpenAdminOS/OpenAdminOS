import { useNavigate } from "react-router";

import { useDataBoundary, useShellChrome } from "../state";
import { OPEN_NEW_CONVERSATION_EVENT } from "../shared/shortcuts";
import { IconChat, IconChevronRight, IconCloud, IconLock, IconSettings } from "./icons";
import { TenantSwitcher } from "./TenantSwitcher";
import { Tooltip } from "./ui";

export function TopBar() {
  const navigate = useNavigate();
  const platform = window.openAdminOS?.platform;
  const { collapsed, toggleSidebar, setTitleTarget, setActionsTarget } = useShellChrome();
  const { boundary } = useDataBoundary();
  const draggable = platform === "macos" || platform === "windows";

  const newConversation = () => {
    navigate("/chat");
    window.requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent(OPEN_NEW_CONVERSATION_EVENT)),
    );
  };

  return (
    <header
      className={`app-topbar relative flex h-[52px] shrink-0 items-center border-b border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 ${draggable ? "app-region-drag" : ""}`}
      style={platform === "windows" ? { paddingRight: 140 } : undefined}
    >
      <div className={`app-region-no-drag flex min-w-0 items-center gap-1 ${collapsed && platform === "macos" ? "pl-[76px]" : ""}`}>
        {collapsed ? (
          <>
            <Tooltip content="Expand sidebar" side="bottom">
              <button
                type="button"
                aria-label="Expand sidebar"
                onClick={toggleSidebar}
                className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--color-text-muted)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
              >
                <IconChevronRight size={14} />
              </button>
            </Tooltip>
            <Tooltip content="New chat" side="bottom">
              <button
                type="button"
                aria-label="New chat"
                onClick={newConversation}
                className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--color-text-muted)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
              >
                <IconChat size={14} />
              </button>
            </Tooltip>
          </>
        ) : null}
        <TenantSwitcher />
      </div>
      <div ref={setTitleTarget} className="app-region-no-drag pointer-events-auto absolute left-1/2 min-w-0 max-w-[34%] -translate-x-1/2 truncate text-sm font-medium text-[var(--color-text-soft)]" />
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <div ref={setActionsTarget} className="app-region-no-drag flex shrink-0 items-center gap-1" />
        <Tooltip content={boundary.tooltip} side="bottom">
          {boundary.kind === "none" ? (
            <button
              type="button"
              onClick={() => navigate("/settings/providers")}
              className="app-region-no-drag flex h-8 min-w-0 max-w-[390px] items-center gap-1.5 rounded-[8px] bg-[var(--color-warning-soft)] px-2 text-xs text-[var(--color-warning)] hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
            >
              <IconSettings size={11} className="shrink-0" />
              <span className="truncate">{boundary.label}</span>
            </button>
          ) : (
            <span
              role="status"
              aria-label={`${boundary.label}${boundary.model ? ` · ${boundary.model}` : ""}`}
              tabIndex={0}
              className={`app-region-no-drag flex h-8 min-w-0 max-w-[390px] items-center gap-1.5 rounded-[8px] px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${
                boundary.kind === "hosted"
                  ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
                  : "text-[var(--color-text-soft)]"
              }`}
            >
              {boundary.kind === "local" ? <IconLock size={11} className="shrink-0" /> : <IconCloud size={11} className="shrink-0" />}
              <span className="truncate">{boundary.label}</span>
              {boundary.model ? <span className="truncate text-[var(--color-text-muted)]">· {boundary.model}</span> : null}
            </span>
          )}
        </Tooltip>
      </div>
    </header>
  );
}
