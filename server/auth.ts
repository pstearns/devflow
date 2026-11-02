// Single-admin, local-only authentication.
//   - Password: Argon2id (Node's built-in OpenSSL implementation), PHC-encoded, parameters above OWASP's minimum.
//   - Storage: SQLite (node:sqlite) in a private directory outside Git; only the hash and account metadata are stored.
//   - Sessions: 256-bit random opaque tokens in an HttpOnly/SameSite=Strict cookie. Only a SHA-256 verifier of the token is
//     stored, so the database alone cannot be replayed as a login. Idle expiry is enforced here, server-side.
//   - The admin account is created ONLY by the interactive CLI (auth-cli.ts), never by application startup.
import { DatabaseSync } from 'node:sqlite';
import { argon2, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Limiter } from './util.ts';

const argon2Async = promisify(argon2) as unknown as (alg: 'argon2id', p: { message: Buffer; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number }) => Promise<Buffer>;

/** OWASP minimum for Argon2id is m=19 MiB, t=2, p=1. These are deliberately stronger (64 MiB, t=3). */
export const ARGON2 = { memoryKiB: 65536, passes: 3, parallelism: 1, tagLength: 32, saltLength: 16 } as const;
export const IDLE_SECONDS = 1800; // 30-minute sliding inactivity timeout
export const MIN_PASSWORD = 15; // OWASP: 15+ characters when there is no MFA
export const MAX_PASSWORD = 128;
export const SESSION_COOKIE = 'devflow_session';
const MAX_SESSIONS = 10;
const LOCK_AFTER = 5; // failed logins before throttling starts
const LOCK_BASE_S = 30, LOCK_MAX_S = 900; // 30 s doubling to 15 min
const ATTEMPT_WINDOW_S = 900;

export const defaultAuthPath = (env: NodeJS.ProcessEnv = process.env) => env.DEVFLOW_AUTH_DB || join(homedir(), '.local', 'share', 'devflow', 'auth.sqlite');

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');
const normalize = (pw: string) => pw.normalize('NFKC'); // OWASP: normalize Unicode before hashing

export function passwordPolicyError(pw: string): string | undefined {
  if (pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters (a passphrase works well).`;
  if (pw.length > MAX_PASSWORD) return `Password must be at most ${MAX_PASSWORD} characters.`;
  if (new Set(pw).size < 6) return 'Password is too repetitive.';
  return undefined;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(ARGON2.saltLength);
  const tag = await argon2Async('argon2id', { message: Buffer.from(normalize(password)), nonce: salt, parallelism: ARGON2.parallelism, tagLength: ARGON2.tagLength, memory: ARGON2.memoryKiB, passes: ARGON2.passes });
  return `$argon2id$v=19$m=${ARGON2.memoryKiB},t=${ARGON2.passes},p=${ARGON2.parallelism}$${b64(salt)}$${b64(tag)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const parsePhc = (phc: string) => {
  const m = PHC.exec(phc);
  if (!m) return undefined;
  const memory = Number(m[1]), passes = Number(m[2]), parallelism = Number(m[3]);
  // bounds guard against a tampered database making verification a denial-of-service
  if (memory < 8 || memory > 1_048_576 || passes < 1 || passes > 10 || parallelism < 1 || parallelism > 8) return undefined;
  return { memory, passes, parallelism, salt: Buffer.from(m[4]!, 'base64'), tag: Buffer.from(m[5]!, 'base64') };
};

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const p = parsePhc(phc);
  if (!p || p.tag.length < 16 || p.salt.length < 8) return false;
  const got = await argon2Async('argon2id', { message: Buffer.from(normalize(password)), nonce: p.salt, parallelism: p.parallelism, tagLength: p.tag.length, memory: p.memory, passes: p.passes });
  return got.length === p.tag.length && timingSafeEqual(got, p.tag);
}

export const needsRehash = (phc: string) => {
  const p = parsePhc(phc);
  return !p || p.memory < ARGON2.memoryKiB || p.passes < ARGON2.passes || p.parallelism !== ARGON2.parallelism;
};

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export type Login =
  | { ok: true; token: string; csrf: string }
  | { ok: false; code: 'invalid' | 'locked' | 'not-setup' | 'bad-input'; retryAfterSeconds?: number };
export type Validated = { ok: true; csrf: string; remainingSeconds: number } | { ok: false; reason: 'none' | 'expired' };

export interface AuthOptions { path: string; clock?: () => number; idleSeconds?: number; log?: (line: string) => void }

export class AuthService {
  readonly path: string;
  readonly idleSeconds: number;
  private db: DatabaseSync;
  private clock: () => number;
  private log: (l: string) => void;
  private hashing = new Limiter(2); // bound concurrent 64 MiB hashes
  private csrfKey: string;

  private constructor(opts: AuthOptions, db: DatabaseSync, csrfKey: string) {
    this.path = opts.path; this.db = db; this.csrfKey = csrfKey;
    this.clock = opts.clock ?? Date.now; this.idleSeconds = opts.idleSeconds ?? IDLE_SECONDS; this.log = opts.log ?? (() => {});
  }

  /** Opens (creating the empty database if needed) with owner-only permissions. Never creates the admin account. */
  static open(opts: AuthOptions): AuthService {
    const memory = opts.path === ':memory:';
    if (!memory) {
      const dir = dirname(opts.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      const old = process.umask(0o077); // anything SQLite creates is owner-only from the first byte
      try { AuthService.hardenPerms(opts.path, dir); } finally { process.umask(old); }
    }
    const old = process.umask(0o077);
    let db: DatabaseSync;
    try { db = new DatabaseSync(opts.path); } finally { process.umask(old); }
    db.exec(`PRAGMA journal_mode = DELETE; PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, password_changed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE, created_at_ms INTEGER NOT NULL, last_activity_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, success INTEGER NOT NULL);`);
    // sessions are ephemeral: an older layout is dropped and recreated (this ends those sessions, nothing else)
    if (!(db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some((c) => c.name === 'last_activity_ms')) {
      db.exec('DROP TABLE sessions; CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE, created_at_ms INTEGER NOT NULL, last_activity_ms INTEGER NOT NULL);');
    }
    let row = db.prepare("SELECT value FROM meta WHERE key = 'csrf_key'").get() as { value: string } | undefined;
    if (!row) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('csrf_key', ?), ('schema_version', '1')").run(randomBytes(32).toString('hex'));
      row = db.prepare("SELECT value FROM meta WHERE key = 'csrf_key'").get() as { value: string };
    }
    if (!memory) { const old2 = process.umask(0o077); try { chmodSync(opts.path, 0o600); } finally { process.umask(old2); } }
    return new AuthService(opts, db, row.value);
  }

  /** Directory 0700, file 0600, owned by us, not a symlink. Loose permissions are tightened; anything unsafe is refused. */
  private static hardenPerms(path: string, dir: string) {
    const d = lstatSync(dir);
    if (d.isSymbolicLink() || !d.isDirectory()) throw new Error(`Auth directory ${dir} must be a real directory`);
    if (d.uid !== process.getuid?.()) throw new Error(`Auth directory ${dir} is not owned by the current user`);
    if ((d.mode & 0o077) !== 0) chmodSync(dir, 0o700);
    if (existsSync(path)) {
      const f = lstatSync(path);
      if (f.isSymbolicLink() || !f.isFile()) throw new Error(`Auth database ${path} must be a regular file`);
      if (f.uid !== process.getuid?.()) throw new Error(`Auth database ${path} is not owned by the current user`);
      if ((f.mode & 0o077) !== 0) chmodSync(path, 0o600);
    }
  }

  close() { this.db.close(); }
  private now() { return Math.floor(this.clock() / 1000); } // seconds: account metadata and throttling
  private nowMs() { return Math.floor(this.clock()); } // milliseconds: session timing must be exact

  get hasAdmin(): boolean { return !!this.db.prepare('SELECT 1 AS x FROM admin WHERE id = 1').get(); }
  get activeSessions(): number { this.purge(); return (this.db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c; }
  get permissions(): { dir: string; file: string } | undefined {
    if (this.path === ':memory:') return undefined;
    return { dir: (statSync(dirname(this.path)).mode & 0o777).toString(8), file: (statSync(this.path).mode & 0o777).toString(8) };
  }

  /** Creates the single admin account. Called ONLY from the interactive CLI. The plaintext password is hashed and dropped. */
  async createAdmin(password: string): Promise<void> {
    const bad = passwordPolicyError(password);
    if (bad) throw new Error(bad);
    if (this.hasAdmin) throw new Error('An admin account already exists. Use the reset command to change its password.');
    const h = await this.hashing.run(() => hashPassword(password));
    const t = this.now();
    this.db.prepare("INSERT INTO admin (id, username, password_hash, created_at, password_changed_at) VALUES (1, 'admin', ?, ?, ?)").run(h, t, t);
  }

  /** Replaces the password and invalidates every session. Called ONLY from the interactive CLI. */
  async resetPassword(password: string): Promise<void> {
    const bad = passwordPolicyError(password);
    if (bad) throw new Error(bad);
    if (!this.hasAdmin) throw new Error('No admin account exists yet. Run setup first.');
    const h = await this.hashing.run(() => hashPassword(password));
    this.db.prepare('UPDATE admin SET password_hash = ?, password_changed_at = ? WHERE id = 1').run(h, this.now());
    this.db.exec('DELETE FROM sessions; DELETE FROM login_attempts;');
  }

  // ---- throttling -------------------------------------------------------------------------------------------------
  private lockRemaining(): number {
    const t = this.now();
    const rows = this.db.prepare('SELECT at FROM login_attempts WHERE success = 0 AND at > ? ORDER BY at DESC').all(t - ATTEMPT_WINDOW_S) as { at: number }[];
    if (rows.length < LOCK_AFTER) return 0;
    const wait = Math.min(LOCK_MAX_S, LOCK_BASE_S * 2 ** (rows.length - LOCK_AFTER));
    return Math.max(0, rows[0]!.at + wait - t);
  }

  async login(password: unknown): Promise<Login> {
    if (!this.hasAdmin) return { ok: false, code: 'not-setup' };
    if (typeof password !== 'string' || password.length === 0 || password.length > 1024) return { ok: false, code: 'bad-input' };
    const wait = this.lockRemaining();
    if (wait > 0) { this.log('auth login throttled'); return { ok: false, code: 'locked', retryAfterSeconds: wait }; }
    const row = this.db.prepare('SELECT password_hash FROM admin WHERE id = 1').get() as { password_hash: string };
    const ok = await this.hashing.run(() => verifyPassword(password, row.password_hash)); // always pays the full hashing cost
    const t = this.now();
    this.db.prepare('DELETE FROM login_attempts WHERE at < ?').run(t - 86400);
    if (!ok) {
      this.db.prepare('INSERT INTO login_attempts (at, success) VALUES (?, 0)').run(t);
      const after = this.lockRemaining();
      this.log('auth login failed');
      return after > 0 ? { ok: false, code: 'locked', retryAfterSeconds: after } : { ok: false, code: 'invalid' };
    }
    this.db.prepare('DELETE FROM login_attempts').run();
    if (needsRehash(row.password_hash)) this.db.prepare('UPDATE admin SET password_hash = ? WHERE id = 1').run(await this.hashing.run(() => hashPassword(password)));
    this.purge();
    const token = randomBytes(32).toString('base64url');
    const hash = sha256(token);
    const tm = this.nowMs();
    this.db.prepare('INSERT INTO sessions (token_hash, created_at_ms, last_activity_ms) VALUES (?, ?, ?)').run(hash, tm, tm);
    // keep the table small: the oldest sessions beyond the cap are discarded
    this.db.prepare('DELETE FROM sessions WHERE id NOT IN (SELECT id FROM sessions ORDER BY last_activity_ms DESC, id DESC LIMIT ?)').run(MAX_SESSIONS);
    this.log('auth login ok');
    return { ok: true, token, csrf: this.csrfFor(hash) };
  }

  private csrfFor(tokenHash: string) { return createHmac('sha256', this.csrfKey).update(`csrf:${tokenHash}`).digest('hex'); }
  private purge() { this.db.prepare('DELETE FROM sessions WHERE last_activity_ms <= ?').run(this.nowMs() - this.idleSeconds * 1000); }

  /**
   * Resolves a cookie token to a live session. Expiry is decided here from the stored last-activity time, regardless of
   * what the browser does. The sliding window moves ONLY when `interaction` is true (a real user action), so health
   * checks, passive refreshes and static requests can never keep a session alive.
   */
  validate(token: string | undefined, interaction: boolean): Validated {
    if (!token || token.length < 20 || token.length > 100) return { ok: false, reason: 'none' };
    const hash = sha256(token);
    const row = this.db.prepare('SELECT id, last_activity_ms FROM sessions WHERE token_hash = ?').get(hash) as { id: number; last_activity_ms: number } | undefined;
    if (!row) return { ok: false, reason: 'none' };
    const t = this.nowMs();
    if (t - row.last_activity_ms >= this.idleSeconds * 1000) { // exactly the window: not a millisecond more
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
      this.log('auth session expired');
      return { ok: false, reason: 'expired' };
    }
    let last = row.last_activity_ms;
    if (interaction && t > last) { this.db.prepare('UPDATE sessions SET last_activity_ms = ? WHERE id = ?').run(t, row.id); last = t; }
    return { ok: true, csrf: this.csrfFor(hash), remainingSeconds: Math.max(0, Math.ceil((this.idleSeconds * 1000 - (t - last)) / 1000)) };
  }

  csrfValid(token: string | undefined, given: unknown): boolean {
    if (!token || typeof given !== 'string') return false;
    const want = Buffer.from(this.csrfFor(sha256(token))), got = Buffer.from(given);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  logout(token: string | undefined): void {
    if (!token) return;
    const r = this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    if (Number(r.changes) > 0) this.log('auth logout'); // only when a session really ended
  }
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
export const sessionCookie = (token: string) => `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
export const clearCookie = () => `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
