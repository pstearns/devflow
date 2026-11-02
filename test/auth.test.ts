import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { nodeVersionError } from '../server/node-check.ts';
import { ARGON2, AuthService, MIN_PASSWORD, SESSION_COOKIE, defaultAuthPath, hashPassword, needsRehash, passwordPolicyError, readAuthStatus, verifyPassword } from '../server/auth.ts';
import { main, promptHidden } from '../server/auth-cli.ts';
import { buildApp, normalizePath } from '../server/app.ts';
import { SnapshotService } from '../server/service.ts';
import { parseConfig } from '../server/config.ts';
import { jsonHeaders, makeAuth, randomPassword, signIn } from './helpers.ts';

const MIN = 60;
const tmp = (p = 'devflow-auth-') => mkdtempSync(join(tmpdir(), p));
function clock(start = 1_800_000_000_000) { const c = { t: start, now: () => c.t, advance: (s: number) => { c.t += s * 1000; } }; return c; }
const emptyService = () => new SnapshotService(parseConfig({ projects: [] }), {});

async function webApp(opts: { idleSeconds?: number; withAdmin?: boolean; dist?: string } = {}) {
  const c = clock();
  const logs: string[] = [];
  const auth = AuthService.open({ path: ':memory:', clock: c.now, idleSeconds: opts.idleSeconds, log: (l) => logs.push(l) });
  const password = randomPassword();
  if (opts.withAdmin !== false) await auth.createAdmin(password);
  const app = await buildApp(emptyService(), { distDir: opts.dist ?? '/none', auth });
  return { c, auth, password, app, logs };
}
const login = (app: Awaited<ReturnType<typeof webApp>>['app'], password: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/auth/login', headers: jsonHeaders(extra), payload: JSON.stringify({ password }) });
const tokenOf = (r: { headers: Record<string, unknown> }) => new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(String(r.headers['set-cookie']))?.[1];

describe('password hashing (Argon2id)', () => {
  it('produces an Argon2id PHC string above OWASP minimums, with a unique salt per hash', async () => {
    const [a, b] = await Promise.all([hashPassword('correct horse battery staple'), hashPassword('correct horse battery staple')]);
    const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(a)!;
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBeGreaterThanOrEqual(19456); // OWASP minimum: 19 MiB
    expect(Number(m[2])).toBeGreaterThanOrEqual(2); // ... with t = 2
    expect(Number(m[3])).toBeGreaterThanOrEqual(1);
    expect([Number(m[1]), Number(m[2]), Number(m[3])]).toEqual([ARGON2.memoryKiB, ARGON2.passes, ARGON2.parallelism]);
    expect(a).not.toBe(b);
    expect(a).not.toContain('correct horse');
  });
  it('verifies only the right password; rejects tampered or foreign hashes without doing unbounded work', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
    expect(await verifyPassword('x', '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345')).toBe(false); // not argon2id
    expect(await verifyPassword('x', h.replace(/m=\d+/, 'm=999999999'))).toBe(false); // absurd memory cost is refused
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
  });
  it('normalizes Unicode (NFKC) before hashing', async () => {
    const h = await hashPassword('ｐａｓｓｐｈｒａｓｅ-ｗｉｄｅ-１２３');
    expect(await verifyPassword('passphrase-wide-123', h)).toBe(true);
  });
  it('flags hashes weaker than the current parameters for upgrade at next login', async () => {
    expect(needsRehash(await hashPassword('x'.repeat(16) + 'ab12'))).toBe(false);
    expect(needsRehash('$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g')).toBe(true);
  });
  it('enforces the password policy', () => {
    expect(passwordPolicyError('short')).toMatch(new RegExp(String(MIN_PASSWORD)));
    expect(passwordPolicyError('a'.repeat(40))).toMatch(/repetitive/);
    expect(passwordPolicyError('x'.repeat(200) + 'abcdef')).toMatch(/at most/);
    expect(passwordPolicyError('a decent passphrase here')).toBeUndefined();
  });
});

describe('account lifecycle', () => {
  it('opening the service never creates an admin; everything stays locked until setup', async () => {
    const w = await webApp({ withAdmin: false });
    expect(w.auth.hasAdmin).toBe(false);
    expect((await w.app.inject({ url: '/api/snapshot', headers: { host: 'devflow.localhost:4317' } })).statusCode).toBe(503);
    expect((await login(w.app, 'anything at all here')).statusCode).toBe(503);
    expect((await w.app.inject({ url: '/api/auth/state', headers: { host: 'devflow.localhost:4317' } })).json()).toMatchObject({ setup: false, authenticated: false });
    expect(w.auth.hasAdmin).toBe(false); // still none after all of that
  });
  it('creates exactly one admin; reset changes the password and ends every session', async () => {
    const { auth, password } = await makeAuth();
    await expect(auth.createAdmin(randomPassword())).rejects.toThrow(/already exists/);
    await expect(auth.createAdmin('short')).rejects.toThrow(/at least/);
    const first = await auth.login(password);
    expect(first.ok).toBe(true);
    const next = randomPassword();
    await auth.resetPassword(next);
    expect(auth.validate(first.ok ? first.token : '', false)).toEqual({ ok: false, reason: 'none' }); // old session is dead
    expect((await auth.login(password)).ok).toBe(false);
    expect((await auth.login(next)).ok).toBe(true);
    const empty = AuthService.open({ path: ':memory:' });
    await expect(empty.resetPassword(randomPassword())).rejects.toThrow(/No admin/);
  });
  it('stores only an Argon2id hash and session verifiers: neither the password nor a usable token is in the database file', async () => {
    const dir = tmp(); const path = join(dir, 'auth.sqlite');
    const auth = AuthService.open({ path });
    const password = randomPassword();
    await auth.createAdmin(password);
    const r = await auth.login(password);
    if (!r.ok) throw new Error('login');
    auth.close();
    const raw = readFileSync(path);
    expect(raw.includes(Buffer.from(password))).toBe(false);
    expect(raw.includes(Buffer.from(r.token))).toBe(false); // the bearer token itself is never stored
    const db = new DatabaseSync(path);
    expect(db.prepare('SELECT password_hash FROM admin').get()).toMatchObject({ password_hash: expect.stringMatching(/^\$argon2id\$/) });
    expect((db.prepare('PRAGMA table_info(admin)').all() as { name: string }[]).map((c) => c.name).sort()).toEqual(['created_at', 'id', 'password_changed_at', 'password_hash', 'username']); // metadata only
    const s = db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    expect(s.token_hash).toMatch(/^[0-9a-f]{64}$/); // a SHA-256 verifier
    expect(s.token_hash).not.toBe(r.token);
    db.close();
  });
  it('session tokens are 256-bit random and unique', async () => {
    const { auth, password } = await makeAuth();
    const toks = new Set<string>();
    for (let i = 0; i < 4; i++) { const r = await auth.login(password); if (r.ok) toks.add(r.token); }
    expect(toks.size).toBe(4);
    for (const t of toks) { expect(Buffer.from(t, 'base64url').length).toBe(32); expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/); }
  });
});

describe('login, failures and throttling', () => {
  it('issues an HttpOnly, SameSite=Strict, host-only session cookie', async () => {
    const w = await webApp();
    const r = await login(w.app, w.password);
    expect(r.statusCode).toBe(200);
    const ck = String(r.headers['set-cookie']);
    expect(ck).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43};`));
    expect(ck).toMatch(/; HttpOnly/);
    expect(ck).toMatch(/; SameSite=Strict/);
    expect(ck).toMatch(/; Path=\//);
    expect(ck).not.toMatch(/Domain=/i);
    expect(r.json()).toMatchObject({ ok: true, idleSeconds: 1800 });
    expect(r.body).not.toContain(tokenOf(r)!); // the token is only ever in the cookie
  });
  it('a wrong password gets one generic answer and no session', async () => {
    const w = await webApp();
    const a = await login(w.app, 'definitely not the password');
    const b = await login(w.app, randomPassword());
    expect([a.statusCode, b.statusCode]).toEqual([401, 401]);
    expect(a.json()).toEqual(b.json());
    expect(a.headers['set-cookie']).toBeUndefined();
    expect(a.json()).toEqual({ ok: false, code: 'invalid', error: 'Incorrect password' });
  });
  it('throttles after repeated failures, rejects even the right password while locked, and backs off', async () => {
    const w = await webApp();
    for (let i = 0; i < 4; i++) expect((await login(w.app, `wrong password number ${i}!!`)).statusCode).toBe(401);
    const fifth = await login(w.app, 'wrong password number 5!!');
    expect(fifth.statusCode).toBe(429); // the failure that crosses the threshold starts the lock
    expect(Number(fifth.headers['retry-after'])).toBeGreaterThan(0);
    const during = await login(w.app, w.password); // correct, but locked
    expect(during.statusCode).toBe(429);
    expect(during.headers['set-cookie']).toBeUndefined();
    w.c.advance(25); expect((await login(w.app, w.password)).statusCode).toBe(429); // 30 s base lock not over yet
    w.c.advance(10);
    const sixth = await login(w.app, 'wrong again after the lock!');
    expect(sixth.statusCode).toBe(429);
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(Number(fifth.headers['retry-after'])); // doubled
    w.c.advance(120);
    expect((await login(w.app, w.password)).statusCode).toBe(200); // lock expired; success clears the counter
    for (let i = 0; i < 4; i++) expect((await login(w.app, `fresh wrong attempt ${i} ok!`)).statusCode).toBe(401); // counter really reset
  });
  it('concurrent wrong guesses cannot outrun the lockout: only the first five are ever verified', async () => {
    const w = await webApp();
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => login(w.app, `concurrent wrong guess ${i}!!`)));
    expect(res.filter((r) => r.statusCode === 401 || (r.statusCode === 429 && r.json().code === 'locked' && r.headers['retry-after'])).length).toBe(8);
    expect(w.auth.lockStatus.recentFailures).toBe(5); // 5 guesses were actually checked; the other 3 never reached verification
    expect(res.every((r) => r.headers['set-cookie'] === undefined)).toBe(true);
  });
  it('a correct password queued behind the guesses that cause a lockout is refused, not verified', async () => {
    const w = await webApp();
    // called synchronously, so the order in the queue is exactly this order: 5 wrong guesses, then the right password
    const wrong = Array.from({ length: 5 }, (_, i) => w.auth.login(`queued wrong guess ${i}!!`));
    const right = w.auth.login(w.password);
    const rr = await right;
    expect(rr).toMatchObject({ ok: false, code: 'locked' });
    expect((await Promise.all(wrong)).every((r) => !r.ok)).toBe(true);
    expect(w.auth.activeSessions).toBe(0);
    expect((await login(w.app, w.password)).statusCode).toBe(429); // and it stays locked afterwards
  });
  it('bounds pending logins: a flood is refused immediately instead of queueing without limit', async () => {
    const w = await webApp();
    const res = await Promise.all(Array.from({ length: 40 }, (_, i) => login(w.app, `flood guess number ${i}!!`)));
    expect(res.filter((r) => r.statusCode === 429 && r.json().code === 'busy').length).toBeGreaterThanOrEqual(30);
    expect(res.some((r) => r.statusCode === 200)).toBe(false);
    expect(w.auth.lockStatus.recentFailures).toBeLessThanOrEqual(5);
  });
  it('an internal verification error leaves no stale failure record and does not count toward the lock', async () => {
    const c = clock();
    const auth = AuthService.open({ path: ':memory:', clock: c.now, verify: async () => { throw new Error('out of memory'); } });
    await auth.createAdmin(randomPassword());
    for (let i = 0; i < 8; i++) await expect(auth.login(`guess number ${i} here!!`)).rejects.toThrow(/out of memory/);
    expect(auth.lockStatus).toMatchObject({ locked: false, recentFailures: 0 });
    expect(auth.activeSessions).toBe(0);
  });
  it('concurrent valid and invalid logins are counted exactly: a correct login among fewer than five guesses succeeds and clears history', async () => {
    const w = await webApp();
    const rs = await Promise.all([...Array.from({ length: 3 }, (_, i) => w.auth.login(`concurrent bad ${i} guess!`)), w.auth.login(w.password)]);
    expect(rs.slice(0, 3).every((r) => !r.ok)).toBe(true);
    expect(rs[3]).toMatchObject({ ok: true });
    expect(w.auth.lockStatus).toMatchObject({ locked: false, recentFailures: 0 });
  });
  it('rejects malformed login bodies and non-JSON / cross-origin login posts', async () => {
    const w = await webApp();
    for (const bad of [undefined, null, 42, ['x'], { a: 1 }, '']) expect((await login(w.app, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    expect((await login(w.app, 'x'.repeat(5000))).statusCode).toBe(413);
    expect((await w.app.inject({ method: 'POST', url: '/api/auth/login', headers: jsonHeaders({ origin: 'http://evil.example' }), payload: JSON.stringify({ password: w.password }) })).statusCode).toBe(403);
    const { origin: _o, ...noOrigin } = jsonHeaders();
    expect((await w.app.inject({ method: 'POST', url: '/api/auth/login', headers: noOrigin, payload: JSON.stringify({ password: w.password }) })).statusCode).toBe(403);
    expect((await w.app.inject({ method: 'POST', url: '/api/auth/login', headers: jsonHeaders({ 'content-type': 'application/x-www-form-urlencoded' }), payload: `password=${w.password}` })).statusCode).toBe(415);
    expect((await w.app.inject({ method: 'POST', url: '/api/auth/login', headers: jsonHeaders({ 'sec-fetch-site': 'cross-site' }), payload: JSON.stringify({ password: w.password }) })).statusCode).toBe(403);
  });
});

describe('every endpoint requires a session', () => {
  const dist = (() => {
    const d = tmp('devflow-dist-'); mkdirSync(join(d, 'assets'), { recursive: true });
    writeFileSync(join(d, 'index.html'), '<html>app shell</html>'); writeFileSync(join(d, 'login.html'), '<html>login</html>');
    writeFileSync(join(d, 'assets', 'a.js'), 'console.log(1)'); writeFileSync(join(d, 'secret.txt'), 'not public'); writeFileSync(join(d, 'auth.sqlite'), 'db');
    return d;
  })();
  const H = { host: 'devflow.localhost:4317' };

  it('API endpoints answer 401 to anonymous, forged and malformed cookies (and never leak data)', async () => {
    const w = await webApp({ dist });
    const gets = ['/api/snapshot', '/api/snapshot?refresh=1', '/api/issue/ATL-1', '/api/team/ATL', '/api/issue-actions/ATL-1', '/api/healthz', '/api/readyz', '/api/auth/session', '/api/anything-else'];
    for (const cookie of [undefined, `${SESSION_COOKIE}=${'a'.repeat(43)}`, `${SESSION_COOKIE}=`, `${SESSION_COOKIE}=../../etc`, 'other=1']) {
      for (const url of gets) {
        const r = await w.app.inject({ url, headers: cookie ? { ...H, cookie } : H });
        expect([r.statusCode, url, cookie], `${url} ${cookie}`).toEqual([401, url, cookie]);
        expect(r.json()).toMatchObject({ code: 'auth-required' });
      }
      for (const url of ['/api/actions/labels', '/api/actions/approve', '/api/auth/touch', '/api/auth/logout']) {
        const r = await w.app.inject({ method: 'POST', url, headers: jsonHeaders(cookie ? { cookie } : {}), payload: '{}' });
        expect([r.statusCode, url], url).toEqual([401, url]);
      }
    }
  });
  it('page navigations redirect to /login; only the login page, build assets and the two auth endpoints are public', async () => {
    const w = await webApp({ dist });
    for (const url of ['/', '/index.html', '/pipeline', '/some/client/route', '/secret.txt', '/auth.sqlite', '/.env', '/../etc/passwd']) {
      const r = await w.app.inject({ url, headers: H });
      expect([r.statusCode, r.headers.location], url).toEqual([302, '/login']);
      expect(r.body, url).not.toMatch(/app shell|not public/);
    }
    expect((await w.app.inject({ url: '/login', headers: H })).body).toContain('login');
    expect((await w.app.inject({ url: '/login.html', headers: H })).statusCode).toBe(200);
    expect((await w.app.inject({ url: '/assets/a.js', headers: H })).statusCode).toBe(200);
    expect((await w.app.inject({ url: '/api/auth/state', headers: H })).json()).toMatchObject({ setup: true, authenticated: false });
    expect((await login(w.app, w.password)).statusCode).toBe(200);
  });
  it('a signed-in session reaches the app and API; the login page then redirects to the app', async () => {
    const w = await webApp({ dist });
    const s = await signIn(w.app, w.password);
    expect((await s.get('/')).body).toContain('app shell');
    expect((await s.get('/api/healthz')).statusCode).toBe(200);
    const l = await w.app.inject({ url: '/login', headers: { ...H, cookie: s.cookie } });
    expect([l.statusCode, l.headers.location]).toEqual([302, '/']);
  });
  describe('request path normalization (one function for the gate and the static router)', () => {
    const SHELL = 'app shell';
    const BAD = [
      '/assets/..%2findex.html', '/assets/..%2Findex.html', '/assets/%2e%2e%2findex.html', '/assets/..%5cindex.html', // encoded separators
      '/assets/%252e%252e/index.html', '/assets/..%252findex.html', '/assets/%252e%252e%252findex.html', // double encoding
      '/assets/%zz', '/assets/%', '/assets/%2', '/assets/a%', '/assets/%c0%ae%c0%ae/index.html', '/assets/%ff', // malformed escapes / invalid UTF-8
      '/assets/..\\index.html', '/assets/a\\..\\index.html', '/assets\\a.js', // mixed / backslash separators
      '/assets/%2e%2e/index.html', '/assets/%2E%2E/index.html', '/assets/./a.js', '/assets/%2e/a.js', '/assets//a.js', '//assets/a.js', '/assets/a.js/../../index.html', // dot and empty segments
      '/assets/%00', '/assets/a%00.js', '/assets/a%0d%0a', // NUL / control characters
      '/api/%61uth/state', '/api/auth%2fstate', '/api/healthz%00',
    ];
    it('normalizePath accepts ordinary paths and rejects every ambiguous representation', () => {
      for (const ok of ['/', '/login', '/pipeline', '/pipeline/', '/assets/a.js', '/assets/index-Ab3_x.css', '/some/client/route', '/api/issue/ATL-1', '/team/ATL?x=%2f&y=%zz', '/a%20b']) expect(normalizePath(ok), ok).toBeDefined();
      expect(normalizePath('/a%20b')).toBe('/a b');
      expect(normalizePath('/pipeline?refresh=1')).toBe('/pipeline');
      for (const bad of [...BAD, 'assets/a.js', 'http://evil.example/assets/a.js', '', '/assets/../index.html']) expect(normalizePath(bad), bad).toBeUndefined();
    });
    it('every bad path is refused (400) before authentication, with or without a session, and never returns the app shell', async () => {
      const w = await webApp({ dist });
      const s = await signIn(w.app, w.password);
      for (const url of BAD) {
        const anon = await w.app.inject({ url, headers: H });
        // (light-my-request itself rewrites literal dots/backslashes, so those are covered over a real socket below)
        expect(anon.body, url).not.toContain(SHELL);
        const signed = await w.app.inject({ url, headers: { ...H, cookie: s.cookie } });
        expect(signed.body, url).not.toContain('not public');
      }
      for (const url of BAD.filter((u) => u.includes('%') && !/%2e/i.test(u) && !u.includes('%252e%252e/'))) { // (inject's URL parser pre-normalizes %2e dot segments; the socket test covers them)
        for (const headers of [H, { ...H, cookie: s.cookie }]) expect((await w.app.inject({ url, headers })).statusCode, url).toBe(400);
      }
    });
    it('literal ../ traversal over a real socket (where nothing pre-normalizes the request line) is refused too', async () => {
      const w = await webApp({ dist });
      await w.app.listen({ host: '127.0.0.1', port: 0 });
      const port = (w.app.server.address() as AddressInfo).port;
      const get = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const rq = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: 'devflow.localhost:4317', ...headers } }, (res) => {
          let body = ''; res.on('data', (d) => (body += d)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        rq.on('error', reject); rq.end();
      });
      try {
        for (const path of ['/assets/../index.html', '/assets/../../etc/passwd', '/assets/a.js/../../index.html', '/assets/./../index.html', '/assets/..%2findex.html', '/../index.html', '/assets/..\\index.html', '/assets\\a.js', '//evil.example/x', '/assets/%2e%2e/index.html', '/assets/%2E%2E/index.html', '/assets/%2e/a.js', '/assets/%2e%2e%2findex.html']) {
          const r = await get(path);
          expect([path, r.status]).toEqual([path, 400]);
          expect(r.body).not.toContain(SHELL);
        }
        expect((await get('/assets/a.js')).status).toBe(200);
        expect((await get('/index.html')).status).toBe(302); // the shell itself still needs a session
      } finally { await w.app.close(); }
    });
    it('/assets/ never falls back to the app shell: unknown, extensionless and directory paths are 404 for anyone', async () => {
      const w = await webApp({ dist });
      const s = await signIn(w.app, w.password);
      expect((await w.app.inject({ url: '/assets', headers: H })).statusCode).toBe(302); // not under /assets/: an ordinary protected route
      for (const url of ['/assets/nothing', '/assets/', '/assets/missing.js', '/assets/sub/dir']) {
        for (const headers of [H, { ...H, cookie: s.cookie }]) {
          const r = await w.app.inject({ url, headers });
          expect(r.body, url).not.toContain(SHELL);
          expect(r.statusCode, url).toBe(404);
        }
      }
    });
    it('normal behaviour is preserved: login assets are public, the shell and SPA routes need a session, refresh works', async () => {
      const w = await webApp({ dist });
      for (const url of ['/login', '/login.html', '/assets/a.js']) expect((await w.app.inject({ url, headers: H })).statusCode, url).toBe(200);
      expect((await w.app.inject({ url: '/pipeline', headers: H })).headers.location).toBe('/login');
      const s = await signIn(w.app, w.password);
      for (const url of ['/', '/pipeline', '/pipeline/', '/team/ATL?x=1', '/some/client/route', '/a%20b']) {
        const r = await s.get(url);
        expect([url, r.statusCode, r.body.includes(SHELL)], url).toEqual([url, 200, true]); // a browser refresh on any client route
      }
      expect((await s.get('/secret.txt')).body).toContain('not public'); // existing files in dist remain servable to a signed-in user only
      expect((await w.app.inject({ url: '/secret.txt', headers: H })).statusCode).toBe(302);
    });
    it('a symlink inside dist that points outside it is not served', async () => {
      const outside = tmp('devflow-outside-'); writeFileSync(join(outside, 'x.txt'), 'outside secret');
      const d = tmp('devflow-dist-'); mkdirSync(join(d, 'assets')); writeFileSync(join(d, 'index.html'), SHELL); writeFileSync(join(d, 'login.html'), 'l');
      symlinkSync(join(outside, 'x.txt'), join(d, 'assets', 'leak.txt'));
      const w = await webApp({ dist: d });
      const r = await w.app.inject({ url: '/assets/leak.txt', headers: H });
      expect([r.statusCode, r.body.includes('outside secret')]).toEqual([404, false]);
    });
  });
  describe('cross-site API reads', () => {
    it('a page on another local port cannot make authenticated API reads (or refreshes that spend upstream quota)', async () => {
      const c = clock(); let upstream = 0;
      const auth = AuthService.open({ path: ':memory:', clock: c.now }); const password = randomPassword(); await auth.createAdmin(password);
      const service = new SnapshotService(parseConfig({ projects: [] }), { linearKey: 'k', githubToken: 't', fetchImpl: (async () => { upstream++; throw new Error('offline'); }) as typeof fetch });
      const app = await buildApp(service, { distDir: '/none', auth });
      const s = await signIn(app, password);
      for (const extra of [{ 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'http://localhost:3000' }, { origin: 'http://devflow.localhost:9999' }, { origin: 'null' }] as Record<string, string>[]) {
        for (const url of ['/api/snapshot?refresh=1', '/api/snapshot', '/api/team/ATL?refresh=1', '/api/issue/ATL-1', '/api/healthz', '/api/auth/session']) {
          const r = await s.get(url, extra);
          expect([url, JSON.stringify(extra), r.statusCode]).toEqual([url, JSON.stringify(extra), 403]);
        }
      }
      expect(upstream).toBe(0);
      expect((await s.get('/api/healthz', { 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
      expect((await s.get('/api/healthz', { 'sec-fetch-site': 'none' })).statusCode).toBe(200); // address-bar navigation
      expect((await s.get('/api/healthz', { origin: 'http://devflow.localhost:4317' })).statusCode).toBe(200);
      expect((await s.get('/api/snapshot?refresh=1', { 'sec-fetch-site': 'same-origin' })).statusCode).not.toBe(403);
    });
  });
  it('strict Host validation: only devflow.localhost on the listening port is served; everything else is refused first', async () => {
    const w = await webApp();
    const s = await signIn(w.app, w.password);
    const at = (host: string, url = '/api/healthz') => w.app.inject({ url, headers: { cookie: s.cookie, host } });
    expect((await at('DEVFLOW.localhost:4317')).statusCode).toBe(200); // host names are case-insensitive
    for (const bad of ['evil.example', 'devflow.localhost', 'devflow.localhost:4318', 'devflow.localhost.', 'devflow.localhost.evil.example:4317', 'x.devflow.localhost:4317', 'user@devflow.localhost:4317', 'localhost:4317', '127.0.0.1:4317', '[::1]:4317', '']) {
      expect((await at(bad)).statusCode, bad).toBe(403);
    }
    // bare loopback names get a content-free redirect for page navigations only; no cookie is read or set
    const r = await w.app.inject({ url: '/pipeline?x=1', headers: { cookie: s.cookie, host: 'localhost:4317' } });
    expect([r.statusCode, r.headers.location, r.headers['set-cookie']]).toEqual([308, 'http://devflow.localhost:4317/pipeline?x=1', undefined]);
    expect((await w.app.inject({ url: '/api/snapshot', headers: { cookie: s.cookie, host: 'localhost:4317' } })).statusCode).toBe(403);
    expect((await w.app.inject({ method: 'POST', url: '/api/auth/login', headers: jsonHeaders({ host: 'localhost:4317', origin: 'http://localhost:4317' }), payload: '{}' })).statusCode).toBe(403);
    // a non-default port is honoured exactly
    const other = await buildApp(emptyService(), { distDir: '/none', auth: w.auth, port: 5000 });
    expect((await other.inject({ url: '/api/auth/state', headers: { host: 'devflow.localhost:5000' } })).statusCode).toBe(200);
    expect((await other.inject({ url: '/api/auth/state', headers: { host: 'devflow.localhost:4317' } })).statusCode).toBe(403);
  });
  it('the session cookie is host-only: no Domain attribute, so it is never sent to other local names or apps', async () => {
    const w = await webApp();
    const set = String((await login(w.app, w.password)).headers['set-cookie']);
    expect(set).not.toMatch(/domain=/i);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
  });
});

describe('session lifetime: 30-minute sliding inactivity timeout, enforced server-side', () => {
  const user = { 'x-devflow-interaction': 'user' };
  async function session() {
    const w = await webApp();
    const s = await signIn(w.app, w.password);
    const at = (url: string, extra: Record<string, string> = {}) => w.app.inject({ url, headers: { host: 'devflow.localhost:4317', cookie: s.cookie, ...extra } });
    return { ...w, s, at };
  }
  it('expires 30 minutes after the last real interaction, deletes the session and clears the cookie', async () => {
    const w = await session();
    w.c.advance(29 * MIN);
    expect((await w.at('/api/healthz')).statusCode).toBe(200);
    w.c.advance(2 * MIN); // 31 minutes since login, no interaction in between
    const r = await w.at('/api/healthz');
    expect([r.statusCode, r.json().code]).toEqual([401, 'session-expired']);
    expect(String(r.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect((await w.at('/api/healthz', user)).statusCode).toBe(401); // an expired session cannot be revived, even by a "user" request
    expect(w.auth.activeSessions).toBe(0);
  });
  it('expires at exactly the window, to the millisecond (never a second late)', async () => {
    const w = await session();
    w.c.t += 1800_000 - 1; // 29:59.999 since login
    expect((await w.at('/api/healthz')).statusCode).toBe(200);
    w.c.t += 1; // 30:00.000
    expect((await w.at('/api/healthz')).statusCode).toBe(401);
    const w2 = await session();
    w2.c.t += 1800_000 - 1;
    expect((await w2.at('/api/snapshot', user)).statusCode).toBe(200); // interaction one millisecond before the deadline slides it...
    w2.c.t += 1800_000 - 1;
    expect((await w2.at('/api/healthz')).statusCode).toBe(200); // ...by a full window
    w2.c.t += 1;
    expect((await w2.at('/api/healthz')).statusCode).toBe(401);
  });
  it('slides only on real user interactions', async () => {
    const w = await session();
    w.c.advance(20 * MIN);
    expect((await w.at('/api/snapshot', user)).statusCode).toBe(200); // interaction at +20 min
    w.c.advance(20 * MIN); // +40 min total, 20 since the interaction
    expect((await w.at('/api/healthz', user)).statusCode).toBe(200); // another interaction at +40
    w.c.advance(29 * MIN);
    expect((await w.at('/api/healthz')).statusCode).toBe(200);
    w.c.advance(2 * MIN);
    expect((await w.at('/api/healthz')).statusCode).toBe(401);
  });
  it('passive requests never extend it: health checks, readiness, state, unlabelled and "passive" refreshes', async () => {
    const w = await session();
    for (const [min, url, extra] of [[10, '/api/healthz', {}], [14, '/api/readyz', {}], [18, '/api/snapshot', {}], [22, '/api/snapshot', { 'x-devflow-interaction': 'passive' }], [26, '/api/auth/session', {}], [29, '/api/auth/state', user]] as const) {
      w.c.t = 1_800_000_000_000 + min * MIN * 1000;
      const r = await w.at(url, { ...extra });
      expect([url, r.statusCode !== 401], `${url} at ${min}`).toEqual([url, true]); // readyz may be 503 here (no web build); what matters is it is not 401
    }
    w.c.t = 1_800_000_000_000 + 31 * MIN * 1000; // 31 min after login: none of the above counted
    expect((await w.at('/api/healthz')).statusCode).toBe(401);
  });
  it('the explicit touch endpoint (needs CSRF) extends the session', async () => {
    const w = await session();
    w.c.advance(25 * MIN);
    const t = await w.s.post('/api/auth/touch', {});
    expect(t.statusCode).toBe(200);
    w.c.advance(25 * MIN);
    expect((await w.at('/api/healthz')).statusCode).toBe(200);
  });
  it('forged requests from another local origin cannot renew a session, even with the interaction header and a valid cookie', async () => {
    const w = await session();
    const evil = { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' };
    w.c.advance(25 * MIN);
    for (const url of ['/api/auth/touch', '/api/actions/labels', '/api/actions/status']) {
      expect((await w.s.post(url, {}, evil)).statusCode, url).toBe(403);
      expect((await w.s.post(url, {}, { origin: 'http://127.0.0.1:9999', 'sec-fetch-site': 'cross-site' })).statusCode, url).toBe(403);
      expect((await w.s.post(url, {}, { 'content-type': 'text/plain' })).statusCode, url).toBe(415);
      expect((await w.s.post(url, {}, { 'x-devflow-csrf': 'wrong' })).statusCode, url).toBe(403);
    }
    expect((await w.s.get('/api/healthz', { 'sec-fetch-site': 'same-site' })).statusCode).toBe(403); // another local origin: refused outright, and must not renew
    w.c.advance(6 * MIN); // 31 minutes after the last real interaction
    expect((await w.at('/api/healthz')).statusCode).toBe(401);
  });
  it('a validated request renews the session only after every check passed', async () => {
    const w = await session();
    w.c.advance(25 * MIN);
    expect((await w.s.post('/api/actions/status', {})).statusCode).not.toBe(403); // valid origin, content type and CSRF => renewed
    w.c.advance(25 * MIN);
    expect((await w.at('/api/healthz')).statusCode).toBe(200);
  });
  it('a system clock that moves backwards ends the session instead of extending it', async () => {
    const w = await session();
    w.c.advance(10 * MIN);
    expect((await w.at('/api/healthz')).statusCode).toBe(200);
    w.c.advance(-60 * MIN); // clock set back an hour
    expect((await w.at('/api/healthz')).statusCode).toBe(401);
    w.c.advance(60 * MIN);
    expect((await w.at('/api/healthz')).statusCode).toBe(401); // and it stays dead once the clock is right again
    expect(w.auth.activeSessions).toBe(0);
  });
  it('page navigation with an expired session redirects to the login page', async () => {
    const dist = tmp('devflow-dist-'); writeFileSync(join(dist, 'index.html'), 'x'); writeFileSync(join(dist, 'login.html'), 'x');
    const w = await webApp({ dist });
    const s = await signIn(w.app, w.password);
    w.c.advance(31 * MIN);
    const r = await w.app.inject({ url: '/', headers: { host: 'devflow.localhost:4317', cookie: s.cookie } });
    expect([r.statusCode, r.headers.location]).toEqual([302, '/login?expired=1']);
  });
  it('honours a shorter configured idle window (used by browser tests) but defaults to 30 minutes', async () => {
    expect(AuthService.open({ path: ':memory:' }).idleSeconds).toBe(1800);
    const w = await webApp({ idleSeconds: 5 });
    const s = await signIn(w.app, w.password);
    w.c.advance(6);
    expect((await w.app.inject({ url: '/api/healthz', headers: { host: 'devflow.localhost:4317', cookie: s.cookie } })).statusCode).toBe(401);
  });
});

describe('logout, reuse and rotation', () => {
  it('logout invalidates the session server-side: a saved cookie is useless afterwards', async () => {
    const w = await webApp();
    const s = await signIn(w.app, w.password);
    expect((await s.get('/api/healthz')).statusCode).toBe(200);
    const out = await s.post('/api/auth/logout', {});
    expect(out.statusCode).toBe(200);
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect((await s.get('/api/healthz')).statusCode).toBe(401); // replaying the old cookie
    expect((await s.post('/api/auth/touch', {})).statusCode).toBe(401);
    expect(w.auth.activeSessions).toBe(0);
  });
  it('logout requires the CSRF token and a same-origin request, and leaves the session intact otherwise', async () => {
    const w = await webApp();
    const s = await signIn(w.app, w.password);
    const h = jsonHeaders({ cookie: s.cookie });
    expect((await w.app.inject({ method: 'POST', url: '/api/auth/logout', headers: h, payload: '{}' })).statusCode).toBe(403);
    expect((await w.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...h, 'x-devflow-csrf': 'wrong' }, payload: '{}' })).statusCode).toBe(403);
    expect((await w.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...h, 'x-devflow-csrf': s.csrf, origin: 'http://evil.example' }, payload: '{}' })).statusCode).toBe(403);
    expect((await s.get('/api/healthz')).statusCode).toBe(200);
  });
  it('a new login replaces the session that was presented; tokens are not reusable across logins', async () => {
    const w = await webApp();
    const s1 = await signIn(w.app, w.password);
    const r2 = await login(w.app, w.password, { cookie: s1.cookie });
    const t2 = tokenOf(r2)!;
    expect(t2).not.toBe(s1.token);
    expect((await s1.get('/api/healthz')).statusCode).toBe(401); // old token revoked by the fresh login
    expect((await w.app.inject({ url: '/api/healthz', headers: { host: 'devflow.localhost:4317', cookie: `${SESSION_COOKIE}=${t2}` } })).statusCode).toBe(200);
  });
  it('keeps at most 10 live sessions', async () => {
    const { auth, password } = await makeAuth();
    const toks: string[] = [];
    for (let i = 0; i < 12; i++) { const r = await auth.login(password); if (r.ok) toks.push(r.token); }
    expect(auth.activeSessions).toBe(10);
    expect(auth.validate(toks[0], false).ok).toBe(false);
    expect(auth.validate(toks[11], false).ok).toBe(true);
  });
});

describe('CSRF protection is bound to the session', () => {
  it('a CSRF token only works with the session it was issued for', async () => {
    const w = await webApp();
    const a = await signIn(w.app, w.password);
    const b = await signIn(w.app, w.password);
    expect(a.csrf).not.toBe(b.csrf);
    expect((await w.app.inject({ method: 'POST', url: '/api/auth/touch', headers: jsonHeaders({ cookie: b.cookie, 'x-devflow-csrf': a.csrf }), payload: '{}' })).statusCode).toBe(403);
    expect((await w.app.inject({ method: 'POST', url: '/api/auth/touch', headers: jsonHeaders({ cookie: b.cookie, 'x-devflow-csrf': b.csrf }), payload: '{}' })).statusCode).toBe(200);
    const sess = (await b.get('/api/auth/session')).json();
    expect(sess.csrf).toBe(b.csrf); // the page obtains its token from the authenticated session endpoint
  });
  it('every state-changing endpoint refuses cross-site, form and token-less requests', async () => {
    const w = await webApp();
    const s = await signIn(w.app, w.password);
    for (const url of ['/api/auth/touch', '/api/auth/logout', '/api/actions/labels']) {
      const base = jsonHeaders({ cookie: s.cookie, 'x-devflow-csrf': s.csrf });
      expect((await w.app.inject({ method: 'POST', url, headers: { ...base, origin: 'http://evil.example' }, payload: '{}' })).statusCode, `${url} origin`).toBe(403);
      expect((await w.app.inject({ method: 'POST', url, headers: { ...base, 'sec-fetch-site': 'same-site' }, payload: '{}' })).statusCode, `${url} site`).toBe(403);
      expect((await w.app.inject({ method: 'POST', url, headers: { ...base, 'content-type': 'text/plain' }, payload: '{}' })).statusCode, `${url} type`).toBe(415);
      const { 'x-devflow-csrf': _c, ...none } = base;
      expect((await w.app.inject({ method: 'POST', url, headers: none, payload: '{}' })).statusCode, `${url} token`).toBe(403);
    }
    expect((await s.get('/api/healthz')).statusCode).toBe(200); // none of that touched the session
  });
});

describe('filesystem permissions', () => {
  it('creates the database directory 0700 and files 0600, with no looser side files', async () => {
    const root = tmp(); const path = join(root, 'share', 'devflow', 'auth.sqlite');
    const auth = AuthService.open({ path });
    await auth.createAdmin(randomPassword());
    await auth.login(randomPassword()).catch(() => {});
    expect((statSync(join(root, 'share', 'devflow')).mode & 0o777).toString(8)).toBe('700');
    for (const f of readdirSync(join(root, 'share', 'devflow'))) expect((statSync(join(root, 'share', 'devflow', f)).mode & 0o077) === 0, f).toBe(true);
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
    expect(auth.permissions).toEqual({ dir: '700', file: '600' });
    auth.close();
  });
  it('tightens loose permissions it finds', () => {
    const root = tmp(); const dir = join(root, 'd'); mkdirSync(dir); const path = join(dir, 'auth.sqlite');
    AuthService.open({ path }).close();
    chmodSync(dir, 0o755); chmodSync(path, 0o644);
    const a = AuthService.open({ path });
    expect(a.permissions).toEqual({ dir: '700', file: '600' });
    a.close();
  });
  it('refuses a symlinked database or directory', () => {
    const root = tmp(); const real = join(root, 'real.sqlite'); writeFileSync(real, ''); const link = join(root, 'link.sqlite');
    symlinkSync(real, link);
    expect(() => AuthService.open({ path: link })).toThrow(/regular file/);
    const realDir = join(root, 'realdir'); mkdirSync(realDir); const linkDir = join(root, 'linkdir'); symlinkSync(realDir, linkDir);
    expect(() => AuthService.open({ path: join(linkDir, 'auth.sqlite') })).toThrow(/real directory/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
  it('lives outside the repository by default and is ignored by Git if it ever appears inside', () => {
    const p = defaultAuthPath({} as NodeJS.ProcessEnv);
    expect(p.endsWith('/.local/share/devflow/auth.sqlite')).toBe(true);
    expect(p.startsWith(process.cwd())).toBe(false);
    expect(execFileSync('git', ['check-ignore', 'auth.sqlite', 'x/auth.sqlite-journal'], { cwd: process.cwd() }).toString().trim().split('\n')).toHaveLength(2);
  });
});

describe('no credential leakage', () => {
  it('logs, responses and headers never contain the password, tokens, hashes or the CSRF key', async () => {
    const w = await webApp();
    const secrets: string[] = [w.password];
    const wrong = 'my-wrong-password-attempt-xyz';
    secrets.push(wrong);
    const seen: string[] = [];
    const rec = (r: { body: string; headers: Record<string, unknown> }) => seen.push(r.body, JSON.stringify(r.headers));
    rec(await login(w.app, wrong));
    const ok = await login(w.app, w.password);
    const token = tokenOf(ok)!; secrets.push(token);
    expect(ok.body).not.toContain(token); // the token is delivered ONLY as a cookie...
    const { 'set-cookie': _sc, ...okHeaders } = ok.headers; seen.push(ok.body, JSON.stringify(okHeaders)); // ...so everything but that one header is scanned
    const s = { cookie: `${SESSION_COOKIE}=${token}` };
    for (const url of ['/api/auth/session', '/api/auth/state', '/api/healthz', '/api/snapshot', '/api/nope']) rec(await w.app.inject({ url, headers: { host: 'devflow.localhost:4317', ...s } }));
    rec(await w.app.inject({ url: '/api/healthz', headers: { host: 'devflow.localhost:4317' } })); // anonymous
    const blob = [...seen, ...w.logs].join('\n');
    for (const secret of secrets) expect(blob.includes(secret), `leaked ${secret.slice(0, 6)}…`).toBe(false);
    expect(blob).not.toMatch(/\$argon2/);
    expect(w.logs).toEqual(['auth login failed', 'auth login ok']); // events only, nothing identifying
    const stateBody = (await w.app.inject({ url: '/api/auth/state', headers: { host: 'devflow.localhost:4317' } })).json();
    expect(Object.keys(stateBody).sort()).toEqual(['authenticated', 'idleSeconds', 'setup']);
  });
  it('only login, logout and expiry set cookies', async () => {
    const w = await webApp();
    const s = await signIn(w.app, w.password);
    for (const url of ['/api/healthz', '/api/auth/session', '/api/auth/state']) expect((await s.get(url)).headers['set-cookie'], url).toBeUndefined();
  });
});

describe('interactive CLI', () => {
  const fakeTty = (typed: string[]) => {
    const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: () => input, resume: () => input, pause: () => input, setEncoding: () => input }) as unknown as NodeJS.ReadStream;
    const out: string[] = [];
    const output = { write: (s: string) => { out.push(s); return true; } } as unknown as NodeJS.WriteStream;
    queueMicrotask(() => { for (const t of typed) input.emit('data', t); });
    return { input, output, out };
  };
  it('reads a password without echo, honouring backspace, and never writes it to the output', async () => {
    const t = fakeTty(['secr', 'et!', '\u007fX', '\r']);
    const pw = await promptHidden('Password: ', t.input, t.output);
    expect(pw).toBe('secretX'); // backspace removed the "!"
    expect(t.out.join('')).toBe('Password: \n'); // prompt + newline only: no echoed characters
  });
  it('can be cancelled, and refuses to read from a pipe / non-interactive input', async () => {
    const t = fakeTty(['abc', '\u0003']);
    await expect(promptHidden('P: ', t.input, t.output)).rejects.toThrow(/Cancelled/);
    const piped = Object.assign(new EventEmitter(), { isTTY: false }) as unknown as NodeJS.ReadStream;
    await expect(promptHidden('P: ', piped, { write: () => true } as unknown as NodeJS.WriteStream)).rejects.toThrow(/interactive terminal/);
  });
  it('setup without a terminal fails and creates no account; status prints no secrets; bad usage exits 2', async () => {
    const dir = tmp(); const env = { DEVFLOW_AUTH_DB: join(dir, 'auth.sqlite') } as NodeJS.ProcessEnv;
    const logs: string[] = []; const errs: string[] = [];
    expect(await main(['status'], env)).toBe(0);
    expect(readdirSync(dir)).toEqual([]); // status on an uninitialized installation creates nothing
    const lo = console.log, le = console.error;
    console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => errs.push(a.join(' '));
    try {
      expect(await main(['setup', 'argv-password-ignored-123'], env)).toBe(1); // piped test runner: not a TTY
      expect(errs.join('\n')).toMatch(/interactive terminal/);
      expect(await main(['status'], env)).toBe(0);
      expect(await main(['reset'], env)).toBe(1);
      expect(await main(['bogus'], env)).toBe(2);
    } finally { console.log = lo; console.error = le; }
    const db = AuthService.open({ path: env.DEVFLOW_AUTH_DB! });
    expect(db.hasAdmin).toBe(false); // nothing was created
    db.close();
    expect(logs.join('\n')).toMatch(/Admin set up:\s+no/);
    expect(logs.join('\n') + errs.join('\n')).not.toContain('argv-password-ignored-123');
  });
  it('unlock clears a lockout without changing the password or sessions; status reports the lock', async () => {
    const dir = tmp(); const path = join(dir, 'auth.sqlite'); const env = { DEVFLOW_AUTH_DB: path } as NodeJS.ProcessEnv;
    const pw = randomPassword();
    const a = AuthService.open({ path });
    await a.createAdmin(pw);
    for (let i = 0; i < 5; i++) await a.login(`wrong guess for the cli ${i}!`);
    const session = await a.login(pw.slice(0, -1) + 'x'); // still locked; no session
    expect(session).toMatchObject({ ok: false, code: 'locked' });
    a.close();
    const logs: string[] = []; const lo = console.log;
    console.log = (...x) => logs.push(x.join(' '));
    try {
      expect(await main(['status'], env)).toBe(0);
      expect(logs.join('\n')).toMatch(/Login lock:\s+LOCKED, \d+s remaining/);
      logs.length = 0;
      expect(await main(['unlock'], env)).toBe(0);
      expect(await main(['status'], env)).toBe(0);
      expect(logs.join('\n')).toMatch(/Login lock:\s+not locked \(0 recent/);
    } finally { console.log = lo; }
    const b = AuthService.open({ path });
    expect(await b.login(pw)).toMatchObject({ ok: true }); // same password still works
    b.close();
  });
  it('status is read-only: it creates no directory or file, and does not alter an existing database or its permissions', async () => {
    const root = tmp(); const path = join(root, 'not', 'yet', 'auth.sqlite');
    expect(readAuthStatus(path)).toMatchObject({ exists: false, hasAdmin: false, locked: false });
    const lo = console.log; console.log = () => {};
    try { expect(await main(['status'], { DEVFLOW_AUTH_DB: path } as NodeJS.ProcessEnv)).toBe(0); } finally { console.log = lo; }
    expect(existsSync(join(root, 'not'))).toBe(false);
    const real = join(root, 'auth.sqlite'); const a = AuthService.open({ path: real }); await a.createAdmin(randomPassword()); a.close();
    chmodSync(real, 0o644); const before = readFileSync(real);
    expect(readAuthStatus(real)).toMatchObject({ exists: true, hasAdmin: true, permissions: { file: '644' } });
    expect((statSync(real).mode & 0o777).toString(8)).toBe('644'); // not "fixed" by a status check
    expect(readFileSync(real).equals(before)).toBe(true);
    expect(readdirSync(root).sort()).toEqual(['auth.sqlite']); // no journal or side files
  });
  it('enforces Node 24.7+', () => {
    for (const ok of ['24.7.0', '24.12.1', '25.0.0', '26.6.0']) expect(nodeVersionError(ok), ok).toBeUndefined();
    for (const bad of ['24.6.9', '24.0.0', '22.22.0', '20.11.1', '18.0.0']) expect(nodeVersionError(bad), bad).toMatch(/24\.7/);
  });
});
