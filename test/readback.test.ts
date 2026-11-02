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
  it('is stateless: a new instance (a restart) just reads Linear; the Ready gate is Linear\'s Ready label', async () => {
    const { actions, mk, spec } = await setup({ fail: (op) => op === 'IssueAddLabel' });
    await fail(actions.approve('ATL-15', 'ATL-15')); // left Todo without Ready
    const restarted = mk();
    expect((await restarted.options('ATL-15')).states.find((s) => s.name === 'In Progress')).toMatchObject({ allowed: false });
    expect((await fail(restarted.status('ATL-15', st('In Progress')))).code).toBe('transition-refused');
    spec('ATL-15').labels = ['Idea', 'Ready']; // someone adds Ready in Linear itself
    expect((await restarted.status('ATL-15', st('In Progress'))).ok).toBe(true); // DevFlow follows Linear
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

describe('Done uses FRESH, valid GitHub evidence for the right repository', () => {
  type Mut = (real: any) => Response | any;
  const prDetail = /\/repos\/demo-org\/atlas\/pulls\/1$/;
  const broken = (mut: Mut | 'http500') => (f: typeof fetch) => (async (u: string | URL | Request, i?: RequestInit) => {
    const url = new URL(String(u instanceof Request ? u.url : u));
    if (url.hostname === 'api.github.com' && prDetail.test(url.pathname)) {
      if (mut === 'http500') return new Response('{"message":"boom"}', { status: 500 });
      const real = await (await f(u, i)).json();
      return new Response(JSON.stringify(mut(real)), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return f(u, i);
  }) as typeof fetch;
  const cases: [string, Mut | 'http500'][] = [
    ['an empty object ({})', () => ({})],
    ['HTTP 500', 'http500'],
    ['a different PR number', (r) => ({ ...r, number: 999 })],
    ['the same number in ANOTHER repository', (r) => ({ ...r, base: { ...r.base, repo: { full_name: 'other-org/other-repo' } } })],
    ['no repository identity at all', (r) => ({ ...r, base: { ref: r.base.ref } })],
    ['merged_at set but merged: false', (r) => ({ ...r, merged: false })],
    ['merged: true but no merged_at', (r) => ({ ...r, merged_at: null })],
  ];
  for (const [name, mut] of cases) {
    it(`${name}: cached "merged" is NOT enough and Linear is not changed`, async () => {
      const { actions, spec, service, ops } = await setup({}, broken(mut));
      spec('ATL-1').state = 'In Review';
      await service.get(true);
      expect(service.peek()!.prs.find((p) => p.key === 'demo-org/atlas#1')?.state).toBe('merged'); // cached, for display
      const e = await fail(actions.status('ATL-1', 'st-ATL-done'));
      expect(['evidence-unverified', 'http', 'invalid', 'network']).toContain(e.code);
      expect([spec('ATL-1').state, ops()]).toEqual(['In Review', []]);
    });
  }
  it('repository comparison ignores case, and valid fresh evidence still lets Done through', async () => {
    const { actions, spec, service } = await setup({}, broken((r) => ({ ...r, base: { ...r.base, repo: { full_name: 'DEMO-ORG/Atlas' } } })));
    spec('ATL-1').state = 'In Review';
    await service.get(true);
    expect((await actions.status('ATL-1', 'st-ATL-done')).ok).toBe(true);
  });
  it('the menu may use cached evidence for display, but the change itself re-verifies', async () => {
    const { actions, service, spec } = await setup({}, broken(() => ({})));
    spec('ATL-1').state = 'In Review';
    await service.get(true);
    expect((await actions.options('ATL-1')).states.find((s) => s.name === 'Done')?.allowed).toBe(true);
    expect((await fail(actions.status('ATL-1', 'st-ATL-done'))).code).toBe('evidence-unverified');
  });
  it('a fresh "not merged" answer still refuses', async () => {
    const { actions } = await setup();
    expect((await fail(actions.status('ATL-3', 'st-ATL-done'))).message).toMatch(/merged linked PR/);
  });
});
