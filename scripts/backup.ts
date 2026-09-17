import { chmod, mkdir, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppDatabase } from '../packages/database/src/database.js';

const dataDirectory = resolve(process.env.DATA_DIR ?? './data');
const backupDirectory = resolve(process.env.BACKUP_DIR ?? `${dataDirectory}/backups`);
await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const finalPath = resolve(backupDirectory, `agentic-trading-manager-${stamp}.db`);
const temporaryPath = `${finalPath}.partial`;
const databasePath=resolve(dataDirectory,'agentic-trading-manager.db');
await stat(databasePath); // Never create or migrate the source before backing it up.
const database = new AppDatabase(databasePath);
try {
  await database.raw.backup(temporaryPath);
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, finalPath);
  const info = await stat(finalPath);
  process.stdout.write(`${JSON.stringify({ ok: true, path: finalPath, bytes: info.size })}\n`);
} finally { database.close(); }
