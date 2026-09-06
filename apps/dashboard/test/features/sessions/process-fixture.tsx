import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {conversationRows} from "../../../src/features/sessions/presentation";
import {useProcessRows} from "../../../src/features/sessions/process";
import {ConversationWindow} from "../../../src/features/sessions/virtual-window";
import {UnifiedConversationRow} from "../../../src/features/sessions/view";
import type {SessionMessage} from "../../../src/api/payloads";
import "../../../src/styles.css";
const noop=async()=>{};
function Fixture(){
  const [status,setStatus]=useState("running");
  const [tools,setTools]=useState(new Map<string,boolean>());
  const messages=[
    {role:"user",content:"Inspect the file",display_id:"u",client_message_id:"u"},
    {role:"assistant",id:"a",content:[{type:"thinking",thinking:"I will inspect the file before answering."},{type:"text",text:"Checking the implementation now."},{type:"tool_call",id:"c",name:"read",arguments:{path:"example.ts"}}]},
    {role:"tool",content:[{type:"tool_result",tool_call_id:"c",content:"Example source\n".repeat(100)}]},
    {role:"assistant",id:"b",content:[{type:"thinking",thinking:"The result is consistent.\n".repeat(40)},{type:"text",text:"**Final answer** stays outside the process."}]},
  ].map(m=>({...m,display_group_id:"g",created_at:1,turn:{turn_id:"t",status,elapsed_ms:14000}})) as SessionMessage[];
  const process=useProcessRows(conversationRows(messages,[],[]),"fixture");
  return <div style={{height:"100vh",display:"flex",flexDirection:"column"}}>
    <div><button onClick={()=>setStatus("completed")}>Complete</button><button onClick={()=>setStatus("error")}>Fail</button><button onClick={()=>setStatus("running")}>Run again</button></div>
    <ConversationWindow rows={process.rows} hasOlder={false} hasNewer={false} loadOlder={noop} loadNewer={noop} jumpToLatest={()=>{}} onVisibleGroups={()=>{}} pageError=""
      renderRow={row=><UnifiedConversationRow row={row} expanded={row.kind==="process"?process.states.get(row.id)?.expanded??false:tools.get(row.id)??false}
        onToggle={row.kind==="process"?process.toggle:id=>setTools(old=>new Map(old).set(id,!old.get(id)))} onOpenFile={noop} onRevealFile={noop} onOpenAttachment={noop}/>} />
  </div>;
}
const root=createRoot(document.getElementById("root")!);root.render(<Fixture/>);
if(import.meta.hot) import.meta.hot.dispose(()=>root.unmount());
