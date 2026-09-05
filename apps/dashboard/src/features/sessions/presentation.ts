import type { DesktopConversationActivityPayload, DesktopConversationSendPayload } from "@lxe/desktop-protocol";
import type { DesktopConversationTurnPayload, SessionMessage, SessionArtifactPayload } from "../../api/payloads";
import { isRecord } from "../../shared/content";
import { fallbackToolCallBlocks, toolOperations, type ToolOperation } from "./conversation";

export interface PendingMessage {
  pendingId: string; sessionId: string; text: string; createdAt: number;
  attachments: NonNullable<SessionMessage["attachments"]>;
  turnId?: string; messageId?: string; error?: string;
}
export interface ConversationRow {
  id: string; groupId: string; turnId: string; kind: "message" | "tool" | "status" | "artifacts";
  message?: SessionMessage; operation?: ToolOperation;
  liveTool?: NonNullable<DesktopConversationTurnPayload["stream"]>["tool_steps"][number];
  phase?: string; startedAt?: number; elapsedMs?: number;
  status?: string; error?: string; createdAt: number; artifacts?: SessionArtifactPayload[];
}
export const userDisplayId = (message: { client_message_id?: string; message_id?: string; display_id?: string }): string =>
  `user:${message.client_message_id || message.message_id || message.display_id}`;
export const isInternalMessage = (message: SessionMessage): boolean =>
  message.source_reason === "environment_context" || (message.role === "user" && isRecord(message.environmentContext));

/** One projection for both streaming and stored data. Source IDs never depend on the loaded page index. */
export function conversationRows(messages: SessionMessage[], turns: DesktopConversationTurnPayload[], pending: PendingMessage[]): ConversationRow[] {
  messages = messages.map((message) => {
    if (!message.tool_calls) return message;
    const content = Array.isArray(message.content) ? message.content : message.content ? [{type:"text",text:String(message.content)}] : [];
    return {...message, tool_calls: undefined, content: [...content, ...fallbackToolCallBlocks(message.tool_calls)]};
  });
  const rows: ConversationRow[] = [];
  const byTurn = new Map<string, ConversationRow[]>();
  const add = (row: ConversationRow) => {
    rows.push(row);
    if (row.turnId) { const list = byTurn.get(row.turnId) ?? []; list.push(row); byTurn.set(row.turnId, list); }
  };
  const operations = toolOperations(messages);
  const claimedTools = new Set<string>();
  for (const message of messages) {
    if (isInternalMessage(message)) continue;
    const turnId = message.turn?.turn_id ?? "";
    const base = { groupId: message.display_group_id, turnId, createdAt: (message.created_at ?? 0) * 1000 };
    const messageId = String(message.id || message.display_id || message.display_group_id);
    if (message.role === "user") {
      add({ ...base, id: userDisplayId(message), kind: "message", message, status: "saved" });
    } else {
      const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content ?? "") }];
      blocks.forEach((value, index) => {
        const block = isRecord(value) ? value : { type: "text", text: String(value) };
        if (["tool_call", "tool_use", "tool_result"].includes(String(block.type))) {
          const callId = String(block.id || block.tool_call_id || block.tool_use_id || `${messageId}:${index}`);
          const id = `tool:${callId}`;
          if (claimedTools.has(id)) return;
          const operation = operations.find((op) => {
            const call = isRecord(op.call) ? op.call : {};
            const result = isRecord(op.result) ? op.result : {};
            return op.call === block || op.result === block || String(call.id || result.tool_call_id || result.tool_use_id) === callId;
          });
          if (operation) { claimedTools.add(id); add({ ...base, id, kind: "tool", operation: { ...operation, key: id } }); }
          return;
        }
        add({ ...base, id: `${messageId}:${index}`, kind: "message", status: "completed", message: { ...message, content: [block], attachments: index === blocks.length - 1 ? message.attachments : undefined, artifacts: undefined } });
      });
    }
    if (message.artifacts?.length) add({ ...base, id: `artifacts:${messageId}`, kind: "artifacts", artifacts: message.artifacts });
  }
  const turnStatus = new Map(messages.flatMap((message) => message.turn?.status && !isInternalMessage(message) ? [[message.turn.turn_id, message] as const] : []));
  for (const [id, message] of turnStatus) {
    if (!turns.some((turn) => turn.turn_id === id)) rows.push({id:`status:${id}`,turnId:id,groupId:message.display_group_id,createdAt:(message.created_at??0)*1000,kind:"status",status:message.turn!.status!,elapsedMs:message.turn!.elapsed_ms ?? undefined});
  }
  for (const turn of turns) {
    const history = byTurn.get(turn.turn_id) ?? [];
    const groupId = history.find((row) => row.message?.role === "assistant" || row.kind === "tool")?.groupId ?? `live:${turn.turn_id}`;
    const base = { groupId, turnId: turn.turn_id, createdAt: turn.created_at ?? turn.started_at };
    const userId = userDisplayId(turn);
    if (!rows.some((row) => row.id === userId || (row.turnId === turn.turn_id && row.message?.role === "user"))) {
      rows.push({ ...base, id: userId, kind: "message", status: turn.state, message: { display_group_id: groupId, role: "user", content: turn.text, attachments: turn.attachments, created_at: base.createdAt / 1000 } });
    }
    const parts: ConversationRow[] = (turn.stream?.process_parts ?? []).map((part) => part.type === "tool"
      ? { ...base, id: `tool:${part.tool_step.id}`, kind: "tool", liveTool: part.tool_step }
      : { ...base, id: part.part_id, kind: "message", status: part.status, message: { display_group_id: groupId, role: "assistant", content: [part.type === "thinking" ? { type: "thinking", thinking: part.text, redacted: part.redacted_count > 0 } : { type: "text", text: part.text }] } });
    // Stored data confirms an item; the live order remains authoritative during the handoff,
    // including failed-attempt rows that deliberately have no persisted counterpart.
    const existing = new Map(rows.map((row) => [row.id, row]));
    const merged = parts.map((part) => existing.get(part.id) ?? part);
    const partIds = new Set(parts.map((part) => part.id));
    const insertion = rows.findIndex((row) => row.turnId === turn.turn_id && row.message?.role !== "user");
    for (let i = rows.length - 1; i >= 0; i--) if (partIds.has(rows[i]!.id)) rows.splice(i, 1);
    if (insertion >= 0) rows.splice(Math.min(insertion, rows.length), 0, ...merged); else rows.push(...merged);
    rows.push({ ...base, id: `status:${turn.turn_id}`, kind: "status", status: turn.state, phase: turn.stream?.display_metrics.phase, startedAt: turn.started_at, elapsedMs: turn.started_at > 0 && turn.settled_at > 0 ? turn.settled_at - turn.started_at : undefined });
  }
  for (const item of pending) {
    const id = `user:${item.pendingId}`;
    if (rows.some((row) => row.id === id)) continue;
    rows.push({ id, groupId: `pending:${item.pendingId}`, turnId: item.turnId ?? "", createdAt: item.createdAt, kind: "message", status: item.error ? "error" : item.turnId ? "accepted" : "sending", error: item.error, message: { display_group_id: id, role: "user", content: item.text, attachments: item.attachments, created_at: item.createdAt / 1000 } });
  }
  // Keep a turn together, including when its user row is supplied by pending state.
  const starts = new Map<string, number>();
  for (const row of rows) { const group = row.turnId || row.groupId; starts.set(group, Math.min(starts.get(group) ?? Infinity, row.createdAt || Infinity)); }
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  return unique.sort((a, b) => {
    const time = (starts.get(a.turnId || a.groupId) ?? 0) - (starts.get(b.turnId || b.groupId) ?? 0);
    if (time) return time;
    if (a.turnId && a.turnId === b.turnId) {
      if (a.message?.role === "user" && b.message?.role !== "user") return -1;
      if (b.message?.role === "user" && a.message?.role !== "user") return 1;
      if (a.kind === "status") return 1;
      if (b.kind === "status") return -1;
    }
    return 0;
  });
}

export function acknowledgeConversationSend(current: DesktopConversationActivityPayload | undefined, result: DesktopConversationSendPayload, pendingMessage: PendingMessage): DesktopConversationActivityPayload {

  const optimisticTurn: DesktopConversationTurnPayload = {
    turn_id: result.turn_id,
    message_id: result.message_id,
    client_message_id: pendingMessage.pendingId,
    created_at: pendingMessage.createdAt,
    text: pendingMessage.text,
    ...(pendingMessage.attachments.length ? { attachments: pendingMessage.attachments } : {}),
    state: result.state,
    started_at: 0,
    user_persisted_at: 0,
    settled_at: 0,
  };
  const activity = current ?? {
    session_id: result.session_id,
    active: null,
    queued: [],
    latest: null,
  };
  if ([activity.active, activity.latest, ...activity.queued].some((turn) => turn?.turn_id === result.turn_id)) return activity;
  if (result.state === "running") {
    return {
      ...activity,
      active: optimisticTurn,
      queued: activity.queued.filter((turn) => turn.turn_id !== result.turn_id),
    };
  }
  return {
    ...activity,
    queued: activity.queued.some((turn) => turn.turn_id === result.turn_id)
      ? activity.queued
      : [...activity.queued, optimisticTurn],
  };

}
