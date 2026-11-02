// Ambiguous Linear outcomes (a mutation that commits but whose response is lost) and fresh-evidence rules.
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
  return { f0, service, actions: mk(), mk, spec, ops: () => f0.store.mutations.map((m) => m.op), comments: (id: string) => (f0.store.comments.get(id) ?? []).map((c) => c.body) };
}

describe('approval: ambiguous outcomes are resolved from Linear, not from the replies', () => {
  it('commit-then-timeout on the label write: the committed Ready label and state are really reverted and verified', async () => {
    const { actions, spec, ops } = await setup({ lostResponse: (op) => op === 'IssueAddLabel' });
    const e = await fail(actions.approve('ATL-15', 'ATL-15'));
    expect(e.code).toBe('write-failed');
    expect(e.message).toMatch(/rolled back and verified/);
    expect(spec('ATL-15').state).toBe('Backlog');
    expect(spec('ATL-15').labels).toEqual(['Idea']); // Ready is gone, the unrelated label is untouched
    expect(ops()).toContain('IssueRemoveLabel');
  });
  it('commit-then-timeout on the status write (first step)', async () => {
    const { actions, spec } = await setup({ lostResponse: (op) => op === 'IssueUpdate' });
    const e = await fail(actions.approve('ATL-15', 'ATL-15'));
    expect(e.code).toBe('write-failed');
    expect(e.message).toMatch(/rolled back and verified/);
    expect([spec('ATL-15').state, spec('ATL-15').labels]).toEqual(['Backlog', ['Idea']]);
  });
  it('commit-then-timeout on the evidence comment: Linear holds the complete approval, so it is reported as approved (verified), not rolled back', async () => {
    const { actions, spec } = await setup({ lostResponse: (op) => op === 'CommentCreate' });
    const r = await actions.approve('ATL-15', 'ATL-15');
    expect(r.verified).toBe(true);
    expect([spec('ATL-15').state, spec('ATL-15').labels]).toEqual(['Todo', ['Idea', 'Ready']]);
  });
  it('partial mutation: the label write is rejected after the status moved; status goes back', async () => {
    const { actions, spec } = await setup({ fail: (op) => op === 'IssueAddLabel' });
    expect((await fail(actions.approve('ATL-15', 'ATL-15'))).code).toBe('write-failed');
    expect([spec('ATL-15').state, spec('ATL-15').labels]).toEqual(['Backlog', ['Idea']]);
  });
  it('a pre-existing Ready label is preserved by rollback (and so is every other label)', async () => {
    const { actions, spec } = await setup({ fail: (op) => op === 'CommentCreate' });
    spec('ATL-15').labels = ['Idea', 'Ready']; // already Ready while still in Backlog
    const e = await fail(actions.approve('ATL-15', 'ATL-15'));
    expect(e.message).toMatch(/kept as it was/);
    expect([spec('ATL-15').state, spec('ATL-15').labels]).toEqual(['Backlog', ['Idea', 'Ready']]);
  });
  it('a rolled-back approval never counts as success and does not block later ordinary work', async () => {
    const { actions, spec } = await setup({ fail: (op) => op === 'CommentCreate' });
    await fail(actions.approve('ATL-15', 'ATL-15'));
    expect((await actions.options('ATL-15')).states.find((s) => s.name === 'In Progress')?.reason).toMatch(/approval/); // still needs a real approval
    expect((await actions.status('ATL-15', st('Todo'))).ok).toBe(true);
    expect(spec('ATL-15').labels).not.toContain('Ready');
  });
});

describe('approval: failed or unprovable compensation fails closed', () => {
  // comment fails, and after the first status write every further status/label change is rejected: Ready + Todo is left behind
  const stuck = (): FakeLinearOpts => { let updates = 0; return { fail: (op) => op === 'CommentCreate' || (op === 'IssueUpdate' && ++updates > 1) || op === 'IssueRemoveLabel' }; };

  it('reports manual intervention (never "rolled back") when the restore cannot be verified', async () => {
    const { actions, spec } = await setup(stuck());
    const e = await fail(actions.approve('ATL-15', 'ATL-15'));
    expect(e.code).toBe('manual-intervention');
    expect(e.message).toMatch(/Manual intervention required/);
    expect(e.message).not.toMatch(/rolled back and verified/);
    expect([spec('ATL-15').state, spec('ATL-15').labels]).toEqual(['Todo', ['Idea', 'Ready']]); // really left half-applied
  });
  it('the half-applied issue cannot be started through ordinary status changes, and cannot be re-approved', async () => {
    const { actions } = await setup(stuck());
    await fail(actions.approve('ATL-15', 'ATL-15'));
    const o = await actions.options('ATL-15');
    expect(o.states.find((s) => s.name === 'In Progress')).toMatchObject({ allowed: false, reason: expect.stringMatching(/did not complete cleanly/) });
    expect((await fail(actions.status('ATL-15', st('In Progress')))).code).toBe('transition-refused');
    expect((await fail(actions.approve('ATL-15', 'ATL-15'))).code).toBe('manual-intervention');
  });
  it('the block survives a restart when the marker comment could be written (durable in Linear)', async () => {
    let updates = 0, comments = 0;
    const { actions, mk, comments: bodies } = await setup({ fail: (op) => (op === 'CommentCreate' && ++comments === 1) || (op === 'IssueUpdate' && ++updates > 1) || op === 'IssueRemoveLabel' });
    await fail(actions.approve('ATL-15', 'ATL-15'));
    expect(bodies('ATL-15').some((b) => b.includes('devflow-approval-incomplete:'))).toBe(true);
    const restarted = mk(); // new process: no in-memory state
    expect((await fail(restarted.status('ATL-15', st('In Progress')))).code).toBe('transition-refused');
  });
  it('removing Ready (revoke) clears the block', async () => {
    let fixed = false, updates = 0;
    const { actions, spec } = await setup({ fail: (op) => !fixed && (op === 'CommentCreate' || (op === 'IssueUpdate' && ++updates > 1) || op === 'IssueRemoveLabel') });
    await fail(actions.approve('ATL-15', 'ATL-15'));
    fixed = true; // Linear is healthy again
    await actions.revoke('ATL-15', 'ATL-15', 'cleanup');
    expect([spec('ATL-15').state, spec('ATL-15').labels]).toEqual(['Backlog', ['Idea']]);
    expect((await actions.approve('ATL-15', 'ATL-15')).ok).toBe(true);
  });
  it('when Linear cannot be read after the failure, recovery is not claimed', async () => {
    let down = false;
    const { actions } = await setup({ lostResponse: (op) => { if (op === 'IssueAddLabel') down = true; return op === 'IssueAddLabel'; } },
      (f) => (async (u: string | URL | Request, i?: RequestInit) => { if (down && /^\s*query/.test(String(i?.body ? JSON.parse(String(i.body)).query : ''))) throw new TypeError('fetch failed'); return f(u, i); }) as typeof fetch);
    const e = await fail(actions.approve('ATL-15', 'ATL-15'));
    expect(e.code).toBe('manual-intervention');
  });
});

describe('Done requires FRESH, valid GitHub evidence', () => {
  const prDetail = /\/repos\/demo-org\/atlas\/pulls\/1(\?|$)/;
  const brokenPrDetail = (mode: '200-empty' | '500' | 'wrong-pr') => (f: typeof fetch) => (async (u: string | URL | Request, i?: RequestInit) => {
    const url = String(u instanceof Request ? u.url : u);
    if (new URL(url).hostname === 'api.github.com' && prDetail.test(new URL(url).pathname)) {
      if (mode === '200-empty') return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      if (mode === '500') return new Response('{"message":"boom"}', { status: 500 });
      const real = await (await f(u, i)).json(); return new Response(JSON.stringify({ ...real, number: 999 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return f(u, i);
  }) as typeof fetch;

  for (const mode of ['200-empty', '500', 'wrong-pr'] as const) {
    it(`GitHub PR detail ${mode}: cached "merged" is NOT enough; Linear is not changed`, async () => {
      const { actions, spec, service, ops } = await setup({}, brokenPrDetail(mode));
      spec('ATL-1').state = 'In Review';
      await service.get(true);
      expect(service.peek()!.prs.find((p) => p.key === 'demo-org/atlas#1')?.state).toBe('merged'); // the cache says merged (display)
      const e = await fail(actions.status('ATL-1', 'st-ATL-done'));
      expect(['evidence-unverified', 'http', 'invalid', 'network']).toContain(e.code);
      expect(spec('ATL-1').state).toBe('In Review');
      expect(ops()).toEqual([]);
    });
  }
  it('the menu may still use cached evidence for display, but the change itself re-verifies', async () => {
    const { actions, service, spec } = await setup({}, brokenPrDetail('200-empty'));
    spec('ATL-1').state = 'In Review';
    await service.get(true);
    expect((await actions.options('ATL-1')).states.find((s) => s.name === 'Done')?.allowed).toBe(true);
    expect((await fail(actions.status('ATL-1', 'st-ATL-done'))).code).toBe('evidence-unverified');
  });
  it('valid fresh evidence still works, and a fresh "not merged" answer still refuses', async () => {
    const ok = await setup();
    ok.spec('ATL-1').state = 'In Review'; await ok.service.get(true);
    expect((await ok.actions.status('ATL-1', 'st-ATL-done')).ok).toBe(true);
    const no = await setup();
    expect((await fail(no.actions.status('ATL-3', 'st-ATL-done'))).message).toMatch(/merged linked PR/);
  });
});
