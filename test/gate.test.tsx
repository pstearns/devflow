import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { Issue, MilestoneGate, Snapshot } from '../shared/types.ts';
import { SnapshotService } from '../server/service.ts';
import { demoConfig, demoFetch, DEMO_READ_KEY } from '../server/demo.ts';
import { computeGates } from '../server/gate.ts';
import { buildApp } from '../server/app.ts';
import { Overview } from '../web/src/views/Overview.tsx';
import { gatesInSel } from '../web/src/lib.ts';
import { makeAuth, signIn } from './helpers.ts';

const now = Date.parse('2026-06-01T12:00:00Z');
const noop = () => {};
const setup = async () => {
  const f = demoFetch(now);
  const service = new SnapshotService(demoConfig(), { linearKey: DEMO_READ_KEY, githubToken: 't', fetchImpl: f, mode: 'demo' }, () => now);
  return { f, service, snap: await service.get() };
};
const gate = (o: Partial<MilestoneGate>): MilestoneGate => ({ projectId: 'p', projectName: 'Proj', teamKey: 'ATL', state: 'executable', reason: 'why', deferred: [], pathTickets: ['ATL-7'], remaining: 1, ...o });
const html = (snap: Snapshot, gates: MilestoneGate[], sel = { team: '', project: 'all' }) =>
  renderToString(<Overview snap={{ ...snap, gates }} issues={snap.issues} sel={sel} go={noop} now={now} />);

describe('demo configuration carries a synthetic critical path', () => {
  it('Atlas: ATL-7 is the executable gate; deferred ATL-16 does not block. Beacon: link goes to the blocker BCN-2', async () => {
    const { snap } = await setup();
    const g = (id: string) => snap.gates.find((x) => x.projectId === id)!;
    expect(g('atlas')).toMatchObject({ state: 'executable', gate: 'ATL-7', advanceTicket: 'ATL-7', deferred: ['ATL-16'], remaining: 1 });
    expect(g('beacon')).toMatchObject({ state: 'blocked', gate: 'BCN-3', advanceTicket: 'BCN-2' });
    expect(snap.gates).toHaveLength(2); // projects without a path produce no gate at all
  });
});

describe('Next milestone blocker card renders', () => {
  const STATES: [MilestoneGate['state'], string, string | undefined][] = [
    ['blocked', 'Blocked', 'BCN-2'], ['needs-authorization', 'Needs authorization', 'ATL-17'], ['executable', 'Executable', 'ATL-7'],
    ['in-flight', 'In flight', 'ATL-3'], ['unknown', 'Unknown', undefined], ['clear', 'Clear', undefined],
  ];
  it.each(STATES)('%s: label, labelled region, and a ticket link only when one can advance the milestone', async (state, label, ticket) => {
    const { snap } = await setup();
    const out = html(snap, [gate({ state, advanceTicket: ticket, title: ticket ? 'Some title' : undefined })]);
    expect(out).toContain(`data-gate-state="${state}"`);
    expect(out).toContain('role="region"');
    expect(out).toContain('aria-label="Next milestone blocker, Proj"');
    expect(out).toContain(`>${label}</span>`);
    const linkRe = /<button[^>]*class="mono text-accent"[^>]*>([^<]*)<\/button>/g;
    const inCard = out.slice(out.indexOf('data-gate-state'), out.indexOf('Needs attention'));
    expect([...inCard.matchAll(linkRe)].map((m) => m[1])).toEqual(ticket ? [ticket] : []);
  });
  it('deferred obligations are listed separately, and a deferred-only path is Clear', async () => {
    const { snap } = await setup();
    const out = html(snap, [gate({ state: 'clear', deferred: ['ATL-8'], remaining: 0 })]);
    expect(out).toContain('Deferred, not blocking');
    expect(out).toContain('ATL-8');
    expect(out).toContain('path clear');
  });
  it('no gates, no card; other overview content is unaffected', async () => {
    const { snap } = await setup();
    const out = html(snap, []);
    expect(out).not.toContain('Next milestone blocker');
    expect(out).toContain('Needs attention');
  });
});

describe('selection scoping (no stale cards after switching team or project)', () => {
  const gs = [gate({ projectId: 'a', teamKey: 'ATL', pathTickets: ['ATL-7'] }), gate({ projectId: 'b', teamKey: 'BCN', pathTickets: ['BCN-3'] }), gate({ projectId: 'q', teamKey: 'QAT', pathTickets: ['QAT-99'] })];
  const ids = (sel: { team: string; project: string }, vis: string[]) => gatesInSel(gs, sel, vis.map((identifier) => ({ identifier }))).map((g) => g.projectId);
  it('all teams shows every path; a team shows only its own, even when its tickets are not loaded', () => {
    expect(ids({ team: '', project: 'all' }, [])).toEqual(['a', 'b', 'q']);
    expect(ids({ team: 'ATL', project: 'all' }, ['ATL-7'])).toEqual(['a']);
    expect(ids({ team: 'QAT', project: 'all' }, [])).toEqual(['q']);
    expect(ids({ team: 'ZED', project: 'all' }, [])).toEqual([]);
  });
  it('a project or "unprojected" shows only paths with a ticket inside it', () => {
    expect(ids({ team: 'ATL', project: 'lp-ATL' }, ['ATL-7'])).toEqual(['a']);
    expect(ids({ team: 'ATL', project: 'lp-ATL2' }, ['ATL-21'])).toEqual([]);
    expect(ids({ team: 'ATL', project: 'none' }, ['ATL-20'])).toEqual([]);
  });
});

describe('gate state transitions as the underlying ticket advances', () => {
  const mk = (id: string, o: Partial<Issue> = {}) => ({ identifier: id, title: `T ${id}`, state: { name: 'Todo', type: 'unstarted' }, openBlockers: [], awaitingHuman: [], stage: 'backlog', ...o }) as unknown as Issue;
  const proj = [{ id: 'p', name: 'P', linear: { teamKey: 'A', projects: [] }, criticalPath: [{ ticket: 'A-1', deferred: false }, { ticket: 'A-2', deferred: false }] }];
  const dep = { identifier: 'A-0', title: 'dep', stateName: 'Todo', stateType: 'unstarted', resolved: false };
  it('walks blocked → needs-authorization → executable → in-flight → next gate → clear', () => {
    const at = (a1: Issue, a2 = mk('A-2')) => computeGates(proj, [a1, a2])[0]!;
    expect(at(mk('A-1', { openBlockers: [dep] as never }))).toMatchObject({ state: 'blocked', advanceTicket: 'A-0' });
    expect(at(mk('A-1'))).toMatchObject({ state: 'needs-authorization', advanceTicket: 'A-1' });
    expect(at(mk('A-1', { stage: 'ready' }))).toMatchObject({ state: 'executable', advanceTicket: 'A-1' });
    expect(at(mk('A-1', { stage: 'review', state: { name: 'In Review', type: 'started' } as never, awaitingHuman: ['Merge decision on PR #1'] }))).toMatchObject({ state: 'in-flight', advanceTicket: 'A-1' });
    const done = (id: string) => mk(id, { stage: 'done', state: { name: 'Done', type: 'completed' } as never });
    expect(at(done('A-1'))).toMatchObject({ state: 'needs-authorization', gate: 'A-2', remaining: 1 });
    expect(at(done('A-1'), done('A-2'))).toMatchObject({ state: 'clear', remaining: 0 });
    expect(at(mk('A-1', { state: { name: 'Canceled', type: 'canceled' } as never }), done('A-2'))).toMatchObject({ state: 'clear' });
  });
  it('a Linear "blocked" marker with no relation is a blocker pointing at the gate itself', () => {
    expect(computeGates(proj, [mk('A-1', { blockedMarker: 'Linear label "blocked"' }), mk('A-2')])[0]).toMatchObject({ state: 'blocked', advanceTicket: 'A-1' });
  });
});

describe('authorization boundary: the card is informational only', () => {
  it('building the snapshot sends no Linear mutation, and "executable" is never reported without real Ready authorization', async () => {
    const { f, snap } = await setup();
    expect(f.store.mutations).toEqual([]);
    // property over every demo ticket: a single-ticket path is executable iff DevFlow's own readiness says the ticket is Ready and unblocked
    for (const i of snap.issues.filter((x) => x.state.type !== 'completed' && x.state.type !== 'canceled')) {
      const g = computeGates([{ id: 'x', name: 'x', linear: undefined, criticalPath: [{ ticket: i.identifier, deferred: false }] }], snap.issues)[0]!;
      expect(g.state === 'executable', i.identifier).toBe(i.stage === 'ready' && i.openBlockers.length === 0 && !i.blockedMarker);
    }
    // an unauthorized, unblocked ticket is "needs authorization": the card never presents it as executable
    expect(snap.issues.find((i) => i.identifier === 'ATL-16')!.stage).toBe('backlog');
  });
  it('the API exposes gates read-only: no route accepts writes for them, and normal actions still go through their own checks', async () => {
    const { service, f } = await setup();
    const { auth, password } = await makeAuth();
    const app = await buildApp(service, { distDir: '/none', auth });
    const s = await signIn(app, password);
    const snap = (await s.get('/api/snapshot')).json() as Snapshot;
    expect(snap.gates.length).toBe(2);
    for (const url of ['/api/gates', '/api/gate', '/api/snapshot', '/api/actions/gate']) {
      const r = await s.post(url, { ticket: 'ATL-7', state: 'executable' });
      expect([400, 403, 404, 405]).toContain(r.statusCode);
    }
    expect(f.store.mutations).toEqual([]);
    expect(f.store.issues.ATL!.find((x) => x.n === 16)!.labels).not.toContain('Ready'); // nothing was approved or relabelled
  });
});
