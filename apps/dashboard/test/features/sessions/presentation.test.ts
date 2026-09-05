import { describe, expect, test } from "bun:test";
import { acknowledgeConversationSend, conversationRows, type PendingMessage } from "../../../src/features/sessions/presentation";
import { boundConversationWindow, appendConversationWindow, prependConversationWindow } from "../../../src/features/sessions/model";
import type { SessionDetailPayload, SessionMessage, DesktopConversationTurnPayload } from "../../../src/api/payloads";

const page = (start: number, end: number): SessionDetailPayload => ({ session: { session_id: "s" },
  messages: Array.from({length: end - start}, (_, index) => ({ role: "user", content: `message ${start + index}`, display_id: `g${start + index}:0`, display_group_id: `g${start + index}` })),
  messages_page: { fetched_at: 1, total: 1000, raw_message_total: 1000, limit: 10, oldest_cursor: `g${start}`, newest_cursor: `g${end-1}`, previous_cursor: start ? `g${start}` : null, has_previous: start > 0, next_cursor: end < 1000 ? `g${end-1}` : null, has_next: end < 1000, group_cursors: Array.from({length:end-start},(_,i)=>`g${start+i}`) }
} as SessionDetailPayload);
const pending: PendingMessage = { pendingId: "client", sessionId: "s", text: "same text", attachments: [], createdAt: 10 };
const turn = { turn_id: "turn", message_id: "server", client_message_id: "client", text: pending.text, created_at: 10, started_at: 10, settled_at: 20, user_persisted_at: 12, state: "completed" } as DesktopConversationTurnPayload;
const stored: SessionMessage = { display_group_id: "g1", display_id: "g1:0", role: "user", client_message_id: "client", message_id: "server", content: pending.text, turn: {turn_id:"turn", status:"completed", elapsed_ms:10} };
describe("unified conversation identity", () => {
  test("pending, activity and persistence share one user key for every arrival order", () => {
    for (const [messages, turns, sends] of [ [[], [], [pending]], [[], [turn], [pending]], [[stored], [], [pending]], [[stored], [turn], [pending]], [[stored], [turn], []] ] as [SessionMessage[], DesktopConversationTurnPayload[], PendingMessage[]][]) {
      expect(conversationRows(messages, turns, sends).filter(r=>r.message?.role === "user").map(r=>r.id)).toEqual(["user:client"]);
    }
    expect(conversationRows([], [], [pending, {...pending, pendingId:"other"}]).length).toBe(2);
  });
  test("failed sends stay visible; timestamps alone never retire a bubble", () => {
    expect(conversationRows([], [turn], [pending]).some(r=>r.id === "user:client")).toBe(true);
    expect(conversationRows([], [], [{...pending,error:"actual transport failure"}])[0]?.error).toBe("actual transport failure");
  });
  test("environment metadata hides internal content without inspecting user text", () => {
    expect(conversationRows([{...stored,source_reason:"environment_context"}],[],[])).toHaveLength(0);
    expect(conversationRows([{...stored,environmentContext:{cwd:"/tmp"}}],[],[])).toHaveLength(0);
    expect(conversationRows([{...stored,content:"<environment_context>example</environment_context>"}],[],[]).filter(row=>row.kind === "message")).toHaveLength(1);
  });
  test("streaming and persisted block identity and failed attempt order survive handoff", () => {
    const streaming = {...turn,stream:{display_metrics:{phase:"generating_answer"},process_parts:[
      {type:"text",part_id:"failed:0",sequence:1,text:"partial failure",status:"error",presentation:"process"},
      {type:"thinking",part_id:"answer:0",sequence:2,text:"thinking",status:"completed",redacted_count:0},
      {type:"text",part_id:"answer:1",sequence:3,text:"final",status:"completed",presentation:"final"},
    ]}} as DesktopConversationTurnPayload;
    const history = {...stored, role:"assistant", id:"answer",content:[{type:"thinking",thinking:"thinking"},{type:"text",text:"final"}]} as SessionMessage;
    const rows = conversationRows([stored,history],[streaming],[]);
    expect(rows.filter(r=>r.message?.role === "assistant").map(r=>r.id)).toEqual(["failed:0","answer:0","answer:1"]);
    expect(rows.find(r=>r.id === "answer:1")?.status).toBe("completed");
  });
  test("legacy display keys remain stable when older groups are prepended", () => {
    const last = conversationRows(page(10,20).messages,[],[]).map(r=>r.id);
    expect(conversationRows(page(0,20).messages,[],[]).slice(10).map(r=>r.id)).toEqual(last);
  });
});
describe("bounded reading window", () => {
  test("1000 groups remain bounded while paging in both directions", () => {
    let current = page(990,1000);
    for (let i=980;i>=0;i-=10) {
      current = boundConversationWindow(prependConversationWindow(current,page(i,i+10)),[`g${i+10}`],"older");
      expect(current.messages_page.group_cursors!.length).toBeLessThanOrEqual(60);
    }
    expect(current.messages[0]!.display_group_id).toBe("g0");
    expect(current.messages_page.has_next).toBe(true);
    for (let i=60;i<1000;i+=10) current=boundConversationWindow(appendConversationWindow(current,page(i,i+10)),[],"newer");
    expect(current.messages.at(-1)!.display_group_id).toBe("g999");
    expect(new Set(current.messages.map(m=>m.display_id)).size).toBe(current.messages.length);
  });
  test("byte budget evicts distant groups but protects a single oversized visible group", () => {
    const current=page(0,3);current.messages[1]!.content="x".repeat(17*1024*1024);
    const bounded=boundConversationWindow(current,["g1"]);
    expect(bounded.messages.map(m=>m.display_group_id)).toEqual(["g1"]);
    expect(bounded.messages_page.has_previous).toBe(true);expect(bounded.messages_page.has_next).toBe(true);
  });
});


test("late send acknowledgements cannot overwrite a running or completed activity snapshot", () => {
  const current={session_id:"s",active:null,latest:turn,queued:[]};
  const result={session_id:"s",turn_id:"turn",message_id:"server",created:false,state:"running" as const};
  expect(acknowledgeConversationSend(current,result,pending)).toBe(current);
  const accepted=acknowledgeConversationSend(undefined,result,pending);
  expect(accepted.active?.client_message_id).toBe("client");
  expect(conversationRows([],accepted.active?[accepted.active]:[],[pending]).filter(row=>row.message?.role === "user")).toHaveLength(1);
});
