import { resolve } from 'node:path';
import { openDatabase } from '../packages/database/src/database.js';

const dataDirectory = resolve(process.env.DATA_DIR ?? './data');
const database = openDatabase(resolve(dataDirectory, 'agentic-trading-manager.db'));
const migrations = database.raw.prepare('SELECT version,applied_at AS appliedAt FROM schema_migrations ORDER BY version').all();
process.stdout.write(`${JSON.stringify({ ok: true, database: database.path, migrations }, null, 2)}\n`);
database.close();
