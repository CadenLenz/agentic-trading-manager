import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeId } from '../../core/src/utils.js';

export interface CodexRunRequest<T> {
  requestId?: string;
  agent: string;
  prompt: string;
  schema: Record<string, unknown>;
  validate: (value: unknown) => T;
  workingDirectory: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  model?: string | null;
  effort?: string | null;
  robinhoodReads?: boolean;
}
export interface CodexRunResult<T> { requestId: string; value: T; durationMs: number; attempts: number; stderr: string; metadata: Record<string, unknown> }

export class CodexRunner {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly inFlight = new Map<string, Promise<CodexRunResult<unknown>>>();
  readonly binary: string;
  readonly maxConcurrency: number;
  readonly defaultTimeoutMs: number;

  constructor(options: { binary?: string; maxConcurrency?: number; timeoutMs?: number } = {}) {
    this.binary = options.binary ?? process.env.CODEX_BIN ?? 'codex';
    this.maxConcurrency = options.maxConcurrency ?? Number(process.env.CODEX_MAX_CONCURRENCY ?? 1);
    this.defaultTimeoutMs = options.timeoutMs ?? Number(process.env.CODEX_TIMEOUT_MS ?? 120_000);
  }

  async run<T>(request: CodexRunRequest<T>): Promise<CodexRunResult<T>> {
    const requestId = request.requestId ?? makeId('codex');
    const duplicate = this.inFlight.get(requestId);
    if (duplicate) return duplicate as Promise<CodexRunResult<T>>;
    const promise = this.runWithRetry({ ...request, requestId });
    this.inFlight.set(requestId, promise as Promise<CodexRunResult<unknown>>);
    try { return await promise; } finally { this.inFlight.delete(requestId); }
  }

  health(): { healthy: boolean; active: number; queued: number; maxConcurrency: number } { return { healthy: true, active: this.active, queued: this.waiters.length, maxConcurrency: this.maxConcurrency }; }

  private async runWithRetry<T>(request: CodexRunRequest<T> & { requestId: string }): Promise<CodexRunResult<T>> {
    return this.runOnce(request, 1);
  }

  private async runOnce<T>(request: CodexRunRequest<T> & { requestId: string }, attempts: number): Promise<CodexRunResult<T>> {
    await this.acquire(request.signal);
    const started = Date.now();
    let directory:string|null=null;
    try {
    directory = await mkdtemp(join(tmpdir(), 'agentic-codex-'));
    const schemaPath = join(directory, 'schema.json');
    const outputPath = join(directory, 'output.json');
    await writeFile(schemaPath, JSON.stringify(request.schema), { mode: 0o600 });
      const args = ['exec', '--json', '--strict-config', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--output-schema', schemaPath, '--output-last-message', outputPath, '--cd', resolve(request.workingDirectory), '-'];
      args.splice(args.length-1,0,...isolatedConfig(request));
      const prompt = [
        `You are the ${request.agent} logical agent inside Agentic Trading Manager.`,
        'The application is authoritative. Never execute financial actions. Only read tools and schema output are permitted.',
        'Return only a value matching the supplied response schema. Do not expose hidden chain-of-thought; provide concise audit-ready rationale.',
        request.prompt,
      ].join('\n\n');
      const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
      const result = await this.spawnProcess(args, prompt, timeoutMs, request.signal);
      const text = await readFile(outputPath, 'utf8');
      let decoded: unknown;
      try { decoded = JSON.parse(text); } catch { throw new Error('Codex returned malformed JSON'); }
      return { requestId: request.requestId, value: request.validate(decoded), durationMs: Date.now() - started, attempts, stderr: result.stderr.slice(-4_000), metadata: { exitCode: result.exitCode, stdout: result.stdout } };
    } finally { this.release(); if(directory)await rm(directory, { recursive: true, force: true }); }
  }

  private spawnProcess(args: string[], input: string, timeoutMs: number, signal?: AbortSignal): Promise<{ exitCode: number; stderr: string; stdout:string }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.binary, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached:process.platform!=='win32', env: safeCodexEnvironment() });
      let stderr = '',stdout='';
      let settled = false;
      const finish = (error?: Error, exitCode = -1): void => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else if (exitCode !== 0) reject(Object.assign(new Error(`Codex exited ${exitCode}: ${processDiagnostic(stderr,stdout)}`),{stdout:scrubLog(stdout),stderr:scrubLog(stderr)}));
        else resolvePromise({ exitCode, stderr: scrubLog(stderr), stdout:scrubLog(stdout) });
      };
      const kill = (): void => { try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{/* already exited */} };
      const abort = (): void => { kill(); finish(new Error('Codex run canceled')); };
      const timer = setTimeout(() => { kill(); finish(new Error(`Codex run timed out after ${timeoutMs}ms`)); }, timeoutMs);
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 20_000) stderr = stderr.slice(-20_000); });
      child.stdout.on('data',(chunk:Buffer)=>{stdout=(stdout+chunk.toString()).slice(-20000);});
      child.stdin.on('error',()=>{/* close/error reports process failure */});
      child.on('error', (error) => finish(error));
      child.on('close', (code) => finish(undefined, code ?? -1));
      signal?.addEventListener('abort', abort, { once: true });
      if(signal?.aborted){abort();return;}
      child.stdin.end(input);
    });
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if(signal?.aborted)throw new Error('Codex run canceled');
    if (this.active < this.maxConcurrency) { this.active += 1; return; }
    await new Promise<void>((resolvePromise, reject) => {
      const resume = (): void => { signal?.removeEventListener('abort', abort); this.active += 1; resolvePromise(); };
      const abort = (): void => { const index = this.waiters.indexOf(resume); if (index >= 0) this.waiters.splice(index, 1); reject(new Error('Codex run canceled while queued')); };
      this.waiters.push(resume); signal?.addEventListener('abort', abort, { once: true });
    });
  }
  private release(): void { this.active = Math.max(0, this.active - 1); this.waiters.shift()?.(); }
}

// Fixed capabilities, never accepted from an HTTP request or user prose.
export const BROKER_READ_TOOLS=['get_accounts','get_portfolio','get_equity_positions','get_option_positions','get_equity_orders','get_option_orders','get_equity_quotes','get_option_quotes','get_option_instruments','get_option_chains','get_equity_fundamentals','get_equity_news','get_financials','get_earnings_results','get_earnings_calendar','get_equity_technical_indicators','get_equity_historicals','get_option_historicals'];
export function isolatedConfig(request:{model?:string|null;effort?:string|null;robinhoodReads?:boolean}){
  const config=['approval_policy="never"','forced_login_method="chatgpt"','model_provider="openai"','mcp_oauth_credentials_store="keyring"','web_search="disabled"','project_doc_max_bytes=0','features.skip_host_skill_discovery=true','features.code_mode_host=true',
    ...['shell_tool','unified_exec','apps','plugins','hooks','multi_agent','multi_agent_v2','code_mode','computer_use','browser_use','browser_use_external','browser_use_full_cdp_access','in_app_browser','memories','skill_search','skill_mcp_dependency_install','image_generation','view_image'].map(k=>'features.'+k+'=false')];
  if(request.robinhoodReads)config.push('mcp_servers.robinhood-trading.url="https://agent.robinhood.com/mcp/trading"','mcp_servers.robinhood-trading.enabled_tools='+JSON.stringify(BROKER_READ_TOOLS),'mcp_servers.robinhood-trading.startup_timeout_sec=15');
  if(request.effort)config.push('model_reasoning_effort='+JSON.stringify(request.effort));
  return [...config.flatMap(c=>['-c',c]),...(request.model?['--model',request.model]:[])];
}
export function safeCodexEnvironment(){
  const env:NodeJS.ProcessEnv={NO_COLOR:'1'};
  for(const key of ['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TMPDIR','SYSTEMROOT','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','CODEX_HOME','DBUS_SESSION_BUS_ADDRESS','XDG_DATA_HOME'])if(process.env[key])env[key]=process.env[key];
  return env;
}
export function scrubLog(value:string){return value.replace(/(?:Bearer\s+)[^\s"']+/gi,'Bearer [REDACTED]').replace(/(?:sk-|sk-proj-)[a-zA-Z0-9_-]+/g,'[REDACTED]').replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,'[REDACTED]');}

export function processDiagnostic(stderr:string,stdout:string){
  for(const line of stdout.split('\n').reverse())try{const event=JSON.parse(line);if(event.type==='error'||event.type==='turn.failed')return scrubLog(String(event.message??event.error?.message??'Codex task failed')).slice(-1500);}catch{/* non-JSON diagnostic */}
  const marker=stderr.lastIndexOf('ERROR:');return scrubLog((marker>=0?stderr.slice(marker):stderr||stdout).slice(-1500));
}
