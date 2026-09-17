import {createHash} from 'node:crypto';
import type {AppDatabase} from '../../database/src/database.js';
export function openaiCredentialFingerprint(){return createHash('sha256').update((process.env.OPENAI_API_KEY??'')+'\0'+(process.env.OPENAI_MODEL??'gpt-5.5')).digest('hex');}
export function hasOpenAIModelEvidence(db:AppDatabase){
  const row=db.raw.prepare('SELECT body_json FROM connector_status WHERE id=?').get('OPENAI') as {body_json:string}|undefined;
  if(!row||!process.env.OPENAI_API_KEY)return false;
  const status=JSON.parse(row.body_json),at=Date.parse(status.lastSuccess??''),age=Date.now()-at;
  return status.state==='CONNECTED'&&Number.isFinite(at)&&age>=-5000&&age<86400000&&db.getSetting<string|null>('openai_verified_fingerprint',null)===openaiCredentialFingerprint();
}
