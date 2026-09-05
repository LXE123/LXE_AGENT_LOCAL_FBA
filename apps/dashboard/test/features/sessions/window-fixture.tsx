// Local browser acceptance fixture. No IPC, model request, or production session is used.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSessionConversationQuery } from "../../../src/api/queries";
import { setDashboardTransportForTests } from "../../../src/api/client";
import React, { useCallback, useRef, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ConversationWindow } from "../../../src/features/sessions/virtual-window";
import { UnifiedConversationRow } from "../../../src/features/sessions/view";
import { conversationRows } from "../../../src/features/sessions/presentation";
import { appendConversationWindow, prependConversationWindow, boundConversationWindow } from "../../../src/features/sessions/model";
import type { SessionDetailPayload, SessionMessage } from "../../../src/api/payloads";
import "../../../src/styles.css";
const all: SessionMessage[] = Array.from({ length: 1000 }, (_, i) => ({
  display_group_id: `g${i}`, display_id: `g${i}:0`, role: i % 7 === 1 || i % 7 === 3 || i % 2 ? "assistant" : "user", created_at: i + 1,
  content: i % 7 === 1 ? [{ type: "thinking", thinking: `Thought ${i}\n${"detail ".repeat(200)}` }]
    : i % 7 === 3 ? [{ type: "tool_call", id: `tool-${i}`, name: "read", arguments: {path:`fixture-${i}.md`} },{type:"tool_result",tool_call_id:`tool-${i}`,content:"output\n".repeat(500)}]
    : `Message ${i}\n\n**Markdown** paragraph. ${"Long text ".repeat(i % 5 * 20)}`,
}));
function page(start: number, end: number): SessionDetailPayload {
  return { session: {session_id:"fixture"}, messages: all.slice(start,end), messages_page: {
    fetched_at:1,total:1000,raw_message_total:1000,limit:10,oldest_cursor:`g${start}`,newest_cursor:`g${end-1}`,
    previous_cursor:start?`g${start}`:null,has_previous:start>0,next_cursor:end<1000?`g${end-1}`:null,has_next:end<1000,
    group_cursors:all.slice(start,end).map(m=>m.display_group_id),
  }} as SessionDetailPayload;
}
const queryClient = new QueryClient({defaultOptions:{queries:{retry:false}}});
setDashboardTransportForTests({call: async (call) => {
  if(call.operation !== "sessions.detail") throw new Error("fixture only supports history reads");
  const input=call.input as {session_id:string;message_before?:string;message_after?:string};
  if(input.message_before) await new Promise(resolve=>setTimeout(resolve,250));
  const result=page(input.message_before?980:990,input.message_before?990:1000);
  return {...result,session:{...result.session,session_id:input.session_id}} as never;
}});
function QueryProbe(){
  const [session,setSession]=useState("race-first");
  const query=useSessionConversationQuery(session);
  return <div><button onClick={()=>{void query.fetchPreviousPage();setSession("race-second")}}>Switch during history load</button>
    <span id="query-result">{JSON.stringify({requested:session,actual:query.data?.session.session_id,loading:query.isFetchingPreviousPage,oldest:query.data?.messages_page.oldest_cursor})}</span></div>;
}
const noop = async () => {};
function Fixture() {
  const [data,setData]=useState(()=>page(990,1000));
  const [expanded,setExpanded]=useState(new Map<string,boolean>());
  const [phase,setPhase]=useState(0);
  const [imageGroup,setImageGroup]=useState("");
  const [imageHeight,setImageHeight]=useState(30);
  const visible=useRef<string[]>([]);
  const bubble = useRef<Element|null>(null);
  const [measurement,setMeasurement]=useState<Record<string,unknown>>({});
  useEffect(()=>{ if(phase===1) bubble.current=document.querySelector('[data-conversation-row="user:handoff"]');
    if(phase===2) setMeasurement(m=>({...m,sameBubbleNode:bubble.current===document.querySelector('[data-conversation-row="user:handoff"]')}));
  },[phase]);
  const anchor = () => {
    const root=document.querySelector('.conversation-transcript')!;
    const top=root.getBoundingClientRect().top;
    const item=[...document.querySelectorAll<HTMLElement>('[data-conversation-row]')].find(e=>e.getBoundingClientRect().bottom>top);
    return item?{id:item.dataset.conversationRow!,offset:item.getBoundingClientRect().top-top}:null;
  };
  const measureLater=(saved:ReturnType<typeof anchor>)=>setTimeout(()=>{
    const element=[...document.querySelectorAll<HTMLElement>('[data-conversation-row]')].find(e=>e.dataset.conversationRow===saved?.id);
    const top=document.querySelector('.conversation-transcript')!.getBoundingClientRect().top;
    setMeasurement(m=>({...m,anchor:saved?.id,anchorError:element&&saved?Math.abs(element.getBoundingClientRect().top-top-saved.offset):null,mounted:document.querySelectorAll('[data-conversation-row]').length}));
  },200);
  const toggle=useCallback((id:string)=>setExpanded(m=>new Map(m).set(id,!m.get(id))),[]);
  const setVisible=useCallback((ids:string[])=>{visible.current=ids},[]);
  const load=async (direction:"older"|"newer")=>{
    const saved=anchor();
    await new Promise(r=>setTimeout(r,30));
    setData(current=> {
      const start=Number(current.messages_page.oldest_cursor!.slice(1)), end=Number(current.messages_page.newest_cursor!.slice(1))+1;
      return boundConversationWindow(direction==="older"?prependConversationWindow(current,page(Math.max(0,start-10),start)):appendConversationWindow(current,page(end,Math.min(1000,end+10))),visible.current,direction);
    });
    measureLater(saved);
  };
  const history=phase===2?[...data.messages,{display_group_id:"g1000",display_id:"g1000:0",role:"user",client_message_id:"handoff",content:"Handoff bubble",created_at:1001}]:data.messages;
  const rows=conversationRows(history,[],phase===1?[{pendingId:"handoff",sessionId:"fixture",text:"Handoff bubble",createdAt:1001000,attachments:[]}]:[]);
  return <div style={{height:"100vh",display:"flex",flexDirection:"column"}}>
    <QueryProbe/>
    <div style={{display:"flex",gap:8,padding:8,flexWrap:"wrap"}}>
      <button onClick={()=>setPhase(1)}>Pending bubble</button><button onClick={()=>setPhase(2)}>Persist bubble</button>
      <button onClick={()=>setData(current=>({...current,messages:current.messages.map((m,i)=>i===current.messages.length-1?{...m,content:String(m.content)+"\n\nStreaming addition ".repeat(20)}:m)}))}>Stream text</button>
      <button onClick={()=>setData(current=>({...current,messages:current.messages.map((m,i)=>i===Math.max(0,current.messages.length-3)?{...m,content:String(m.content)+"\n\nHeight changed ".repeat(80)}:m)}))}>Grow earlier row</button>
      <button onClick={()=>{
        const saved=anchor();
        const visibleGroup=visible.current[0]; const index=data.messages.findIndex(m=>m.display_group_id===visibleGroup);
        setImageGroup(data.messages[Math.max(0,index-1)]?.display_group_id??""); setImageHeight(30);
        setTimeout(()=>{setImageHeight(240);measureLater(saved)},60);
      }}>Load image above anchor</button>
      <span id="acceptance">{JSON.stringify(measurement)}</span><span id="metrics">{JSON.stringify({groups:data.messages_page.group_cursors?.length,bytes:new TextEncoder().encode(JSON.stringify(data.messages)).length,rows:rows.length})}</span>
    </div>
    <ConversationWindow rows={rows} renderRow={row=><><UnifiedConversationRow row={row} expanded={expanded.get(row.id)??false} onToggle={toggle} onOpenFile={noop} onRevealFile={noop} onOpenAttachment={noop}/>{row.groupId===imageGroup?<img alt="fixture dynamic image" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='240'%3E%3Crect width='320' height='240' fill='%23ccddee'/%3E%3C/svg%3E" style={{height:imageHeight,width:320}}/>:null}</>}
      hasOlder={data.messages_page.has_previous} hasNewer={!!data.messages_page.has_next} loadOlder={()=>load("older")} loadNewer={()=>load("newer")}
      jumpToLatest={()=>setData(page(990,1000))} onVisibleGroups={setVisible} pageError=""/>
  </div>;
}
const fixtureRoot=createRoot(document.getElementById("root")!);
fixtureRoot.render(<QueryClientProvider client={queryClient}><Fixture/></QueryClientProvider>);
if (import.meta.hot) import.meta.hot.dispose(()=>fixtureRoot.unmount());
