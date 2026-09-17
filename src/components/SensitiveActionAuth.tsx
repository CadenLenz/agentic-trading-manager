import {useState} from 'react';
import {post} from '../api';
export function SensitiveActionAuth({notify}:{notify:(message:string,tone?:string)=>void}){
  const [password,setPassword]=useState(''),[busy,setBusy]=useState(false);
  const authenticate=async()=>{setBusy(true);try{await post('/api/v2/reauth',{password});notify('This session is reauthenticated for sensitive changes for five minutes.');}catch(e){notify(String(e),'danger');}finally{setPassword('');setBusy(false);}};
  return <details className="sensitive-action-auth"><summary>Reauthenticate for major changes</summary><p>Risk, policy, ownership, kill reset, STOP release and confirmed configuration changes require a recent password check for this session. STOP and pause do not.</p><form onSubmit={e=>{e.preventDefault();void authenticate();}}><input aria-label="Sensitive action password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/><button className="button secondary" disabled={busy||!password}>Reauthenticate this session</button></form></details>;
}
