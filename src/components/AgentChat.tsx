import {CodexTasks} from './CodexTasks';
export function AgentChat({open,close,notify,initialPrompt=''}:{initialPrompt?:string;open:boolean;close:()=>void;refresh:()=>Promise<void>;notify:(text:string,tone?:string)=>void}){
  if(!open)return null;
  return <aside className="chat-drawer open" aria-label="Codex tasks" onKeyDown={e=>{if(e.key==='Escape')close();}}><header><h2>Codex tasks</h2><button className="button secondary" autoFocus onClick={close}>Close</button></header><div className="messages"><CodexTasks initialPrompt={initialPrompt} compact notify={notify}/></div></aside>;
}
