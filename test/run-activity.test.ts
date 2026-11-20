import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../server/app.ts';
import { parseConfig } from '../server/config.ts';
import { runActivity } from '../server/orchestrator/activity.ts';
import { SnapshotService } from '../server/service.ts';
import { makeAuth, signIn } from './helpers.ts';

const path = '/api/issue/PS-8/run-activity';
const at = '2026-11-20T01:00:00.000Z';

describe('run activity', () => {
  it('projects only scoped controller handoffs and ignores raw diagnostics and partial records', () => {
    const root = mkdtempSync(join(tmpdir(), 'devflow-activity-'));
    try {
      const dir = join(root, 'PS-8-abc123');
      mkdirSync(dir);
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
        ticket: 'PS-8', issueId: 'issue-8', project: 'pilot', repo: 'owner/repo', runId: 'abc123',
        createdAt: at, state: 'repairing', attempts: [{ n: 0, review: { findings: 1 } }],
      }));
      writeFileSync(join(dir, 'events.jsonl'), [
        { at, what: 'state:reviewing', sha: 'a'.repeat(40) },
        { at, what: 'review-validated', verdict: 'FAIL', attempt: 0, detail: 'private agent output' },
        { at, what: 'infra-failure', detail: 'private diagnostic' },
        { at, what: 'state:repairing' },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n' + JSON.stringify({ at, what: 'state:awaiting-owner' }));
      const issue = { identifier: 'PS-8', id: 'issue-8' };
      const activity = runActivity(root, issue, 'pilot', 'owner/repo');
      expect(activity.activeAgent).toBe('claude');
      expect(activity.events.map((e) => [e.actor, e.title, e.detail])).toEqual([
        ['codex', 'Codex received the verified commit', 'aaaaaaaaaaaa'],
        ['codex', 'Codex sent findings to DevFlow', '1 finding'],
        ['claude', 'Claude received a repair request', undefined],
      ]);
      expect(runActivity(root, issue, 'other', 'owner/repo').runId).toBeNull();
      expect(runActivity(root, { ...issue, id: 'other' }, 'pilot', 'owner/repo').runId).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('authenticates SSE, replays activity to new connections, and stops after logout', async () => {
    const { auth, password } = await makeAuth();
    const service = new SnapshotService(parseConfig({ projects: [] }), {});
    const activity = { runId: 'abc123', state: 'ci', activeAgent: null, events: [] };
    const projection = vi.spyOn(service, 'activity').mockReturnValue(activity);
    const reviewing = { ...activity, state: 'reviewing', activeAgent: 'codex' as const };
    const app = await buildApp(service, { auth, distDir: '/none' });
    try {
      expect((await app.inject({ url: path, headers: { host: 'devflow.localhost:4317' } })).statusCode).toBe(401);
      const signed = await signIn(app, password);
      expect((await app.inject({ url: path, headers: { ...signed.headers, 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
      await app.listen({ host: '127.0.0.1', port: 0 });
      const port = (app.server.address() as AddressInfo).port;
      const read = (onFirst: () => void | Promise<unknown>, until: string) => new Promise<string>((resolve, reject) => {
        const req = request({ port, host: '127.0.0.1', path, headers: { host: 'devflow.localhost:4317', cookie: signed.cookie } }, (res) => {
          let data = '';
          let first = true;
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            data += chunk;
            if (first && data.includes('event: activity')) {
              first = false;
              Promise.resolve(onFirst()).catch(reject);
            }
            if (data.includes(until)) { resolve(data); res.destroy(); }
          });
          res.on('error', reject);
          res.on('end', () => reject(new Error('stream ended before the expected event')));
        });
        req.setTimeout(5_000, () => req.destroy(new Error('activity stream timed out')));
        req.on('error', reject);
        req.end();
      });
      const first = await read(() => {}, JSON.stringify(activity));
      const live = await read(() => { projection.mockReturnValue(reviewing); }, JSON.stringify(reviewing));
      const replay = await read(() => signed.post('/api/auth/logout', {}), 'event: unavailable');
      expect(first).toContain(JSON.stringify(activity));
      expect(live).toContain(JSON.stringify(activity));
      expect(live).toContain(JSON.stringify(reviewing));
      expect(replay).toContain(JSON.stringify(reviewing));
    } finally { await app.close(); auth.close(); }
  }, 15_000);
});
