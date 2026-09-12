import { useEffect, useRef } from "react";
import type { NovaActivity } from "@openadminos/agent-sdk";

export type NovaConversationItem =
  | { id: string; kind: "speech"; role: "user" | "assistant"; text: string; endMs?: number }
  | { id: string; kind: "activity"; status: NovaActivity["status"] | "stopped" | "replaced"; steps: NovaActivity[]; result?: string };

export function ConversationIcon() {
  return <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="3" /><path d="M11.5 3v14M5.5 7h3M5.5 10h3" /></svg>;
}

export function NovaConversation({ items, onClose, onEvidence }: {
  items: NovaConversationItem[];
  onClose: () => void;
  onEvidence?: () => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [items]);
  useEffect(() => {
    if (!scroll.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    observer.observe(scroll.current);
    return () => observer.disconnect();
  }, []);
  return <aside id="nova-conversation" className="nova-conversation" aria-label="Conversation">
    <div className="nova-conversation-header">
      <div><span className="nova-conversation-eyebrow">NOVA</span><h2>Conversation</h2></div>
      <button type="button" onClick={onClose} aria-label="Hide conversation" title="Hide conversation"><svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button>
    </div>
    <div ref={scroll} className="nova-conversation-log" role="log" aria-label="Voice conversation and activity" aria-live="off" tabIndex={0}
      onScroll={() => { const el = scroll.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
      {!items.length && <div className="nova-conversation-empty"><ConversationIcon /><p>A place to follow along.</p><span>Your words, Nova’s replies and live task activity will appear here.</span></div>}
      {items.map(item => item.kind === "speech"
        ? <div key={item.id} className={`nova-message nova-message-${item.role}`}><span className="nova-message-author">{item.role === "user" ? "You" : "Nova"}</span><p>{item.text}</p></div>
        : <div key={item.id} className="nova-activity-card" data-status={item.status}>
            <div className="nova-activity-heading"><span className="nova-activity-mark" aria-hidden="true">{item.status === "completed" ? "✓" : item.status === "failed" ? "!" : ""}</span><strong>{item.status === "completed" ? "Answer ready" : item.status === "failed" ? "Needs attention" : item.status === "stopped" ? "Session stopped" : item.status === "replaced" ? "Question replaced" : "Working on your request"}</strong><span className="nova-activity-label">ACTIVITY</span></div>
            <ol>{item.steps.slice(-4).map((step, index) => <li key={`${index}-${step.message}`} data-status={step.status}>{step.message}</li>)}</ol>
            {item.result && <details><summary>View result</summary><p className="nova-activity-result">{item.result}</p></details>}
          </div>)}
    </div>
    <div className="nova-conversation-footer"><span>Live updates from your app</span>{onEvidence && <button type="button" onClick={onEvidence}>Open evidence <span aria-hidden="true">↗</span></button>}</div>
  </aside>;
}
