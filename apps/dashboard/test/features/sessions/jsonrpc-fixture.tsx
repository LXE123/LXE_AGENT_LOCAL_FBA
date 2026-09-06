import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DesktopConversationActivityPayload } from "@lxe/desktop-protocol";
import { conversationRows } from "../../../src/features/sessions/presentation";
import { ConversationWindow } from "../../../src/features/sessions/virtual-window";
import { UnifiedConversationRow } from "../../../src/features/sessions/view";
import "../../../src/styles.css";
const noop = async () => {};
function Fixture() {
  const [snapshot, setSnapshot] = useState<{ health: { state: string }; activity: DesktopConversationActivityPayload }>();
  const [error, setError] = useState("");
  const refresh = async (action = "snapshot") => {
    try {
      const response = await fetch(`/__rpc_fixture__/${action}`, { method: action === "snapshot" ? "GET" : "POST" });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      setSnapshot(value);
    } catch (cause) { setError(String(cause)); }
  };
  useEffect(() => { const timer = setInterval(() => { void refresh(); }, 100); return () => clearInterval(timer); }, []);
  const activity = snapshot?.activity;
  const turns = activity ? [activity.active ?? activity.latest, ...activity.queued].filter((turn) => turn !== null) : [];
  const rows = conversationRows([], turns, []);
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <div style={{ padding: 16 }}><button onClick={() => void refresh("send")}>发送 fixture 消息</button> <button onClick={() => void refresh("stop")}>停止</button>
      <span> Gateway / agent-cli：{snapshot?.health.state ?? "starting"}；任务：{turns[0]?.state ?? "idle"}</span>
      <span>；上下文：{turns[0]?.stream?.display_metrics.context_tokens ?? 0}</span>
      {error && <div role="alert">{error}</div>}
    </div>
    <ConversationWindow rows={rows} hasOlder={false} hasNewer={false} loadOlder={noop} loadNewer={noop} jumpToLatest={() => {}} onVisibleGroups={() => {}} pageError=""
      renderRow={(row) => <UnifiedConversationRow row={row} expanded={true} onToggle={() => {}} onOpenFile={noop} onRevealFile={noop} onOpenAttachment={noop} />} />
  </div>;
}
const root = createRoot(document.getElementById("root")!); root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
