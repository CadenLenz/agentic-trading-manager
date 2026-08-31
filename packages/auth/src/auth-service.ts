import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { AppDatabase } from '../../database/src/database.js';
import { makeId, nowIso } from '../../core/src/utils.js';

interface SessionPayload { sub: string; username: string; csrf: string; exp: number; iat: number }

export class AuthService {
  constructor(private readonly database: AppDatabase, private readonly secret: string) {
    if (secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  }

  hasUser(): boolean { return Boolean(this.database.raw.prepare('SELECT 1 FROM users LIMIT 1').get()); }

  async createAdmin(username: string, password: string): Promise<{ id: string; username: string }> {
    if (this.hasUser()) throw new Error('Administrator already exists');
    const salt = randomBytes(16).toString('hex');
    const hash = await this.hashPassword(password, salt);
    const id = makeId('user'); const timestamp = nowIso();
    this.database.raw.prepare('INSERT INTO users(id,username,password_hash,password_salt,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, username, hash, salt, timestamp, timestamp);
    this.database.audit(username, 'ADMIN_CREATED', 'user', id, {});
    return { id, username };
  }

  async authenticate(username: string, password: string): Promise<{ token: string; csrf: string; user: { id: string; username: string } } | null> {
    const row = this.database.raw.prepare('SELECT id,username,password_hash,password_salt FROM users WHERE username=? COLLATE NOCASE').get(username) as { id: string; username: string; password_hash: string; password_salt: string } | undefined;
    const salt = row?.password_salt ?? randomBytes(16).toString('hex');
    const candidate = await this.hashPassword(password, salt);
    const valid = row ? timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(row.password_hash, 'hex')) : false;
    if (!row || !valid) return null;
    const csrf = randomBytes(24).toString('base64url');
    const now = Math.floor(Date.now() / 1_000);
    const payload: SessionPayload = { sub: row.id, username: row.username, csrf, iat: now, exp: now + 8 * 60 * 60 };
    return { token: this.sign(payload), csrf, user: { id: row.id, username: row.username } };
  }

  verify(token: string): SessionPayload | null {
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature) return null;
    const expected = createHmac('sha256', this.secret).update(encoded).digest('base64url');
    if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
      if (!payload.sub || !payload.username || !payload.csrf || payload.exp < Math.floor(Date.now() / 1_000)) return null;
      return payload;
    } catch { return null; }
  }

  private sign(payload: SessionPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encoded}.${createHmac('sha256', this.secret).update(encoded).digest('base64url')}`;
  }
  private async hashPassword(password: string, salt: string): Promise<string> {
    const derived = await new Promise<Buffer>((resolvePromise, reject) => scryptCallback(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolvePromise(key)));
    return derived.toString('hex');
  }
}
