import { describe, expect, it } from 'vitest';
import { ciStatus, humanReviewStatus, independentReviewStatus } from '../server/status.ts';
import type { CheckItem, ReviewItem } from '../shared/types.ts';
import { SnapshotService } from '../server/service.ts';
import { demoConfig, demoFetch } from '../server/demo.ts';
import { parseConfig } from '../server/config.ts';

const chk = (name: string, state: CheckItem['state']): CheckItem => ({ name, state, rawStatus: 'completed', rawConclusion: state, source: 'check_run' });
const rv = (user: string, state: string, at: string): ReviewItem => ({ user, state, at });
const NO_REVIEW_CFG = { checkName: undefined, passedLabel: undefined, findingsLabel: undefined };

describe('status interpretation', () => {
  it('CI: failed beats pending beats unknown beats passed; empty or unreadable is unknown', () => {
    expect(ciStatus([chk('a', 'passed'), chk('b', 'failed'), chk('c', 'pending')], true).value).toBe('failed');
    expect(ciStatus([chk('a', 'passed'), chk('c', 'pending')], true).value).toBe('pending');
    expect(ciStatus([chk('a', 'passed'), chk('c', 'unknown')], true).value).toBe('unknown');
    expect(ciStatus([chk('a', 'passed')], true).value).toBe('passed');
    expect(ciStatus([], true).value).toBe('unknown');
    expect(ciStatus([chk('a', 'passed')], false).value).toBe('unknown');
  });
  it('CI statuses carry evidence naming their source', () => {
    expect(ciStatus([chk('build', 'failed')], true).evidence[0]!.source).toBe('GitHub check run');
  });
  it('human review uses latest decisive review per reviewer', () => {
    expect(humanReviewStatus([rv('m', 'CHANGES_REQUESTED', '1'), rv('m', 'APPROVED', '2')], true, 'open').value).toBe('passed');
    expect(humanReviewStatus([rv('m', 'APPROVED', '1'), rv('m', 'CHANGES_REQUESTED', '2')], true, 'open').value).toBe('failed');
    expect(humanReviewStatus([rv('m', 'APPROVED', '1'), rv('m', 'COMMENTED', '2')], true, 'open').value).toBe('passed');
    expect(humanReviewStatus([], true, 'open').value).toBe('pending');
    expect(humanReviewStatus([], true, 'merged').value).toBe('unknown');
    expect(humanReviewStatus([], false, 'open').value).toBe('unknown');
  });
  it('independent review is never assumed passed', () => {
    const pr = { labels: [] as string[], checks: [chk('build', 'passed')], state: 'open' as const, detailOk: true };
    expect(independentReviewStatus(pr, NO_REVIEW_CFG).value).toBe('unknown');
    const cfg = { checkName: 'codex', passedLabel: 'ok', findingsLabel: 'findings' };
    expect(independentReviewStatus(pr, cfg).value).toBe('pending');
    expect(independentReviewStatus({ ...pr, checks: [chk('Codex', 'passed')] }, cfg).value).toBe('passed');
    expect(independentReviewStatus({ ...pr, labels: ['ok'] }, cfg).value).toBe('passed');
    expect(independentReviewStatus({ ...pr, labels: ['ok', 'findings'] }, cfg).value).toBe('failed');
    expect(independentReviewStatus({ ...pr, state: 'merged' }, cfg).value).toBe('unknown');
  });
});

const now = Date.parse('2026-06-01T12:00:00Z');
async function demoSnap() {
  const s = new SnapshotService(demoConfig(), { linearKey: 'k', githubToken: 't', fetchImpl: demoFetch(now), mode: 'demo' }, () => now);
  return s.get();
}

describe('snapshot over synthetic API', () => {
  it('follows pagination and reports demo mode', async () => {
    const snap = await demoSnap();
    expect(snap.mode).toBe('demo');
    expect(snap.issues.filter((i) => i.identifier.startsWith('ATL-'))).toHaveLength(19);
  });
  it('links PRs only on unambiguous identifier evidence', async () => {
    const snap = await demoSnap();
    const pr = (n: number, repo = 'atlas') => snap.prs.find((p) => p.key === `demo-org/${repo}#${n}`)!;
    expect(pr(3).ticket).toMatchObject({ link: 'linked', identifier: 'ATL-3' });
    expect(pr(14).ticket).toMatchObject({ link: 'ambiguous', candidates: ['ATL-14', 'ATL-7'] });
    expect(pr(15).ticket.link).toBe('unlinked');
    expect(snap.issues.find((i) => i.identifier === 'ATL-7')!.prKeys).toEqual([]);
  });
  it('derives stage, gates and rework from evidence', async () => {
    const snap = await demoSnap();
    const i = (id: string) => snap.issues.find((x) => x.identifier === id)!;
    expect(i('ATL-3').stage).toBe('implementation');
    expect(i('ATL-3').rework).toContain('CI failed');
    expect(i('ATL-4').stage).toBe('review');
    expect(i('ATL-4').gates.review.value).toBe('pending');
    expect(i('ATL-5').stage).toBe('ci');
    expect(i('ATL-13').stage).toBe('merge');
    expect(i('ATL-13').awaitingHuman.length).toBe(1);
    expect(i('ATL-1').stage).toBe('done');
    expect(i('ATL-12').stage).toBeUndefined();
    expect(i('ATL-8').gates.ci.value).toBe('na');
  });
  it('classifies Backlog, Discovery and Ready from real Linear state + labels (not every backlog issue is Discovery)', async () => {
    const snap = await demoSnap();
    const i = (id: string) => snap.issues.find((x) => x.identifier === id)!;
    expect(i('ATL-8').stage).toBe('discovery'); // Backlog state + Discovery label
    expect(i('ATL-15').stage).toBe('backlog'); // Backlog state, no Discovery label
    expect(i('ATL-7').stage).toBe('ready'); // Todo + Ready label
    expect(i('ATL-16').stage).toBe('backlog'); // Todo but NOT authorized: no Ready label
    expect(i('ATL-16').stageEvidence[0]!.label).toMatch(/not authorized/);
    expect(i('ATL-6').stage).toBe('ready');
    expect(i('ATL-6').readiness).toBe('blocked'); // Ready but an open blocker
    expect(i('ATL-7').readiness).toBe('ready');
    expect(i('ATL-15').readiness).toBe('not-ready');
    // classification labels stay labels, never stages
    expect(i('ATL-11').labels.map((l) => l.name)).toEqual(['Bug']);
    expect(i('ATL-11').stage).toBe('implementation');
  });
  it('Ready requires BOTH the label and an unstarted state', async () => {
    const f = demoFetch(now);
    f.store.issues.ATL!.find((x) => x.n === 15)!.labels = ['Ready']; // Ready label on a Backlog-state issue
    const snap = await new SnapshotService(demoConfig(), { linearKey: 'k', githubToken: 't', fetchImpl: f, mode: 'demo' }, () => now).get();
    const i = snap.issues.find((x) => x.identifier === 'ATL-15')!;
    expect(i.stage).toBe('backlog');
    expect(i.stageEvidence.map((e) => e.label).join(' ')).toMatch(/not treated as Ready/);
  });
  it('retrieves labels dynamically with colors, scope, groups, and flags protected/classification labels', async () => {
    const snap = await demoSnap();
    const atl = snap.labels.filter((l) => l.projectId === 'atlas');
    expect(atl.find((l) => l.name === 'Bug')).toMatchObject({ color: '#EB5757', scope: 'workspace', classification: true, protected: false });
    expect(atl.find((l) => l.name === 'Ready')).toMatchObject({ protected: true });
    expect(atl.find((l) => l.name === 'Area')).toMatchObject({ isGroup: true });
    expect(atl.find((l) => l.name === 'Needs Design')).toMatchObject({ classification: false, protected: false }); // unknown label: works without code changes
  });
  it('flags blockers, stale work and overdue milestones as attention, labelled actionable vs suggestion', async () => {
    const snap = await demoSnap();
    const a = (id: string) => snap.attention.find((x) => x.id === id);
    expect(a('blk:ATL-6')).toMatchObject({ actionable: true, kind: 'blocked' });
    expect(a('stale:ATL-9')).toMatchObject({ actionable: false });
    expect(snap.attention.find((x) => x.kind === 'milestone_overdue')!.title).toContain('M1');
    expect(a('ci:demo-org/atlas#3')!.evidence.length).toBeGreaterThan(0);
  });
  it('every surfaced URL is https or a configured obsidian link', async () => {
    const snap = await demoSnap();
    const urls = JSON.stringify(snap).match(/"url":"[^"]+"/g) ?? [];
    expect(urls.length).toBeGreaterThan(10);
    for (const u of urls) expect(u.startsWith('"url":"https://') || u.startsWith('"url":"obsidian://')).toBe(true);
  });
  it('builds Obsidian deep links and copy-path fallback from config only', async () => {
    const snap = await demoSnap();
    const k = snap.projects[0]!.knowledge.find((x) => x.kind === 'obsidian')!;
    expect(k.url).toBe('obsidian://open?vault=Demo-Vault&file=Projects%2FAtlas%2FArchitecture.md');
    expect(k.copyPath).toBe('/example/vault/Projects/Atlas/Architecture.md');
  });
});

const jsonRes = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers });
function svc(fetchImpl: typeof fetch) {
  const cfg = parseConfig({ projects: [{ id: 'p', name: 'P', linear: { teamKey: 'ABC' }, github: { repos: ['o/r'] } }] });
  return new SnapshotService(cfg, { linearKey: 'k', githubToken: 't', fetchImpl }, () => now);
}

describe('failure handling', () => {
  it('reports missing credentials precisely and still produces a snapshot', async () => {
    const cfg = parseConfig({ projects: [{ id: 'p', name: 'P', linear: { teamKey: 'ABC' }, github: { repos: ['o/r'] } }] });
    const snap = await new SnapshotService(cfg, {}).get();
    expect(snap.health.map((h) => h.state)).toEqual(['not_configured', 'not_configured']);
    expect(snap.attention.some((a) => a.kind === 'integration')).toBe(true);
  });
  it('auth failures become error health without leaking the token', async () => {
    const snap = await svc((async () => jsonRes({ message: 'Bad credentials' }, 401)) as typeof fetch).get();
    expect(snap.health.every((h) => h.state === 'error')).toBe(true);
    expect(JSON.stringify(snap)).not.toMatch(/Bearer/);
  });
  it('malformed / non-JSON responses do not crash', async () => {
    const snap = await svc((async () => new Response('<html>oops</html>', { status: 200 })) as typeof fetch).get();
    expect(snap.health.every((h) => h.state === 'error')).toBe(true);
    const snap2 = await svc((async () => jsonRes({ data: { teams: { nodes: [{ projects: 'x' }] } } })) as typeof fetch).get();
    expect(snap2.issues).toEqual([]);
  });
  it('network errors are contained', async () => {
    const snap = await svc((async () => { throw new TypeError('fetch failed: secret-host'); }) as typeof fetch).get();
    expect(snap.health[0]!.error).toBe('Network error contacting API');
  });
  it('serves last good data as stale after a later failure, and backs off on rate limits', async () => {
    let t = now;
    let fail = false;
    const good = demoFetch(now);
    let calls = 0;
    const f = (async (u: RequestInfo | URL, i?: RequestInit) => {
      calls++;
      if (fail) return jsonRes({ message: 'limit' }, 429, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(now / 1000) + 3600), 'x-ratelimit-requests-reset': String(now + 3600_000) });
      return good(u, i);
    }) as typeof fetch;
    const s = new SnapshotService(demoConfig(), { linearKey: 'k', githubToken: 't', fetchImpl: f, mode: 'demo' }, () => t);
    const ok = await s.get();
    expect(ok.health.every((h) => h.state === 'ok')).toBe(true);
    fail = true; t += 60_000;
    const stale = await s.get(true);
    expect(stale.issues.length).toBe(ok.issues.length);
    expect(stale.prs.length).toBe(ok.prs.length);
    expect(stale.health.every((h) => h.state === 'stale')).toBe(true);
    expect(stale.health[0]!.error).toMatch(/rate limit/i);
    expect(stale.attention.some((a) => a.kind === 'integration')).toBe(true);
    const before = calls; fail = false; t += 60_000;
    await s.get(true); // still inside the reset window: no upstream calls
    expect(calls - before).toBe(0);
  });
  it('unknown Linear team yields a clear error, not empty success', async () => {
    const snap = await svc((async (u: RequestInfo | URL) => String(u).includes('linear') ? jsonRes({ data: { teams: { nodes: [] } } }) : jsonRes([])) as typeof fetch).get();
    expect(snap.health.find((h) => h.id === 'linear:p')!.error).toMatch(/not found/);
  });
  it('no access to check runs: CI comes from workflow runs, details are labelled Unavailable, no permission prompt', async () => {
    const good = demoFetch(now);
    const f = (async (u: RequestInfo | URL, i?: RequestInit) => {
      const url = String(u);
      if (/\/check-runs|\/status\?|\/status$/.test(url)) return jsonRes({ message: 'Resource not accessible by personal access token' }, 403, { 'x-accepted-github-permissions': 'checks=read' });
      return good(u, i);
    }) as typeof fetch;
    const snap = await new SnapshotService(demoConfig(), { linearKey: 'k', githubToken: 't', fetchImpl: f, mode: 'demo' }, () => now).get();
    const gh = snap.health.find((h) => h.id === 'github:demo-org/atlas')!;
    expect(JSON.stringify(gh)).not.toMatch(/checks=read|needs/i); // never prompts for the permission
    expect(gh.warnings.some((w) => w.startsWith('check runs'))).toBe(false);
    const pr11 = snap.prs.find((p) => p.key === 'demo-org/atlas#11')!;
    expect(pr11.humanReview.value).toBe('failed'); // reviews still readable
    expect(pr11.detail.checkRunsUnavailable).toBe(true);
    expect(pr11.ci.evidence[0]!.source).toBe('GitHub Actions workflow run');
    expect(pr11.ci.detail).toMatch(/check-run details unavailable/);
    expect(snap.prs.find((p) => p.key === 'demo-org/atlas#3')!.ci.value).toBe('failed');
    // a PR whose head commit has no workflow run must be Unknown/Unavailable, never Passed
    const noRun = snap.prs.find((p) => p.key === 'demo-org/atlas#16')!;
    expect(noRun.ci.value).toBe('unknown');
  });
});
