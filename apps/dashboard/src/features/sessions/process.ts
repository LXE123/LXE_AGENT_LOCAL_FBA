import { useEffect, useState } from "react";
import type { ConversationRow } from "./presentation";

export interface ProcessState { status: string; expanded: boolean }
export const processId = (row: ConversationRow): string => `process:${row.turnId || row.groupId}`;
export function processHeaders(rows: ConversationRow[]): ConversationRow[] {
  const statuses = new Map(rows.filter(row => row.kind === "status").map(row => [row.turnId || row.groupId, row]));
  const headers = new Map<string, ConversationRow>();
  for (const row of rows) {
    if (row.presentation !== "process") continue;
    const id = processId(row);
    if (!headers.has(id)) headers.set(id, { ...row, ...statuses.get(row.turnId || row.groupId),
      id, kind: "process", presentation: undefined, status: statuses.get(row.turnId || row.groupId)?.status ?? "completed" });
  }
  return [...headers.values()];
}
export function reconcileProcesses(previous: Map<string, ProcessState>, headers: ConversationRow[]): Map<string, ProcessState> {
  let result = previous;
  for (const header of headers) {
    const status = header.status ?? "completed";
    const old = previous.get(header.id);
    if (old?.status === status) continue;
    if (result === previous) result = new Map(previous);
    const terminal = ["completed", "error", "cancelled"].includes(status);
    result.set(header.id, { status, expanded: !old || terminal ? status !== "completed" : old.expanded });
  }
  return result;
}
export function visibleProcessRows(rows: ConversationRow[], headers: ConversationRow[], states: Map<string, ProcessState>): ConversationRow[] {
  const byId = new Map(headers.map(header => [header.id, header]));
  const emitted = new Set<string>();
  const result: ConversationRow[] = [];
  for (const row of rows) {
    const id = processId(row);
    if (row.kind === "status" && byId.has(id)) continue;
    if (row.presentation === "process") {
      if (!emitted.has(id)) { result.push(byId.get(id)!); emitted.add(id); }
      if (!states.get(id)?.expanded) continue;
    }
    result.push(row);
  }
  return result;
}
export function useProcessRows(rows: ConversationRow[], session: string) {
  const [memory, setMemory] = useState({ session, states: new Map<string, ProcessState>() });
  const headers = processHeaders(rows);
  const states = reconcileProcesses(memory.session === session ? memory.states : new Map(), headers);
  useEffect(() => {
    if (memory.session !== session || memory.states !== states) setMemory({ session, states });
  }, [session, states, memory]);
  return { rows: visibleProcessRows(rows, headers, states), states,
    toggle: (id: string) => setMemory({session, states: new Map(states).set(id, {...states.get(id)!, expanded: !states.get(id)?.expanded})}) };
}
