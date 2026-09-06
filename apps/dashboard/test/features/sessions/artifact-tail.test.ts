import { expect, test } from "bun:test";
import { conversationRows } from "../../../src/features/sessions/presentation";
import { processHeaders, reconcileProcesses, visibleProcessRows } from "../../../src/features/sessions/process";
import type { SessionMessage, SessionArtifactPayload, DesktopConversationTurnPayload } from "../../../src/api/payloads";
const file = (id: string, turn="t"): SessionArtifactPayload => ({artifact_id:id,turn_id:turn,tool_call_id:"call",name:`${id}.xlsx`});
const message = (id: string, role: string, content: unknown, artifacts?: SessionArtifactPayload[], turn="t"): SessionMessage => ({
  id,display_id:id,display_group_id:`g:${turn}`,role,content,artifacts,created_at:turn==="t"?1:2,turn:{turn_id:turn,status:"completed",elapsed_ms:1000},
});
const source = () => [message("u","user","question"), message("call","assistant",[{type:"tool_call",id:"c",name:"read",arguments:{}}]),
  message("result","tool",[{type:"tool_result",tool_call_id:"c",content:"exported"}],[file("a"),file("b")]),
  message("answer","assistant",[{type:"text",text:"answer"}],[file("a")]), message("next","user","next question",undefined,"next")];
test("files attached to a tool result aggregate below the final reply and above the next user",()=>{
  const rows=conversationRows(source(),[],[]);
  expect(rows.filter(row=>row.kind==="artifacts").map(row=>row.id)).toEqual(["artifacts:turn:t"]);
  expect(rows.find(row=>row.kind==="artifacts")?.artifacts?.map(file=>file.artifact_id)).toEqual(["a","b"]);
  const heads=processHeaders(rows), states=reconcileProcesses(new Map(),heads);
  const visible=visibleProcessRows(rows,heads,states).map(row=>row.id);
  expect(visible.indexOf("artifacts:turn:t")).toBeGreaterThan(visible.indexOf("answer:0"));
  expect(visible.indexOf("artifacts:turn:t")).toBeLessThan(visible.indexOf("user:next"));
});
test("live final answer, handoff and history use the same file row identity and tail order",()=>{
  const stream={turn_id:"t",message_id:"u",text:"question",created_at:1000,started_at:1000,state:"running",stream:{display_metrics:{phase:"generating_answer"},process_parts:[
    {type:"text",part_id:"answer:0",sequence:1,text:"stream answer",status:"streaming",presentation:"final"},
  ]}} as unknown as DesktopConversationTurnPayload;
  for(const [history,turns] of [[source().slice(0,3),[stream]],[source(),[{...stream,state:"completed"}]],[source(),[]]] as [SessionMessage[],DesktopConversationTurnPayload[]][]){
    const rows=conversationRows(history,turns,[]);
    expect(rows.findIndex(row=>row.id==="artifacts:turn:t")).toBeGreaterThan(rows.findIndex(row=>row.id==="answer:0"));
    expect(rows.filter(row=>row.kind==="artifacts")).toHaveLength(1);
  }
});
test("failed, cancelled and textless turns retain their files outside collapsed process",()=>{
  for(const status of ["error","cancelled","completed"] as const){
    const history=source().slice(0,3).map(m=>({...m,turn:{...m.turn!,status}}));
    const rows=conversationRows(history,[],[]), heads=processHeaders(rows), states=reconcileProcesses(new Map(),heads);
    for(const state of states.values()) state.expanded=false;
    expect(visibleProcessRows(rows,heads,states).at(-1)?.id).toBe("artifacts:turn:t");
  }
});
test("legacy records without turn metadata retain files after their response group",()=>{
  const history=source().slice(1,4).map(({turn,...m})=>m);
  const rows=conversationRows(history,[],[]);
  expect(rows.at(-1)?.id).toBe("artifacts:turn:t");
  expect(rows.at(-1)?.artifacts).toHaveLength(2);
});
