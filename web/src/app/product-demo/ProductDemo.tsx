"use client";

import { useEffect, useRef, useState } from "react";
import captures from "../../../public/product-demo/screens.json";
import styles from "./ProductDemo.module.css";

type Hotspot = (typeof captures)[number]["hotspots"][number];
const screens = new Map(captures.map((screen) => [screen.id, screen]));
const routes = new Map<string, string>();
for (const screen of captures) {
  if (!routes.has(screen.route)) routes.set(screen.route, screen.id);
}
routes.set("/settings/providers", "settings");
const agentTargets: Record<string, string> = {
  "Find inactive devices": "agent-details",
  "Compliance overview": "compliance-details",
  "Offboarding agent": "offboarding-details",
  "Team evidence review": "evidence-details",
  "Team PowerShell draft": "script-details",
};

function destination(hotspot: Hotspot, current: string): string | undefined {
  const { label, href } = hotspot;
  if (href?.startsWith("#")) return routes.get(href.slice(1));
  const commands: Record<string, string> = {
    "Go to Chat": "chat",
    "Go to Agents": "agents",
    "Go to Hub": "hub",
    "Go to Schedules Review active agent schedules": "schedules",
    "Go to Agent Team": "team",
    "Go to Changes": "changes",
    "Go to Run history": "history",
    "Go to Workspaces": "workspaces",
  };
  if (commands[label]) return commands[label];
  if (agentTargets[label]) return agentTargets[label];
  if (label.startsWith("CS Contoso")) return "tenants";
  if (label.startsWith("Quick search")) return "quick-search";
  if (label.startsWith("Workspaces Saved")) return "workspaces";
  if (label.startsWith("Connectors External")) return "connectors";
  if (label.startsWith("Offboarding agent Write plan")) return "review";
  if (["Browse hub", "Refresh agent catalog"].includes(label)) return "hub";
  if (["Add teammate", "Add your first teammate"].includes(label))
    return "team-add";
  if (
    label === "Create workspace" ||
    (label === "New" && current === "workspaces")
  )
    return "workspace-add";
  if (label === "New" || label === "Open chat") return "chat";
  if (
    [
      "chat",
      "chat-users",
      "chat-apps",
      "chat-policies",
      "chat-signins",
      "chat-identity",
      "chat-security",
    ].includes(current)
  ) {
    const categories: Record<string, string> = {
      Devices: "chat",
      Users: "chat-users",
      Apps: "chat-apps",
      Policies: "chat-policies",
      "Sign-ins": "chat-signins",
      Identity: "chat-identity",
      Security: "chat-security",
    };
    if (categories[label]) return categories[label];
  }
  if (label === "Review inbox") return "history";
  if (label === "Open cache settings") return "chat-settings";
  if (label.startsWith("Open Cache")) return "cache";
  if (label === "Schedule") return "schedules";
  if (
    [
      "settings",
      "tenants",
      "chat-settings",
      "gateway",
      "appearance",
      "privacy",
      "about",
    ].includes(current)
  ) {
    const settings: Record<string, string> = {
      Providers: "settings",
      Tenants: "tenants",
      Chat: "chat-settings",
      Gateway: "gateway",
      General: "appearance",
      Privacy: "privacy",
      About: "about",
    };
    if (settings[label]) return settings[label];
  }
  if (["changes", "baselines", "compare"].includes(current)) {
    const tabs: Record<string, string> = {
      Timeline: "changes",
      Baselines: "baselines",
      Compare: "compare",
    };
    if (tabs[label]) return tabs[label];
  }
}

/** Actual Electron captures with DOM-measured hit areas. No re-created app chrome. */
export function ProductDemo() {
  const [active, setActive] = useState("chat");
  const [pending, setPending] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const history = useRef<string[]>([]);
  const request = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const screen = screens.get(active) ?? captures[0]!;
  useEffect(() => {
    if (action && !dialog.current?.open) dialog.current?.showModal();
  }, [action]);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );

  function show(id: string, remember = true) {
    if (!screens.has(id) || id === active) return;
    const token = ++request.current;
    setPending(id);
    setError(false);
    const image = new Image();
    image.onload = () => {
      if (token !== request.current) return;
      if (remember) history.current.push(active);
      setActive(id);
      setPending(null);
      viewport.current?.focus({ preventScroll: true });
    };
    image.onerror = () => {
      if (token !== request.current) return;
      setPending(null);
      setError(true);
    };
    image.src = `/product-demo/${id}.png`;
  }
  function back() {
    show(history.current.pop() ?? "chat", false);
  }
  function activate(hotspot: Hotspot) {
    const target = destination(hotspot, active);
    if (target) {
      show(target);
      return;
    }
    if (
      [
        "Close",
        "Cancel",
        "Back",
        "Close dialog",
        "Close modal",
        "Close quick search",
      ].includes(hotspot.label)
    ) {
      back();
      return;
    }
    setAction(
      hotspot.label === "Open control" ? "This control" : hotspot.label,
    );
  }

  return (
    <section
      id="product-demo"
      className={styles.demo}
      aria-label="Explore the OpenAdminOS desktop screenshots"
    >
      <div
        ref={viewport}
        className={styles.viewport}
        tabIndex={0}
        aria-label="Desktop preview. On small screens, scroll horizontally to explore."
        onKeyDown={(event) => {
          if (event.key === "Escape" && !dialog.current?.open) back();
        }}
      >
        <div
          className={styles.stage}
          style={{ aspectRatio: `${screen.width} / ${screen.height}` }}
          aria-busy={pending !== null}
        >
          <img
            key={screen.id}
            src={`/product-demo/${screen.id}.png`}
            alt={`OpenAdminOS desktop: ${screen.label}`}
            width={screen.width}
            height={screen.height}
            className={styles.screenshot}
            draggable={false}
            onError={() => setError(true)}
          />
          <div
            className={styles.controls}
            aria-label={`${screen.label} controls`}
          >
            {screen.hotspots.map((hotspot, index) => (
              <button
                key={`${screen.id}-${index}`}
                type="button"
                className={styles.hotspot}
                aria-label={hotspot.label}
                title={hotspot.label}
                disabled={hotspot.disabled || pending !== null}
                onClick={() => activate(hotspot)}
                style={{
                  left: `${hotspot.x}%`,
                  top: `${hotspot.y}%`,
                  width: `${hotspot.width}%`,
                  height: `${hotspot.height}%`,
                }}
              />
            ))}
          </div>
          {pending && (
            <div className={styles.loading} role="status">
              Opening {screens.get(pending)?.label}…
            </div>
          )}
        </div>
      </div>
      <span className="sr-only" role="status">
        {screen.label}. Screenshot preview with fictional tenant data.
      </span>
      {error && (
        <p className={styles.error} role="alert">
          This screenshot could not load.{" "}
          <button onClick={() => window.location.reload()}>
            Reload the preview
          </button>
          .
        </p>
      )}
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby="screenshot-action-title"
        onClose={() => setAction(null)}
        onCancel={() => setAction(null)}
      >
        <button
          className={styles.close}
          onClick={() => dialog.current?.close()}
          aria-label="Close"
        >
          ×
        </button>
        <h3 id="screenshot-action-title">Available in the desktop app</h3>
        <p>
          “{action}” requires the desktop app. This website lets you explore
          captured screens without connecting to a tenant.
        </p>
        <a href="/download">Download OpenAdminOS ↗</a>
      </dialog>
    </section>
  );
}
