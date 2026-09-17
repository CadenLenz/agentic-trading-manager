import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';
const credentials=z.object({openaiKey:z.string().min(20).max(500),openaiModel:z.string().min(1).max(200)}).strict();
/** Server-only envelope. Credentials are never returned by API, stored in SQLite or logged. */
export class OpenAICredentialVault{
  constructor(readonly path:string,readonly secret:string){}
  private key(){return createHash('sha256').update(this.secret+':OPENAI_CREDENTIAL_VAULT_V1').digest();}
  read(){if(!existsSync(this.path))return null;const e=z.object({version:z.literal(1),iv:z.string(),tag:z.string(),ciphertext:z.string()}).strict().parse(JSON.parse(readFileSync(this.path,'utf8'))),d=createDecipheriv('aes-256-gcm',this.key(),Buffer.from(e.iv,'base64'));d.setAuthTag(Buffer.from(e.tag,'base64'));return credentials.parse(JSON.parse(Buffer.concat([d.update(Buffer.from(e.ciphertext,'base64')),d.final()]).toString('utf8')));}
  save(input:unknown){const value=credentials.parse(input),iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key(),iv),encrypted=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);mkdirSync(dirname(this.path),{recursive:true,mode:0o700});const temporary=this.path+'.'+randomBytes(8).toString('hex')+'.tmp';writeFileSync(temporary,JSON.stringify({version:1,iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')}),{mode:0o600,flag:'wx'});renameSync(temporary,this.path);chmodSync(this.path,0o600);return value;}
}
