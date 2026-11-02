// DevFlow sends the action to Linear, re-reads Linear and reports what Linear says. It keeps no workflow state of its own.
import { describe, expect, it } from 'vitest';
import { SnapshotService } from '../server/service.ts';
import { demoConfig, demoFetch, DEMO_READ_KEY, DEMO_WRITE_KEY } from '../server/demo.ts';
import type { FakeLinearOpts } from '../server/demo-linear.ts';
import { LinearClient } from '../server/linear.ts';
import { LinearWriteClient } from '../server/linear-write.ts';
import { ActionError, LinearActions } from '../server/actions.ts';

const now = Date.parse('2026-06-01T12:00:00Z');
const fail = async (p: Promise<unknown>) => (await p.then(() => { throw new Error('expected rejection'); }, (e) => e)) as ActionError;
const st = (name: string) => `st-ATL-${name.toLowerCase().replace(/\W+/g, '-')}`;

async function setup(opts: FakeLinearOpts = {}, wrap: (f: typeof fetch) => typeof fetch = (f) => f) {
  const f0 = demoFetch(now, opts);
  const f = wrap(f0);
  const cfg = demoConfig();
  const service = new SnapshotService(cfg, { linearKey: DEMO_READ_KEY, githubToken: 't', fetchImpl: f, mode: 'demo' }, () => now);
  service.setWriteInfo({ enabled: true });
  await service.get();
  const mk = () => new LinearActions({ cfg, read: new LinearClient(DEMO_READ_KEY, f), write: new LinearWriteClient(DEMO_WRITE_KEY, f), service, clock: () => now });
  const spec = (id: string) => { const [t, n] = id.split('-') as [string, string]; return f0.store.issues[t!]!.find((x) => x.n === Number(n))!; };
  return { f0, service, actions: mk(), mk, spec, ops: () => f0.store.mutations.map((m) => m.op) };
}

describe('approval = Todo + Ready in Linear, confirmed by a read-back', () => {
  it('sends exactly the two Linear changes (no comments, no extra writes)', async () => {
    const { actions, spec, ops } = await setup();
    expect((await actions.approve('ATL-15', 'ATL-15')).verified).toBe(true);
    expect([spec('ATL-15').state, spec('ATL-15').labels]).toEqual(['Todo', ['Idea', 'Ready']]);
    expect(ops()).toEqual(['IssueUpdate', 'IssueAddLabel']);
  });
  it('a lost reply after Linear committed the label: Linear shows Todo + Ready, so it is reported as done (verified), nothing is undone', async () => {
    const { actions, spec, ops } = await setup({ lostResponse: (op) => op === 'IssueAddLabel' });
    expect((await actions.approve('ATL-15', 'ATL-15')).ok).toBe(true);
    expect([spec('ATL-15').state, spec('ATL-15').labels]).toEqual(['Todo', ['Idea', 'Ready']]);
    expect(ops()).toEqual(['IssueUpdate', 'IssueAddLabel']);
  });
  it('a lost reply after the status committed: reports what Linear shows (Todo, no Ready) and does NOT roll back', async () => {
    const { actions, spec, ops } = await setup({ lostResponse: (op) => op === 'IssueUpdate' });
    const e = await fail(actions.approve('ATL-15', 'ATL-15'));
    expect(e.code).toBe('write-failed');
    expect(e.message).toMatch(/Linear currently shows status "Todo" with labels: Idea\./);
    expect(e.message).not.toMatch(/rolled back and verified|restored/);
    expect([spec('ATL-15').state, spec('ATL-15').labels]).toEqual(['Todo', ['Idea']]); // exactly what Linear holds
    expect(ops()).toEqual(['IssueUpdate']); // no compensating writes
  });
  it('a rejected label write after the status moved: the same honest report', async () => {
    const { actions, spec, ops } = await setup({ fail: (op) => op === 'IssueAddLabel' });
    const e = await fail(actions.approve('ATL-15', 'ATL-15'));
    expect(e.message).toMatch(/status "Todo" with labels: Idea/);
    expect([spec('ATL-15').state, spec('ATL-15').labels]).toEqual(['Todo', ['Idea']]);
    expect(ops()).toEqual(['IssueUpdate', 'IssueAddLabel']);
  });
  it('a change Linear ignored is reported with the state Linear actually has', async () => {
    const { actions } = await setup({ silentNoop: (op) => op === 'IssueUpdate' });
    const e = await fail(actions.approve('ATL-15', 'ATL-15'));
    expect(e.code).toBe('verify-failed');
    expect(e.message).toMatch(/status "Backlog"/);
  });
  it('when Linear cannot be read back, it says the state is unknown instead of claiming anything', async () => {
    let down = false;
    const { actions } = await setup({ lostResponse: (op) => { if (op === 'IssueAddLabel') down = true; return false; } },
      (f) => (async (u: string | URL | Request, i?: RequestInit) => { if (down && /^\s*query/.test(JSON.parse(String(i?.body ?? '{}')).query ?? '')) throw new TypeError('fetch failed'); return f(u, i); }) as typeof fetch);
    const e = await fail(actions.approve('ATL-15', 'ATL-15'));
    expect(e.message).toMatch(/could not be read back, so the current state is unknown/);
  });
  it('an already-Ready issue only needs the status; its Ready label is never touched', async () => {
    const { actions, spec, ops } = await setup();
    spec('ATL-15').labels = ['Idea', 'Ready'];
    await actions.approve('ATL-15', 'ATL-15');
    expect(ops()).toEqual(['IssueUpdate']);
    expect(spec('ATL-15').labels).toEqual(['Idea', 'Ready']);
  });
  it('is stateless: a new instance (a restart) simply shows what Linear holds', async () => {
    const { actions, mk, spec } = await setup({ fail: (op) => op === 'IssueAddLabel' });
    await fail(actions.approve('ATL-15', 'ATL-15')); // left Todo without Ready
    const restarted = mk();
    const o = await restarted.options('ATL-15');
    expect(o.state.name).toBe('Todo');
    expect(o.labels.filter((l) => l.applied).map((l) => l.name)).toEqual(['Idea']);
    spec('ATL-15').labels = ['Idea', 'Ready']; // someone adds Ready in Linear itself
    expect((await restarted.options('ATL-15')).labels.filter((l) => l.applied).map((l) => l.name).sort()).toEqual(['Idea', 'Ready']);
  });
});

describe('revoke = remove Ready + Backlog in Linear, confirmed by a read-back', () => {
  it('a rejected label removal changes nothing and shows that Ready is still set', async () => {
    const { actions, spec, ops } = await setup({ fail: (op) => op === 'IssueRemoveLabel' });
    const e = await fail(actions.revoke('ATL-7', 'ATL-7'));
    expect(e.code).toBe('write-failed');
    expect(e.message).toMatch(/status "Todo" with labels: Ready, Feature/);
    expect([spec('ATL-7').state, spec('ATL-7').labels]).toEqual(['Todo', ['Ready', 'Feature']]);
    expect(ops()).toEqual(['IssueRemoveLabel']);
  });
  it('a lost reply after everything committed is confirmed by the read-back', async () => {
    const { actions, spec } = await setup({ lostResponse: (op) => op === 'IssueUpdate' });
    expect((await actions.revoke('ATL-7', 'ATL-7')).ok).toBe(true);
    expect([spec('ATL-7').state, spec('ATL-7').labels]).toEqual(['Backlog', ['Feature']]);
  });
});

describe('non-code tickets and GitHub: actions never depend on, or call, GitHub', () => {
  const githubCalls = () => { const urls: string[] = []; return { urls, wrap: (f: typeof fetch) => (async (u: string | URL | Request, i?: RequestInit) => { const h = new URL(String(u instanceof Request ? u.url : u)).hostname; if (h === 'api.github.com') urls.push(String(u)); return f(u, i); }) as typeof fetch }; };

  it('a ticket with no GitHub PR can be approved, started, completed, revoked and reopened', async () => {
    const gh = githubCalls();
    const { actions, service, spec } = await setup({}, gh.wrap);
    await service.get();
    gh.urls.length = 0; // from here on, only the actions themselves
    expect(service.peek()!.issues.find((i) => i.identifier === 'ATL-16')!.prKeys).toEqual([]); // documentation ticket: no PR
    expect((await actions.approve('ATL-17', 'ATL-17')).ok).toBe(true); // 'tbd' description, no PR
    expect((await actions.status('ATL-17', st('In Progress'))).ok).toBe(true);
    expect((await actions.status('ATL-17', st('Done'))).ok).toBe(true); // no merged PR needed
    expect(spec('ATL-17').state).toBe('Done');
    expect((await actions.status('ATL-16', st('Backlog'))).ok).toBe(true);
    expect((await actions.approve('ATL-16', 'ATL-16')).ok).toBe(true);
    expect((await actions.revoke('ATL-16', 'ATL-16')).ok).toBe(true);
    expect((await actions.status('ATL-17', st('Todo'))).ok).toBe(true); // reopen
    expect(gh.urls).toEqual([]); // these tickets have no PRs, so not even the post-action issue refresh touches GitHub
  });
  it('a merged PR is not required for Done, and an open PR does not block it either', async () => {
    const { actions, spec } = await setup();
    expect((await actions.status('ATL-3', st('Done'))).ok).toBe(true); // PR #3 is open with failing CI
    expect(spec('ATL-3').state).toBe('Done');
  });
  it('Ready stays protected from ordinary label edits (only Approve/Revoke change it)', async () => {
    const { actions, ops } = await setup();
    expect((await fail(actions.labels('ATL-16', ['lbl-ready'], []))).code).toBe('protected-label');
    expect((await fail(actions.labels('ATL-7', [], ['lbl-ready']))).code).toBe('protected-label');
    expect(ops()).toEqual([]);
  });
});

describe('GitHub display refresh ignores answers that are not this repository\'s PR (cached data kept)', () => {
  const prDetail = /\/repos\/demo-org\/atlas\/pulls\/3$/;
  const mutate = (fn: (r: any) => unknown) => (f: typeof fetch) => (async (u: string | URL | Request, i?: RequestInit) => {
    const url = new URL(String(u instanceof Request ? u.url : u));
    if (url.hostname === 'api.github.com' && prDetail.test(url.pathname)) {
      const real = await (await f(u, i)).json();
      return new Response(JSON.stringify(fn(real)), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return f(u, i);
  }) as typeof fetch;
  const titleAfterRefresh = async (fn: (r: any) => unknown) => {
    const { service } = await setup({}, mutate(fn));
    const snap = await service.getIssue('ATL-3', true);
    return snap!.prs.find((p) => p.key === 'demo-org/atlas#3')!.title;
  };
  const original = 'ATL-3 ingest pipeline';
  it('accepts a fresh answer for the right repository (case-insensitive)', async () => {
    expect(await titleAfterRefresh((r) => ({ ...r, title: 'ATL-3 renamed' }))).toBe('ATL-3 renamed');
    expect(await titleAfterRefresh((r) => ({ ...r, title: 'ATL-3 renamed', base: { ...r.base, repo: { full_name: 'DEMO-ORG/Atlas' } } }))).toBe('ATL-3 renamed');
  });
  const wrong: [string, (r: any) => unknown][] = [
    ['an empty object', () => ({})],
    ['another repository with the same number', (r) => ({ ...r, title: 'EVIL', base: { ...r.base, repo: { full_name: 'other-org/other-repo' } } })],
    ['no repository identity', (r) => ({ ...r, title: 'EVIL', base: { ref: 'main' } })],
    ['a different PR number', (r) => ({ ...r, title: 'EVIL', number: 999 })],
    ['merged_at set but merged: false', (r) => ({ ...r, title: 'EVIL', merged_at: '2026-05-01T00:00:00Z', merged: false })],
  ];
  for (const [name, fn] of wrong) it(`rejects ${name}`, async () => { expect(await titleAfterRefresh(fn)).toBe(original); });
});
