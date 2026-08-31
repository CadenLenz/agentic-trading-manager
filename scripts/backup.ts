import { chmod, mkdir, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../packages/database/src/database.js';

const dataDirectory = resolve(process.env.DATA_DIR ?? './data');
const backupDirectory = resolve(process.env.BACKUP_DIR ?? `${dataDirectory}/backups`);
await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const finalPath = resolve(backupDirectory, `agentic-trading-manager-${stamp}.db`);
const temporaryPath = `${finalPath}.partial`;
const database = openDatabase(resolve(dataDirectory, 'agentic-trading-manager.db'));
try {
  await database.raw.backup(temporaryPath);
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, finalPath);
  const info = await stat(finalPath);
  process.stdout.write(`${JSON.stringify({ ok: true, path: finalPath, bytes: info.size })}\n`);
} finally { database.close(); }
