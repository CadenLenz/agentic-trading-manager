import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { AgenticManager } from '../../../packages/core/src/agentic-manager.js';
import { buildServer } from './server.js';

if(existsSync('.env'))loadEnvFile('.env');
const workingDirectory = resolve(process.cwd());
const dataDirectory = resolve(process.env.DATA_DIR ?? './data');
const databasePath = resolve(dataDirectory, 'agentic-trading-manager.db');
process.stdout.write(`${JSON.stringify({event:'STARTUP_PHASE',phase:'MANAGER_CONSTRUCTION',databaseDirectory:dataDirectory})}\n`);
const manager = new AgenticManager({ databasePath, workingDirectory, sessionSecret: process.env.SESSION_SECRET ?? (process.env.NODE_ENV === 'production' ? '' : 'development-only-session-secret-change-me-now'), startBackgroundServices: true });
process.stdout.write(`${JSON.stringify({event:'STARTUP_PHASE',phase:'MANAGER_START'})}\n`);
await manager.start();
process.stdout.write(`${JSON.stringify({event:'STARTUP_PHASE',phase:'SERVER_BUILD'})}\n`);
const server = await buildServer({ manager, webRoot: resolve(workingDirectory, 'dist/web'), serveWeb: true });
const host = process.env.BIND_HOST ?? '127.0.0.1'; const port = Number(process.env.PORT ?? 4010);

const close = async (): Promise<void> => { await server.close(); await manager.shutdown(); };
process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
await server.listen({ host, port });
process.stdout.write(`${JSON.stringify({event:'STARTUP_COMPLETE',host,port})}\n`);
