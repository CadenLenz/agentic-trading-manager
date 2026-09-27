import {useCallback,useEffect,useState} from 'react';
import {api,post} from '../api';
import {SensitiveActionAuth} from './SensitiveActionAuth';
interface Session {id:string;mode:'ADVISOR'|'OPERATOR'|'AUTONOMOUS';updated_at:string}
interface Message {id:string;role:string;content:string}
interface Change {id:string;status:string;reason:string;payload:unknown}
export function AgentChat({open,close,refresh,notify}:{open:boolean;close:()=>void;refresh:()=>Promise<void>;notify:(text:string,tone?:string)=>void}){
  const [sessions,setSessions]=useState<Session[]>([]),[selected,setSelected]=useState(''),[mode,setMode]=useState<Session['mode']>('ADVISOR');
  const [messages,setMessages]=useState<Message[]>([]),[actions,setActions]=useState<unknown[]>([]),[changes,setChanges]=useState<Change[]>([]);
  const [text,setText]=useState(''),[busy,setBusy]=useState(false);
  const load=useCallback(async()=>{
    const list=await api<Session[]>('/api/v2/agent/sessions');setSessions(list);
    setChanges((await api<{changes:Change[]}>('/api/changes')).changes.filter(c=>c.status==='PENDING'));
    if(!selected&&list[0])setSelected(list[0].id);
    if(selected){const d=await api<{messages:Message[];actions:unknown[];session:Session}>('/api/v2/agent/sessions/'+selected);setMessages(d.messages);setActions(d.actions);setMode(d.session.mode);}
  },[selected]);
  useEffect(()=>{if(open)void load().catch(e=>notify(String(e),'danger'));},[open,load,notify]);
  const create=async()=>{const s=await post<Session>('/api/v2/agent/sessions',{mode});setSelected(s.id);setMessages([]);setActions([]);};
  const confirm=async(id:string,reject=false)=>{
    if(!reject&&!window.confirm('Apply exactly this structured change? This is not a trade approval.'))return;
    try{await post('/api/changes/'+id+(reject?'/reject':'/confirm'),{});await load();await refresh();}
    catch(e){notify(String(e),'danger');}
  };
  const send=async()=>{
    if(!text.trim()||busy)return;setBusy(true);
    try{let id=selected;if(!id){const s=await post<Session>('/api/v2/agent/sessions',{mode});id=s.id;setSelected(id);}
      await post('/api/v2/agent/sessions/'+id+'/chat',{message:text});setText('');
      const d=await api<{messages:Message[];actions:unknown[]}>('/api/v2/agent/sessions/'+id);setMessages(d.messages);setActions(d.actions);
      setChanges((await api<{changes:Change[]}>('/api/changes')).changes.filter(c=>c.status==='PENDING'));await refresh();
    }catch(e){notify(String(e),'danger');}finally{setBusy(false);}
  };
  if(!open)return null;
  return <aside className={'chat-drawer '+(open?'open':'')} aria-label="Trading assistant" onKeyDown={e=>{if(e.key==='Escape')close();}}>
    <header><div><p className="eyebrow">YOUR ASSISTANT</p><h2>What can I help with?</h2></div><button className="button secondary" autoFocus onClick={close}>Close</button></header>
    <div className="chat-contract">Ask about your account or request a change. Important changes need your confirmation. Trade approvals happen in Trade reviews.</div>
    <details className="v2-chat-controls"><summary>Conversation & permissions</summary>
      <select aria-label="Conversation" value={selected} onChange={e=>setSelected(e.target.value)}><option value="">New conversation</option>{sessions.map(s=><option key={s.id} value={s.id}>{s.mode} · {s.updated_at.slice(0,16)}</option>)}</select>
      <select aria-label="New session mode" value={mode} onChange={e=>setMode(e.target.value as Session['mode'])}><option value="ADVISOR">Explain and advise</option><option value="OPERATOR">Help with operations</option><option value="AUTONOMOUS">Automatic within approved policy</option></select>
      <button className="button secondary" disabled={busy} onClick={()=>void create().catch(e=>notify(String(e),'danger'))}>Start new conversation</button>
    </details>
    <div className="messages">
      <SensitiveActionAuth notify={notify}/>
      {!messages.length&&<div className="assistant-prompts"><h3>Start with a question</h3>{['What should I do next?','Is everything working?','How am I doing today?','Help me connect Robinhood.'].map(prompt=><button key={prompt} onClick={()=>setText(prompt)}>{prompt}</button>)}</div>}{messages.filter(m=>['user','assistant'].includes(m.role)).map(m=><article className={'message '+(m.role==='user'?'operator':'manager')} key={m.id}><small>{m.role}</small><p>{m.content}</p></article>)}
      {busy&&<p>Working on your request…</p>}
      {changes.map(c=><article className="pending-card" key={c.id}><h3>{c.reason}</h3><pre>{JSON.stringify(c.payload,null,2)}</pre><div><button className="button secondary" onClick={()=>void confirm(c.id,true)}>Reject</button><button className="button primary" onClick={()=>void confirm(c.id)}>Confirm structured change</button></div></article>)}
      <details><summary>Tool action audit ({actions.length})</summary><pre>{JSON.stringify(actions,null,2)}</pre></details>
    </div>
    <form className="chat-input" onSubmit={e=>{e.preventDefault();void send();}}><textarea aria-label="Agent message" value={text} onChange={e=>setText(e.target.value)} placeholder="Ask a question or request a change…"/><button className="button primary" disabled={busy||!text.trim()}>Send</button></form>
  </aside>;
}
