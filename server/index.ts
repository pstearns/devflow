import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadEnvFile, type Config } from './config.ts';
import { demoConfig, demoFetch } from './demo.ts';
import { buildApp } from './app.ts';
import { SnapshotService } from './service.ts';
import { LinearClient } from './linear.ts';
import { LinearWriteClient } from './linear-write.ts';
import { LinearActions } from './actions.ts';
import { DEMO_READ_KEY, DEMO_WRITE_KEY } from './demo-linear.ts';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
// Works from source (server/) and from the compiled build (dist-server/server/).
const distDir = [resolve(here, '../dist'), resolve(here, '../../dist')].find((d) => existsSync(`${d}/index.html`));
const root = distDir ? dirname(distDir) : resolve(here, '..');
process.chdir(root);

const die = (msg: string): never => { console.error(`DevFlow: ${msg}`); process.exit(1); };

const demo = process.env.DEVFLOW_DEMO === '1';
const envWarning = demo ? undefined : loadEnvFile('.env');
if (envWarning) console.warn(`DevFlow warning: ${envWarning}`);
if (!distDir) die('web build not found. Run: npm run build');

let cfg: Config;
try {
  if (demo) cfg = demoConfig();
  else {
    const loaded = loadConfig();
    if (!loaded.found) die(`no configuration at ${loaded.path}. Copy devflow.config.example.json to devflow.config.json (or use: npm run demo).`);
    cfg = loaded.config;
  }
} catch (e) {
  die(`invalid configuration: ${e instanceof Error ? e.message : 'unreadable'}`);
}
cfg = cfg!;

let lastRequest = Date.now();
const accessLog = process.env.DEVFLOW_ACCESS_LOG === '1'; // opt-in diagnostics: method + path only
const demoFetchImpl = demo ? demoFetch() : undefined;
const service = new SnapshotService(
  cfg,
  demo
    ? { linearKey: 'demo', githubToken: 'demo', fetchImpl: demoFetchImpl, mode: 'demo' }
    : { linearKey: process.env.LINEAR_API_KEY?.trim() || undefined, githubToken: process.env.GITHUB_TOKEN?.trim() || undefined },
);
// Controlled Linear actions need their OWN credential. It must differ from the read key, so the read key can never write.
const readKey = demo ? DEMO_READ_KEY : process.env.LINEAR_API_KEY?.trim();
const writeKey = demo ? DEMO_WRITE_KEY : process.env.LINEAR_WRITE_API_KEY?.trim();
let actions: LinearActions | undefined;
if (readKey) {
  const fetchImpl = demo ? demoFetchImpl : undefined;
  const write = writeKey && writeKey !== readKey ? new LinearWriteClient(writeKey, fetchImpl) : undefined;
  if (writeKey && writeKey === readKey) console.warn('DevFlow warning: LINEAR_WRITE_API_KEY equals LINEAR_API_KEY; write access stays disabled (use a separate key).');
  service.setWriteInfo(write ? { enabled: true } : { enabled: false, reason: 'Linear write access is not configured: set LINEAR_WRITE_API_KEY to a separate Linear personal API key with Write permission limited to the configured team(s).' });
  actions = new LinearActions({ cfg, read: new LinearClient(readKey, fetchImpl), write, service, csrf: randomBytes(24).toString('hex'), log: (l) => console.log(`DevFlow ${l}`) });
}
const app = await buildApp(service, {
  actions, distDir: distDir!, onRequest: (m, u) => { lastRequest = Date.now(); if (accessLog) console.log(`${new Date().toISOString()} ${m} ${u.split('?')[0]}`); } });

const HOST = '127.0.0.1'; // loopback only; never exposed to the LAN
const PORT = Number(process.env.DEVFLOW_PORT) || cfg.port; // exactly one port: no scanning, no silent drift
try {
  await app.listen({ host: HOST, port: PORT });
} catch (e) {
  die((e as NodeJS.ErrnoException).code === 'EADDRINUSE'
    ? `port ${PORT} is already in use (is DevFlow already running? try http://localhost:${PORT})`
    : `could not listen on ${HOST}:${PORT}`);
}
console.log(`DevFlow ${demo ? '(DEMO DATA) ' : ''}listening on http://localhost:${PORT}`);
if (!demo) console.log(`  Linear: ${process.env.LINEAR_API_KEY ? 'key set' : 'LINEAR_API_KEY missing'} · GitHub: ${process.env.GITHUB_TOKEN ? 'token set' : 'GITHUB_TOKEN missing'} · projects: ${cfg.projects.length}`);

let closing = false;
const shutdown = (why: string) => {
  if (closing) return;
  closing = true;
  console.log(`DevFlow stopping (${why})`);
  const force = setTimeout(() => process.exit(0), 5000);
  force.unref();
  app.close().finally(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Idle exit keeps the on-demand launcher from leaving WSL awake. This timer makes no API request.
if (cfg.idleExitMinutes > 0) {
  const limit = cfg.idleExitMinutes * 60_000;
  setInterval(() => { if (Date.now() - lastRequest > limit) shutdown(`idle for ${cfg.idleExitMinutes} min`); }, 60_000).unref();
}
