import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeId, redact } from '../../core/src/utils.js';

export interface CodexRunRequest<T> {
  requestId?: string;
  agent: string;
  prompt: string;
  schema: Record<string, unknown>;
  validate: (value: unknown) => T;
  workingDirectory: string;
  timeoutMs?: number;
  signal?: AbortSignal;
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
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try { return await this.runOnce(request, attempt); }
      catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (request.signal?.aborted || /schema|validation|canceled/i.test(lastError.message)) break;
      }
    }
    throw lastError ?? new Error('Codex run failed');
  }

  private async runOnce<T>(request: CodexRunRequest<T> & { requestId: string }, attempts: number): Promise<CodexRunResult<T>> {
    await this.acquire(request.signal);
    const started = Date.now();
    const directory = await mkdtemp(join(tmpdir(), 'agentic-codex-'));
    const schemaPath = join(directory, 'schema.json');
    const outputPath = join(directory, 'output.json');
    await writeFile(schemaPath, JSON.stringify(request.schema), { mode: 0o600 });
    try {
      const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--output-schema', schemaPath, '--output-last-message', outputPath, '--cd', resolve(request.workingDirectory), '-'];
      const prompt = [
        `You are the ${request.agent} logical agent inside Agentic Trading Manager.`,
        'The application is authoritative. Never modify configuration, place an order, or use a brokerage tool unless this exact request explicitly authorizes that single typed action.',
        'Return only a value matching the supplied response schema. Do not expose hidden chain-of-thought; provide concise audit-ready rationale.',
        request.prompt,
      ].join('\n\n');
      const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
      const result = await this.spawnProcess(args, prompt, timeoutMs, request.signal);
      const text = await readFile(outputPath, 'utf8');
      let decoded: unknown;
      try { decoded = JSON.parse(text); } catch { throw new Error('Codex returned malformed JSON'); }
      return { requestId: request.requestId, value: request.validate(decoded), durationMs: Date.now() - started, attempts, stderr: result.stderr.slice(-4_000), metadata: { exitCode: result.exitCode } };
    } finally { this.release(); await rm(directory, { recursive: true, force: true }); }
  }

  private spawnProcess(args: string[], input: string, timeoutMs: number, signal?: AbortSignal): Promise<{ exitCode: number; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.binary, args, { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
      let stderr = '';
      let settled = false;
      const finish = (error?: Error, exitCode = -1): void => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else if (exitCode !== 0) reject(new Error(`Codex exited ${exitCode}: ${JSON.stringify(redact(stderr.slice(-2_000)))}`));
        else resolvePromise({ exitCode, stderr: String(redact(stderr)) });
      };
      const abort = (): void => { child.kill(); finish(new Error('Codex run canceled')); };
      const timer = setTimeout(() => { child.kill(); finish(new Error(`Codex run timed out after ${timeoutMs}ms`)); }, timeoutMs);
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 20_000) stderr = stderr.slice(-20_000); });
      child.on('error', (error) => finish(error));
      child.on('exit', (code) => finish(undefined, code ?? -1));
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.end(input);
    });
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (this.active < this.maxConcurrency) { this.active += 1; return; }
    await new Promise<void>((resolvePromise, reject) => {
      const resume = (): void => { signal?.removeEventListener('abort', abort); this.active += 1; resolvePromise(); };
      const abort = (): void => { const index = this.waiters.indexOf(resume); if (index >= 0) this.waiters.splice(index, 1); reject(new Error('Codex run canceled while queued')); };
      this.waiters.push(resume); signal?.addEventListener('abort', abort, { once: true });
    });
  }
  private release(): void { this.active = Math.max(0, this.active - 1); this.waiters.shift()?.(); }
}
