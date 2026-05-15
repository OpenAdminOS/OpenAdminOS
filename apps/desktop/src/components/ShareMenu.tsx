import { useEffect, useRef, useState } from "react";
import {
  IconCopy,
  IconDownload,
  IconExternal,
  IconShare,
  IconSlack,
} from "./icons";
import { Button } from "./Button";

interface MenuItem {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}

export function ShareMenu({ contextLabel = "agent" }: { contextLabel?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const items: MenuItem[] = [
    {
      icon: <IconCopy size={13} className="text-[var(--color-text-soft)]" />,
      label: "Copy link",
      hint: `openagents://${contextLabel}/...`,
      onClick: () => setOpen(false),
    },
    {
      icon: <IconExternal size={13} className="text-[var(--color-text-soft)]" />,
      label: "Open in browser",
      hint: "github.com/ugurlabs/openagents/tree/main/agents",
      onClick: () => setOpen(false),
    },
    {
      icon: <IconDownload size={13} className="text-[var(--color-text-soft)]" />,
      label: "Export as Markdown",
      hint: "Save report locally",
      onClick: () => setOpen(false),
    },
    {
      icon: <IconSlack size={13} className="text-[var(--color-text-soft)]" />,
      label: "Send to Slack…",
      hint: "Post to a channel",
      onClick: () => setOpen(false),
    },
  ];

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="secondary"
        size="md"
        leadingIcon={<IconShare size={12} />}
        onClick={() => setOpen((o) => !o)}
      >
        Share
      </Button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-[280px] overflow-hidden rounded-xl bg-[var(--color-bg-elevated)] shadow-[var(--shadow-modal)] ring-1 ring-[var(--color-border-strong)] animate-fade-in-scale">
          <div className="border-b border-[var(--color-border-soft)] px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Share this {contextLabel}
          </div>
          <div className="py-1">
            {items.map((it, i) => (
              <button
                key={i}
                onClick={it.onClick}
                className="flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
              >
                <span className="mt-0.5">{it.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] text-[var(--color-text)]">
                    {it.label}
                  </span>
                  {it.hint && (
                    <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                      {it.hint}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
          <div className="border-t border-[var(--color-border-soft)] bg-[var(--color-surface)] px-3 py-2 text-[10.5px] text-[var(--color-text-muted)]">
            Shared content stays local until you choose a destination.
          </div>
        </div>
      )}
    </div>
  );
}
