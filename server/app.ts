import Fastify, { type FastifyInstance } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { SnapshotService } from './service.ts';
import { SourceError } from './util.ts';
import { timingSafeEqual } from 'node:crypto';
import { ActionError, type LinearActions } from './actions.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const READY_REFRESH_LIMIT_MS = 120_000;

export interface AppOptions { distDir: string; onRequest?: (method: string, url: string) => void; actions?: LinearActions }

export async function buildApp(service: SnapshotService, opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const webReady = existsSync(`${opts.distDir}/index.html`);

  app.addHook('onRequest', async (req, reply) => {
    // Only GET/HEAD are accepted, except POST under /api/actions/ (the controlled Linear actions, see below).
    const isAction = req.method === 'POST' && (req.url.split('?')[0] ?? '').startsWith('/api/actions/');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isAction) return reply.code(405).header('allow', 'GET, HEAD').send({ error: 'read-only' });
    // Defend against DNS rebinding: only answer for loopback host names.
    if (!LOCAL_HOST.test(req.headers.host ?? '')) return reply.code(403).send({ error: 'forbidden host' });
    opts.onRequest?.(req.method, req.url);
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
  });

  // Controlled messages only: SourceError text never contains credentials or upstream payloads.
  const fail = (reply: import('fastify').FastifyReply, e: unknown) =>
    reply.code(e instanceof SourceError && e.kind === 'rate_limit' ? 429 : 502).send({ error: e instanceof SourceError ? e.message : 'Upstream read failed' });

  // Dashboard open / Refresh. The only thing that can cause Linear/GitHub reads, besides /api/issue below.
  app.get('/api/snapshot', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    try { return await service.get((req.query as Record<string, string>).refresh === '1'); } catch (e) { return fail(reply, e); }
  });
  // Read one accessible team on first selection. Only teams discovered from Linear can be opened; the key is validated
  // server-side and only that team is read (not other teams, projects or repositories).
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
    try { return (await service.getIssue(id)) ?? reply.code(404).send({ error: 'unknown issue' }); } catch (e) { return fail(reply, e); }
  });
  // ---- controlled Linear actions -------------------------------------------------------------------------------
  const actions = opts.actions;
  const csrfOk = (given: unknown) => {
    if (!actions || typeof given !== 'string') return false;
    const a = Buffer.from(given), b = Buffer.from(actions.csrf);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  // Live action options (reads only). Also hands the same-origin page its CSRF token (cross-origin pages cannot read it).
  app.get('/api/issue-actions/:identifier', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!actions) return reply.code(404).send({ error: 'actions unavailable' });
    try { return await actions.options((req.params as { identifier: string }).identifier); } catch (e) { return actionFail(reply, e); }
  });
  const actionFail = (reply: import('fastify').FastifyReply, e: unknown) => {
    if (e instanceof ActionError) return reply.code(e.status).send({ ok: false, code: e.code, error: e.message, checks: e.checks });
    return fail(reply, e);
  };
  app.post('/api/actions/:kind', { bodyLimit: 8 * 1024 }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!actions) return reply.code(404).send({ ok: false, code: 'disabled', error: 'actions unavailable' });
    const host = req.headers.host ?? '';
    const origin = req.headers.origin;
    // CSRF defence in depth: exact same-origin, fetch-metadata (when sent), JSON-only (not a "simple" form post), secret token.
    if (origin !== `http://${host}`) return reply.code(403).send({ ok: false, code: 'bad-origin', error: 'Cross-origin requests are refused' });
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return reply.code(403).send({ ok: false, code: 'bad-origin', error: 'Cross-origin requests are refused' });
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return reply.code(415).send({ ok: false, code: 'bad-content-type', error: 'JSON required' });
    if (!csrfOk(req.headers['x-devflow-csrf'])) return reply.code(403).send({ ok: false, code: 'bad-csrf', error: 'Missing or invalid CSRF token; reload DevFlow' });
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
        case 'revoke': return await actions.revoke(identifier, body.confirm, body.reason);
        default: return reply.code(404).send({ ok: false, code: 'unknown-action', error: 'Unknown action' });
      }
    } catch (e) { return actionFail(reply, e); }
  });

  // Liveness: process answers. Readiness: web build present and no refresh stuck. Neither calls Linear/GitHub.
  app.get('/api/healthz', async () => ({ ok: true }));
  app.get('/api/readyz', async (_req, reply) => {
    const st = service.status();
    const ready = webReady && st.refreshingForMs < READY_REFRESH_LIMIT_MS;
    return reply.code(ready ? 200 : 503).send({ ready, webBuild: webReady, ...st });
  });

  if (webReady) {
    // Minimal static server for the Vite build (replaces @fastify/static and its glob/minimatch advisories).
    const root = resolve(opts.distDir);
    const serve = (reply: import('fastify').FastifyReply, file: string, immutable: boolean) => {
      reply.header('content-type', MIME[extname(file)] ?? 'application/octet-stream');
      reply.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      return reply.send(createReadStream(file));
    };
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0] ?? '/';
      if (path.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      let rel = '';
      try { rel = decodeURIComponent(path); } catch { return reply.code(400).send({ error: 'bad path' }); }
      if (rel.includes('\0')) return reply.code(400).send({ error: 'bad path' });
      const file = resolve(root, '.' + rel);
      // only regular files strictly inside dist; anything else is the SPA shell
      if (file.startsWith(root + sep) && extname(file) && existsSync(file) && statSync(file).isFile())
        return serve(reply, file, rel.startsWith('/assets/'));
      if (extname(rel) && rel !== '/') return reply.code(404).send({ error: 'not found' });
      return serve(reply, `${root}/index.html`, false);
    });
    app.get('/', async (_req, reply) => serve(reply, `${root}/index.html`, false));
  }
  return app;
}
