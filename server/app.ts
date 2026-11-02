import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { SnapshotService } from './service.ts';
import { SourceError } from './util.ts';
import { ActionError, type LinearActions } from './actions.ts';
import { SESSION_COOKIE, clearCookie, parseCookie, sessionCookie, type AuthService } from './auth.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
/** The one name the app answers to. `*.localhost` resolves to loopback in browsers, and gives DevFlow its own host-only cookie jar. */
export const APP_HOSTNAME = 'devflow.localhost';
export const DEFAULT_PORT = 4317;
/** Bare loopback names: never served, only redirected (GET/HEAD) to the dedicated host so old bookmarks keep working. */
const LEGACY_LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const READY_REFRESH_LIMIT_MS = 120_000;

/**
 * The ONE place a request path is interpreted. Returns the decoded pathname used by BOTH the authentication gate and the
 * static-file router, or undefined if the path is ambiguous or unsafe: malformed or double percent-encoding, encoded
 * separators (%2f, %5c), backslashes, control characters, empty segments (//), and "." / ".." segments (however spelled).
 * Under /api/ no percent-encoding is accepted at all, so the router and the gate can never read a route differently.
 */
export function normalizePath(url: string): string | undefined {
  const raw = url.split('?')[0]!.split('#')[0]!;
  if (!raw.startsWith('/')) return undefined;
  if (/%(?![0-9a-f]{2})/i.test(raw) || /%2f|%5c/i.test(raw)) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return undefined; }
  if (decoded.includes('%') || /[\\\u0000-\u001f\u007f]/.test(decoded)) return undefined; // double encoding, backslash, controls
  if (decoded.startsWith('/api/') && raw.includes('%')) return undefined;
  const segments = decoded.split('/').slice(1);
  if (segments.some((seg, i) => seg === '.' || seg === '..' || (seg === '' && i < segments.length - 1))) return undefined;
  return decoded;
}

export interface AppOptions { distDir: string; port?: number; auth: AuthService; onRequest?: (method: string, url: string) => void; actions?: LinearActions }

interface Sess { token: string; csrf: string; remainingSeconds: number }

export async function buildApp(service: SnapshotService, opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const port = opts.port ?? DEFAULT_PORT;
  const authority = `${APP_HOSTNAME}:${port}`; // exact, case-insensitive match: no other name, no other port, no trailing dot
  const auth = opts.auth;
  const webReady = existsSync(`${opts.distDir}/index.html`);
  const sessions = new WeakMap<FastifyRequest, Sess>();
  const paths = new WeakMap<FastifyRequest, string>(); // set by the gate before anything else looks at the path
  const pathOf = (req: FastifyRequest) => paths.get(req) ?? '/';

  // Everything below this line of defence runs for EVERY request, including 404s and static files.
  app.addHook('onRequest', async (req, reply) => {
    const normalized = normalizePath(req.url);
    if (normalized === undefined) return reply.code(400).send({ error: 'bad path' });
    paths.set(req, normalized);
    const path = normalized;
    // Only GET/HEAD, except POST under /api/actions/ (controlled Linear actions) and /api/auth/ (login/logout/touch).
    const postOk = req.method === 'POST' && (path.startsWith('/api/actions/') || path.startsWith('/api/auth/'));
    if (req.method !== 'GET' && req.method !== 'HEAD' && !postOk) return reply.code(405).header('allow', 'GET, HEAD').send({ error: 'method not allowed' });
    // Defend against DNS rebinding and cookie sharing: only answer for the dedicated host name and port.
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== authority) {
      if (LEGACY_LOOPBACK.test(host) && (req.method === 'GET' || req.method === 'HEAD') && !path.startsWith('/api/')) return reply.redirect(`http://${authority}${req.url.startsWith('/') && !req.url.startsWith('//') ? req.url : '/'}`, 308);
      return reply.code(403).send({ error: 'forbidden host' });
    }
    // A page on another local port is "same-site" (SameSite cookies ignore ports), so its requests would carry the session.
    // Browser-initiated API requests must therefore be same-origin (or a direct address-bar navigation); this also stops a
    // foreign page from triggering refreshes that spend Linear/GitHub quota. Non-browser clients send no Fetch Metadata.
    if (path.startsWith('/api/')) {
      const site = req.headers['sec-fetch-site'];
      const origin = req.headers.origin;
      if ((site !== undefined && site !== 'same-origin' && site !== 'none') || (origin !== undefined && origin !== `http://${authority}`)) {
        return reply.code(403).header('cache-control', 'no-store').send({ error: 'cross-site requests are refused', code: 'bad-origin' });
      }
    }
    opts.onRequest?.(req.method, req.url);

    // ---- authentication gate -----------------------------------------------------------------------------------
    // Public: the login page, its static build assets (no data), and the two endpoints needed to sign in.
    if (path === '/login' || path === '/login.html' || path.startsWith('/assets/') || path === '/api/auth/state' || path === '/api/auth/login') return;
    const isApi = path.startsWith('/api/');
    const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
    if (!auth.hasAdmin) {
      if (isApi) return reply.code(503).send({ error: 'Authentication is not set up. Run "npm run auth:setup" in a terminal.', code: 'not-setup' });
      return reply.redirect('/login', 302);
    }
    // The gate itself never renews a state-changing request: POSTs renew only inside their handler, after the Origin,
    // content-type and CSRF checks pass (`guard`). A GET renews only when it declares a real user interaction and is not
    // marked cross-site by the browser. Health checks, passive refreshes and navigation never extend the session.
    const site = req.headers['sec-fetch-site'];
    const interaction = req.method !== 'POST' && req.headers['x-devflow-interaction'] === 'user' && (site === undefined || site === 'same-origin');
    const v = auth.validate(token, interaction);
    if (!v.ok) {
      reply.header('set-cookie', clearCookie());
      if (isApi) return reply.code(401).header('cache-control', 'no-store').send({ error: v.reason === 'expired' ? 'Session expired after inactivity' : 'Authentication required', code: v.reason === 'expired' ? 'session-expired' : 'auth-required', login: '/login' });
      return reply.redirect(v.reason === 'expired' ? '/login?expired=1' : '/login', 302);
    }
    sessions.set(req, { token: token!, csrf: v.csrf, remainingSeconds: v.remainingSeconds });
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  });

  /** State-changing requests must be exactly same-origin JSON from our own page (CSRF layer 1; layer 2 is the session token). */
  const sameOriginJson = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const host = req.headers.host ?? '';
    const site = req.headers['sec-fetch-site'];
    if (req.headers.origin !== `http://${host}` || (site !== undefined && site !== 'same-origin')) { reply.code(403).send({ ok: false, code: 'bad-origin', error: 'Cross-origin requests are refused' }); return false; }
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { reply.code(415).send({ ok: false, code: 'bad-content-type', error: 'JSON required' }); return false; }
    return true;
  };
  const csrfValid = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const s = sessions.get(req);
    if (!s || !auth.csrfValid(s.token, req.headers['x-devflow-csrf'])) { reply.code(403).send({ ok: false, code: 'bad-csrf', error: 'Missing or invalid CSRF token; reload DevFlow' }); return false; }
    return true;
  };

  /** Full gate for an authenticated state-changing request; the session is renewed only once every check has passed. */
  const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!sameOriginJson(req, reply) || !csrfValid(req, reply)) return false;
    auth.touch(sessions.get(req)!.token);
    return true;
  };

  // ---- auth endpoints -----------------------------------------------------------------------------------------
  app.get('/api/auth/state', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const v = auth.hasAdmin ? auth.validate(parseCookie(req.headers.cookie, SESSION_COOKIE), false) : undefined; // never extends
    return { setup: auth.hasAdmin, authenticated: !!v?.ok, idleSeconds: auth.idleSeconds };
  });
  app.post('/api/auth/login', { bodyLimit: 2048 }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!sameOriginJson(req, reply)) return;
    const b = req.body;
    const password = typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>).password : undefined;
    const r = await auth.login(password);
    if (r.ok) {
      auth.logout(parseCookie(req.headers.cookie, SESSION_COOKIE)); // a fresh login replaces any session already presented (no fixation/reuse)
      reply.header('set-cookie', sessionCookie(r.token));
      return { ok: true, csrf: r.csrf, idleSeconds: auth.idleSeconds };
    }
    if (r.code === 'busy') return reply.code(429).header('retry-after', '1').send({ ok: false, code: 'busy', error: 'Too many sign-in attempts in progress; try again shortly', retryAfterSeconds: 1 });
    if (r.code === 'locked') return reply.code(429).header('retry-after', String(r.retryAfterSeconds ?? 60)).send({ ok: false, code: 'locked', error: 'Too many failed attempts', retryAfterSeconds: r.retryAfterSeconds });
    if (r.code === 'not-setup') return reply.code(503).send({ ok: false, code: 'not-setup', error: 'Authentication is not set up. Run "npm run auth:setup" in a terminal.' });
    if (r.code === 'bad-input') return reply.code(400).send({ ok: false, code: 'bad-input', error: 'A password is required' });
    return reply.code(401).send({ ok: false, code: 'invalid', error: 'Incorrect password' }); // one generic answer for every credential failure
  });
  app.get('/api/auth/session', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = sessions.get(req)!;
    return { csrf: s.csrf, idleSeconds: auth.idleSeconds, remainingSeconds: s.remainingSeconds };
  });
  app.post('/api/auth/touch', { bodyLimit: 512 }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!guard(req, reply)) return;
    return { ok: true, remainingSeconds: auth.idleSeconds };
  });
  app.post('/api/auth/logout', { bodyLimit: 512 }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!sameOriginJson(req, reply) || !csrfValid(req, reply)) return;
    auth.logout(sessions.get(req)!.token); // server-side invalidation: the token is dead even if a copy of the cookie exists
    reply.header('set-cookie', clearCookie());
    return { ok: true };
  });

  // Controlled messages only: SourceError text never contains credentials or upstream payloads.
  const fail = (reply: FastifyReply, e: unknown) =>
    reply.code(e instanceof SourceError && e.kind === 'rate_limit' ? 429 : 502).send({ error: e instanceof SourceError ? e.message : 'Upstream read failed' });

  // Dashboard open / Refresh. The only thing that can cause Linear/GitHub reads, besides the targeted routes below.
  app.get('/api/snapshot', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    try { return await service.get((req.query as Record<string, string>).refresh === '1'); } catch (e) { return fail(reply, e); }
  });
  // Read one accessible team on first selection. The key is validated server-side against the teams Linear showed us.
  app.get('/api/team/:key', async (req, reply) => {
    const key = (req.params as { key: string }).key;
    reply.header('cache-control', 'no-store');
    if (!/^[A-Za-z][A-Za-z0-9]{0,11}$/.test(key)) return reply.code(400).send({ error: 'invalid team key' });
    try { return (await service.getTeam(key, (req.query as Record<string, string>).refresh === '1')) ?? reply.code(404).send({ error: 'unknown team' }); } catch (e) { return fail(reply, e); }
  });
  // Targeted read of one issue (+ its PRs' evidence); never reloads other projects.
  app.get('/api/issue/:identifier', async (req, reply) => {
    const id = (req.params as { identifier: string }).identifier;
    reply.header('cache-control', 'no-store');
    if (!/^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$/.test(id)) return reply.code(400).send({ error: 'invalid identifier' });
    try {
      const snap = await service.getIssue(id);
      return snap ?? reply.code(404).send({ error: 'unknown issue' });
    } catch (e) { return fail(reply, e); }
  });

  // ---- controlled Linear actions: authenticated session + same-origin JSON + session-bound CSRF token ----------------
  const actions = opts.actions;
  const actionFail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof ActionError) return reply.code(e.status).send({ ok: false, code: e.code, error: e.message, checks: e.checks });
    return fail(reply, e);
  };
  app.get('/api/issue-actions/:identifier', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!actions) return reply.code(404).send({ error: 'actions unavailable' });
    try { return await actions.options((req.params as { identifier: string }).identifier); } catch (e) { return actionFail(reply, e); }
  });
  app.post('/api/actions/:kind', { bodyLimit: 8 * 1024 }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!guard(req, reply)) return; // same checks whether or not actions are enabled
    if (!actions) return reply.code(404).send({ ok: false, code: 'disabled', error: 'actions unavailable' });
    const b = req.body;
    if (typeof b !== 'object' || b === null || Array.isArray(b)) return reply.code(400).send({ ok: false, code: 'bad-input', error: 'JSON object required' });
    const body = b as Record<string, unknown>;
    const identifier = typeof body.identifier === 'string' ? body.identifier : '';
    const ids = (v: unknown) => (Array.isArray(v) ? v : []).slice(0, 30);
    try {
      switch ((req.params as { kind: string }).kind) {
        case 'labels': return await actions.labels(identifier, ids(body.add) as string[], ids(body.remove) as string[]);
        case 'status': return await actions.status(identifier, body.stateId as string);
        case 'milestone': return await actions.milestone(identifier, body.milestoneId === null ? null : (body.milestoneId as string));
        case 'approve': return await actions.approve(identifier, body.confirm);
        case 'revoke': return await actions.revoke(identifier, body.confirm);
        default: return reply.code(404).send({ ok: false, code: 'unknown-action', error: 'Unknown action' });
      }
    } catch (e) { return actionFail(reply, e); }
  });

  // Liveness/readiness are protected like everything else and never extend the session (no interaction header).
  app.get('/api/healthz', async () => ({ ok: true }));
  app.get('/api/readyz', async (_req, reply) => {
    const st = service.status();
    const ready = webReady && st.refreshingForMs < READY_REFRESH_LIMIT_MS;
    return reply.code(ready ? 200 : 503).send({ ready, webBuild: webReady, ...st });
  });

  if (webReady) {
    // Minimal static server for the Vite build, restricted to dist/. Reaching here means the gate above already allowed it.
    const root = resolve(opts.distDir);
    const realRoot = realpathSync(root);
    const serve = (reply: FastifyReply, file: string, immutable: boolean) => {
      const html = extname(file) === '.html';
      reply.header('content-type', MIME[extname(file)] ?? 'application/octet-stream');
      reply.header('cache-control', html ? 'no-store' : immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      return reply.send(createReadStream(file));
    };
    const login = () => `${root}/login.html`;
    app.get('/login', async (req, reply) => {
      if (!existsSync(login())) return reply.code(404).send({ error: 'login page missing from the build' });
      // already signed in (checked without extending the session) => straight to the app
      if (auth.hasAdmin && auth.validate(parseCookie(req.headers.cookie, SESSION_COOKIE), false).ok) return reply.redirect('/', 302);
      return serve(reply, login(), false);
    });
    app.setNotFoundHandler((req, reply) => {
      const path = pathOf(req);
      if (path.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      const rel = path; // already decoded and validated by normalizePath; the same string the auth gate used
      const file = resolve(root, '.' + rel);
      // only regular files strictly inside dist (symlinks resolved); anything else is the SPA shell (only reachable when signed in)
      if (file.startsWith(root + sep) && extname(file) && existsSync(file) && statSync(file).isFile() && realpathSync(file).startsWith(realRoot + sep)) return serve(reply, file, rel.startsWith('/assets/'));
      if (rel.startsWith('/assets/') || (extname(rel) && rel !== '/')) return reply.code(404).send({ error: 'not found' }); // /assets/ is public: never answer it with the app shell
      return serve(reply, `${root}/index.html`, false);
    });
    app.get('/', async (_req, reply) => serve(reply, `${root}/index.html`, false));
  }
  return app;
}
