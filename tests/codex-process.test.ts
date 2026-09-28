import {afterEach,describe,it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {writeFileSync} from 'node:fs';
const fake=vi.hoisted(()=>({spawn:vi.fn(),execFile:vi.fn()}));
vi.mock('node:child_process',()=>fake);
import {CodexRunner} from '../packages/agents/src/codex-runner.js';
import {probeCodex} from '../packages/agents/src/worker.js';
const req={agent:'fixture',prompt:'$(touch /tmp/unsafe); --dangerously-bypass-approvals-and-sandbox',schema:{type:'object'},validate:(v:unknown)=>v,workingDirectory:process.cwd()};
afterEach(()=>{vi.clearAllMocks();});
function processFixture(mode:'success'|'invalid'|'hang'|'error'='success'){
 const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});
 fake.spawn.mockImplementation((_bin:string,args:string[])=>{child.stdin.on('finish',()=>{if(mode==='hang')return;if(mode==='error'){child.stderr.write('usage limit exceeded');child.emit('close',1);return;}writeFileSync(args[args.indexOf('--output-last-message')+1]!,mode==='invalid'?'not json':'{"ok":true}');child.emit('close',0);});return child;});return child;
}
describe('Codex child-process contract',()=>{
 it('keeps ChatGPT usable when a locked keyring blocks MCP auth lookup',async()=>{fake.execFile.mockImplementation((_bin:string,args:string[],opts:{timeout:number},callback:(e:Error|null,s:string,t:string)=>void)=>{expect(opts.timeout).toBeLessThan(10000);if(args[1]==='list'){callback(new Error('timed out'),'', '');return;}const value=args[0]==='--version'?'codex-cli 0.157.1':args[0]==='login'?'Logged in using ChatGPT':args[1]==='get'?'{"name":"robinhood-trading","enabled":true,"token":"do-not-expose"}':'--strict-config --ignore-user-config --ignore-rules --output-schema --ephemeral --model';callback(null,value,'');});const result=await probeCodex();expect(result).toMatchObject({usable:true,robinhood:{configured:true,status:'Needs credential-store unlock or login; OAuth status unavailable'}});expect(JSON.stringify(result)).not.toContain('do-not-expose');});
 it('uses explicit argument arrays, stdin, isolated config, no shell or API keys',async()=>{const child=processFixture(),r=new CodexRunner();await r.run(req);const call=fake.spawn.mock.calls[0]!;expect(call[1]).not.toContain(req.prompt);expect(call[1]).toContain('--ignore-user-config');expect(call[1]).toContain('--strict-config');expect(call[2]).toMatchObject({shell:false});expect(child.stdin.read()?.toString()).toContain(req.prompt);});
 it('rejects malformed JSON and never retries',async()=>{processFixture('invalid');await expect(new CodexRunner().run(req)).rejects.toThrow('malformed');expect(fake.spawn).toHaveBeenCalledTimes(1);});
 it('does not retry usage failures',async()=>{processFixture('error');await expect(new CodexRunner().run(req)).rejects.toThrow('usage limit');expect(fake.spawn).toHaveBeenCalledTimes(1);});
 it('times out and kills a child',async()=>{const child=processFixture('hang');await expect(new CodexRunner().run({...req,timeoutMs:20})).rejects.toThrow('timed out');expect(child.kill).toHaveBeenCalled();});
 it('cancels active and already-aborted requests safely',async()=>{const child=processFixture('hang'),controller=new AbortController(),r=new CodexRunner();const running=r.run({...req,signal:controller.signal});const assertion=expect(running).rejects.toThrow('canceled');await vi.waitFor(()=>expect(fake.spawn).toHaveBeenCalled());controller.abort();await assertion;expect(child.kill).toHaveBeenCalled();await expect(r.run({...req,signal:controller.signal})).rejects.toThrow('canceled');expect(fake.spawn).toHaveBeenCalledTimes(1);});
 it('detects ChatGPT login, version and MCP without returning raw config',async()=>{fake.execFile.mockImplementation((_bin:string,args:string[],_opts:unknown,callback:(e:null,s:string,t:string)=>void)=>{const value=args[0]==='--version'?'codex-cli 0.157.1':args[0]==='login'?'Logged in using ChatGPT':args[0]==='mcp'?'[{"name":"robinhood-trading","enabled":true,"auth_status":"o_auth","token":"do-not-expose"}]':'--strict-config --ignore-user-config --ignore-rules --output-schema --ephemeral --model';callback(null,value,'');});const result=await probeCodex();expect(result).toMatchObject({installed:true,loggedIn:true,compatible:true,usable:true,robinhood:{configured:true}});expect(JSON.stringify(result)).not.toContain('do-not-expose');});
});
