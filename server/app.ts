import Fastify, { type FastifyInstance } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { SnapshotService } from './service.ts';
import { SourceError } from './util.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const READY_REFRESH_LIMIT_MS = 120_000;

export interface AppOptions { distDir: string; onRequest?: (method: string, url: string) => void }

export async function buildApp(service: SnapshotService, opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const webReady = existsSync(`${opts.distDir}/index.html`);

  app.addHook('onRequest', async (req, reply) => {
    // Read-only server: nothing but GET/HEAD is ever accepted.
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply.code(405).header('allow', 'GET, HEAD').send({ error: 'read-only' });
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
  // Targeted read of one issue (+ its PRs' evidence); never reloads other projects.
  app.get('/api/issue/:identifier', async (req, reply) => {
    const id = (req.params as { identifier: string }).identifier;
    reply.header('cache-control', 'no-store');
    if (!/^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$/.test(id)) return reply.code(400).send({ error: 'invalid identifier' });
    try { return (await service.getIssue(id)) ?? reply.code(404).send({ error: 'unknown issue' }); } catch (e) { return fail(reply, e); }
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
