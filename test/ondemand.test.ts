import { describe, expect, it, vi } from 'vitest';
import { SnapshotService } from '../server/service.ts';
import { demoConfig, demoFetch } from '../server/demo.ts';
import { parseConfig } from '../server/config.ts';
import { GithubClient, fetchRepo } from '../server/github.ts';
import { LinearClient } from '../server/linear.ts';
import { Limiter, Memo, SourceError, fetchJson } from '../server/util.ts';
import { buildApp } from '../server/app.ts';

const now = Date.parse('2026-06-01T12:00:00Z');
const jsonRes = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers });

function counting(fetchImpl = demoFetch(now)) {
  const calls: string[] = [];
  const f = (async (u: string | URL | Request, i?: RequestInit) => {
    const url = String(u);
    calls.push(url.includes('linear') ? `linear:${/query (\w+)/.exec(String(i?.body))?.[1]}` : new URL(url).pathname.replace('/repos/demo-org/', ''));
    return fetchImpl(u, i);
  }) as typeof fetch;
  return { calls, f };
}
const mk = (f: typeof fetch, t: { v: number }) => new SnapshotService(demoConfig(), { linearKey: 'k', githubToken: 't', fetchImpl: f, mode: 'demo' }, () => t.v);

describe('on-demand reads (no polling)', () => {
  it('makes zero upstream calls until something asks, and reuses data for ordinary navigation', async () => {
    vi.useFakeTimers();
    try {
      const { calls, f } = counting();
      const t = { v: now };
      const s = mk(f, t);
      await vi.advanceTimersByTimeAsync(3_600_000); // an hour with no browser
      expect(calls).toHaveLength(0);
      await s.get();
      const first = calls.length;
      expect(first).toBeGreaterThan(0);
      t.v += 60_000; // navigation within the stale window
      for (let i = 0; i < 20; i++) await s.get();
      expect(calls.length).toBe(first);
      await vi.advanceTimersByTimeAsync(3_600_000); // and again nothing happens on its own
      expect(calls.length).toBe(first);
      expect(vi.getTimerCount()).toBe(0); // no timers left armed by the service
    } finally { vi.useRealTimers(); }
  });
  it('re-reads once data is older than the stale threshold, and on explicit Refresh', async () => {
    const { calls, f } = counting();
    const t = { v: now };
    const s = mk(f, t);
    await s.get();
    const n = calls.length;
    t.v += 6 * 60_000;
    await s.get();
    expect(calls.length).toBeGreaterThan(n);
    const n2 = calls.length;
    t.v += 10_000;
    await s.get(true);
    expect(calls.length).toBeGreaterThan(n2);
  });
  it('opening one issue reads only that issue and its PR evidence, not other projects', async () => {
    const { calls, f } = counting();
    const t = { v: now };
    const s = mk(f, t);
    const before = await s.get();
    expect(before.issues.find((i) => i.identifier === 'ATL-3')!.description).toBe(''); // list omits descriptions
    calls.length = 0;
    const snap = (await s.getIssue('ATL-3'))!;
    const i = snap.issues.find((x) => x.identifier === 'ATL-3')!;
    expect(i.description).toContain('Synthetic description');
    expect(i.detailAt).toBeTruthy();
    expect(calls.filter((c) => c.startsWith('linear:')).sort()).toEqual(['linear:IssueDetail']);
    expect(calls.some((c) => /beacon/.test(c))).toBe(false);
    expect(calls.some((c) => /^atlas\/pulls\?/.test(c))).toBe(false); // PR list is not reloaded
    expect(calls.some((c) => /^atlas\/pulls\/3$/.test(c))).toBe(true);
    expect(calls.length).toBeLessThan(10);
    // second open within the stale window: no calls at all
    calls.length = 0;
    await s.getIssue('ATL-3');
    expect(calls).toHaveLength(0);
    // an issue with no PRs fetches no GitHub data
    calls.length = 0;
    await s.getIssue('ATL-8');
    expect(calls).toEqual(['linear:IssueDetail']);
    expect(await s.getIssue('ATL-999')).toBeUndefined();
  });
  it('a full refresh keeps a fetched description until the issue changes', async () => {
    const { f } = counting();
    const t = { v: now };
    const s = mk(f, t);
    await s.get();
    await s.getIssue('ATL-3');
    t.v += 10_000;
    const snap = await s.get(true);
    expect(snap.issues.find((x) => x.identifier === 'ATL-3')!.description).toContain('Synthetic description');
    expect(snap.issues.find((x) => x.identifier === 'ATL-3')!.childIdentifiers).toEqual(['ATL-10']); // no duplicates on rebuild
  });
  it('completed checks are refreshable evidence even when the head SHA is unchanged', async () => {
    let conclusion = 'success';
    const good = demoFetch(now);
    const f = (async (u: string | URL | Request, i?: RequestInit) => {
      const url = String(u);
      if (/atlas\/commits\/[^/]+\/check-runs/.test(url)) {
        const r = await good(u, i); const b = await r.json() as { check_runs: Record<string, unknown>[] };
        if (b.check_runs[0]) b.check_runs[0].conclusion = conclusion;
        return jsonRes(b);
      }
      return good(u, i);
    }) as typeof fetch;
    const t = { v: now };
    const s = mk(f, t);
    const pr4 = async (force: boolean) => (await s.get(force)).prs.find((p) => p.key === 'demo-org/atlas#4')!;
    expect((await pr4(false)).ci.value).toBe('passed');
    conclusion = 'failure'; // same SHA, check re-run and failed
    t.v += 10_000;
    expect((await pr4(true)).ci.value).toBe('failed');
  });
  it('reviews changed on an unchanged PR are picked up by Refresh', async () => {
    let state = 'APPROVED';
    const good = demoFetch(now);
    const f = (async (u: string | URL | Request, i?: RequestInit) =>
      /atlas\/pulls\/11\/reviews/.test(String(u)) ? jsonRes([{ user: { login: 'm' }, state, submitted_at: '2026-06-01T10:00:00Z' }]) : good(u, i)) as typeof fetch;
    const t = { v: now };
    const s = mk(f, t);
    expect((await s.get()).prs.find((p) => p.key === 'demo-org/atlas#11')!.humanReview.value).toBe('passed');
    state = 'DISMISSED'; t.v += 10_000;
    expect((await s.get(true)).prs.find((p) => p.key === 'demo-org/atlas#11')!.humanReview.value).toBe('pending');
  });
});

describe('Memo', () => {
  it('dedupes in-flight work, honours ttl, force bypasses finished entries, drops failures', async () => {
    const m = new Memo();
    let n = 0;
    const fn = async () => ++n;
    const [a, b] = await Promise.all([m.get('k', 60_000, fn), m.get('k', 60_000, fn)]);
    expect([a, b, n]).toEqual([1, 1, 1]);
    expect(await m.get('k', 60_000, fn)).toBe(1);
    expect(await m.get('k', 60_000, fn, true)).toBe(2);
    await expect(m.get('bad', 1000, async () => { throw new Error('x'); })).rejects.toThrow();
    expect(await m.get('bad', 1000, async () => 7)).toBe(7);
    expect(await m.get('dyn', (v: number) => (v > 0 ? 0 : 60_000), async () => 1)).toBe(1);
    expect(await m.get('dyn', () => 0, async () => 9)).toBe(9); // ttl computed from value => expired immediately
  });
});

describe('HTTP hardening', () => {
  it('a stalled response body is cut off by the same deadline', async () => {
    const stall = (async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a":')); } /* never closes */ }))) as typeof fetch;
    const t0 = Date.now();
    await expect(fetchJson(stall, 'https://x.test', {}, 150)).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('oversized bodies are rejected', async () => {
    const big = (async () => new Response('x'.repeat(5000))) as typeof fetch;
    await expect(fetchJson(big, 'https://x.test', {}, 1000, 1000)).rejects.toThrow(/too large/);
    const declared = (async () => new Response('{}', { headers: { 'content-length': '999999' } })) as typeof fetch;
    await expect(fetchJson(declared, 'https://x.test', {}, 1000, 1000)).rejects.toThrow(/too large/);
  });
  it('GitHub secondary limits (403 + Retry-After / message) are rate limits, not auth errors', async () => {
    const g1 = new GithubClient('t', (async () => jsonRes({ message: 'You have exceeded a secondary rate limit' }, 403, { 'retry-after': '30', 'x-ratelimit-remaining': '4000' })) as typeof fetch);
    await expect(g1.get('/repos/o/r/pulls')).rejects.toMatchObject({ kind: 'rate_limit' });
    const g2 = new GithubClient('t', (async () => jsonRes({ message: 'Resource not accessible' }, 403, { 'x-ratelimit-remaining': '4000' })) as typeof fetch);
    await expect(g2.get('/repos/o/r/pulls')).rejects.toMatchObject({ kind: 'auth' });
  });
  it('upstream error text is never forwarded (no echo of secrets)', async () => {
    const l = new LinearClient('lin_secret', (async () => jsonRes({ errors: [{ message: 'bad token lin_secret leaked', extensions: { code: 'SOME_ERROR' } }] })) as typeof fetch);
    const err = await l.query('query Q { x }', {}).catch((e) => e as SourceError);
    expect(err.message).toBe('Linear GraphQL error (SOME_ERROR)');
    expect(err.message).not.toContain('lin_secret');
  });
  it('rate limit on one source pauses the whole credential', async () => {
    let calls = 0;
    const good = demoFetch(now);
    const f = (async (u: string | URL | Request, i?: RequestInit) => {
      calls++;
      return String(u).includes('github') && /atlas\/pulls\?/.test(String(u)) ? jsonRes({ message: 'x' }, 429, { 'retry-after': '120' }) : good(u, i);
    }) as typeof fetch;
    const cfg = parseConfig({ projects: [{ id: 'a', name: 'A', github: { repos: ['demo-org/atlas', 'demo-org/beacon'] } }, { id: 'b', name: 'B' }] });
    const t = { v: now };
    const s = new SnapshotService(cfg, { githubToken: 't', fetchImpl: f }, () => t.v);
    await s.get();
    const after = calls; t.v += 10_000;
    const snap = await s.get(true);
    expect(calls).toBe(after); // beacon (same credential) was not called while github is backing off
    expect(snap.health.filter((h) => h.id.startsWith('github:')).map((h) => h.state).sort()).toEqual(['error', 'stale']); // atlas never read; beacon keeps last good
  });
});

describe('incomplete evidence is never Passed', () => {
  it('paginates within budget and flags truncation as Unknown', async () => {
    const mkRun = (n: number) => ({ name: `job${n}`, status: 'completed', conclusion: 'success' });
    const good = demoFetch(now);
    const f = (async (u: string | URL | Request, i?: RequestInit) => {
      const url = new URL(String(u));
      if (/atlas\/commits\/[^/]+\/check-runs/.test(url.pathname)) {
        const page = Number(url.searchParams.get('page') ?? 1);
        return jsonRes({ total_count: 1000, check_runs: Array.from({ length: 100 }, (_, k) => mkRun(page * 1000 + k)) });
      }
      return good(u, i);
    }) as typeof fetch;
    const snap = await mk(f, { v: now }).get();
    const pr = snap.prs.find((p) => p.key === 'demo-org/atlas#4')!;
    expect(pr.checks.length).toBeGreaterThanOrEqual(300);
    expect(pr.ci.value).toBe('unknown');
    expect(pr.ci.detail).toMatch(/incomplete/);
    expect(snap.health.find((h) => h.id === 'github:demo-org/atlas')!.warnings.join(' ')).toMatch(/incomplete evidence/);
  });
  it('unreadable commit statuses downgrade an otherwise green CI to Unknown; failures still show', async () => {
    const good = demoFetch(now);
    const f = (async (u: string | URL | Request, i?: RequestInit) =>
      /atlas\/commits\/[^/]+\/status/.test(String(u)) ? jsonRes({ message: 'no' }, 403, { 'x-accepted-github-permissions': 'statuses=read' }) : good(u, i)) as typeof fetch;
    const snap = await mk(f, { v: now }).get();
    expect(snap.prs.find((p) => p.key === 'demo-org/atlas#4')!.ci.value).toBe('unknown');
    expect(snap.prs.find((p) => p.key === 'demo-org/atlas#3')!.ci.value).toBe('failed');
  });
  it('fetchRepo paginates PR lists defensively', async () => {
    const g = new GithubClient('t', demoFetch(now));
    const r = await fetchRepo(g, 'demo-org/atlas', false, now);
    expect(r.prs.length).toBeGreaterThan(5);
  });
});

describe('server surface', () => {
  const app = async () => buildApp(new SnapshotService(demoConfig(), { linearKey: 'k', githubToken: 't', fetchImpl: demoFetch(now), mode: 'demo' }, () => now), { distDir: '/nonexistent' });
  it('is read-only, loopback-only, validates input, reports readiness', async () => {
    const a = await app();
    expect((await a.inject({ method: 'POST', url: '/api/snapshot', headers: { host: 'localhost:4317' } })).statusCode).toBe(405);
    expect((await a.inject({ method: 'GET', url: '/api/snapshot', headers: { host: 'evil.example' } })).statusCode).toBe(403);
    expect((await a.inject({ url: '/api/issue/not%20valid', headers: { host: 'localhost' } })).statusCode).toBe(400);
    expect((await a.inject({ url: '/api/issue/ZZZ-1', headers: { host: 'localhost' } })).statusCode).toBe(404);
    expect((await a.inject({ url: '/api/issue/ATL-3', headers: { host: '127.0.0.1:4317' } })).json().issues.length).toBeGreaterThan(0);
    expect((await a.inject({ url: '/api/healthz', headers: { host: 'localhost' } })).statusCode).toBe(200);
    const ready = await a.inject({ url: '/api/readyz', headers: { host: 'localhost' } });
    expect(ready.statusCode).toBe(503); // no web build at that path: not ready, and says why
    expect(ready.json().webBuild).toBe(false);
  });
  it('static server serves the build and cannot be walked out of dist', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(`${tmpdir()}/devflow-static-`);
    mkdirSync(`${dir}/dist/assets`, { recursive: true });
    writeFileSync(`${dir}/dist/index.html`, '<html>shell</html>');
    writeFileSync(`${dir}/dist/assets/a.js`, 'console.log(1)');
    writeFileSync(`${dir}/.env`, 'SECRET=hunter2');
    const a = await buildApp(new SnapshotService(demoConfig(), { mode: 'demo' }, () => now), { distDir: `${dir}/dist` });
    const get = (url: string) => a.inject({ url, headers: { host: 'localhost' } });
    expect((await get('/')).body).toContain('shell');
    expect((await get('/some/client/route')).body).toContain('shell');
    const js = await get('/assets/a.js');
    expect([js.statusCode, js.headers['content-type']]).toEqual([200, 'text/javascript; charset=utf-8']);
    for (const evil of ['/..%2f.env', '/%2e%2e/.env', '/assets/..%2f..%2f.env', '/../.env', '/%00.env', '/assets/%2e%2e%2f%2e%2e%2f.env']) {
      const r = await get(evil);
      expect(r.body, evil).not.toContain('hunter2');
    }
    expect((await get('/missing.js')).statusCode).toBe(404);
  });
});

describe('refresh cancellation', () => {
  it('a deadline aborts every upstream request, commits nothing, and leaves no refresh running', async () => {
    let active = 0, aborted = 0, started = 0;
    const hang = (async (_u: unknown, init?: RequestInit) => {
      started++; active++;
      return new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => { aborted++; active--; rej(new DOMException('aborted', 'AbortError')); }));
    }) as typeof fetch;
    const s = new SnapshotService(demoConfig(), { linearKey: 'k', githubToken: 't', fetchImpl: hang, mode: 'demo', refreshDeadlineMs: 60 }, () => now);
    await expect(s.get()).rejects.toThrow(/deadline/);
    await new Promise((r) => setTimeout(r, 30)); // let the cancelled refresh finish unwinding
    expect(started).toBeGreaterThan(0);
    expect(aborted).toBe(started);
    expect(active).toBe(0);
    expect(s.status()).toMatchObject({ refreshing: false, haveData: false }); // nothing was committed
  });
  it('recovers: the next refresh runs normally after a cancelled one', async () => {
    let hang = true;
    const good = demoFetch(now);
    const f = (async (u: string | URL | Request, init?: RequestInit) =>
      hang ? new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))) : good(u, init)) as typeof fetch;
    const s = new SnapshotService(demoConfig(), { linearKey: 'k', githubToken: 't', fetchImpl: f, mode: 'demo', refreshDeadlineMs: 50 }, () => now);
    await expect(s.get()).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    hang = false;
    const snap = await s.get();
    expect(snap.health.every((h) => h.state === 'ok')).toBe(true);
  });
});

describe('malformed evidence is never Passed', () => {
  it('a 200 with the wrong shape from statuses / check-runs / reviews becomes Unknown + a warning', async () => {
    for (const [pattern, what] of [[/atlas\/commits\/[^/]+\/status/, 'commit statuses'], [/atlas\/commits\/[^/]+\/check-runs/, 'check runs']] as const) {
      const good = demoFetch(now);
      const f = (async (u: string | URL | Request, i?: RequestInit) => (pattern.test(String(u)) ? jsonRes({ unexpected: 'shape' }) : good(u, i))) as typeof fetch;
      const snap = await mk(f, { v: now }).get();
      const pr = snap.prs.find((p) => p.key === 'demo-org/atlas#4')!;
      expect(pr.ci.value, what).toBe('unknown');
      expect(snap.health.find((h) => h.id === 'github:demo-org/atlas')!.warnings.join(' '), what).toMatch(/unexpected response shape/);
    }
    const good = demoFetch(now);
    const f = (async (u: string | URL | Request, i?: RequestInit) => (/atlas\/pulls\/11\/reviews/.test(String(u)) ? jsonRes({ nope: 1 }) : good(u, i))) as typeof fetch;
    const pr11 = (await mk(f, { v: now }).get()).prs.find((p) => p.key === 'demo-org/atlas#11')!;
    expect(pr11.humanReview.value).toBe('unknown'); // not "failed"/"passed" from an empty list
  });
});

describe('bounded concurrency', () => {
  it('Limiter never runs more than N at once and preserves order', async () => {
    const lim = new Limiter(4);
    let active = 0, max = 0; const order: number[] = [];
    await Promise.all(Array.from({ length: 20 }, (_, i) => lim.run(async () => { active++; max = Math.max(max, active); order.push(i); await new Promise((r) => setTimeout(r, 3)); active--; })));
    expect(max).toBe(4);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  it('GitHub client caps in-flight upstream requests', async () => {
    let active = 0, max = 0;
    const slow = (async () => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 5)); active--; return jsonRes([]); }) as typeof fetch;
    const g = new GithubClient('t', slow);
    await Promise.all(Array.from({ length: 24 }, (_, i) => g.get('/repos/o/r/pulls', { page: i })));
    expect(max).toBeLessThanOrEqual(4);
  });
});

describe('source-specific backoff on issue reads', () => {
  it('a Linear limit hit while opening an issue does not pause GitHub', async () => {
    let linearLimited = false, ghCalls = 0, linCalls = 0;
    const good = demoFetch(now);
    const f = (async (u: string | URL | Request, i?: RequestInit) => {
      const url = String(u);
      if (url.includes('linear')) { linCalls++; if (linearLimited) return jsonRes({}, 429, { 'x-ratelimit-requests-reset': String(now + 600_000) }); }
      else ghCalls++;
      return good(u, i);
    }) as typeof fetch;
    const t = { v: now };
    const s = mk(f, t);
    await s.get();
    linearLimited = true;
    await expect(s.getIssue('ATL-3')).rejects.toMatchObject({ kind: 'rate_limit' });
    ghCalls = 0; linCalls = 0; t.v += 10_000;
    const snap = await s.get(true);
    expect(ghCalls).toBeGreaterThan(0); // GitHub still read
    expect(linCalls).toBe(0); // Linear paused until its reset
    expect(snap.health.find((h) => h.id.startsWith('github:'))!.state).toBe('ok');
    expect(snap.health.find((h) => h.id === 'linear:team:ATL')!.state).toBe('stale');
  });
});
