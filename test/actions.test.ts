import { describe, expect, it } from 'vitest';
import { SnapshotService } from '../server/service.ts';
import { demoConfig, demoFetch, DEMO_READ_KEY, DEMO_WRITE_KEY } from '../server/demo.ts';
import type { FakeLinearOpts } from '../server/demo-linear.ts';
import { LinearClient } from '../server/linear.ts';
import { LinearWriteClient } from '../server/linear-write.ts';
import { ActionError, LinearActions, evaluateApproval, parseCtx, statusOptions } from '../server/actions.ts';
import { buildApp } from '../server/app.ts';
import { DEFAULT_WORKFLOW } from '../server/config.ts';

const now = Date.parse('2026-06-01T12:00:00Z');

async function setup(opts: FakeLinearOpts = {}, writeEnabled = true) {
  const f = demoFetch(now, opts);
  const cfg = demoConfig();
  const service = new SnapshotService(cfg, { linearKey: DEMO_READ_KEY, githubToken: 't', fetchImpl: f, mode: 'demo' }, () => now);
  service.setWriteInfo(writeEnabled ? { enabled: true } : { enabled: false, reason: 'Linear write access is not configured' });
  await service.get();
  const logs: string[] = [];
  const actions = new LinearActions({ cfg, read: new LinearClient(DEMO_READ_KEY, f), write: writeEnabled ? new LinearWriteClient(DEMO_WRITE_KEY, f) : undefined, service, csrf: 'csrf-token-1', log: (l) => logs.push(l), clock: () => now });
  const spec = (id: string) => { const [t, n] = id.split('-') as [string, string]; return f.store.issues[t!]!.find((x) => x.n === Number(n))!; };
  const ops = () => f.store.mutations.map((m) => m.op);
  return { f, service, actions, spec, ops, logs, cfg };
}
const fail = async (p: Promise<unknown>) => (await p.then(() => { throw new Error('expected rejection'); }, (e) => e)) as ActionError;
const OK_SCOPE = { policy: 'project' as const, explicitPolicy: true, writeAllowed: true };
const LBL = { ready: 'lbl-ready', security: 'lbl-security', feature: 'lbl-feature', bug: 'lbl-bug', area: 'lbl-area', design: 'lbl-newcustom', idea: 'lbl-idea' };

describe('credential separation', () => {
  it('the read key can never mutate; the write client only sends allowlisted operations', async () => {
    const { f } = await setup();
    const r = await f('https://api.linear.app/graphql', { method: 'POST', headers: { authorization: DEMO_READ_KEY }, body: JSON.stringify({ query: 'mutation IssueAddLabel($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }', variables: { id: 'uuid-ATL-3', labelId: 'lbl-bug' } }) });
    expect(r.status).toBe(403);
    expect(f.store.issues.ATL!.find((x) => x.n === 3)!.labels).toEqual(['Feature']);
    const w = new LinearWriteClient(DEMO_WRITE_KEY, f);
    await expect(w.addLabel('bad id!', 'lbl-bug')).rejects.toThrow(); // ids are validated
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(w)).sort()).toEqual(['addLabel', 'comment', 'constructor', 'id', 'removeLabel', 'run', 'setMilestone', 'setState', 'viewerName'].sort()); // no generic send / delete
  });
  it('write stays disabled without a write credential', async () => {
    const { actions, ops } = await setup({}, false);
    const o = await actions.options('ATL-16');
    expect(o.writeEnabled).toBe(false);
    expect(o.labels.every((l) => !l.editable)).toBe(true);
    expect(o.states.every((s) => !s.allowed)).toBe(true);
    expect((await fail(actions.labels('ATL-16', [LBL.security], []))).code).toBe('write-disabled');
    expect((await fail(actions.approve('ATL-16', 'ATL-16'))).code).toBe('write-disabled');
    expect(ops()).toEqual([]);
  });
});

describe('labels', () => {
  it('lists live labels and marks protected / group labels as not editable', async () => {
    const { actions } = await setup();
    const o = await actions.options('ATL-3');
    const by = (n: string) => o.labels.find((l) => l.name === n)!;
    expect(by('Feature')).toMatchObject({ applied: true, editable: true, color: '#4CB782', scope: 'workspace', classification: true });
    expect(by('Ready')).toMatchObject({ editable: false, reason: expect.stringMatching(/Protected/) });
    expect(o.labels.find((l) => l.name === 'Area')).toBeUndefined(); // group labels cannot be applied, so they are not offered
    expect(by('Needs Design')).toMatchObject({ editable: true, applied: false }); // unknown/new label: no code change needed
  });
  it('adds and removes labels while preserving unrelated ones, using atomic add/remove (never replacing the set)', async () => {
    const { actions, spec, ops } = await setup();
    spec('ATL-3').labels = ['Feature', 'Needs Design'];
    const r = await actions.labels('ATL-3', [LBL.security], [LBL.design]);
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(spec('ATL-3').labels).toEqual(['Feature', 'Security']); // Feature untouched
    expect(ops()).toEqual(['IssueAddLabel', 'IssueRemoveLabel']);
    expect(r.snapshot.issues.find((i) => i.identifier === 'ATL-3')!.labels.map((l) => l.name)).toEqual(['Feature', 'Security']);
  });
  it('refuses protected, group, unknown, not-applied and conflicting label requests without mutating', async () => {
    const { actions, ops } = await setup();
    expect((await fail(actions.labels('ATL-16', [LBL.ready], []))).code).toBe('protected-label');
    expect((await fail(actions.labels('ATL-7', [], [LBL.ready]))).code).toBe('protected-label'); // cannot revoke via ordinary labels
    expect((await fail(actions.labels('ATL-3', [LBL.area], []))).code).toBe('group-label');
    expect((await fail(actions.labels('ATL-3', ['lbl-nonexistent'], []))).code).toBe('unknown-label');
    expect((await fail(actions.labels('ATL-3', [], [LBL.bug]))).code).toBe('not-applied');
    expect((await fail(actions.labels('ATL-3', [LBL.bug], [LBL.bug]))).code).toBe('bad-input');
    expect((await fail(actions.labels('ATL-3', [], []))).code).toBe('bad-input');
    expect((await fail(actions.labels('ATL-3', ['x; DROP'], []))).code).toBe('bad-input');
    expect(ops()).toEqual([]);
  });
  it('verifies the result: a write Linear silently ignored is reported, not claimed', async () => {
    const { actions } = await setup({ silentNoop: (op) => op === 'IssueAddLabel' });
    expect((await fail(actions.labels('ATL-3', [LBL.security], []))).code).toBe('verify-failed');
  });
});

describe('approval eligibility (pure policy)', () => {
  it('every unverifiable prerequisite is a failed check', async () => {
    const { actions } = await setup();
    expect((await actions.options('ATL-16')).approve).toMatchObject({ eligible: true, already: false, todoState: 'Todo' });
    expect((await actions.options('ATL-15')).approve.eligible).toBe(true); // backlog issue with a description
    const short = (await actions.options('ATL-17')).approve; // description 'tbd'
    expect(short.eligible).toBe(false);
    expect(short.checks.find((c) => c.id === 'description')).toMatchObject({ ok: false });
    const blocked = (await actions.options('ATL-18')).approve;
    expect(blocked.eligible).toBe(false);
    expect(blocked.checks.find((c) => c.id === 'deps')!.detail).toMatch(/ATL-3 \(In Progress\)/);
    expect((await actions.options('ATL-3')).approve.eligible).toBe(false); // already started
    expect((await actions.options('ATL-7')).approve).toMatchObject({ eligible: false, already: true });
  });
  it('honours per-project policy and missing prerequisites', () => {
    const base = { id: 'u', identifier: 'ABC-1', title: 't', description: 'x'.repeat(60), priority: 0, state: { id: 's1', name: 'Backlog', type: 'backlog' as const }, teamKey: 'ABC',
      states: [{ id: 's1', name: 'Backlog', type: 'backlog' as const, position: 0 }, { id: 's2', name: 'Todo', type: 'unstarted' as const, position: 1 }],
      labels: [], milestones: [], openBlockers: [], depsVerifiable: true, comments: [], teamLabels: [{ id: 'r', name: 'Ready', color: '#fff', isGroup: false, scope: 'team' as const }] };
    expect(evaluateApproval(base, DEFAULT_WORKFLOW, true, OK_SCOPE).eligible).toBe(true);
    const strict = { ...DEFAULT_WORKFLOW, readiness: { ...DEFAULT_WORKFLOW.readiness, requireMilestone: true, requirePriority: true, requireClassificationLabel: true } };
    expect(evaluateApproval(base, strict, true, OK_SCOPE).checks.filter((c) => !c.ok).map((c) => c.id).sort()).toEqual(['classification', 'milestone', 'priority']);
    expect(evaluateApproval({ ...base, teamLabels: [] }, DEFAULT_WORKFLOW, true, OK_SCOPE).checks.find((c) => c.id === 'ready-label')!.ok).toBe(false); // label missing: DevFlow does not create labels
    expect(evaluateApproval({ ...base, depsVerifiable: false }, DEFAULT_WORKFLOW, true, OK_SCOPE).eligible).toBe(false); // cannot verify dependencies
    expect(evaluateApproval({ ...base, states: [base.states[0]!] }, DEFAULT_WORKFLOW, true, OK_SCOPE).checks.find((c) => c.id === 'todo-state')!.ok).toBe(false);
    expect(parseCtx({ issue: { id: 'x' } }, [])).toBeUndefined(); // malformed live data is not trusted
  });
});

describe('approve for execution', () => {
  it('requires explicit confirmation (typed identifier) and changes nothing without it', async () => {
    const { actions, ops } = await setup();
    for (const bad of [undefined, true, '', 'ATL-17', 'yes']) expect((await fail(actions.approve('ATL-15', bad))).code).toBe('not-confirmed');
    expect(ops()).toEqual([]);
  });
  it('refuses ineligible tickets with the failed checks and mutates nothing', async () => {
    const { actions, ops } = await setup();
    for (const id of ['ATL-17', 'ATL-18', 'ATL-3', 'ATL-7', 'ATL-12']) {
      const e = await fail(actions.approve(id, id));
      expect([e.code, e.status]).toEqual(['ineligible', 422]);
      expect(e.checks!.some((c) => !c.ok)).toBe(true);
    }
    expect(ops()).toEqual([]);
  });
  it('moves to Todo + Ready, records owner approval evidence, then re-reads and verifies', async () => {
    const { actions, spec, ops, f, logs } = await setup();
    const r = await actions.approve('ATL-15', 'atl-15'); // case-insensitive confirmation
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(spec('ATL-15').state).toBe('Todo');
    expect(spec('ATL-15').labels).toContain('Ready');
    expect(spec('ATL-15').labels).toContain('Idea'); // unrelated label preserved
    expect(ops()).toEqual(['Viewer'.replace('Viewer', 'IssueUpdate'), 'IssueAddLabel', 'CommentCreate']);
    const note = f.store.comments.get('ATL-15')![0]!.body;
    expect(note).toMatch(/Approved for execution/);
    expect(note).toMatch(/Approved by: Demo Owner/);
    expect(note).toMatch(/devflow-approval:/);
    expect(r.snapshot.issues.find((i) => i.identifier === 'ATL-15')!.stage).toBe('ready'); // classification derived from the verified Linear state
    expect(logs.join('\n')).not.toMatch(new RegExp(DEMO_WRITE_KEY)); // credentials never logged
    expect(logs).toEqual(['action=approve issue=ATL-15 outcome=ok']);
  });
  it('rolls back when a step fails (no Ready without evidence)', async () => {
    const { actions, spec } = await setup({ fail: (op) => op === 'CommentCreate' });
    const e = await fail(actions.approve('ATL-15', 'ATL-15'));
    expect(e.code).toBe('write-failed');
    expect(e.message).toMatch(/rolled back/);
    expect(spec('ATL-15').state).toBe('Backlog');
    expect(spec('ATL-15').labels).not.toContain('Ready');
  });
  it('rolls back when the label write fails after the state change', async () => {
    const { actions, spec } = await setup({ fail: (op) => op === 'IssueAddLabel' });
    expect((await fail(actions.approve('ATL-15', 'ATL-15'))).code).toBe('write-failed');
    expect(spec('ATL-15').state).toBe('Backlog');
  });
  it('detects a missing evidence comment during read-back and rolls the approval back', async () => {
    const { actions, spec } = await setup({ silentNoop: (op) => op === 'CommentCreate' });
    const e = await fail(actions.approve('ATL-15', 'ATL-15'));
    expect(e.code).toBe('verify-failed');
    expect(e.message).toMatch(/rolled back/);
    expect(spec('ATL-15').labels).not.toContain('Ready');
    expect(spec('ATL-15').state).toBe('Backlog');
  });
  it('detects a state change Linear ignored', async () => {
    const { actions } = await setup({ silentNoop: (op) => op === 'IssueUpdate' });
    expect((await fail(actions.approve('ATL-15', 'ATL-15'))).code).toBe('verify-failed');
  });
  it('serializes concurrent writes so two approvals never interleave', async () => {
    const { actions, ops } = await setup();
    await Promise.all([actions.approve('ATL-15', 'ATL-15'), actions.approve('ATL-19', 'ATL-19')]);
    expect(ops()).toEqual(['IssueUpdate', 'IssueAddLabel', 'CommentCreate', 'IssueUpdate', 'IssueAddLabel', 'CommentCreate']);
  });
});

describe('revoke readiness', () => {
  it('removes Ready, returns the issue to Backlog and records evidence, verified', async () => {
    const { actions, spec, f } = await setup();
    const r = await actions.revoke('ATL-7', 'ATL-7', 'Scope changed <!-- x -->');
    expect(r.ok).toBe(true);
    expect(spec('ATL-7').labels).toEqual(['Feature']);
    expect(spec('ATL-7').state).toBe('Backlog');
    const note = f.store.comments.get('ATL-7')![0]!.body;
    expect(note).toMatch(/Readiness revoked/);
    expect(note).toMatch(/Reason: Scope changed/);
    expect(note).not.toMatch(/<!-- x -->/); // reason is sanitized; only our own marker comment remains
    expect(r.snapshot.issues.find((i) => i.identifier === 'ATL-7')!.stage).toBe('backlog');
  });
  it('is refused for issues that are not Ready or already started, and needs confirmation', async () => {
    const { actions, ops, spec } = await setup();
    expect((await fail(actions.revoke('ATL-16', 'ATL-16', ''))).code).toBe('not-ready');
    expect((await fail(actions.revoke('ATL-7', 'nope', ''))).code).toBe('not-confirmed');
    spec('ATL-6').state = 'In Progress'; // Ready label but work started
    expect((await fail(actions.revoke('ATL-6', 'ATL-6', ''))).code).toBe('started');
    expect(ops()).toEqual([]);
  });
});

describe('workflow status changes', () => {
  it('cannot bypass approval or completion requirements', async () => {
    const { actions, ops, spec } = await setup();
    const id = (team: string, name: string) => `st-${team}-${name.toLowerCase().replace(/\W+/g, '-')}`;
    expect((await fail(actions.status('ATL-15', id('ATL', 'In Progress')))).message).toMatch(/requires approval/); // backlog -> started without Ready
    expect((await fail(actions.status('ATL-16', id('ATL', 'In Progress')))).code).toBe('transition-refused'); // Todo but not Ready
    expect((await fail(actions.status('ATL-3', id('ATL', 'Done')))).message).toMatch(/merged linked PR/); // PR #3 not merged
    expect((await fail(actions.status('ATL-3', id('ATL', 'Canceled')))).code).toBe('transition-refused');
    expect((await fail(actions.status('ATL-7', id('ATL', 'Backlog')))).message).toMatch(/Revoke readiness/); // Ready issue cannot be dropped to backlog silently
    expect((await fail(actions.status('ATL-2', id('ATL', 'In Progress')))).message).toMatch(/reopened in Linear/);
    expect((await fail(actions.status('ATL-3', 'st-ATL-bogus'))).code).toBe('unknown-state');
    expect((await fail(actions.status('ATL-3', 'bad id'))).code).toBe('bad-input');
    expect(ops()).toEqual([]);
    expect(spec('ATL-3').state).toBe('In Progress');
  });
  it('allows legitimate transitions and verifies them', async () => {
    const { actions, spec } = await setup();
    const id = (name: string) => `st-ATL-${name.toLowerCase().replace(/\W+/g, '-')}`;
    expect((await actions.status('ATL-3', id('In Review'))).ok).toBe(true); // started -> started
    expect(spec('ATL-3').state).toBe('In Review');
    expect((await actions.status('ATL-7', id('In Progress'))).ok).toBe(true); // Ready (approved) -> start work
    expect((await actions.status('ATL-15', id('Todo'))).ok).toBe(true); // Todo alone does not authorize execution
    expect(spec('ATL-15').labels).not.toContain('Ready');
  });
  it('allows Done only with a merged linked PR verified from GitHub', async () => {
    const { actions, spec, service } = await setup();
    spec('ATL-1').state = 'In Review'; // PR #1 for ATL-1 is merged in the GitHub fixtures
    await service.get(true);
    expect((await actions.status('ATL-1', 'st-ATL-done')).ok).toBe(true);
    expect(spec('ATL-1').state).toBe('Done');
  });
  it('options explain every disabled transition', async () => {
    const { actions } = await setup();
    const o = await actions.options('ATL-15');
    const s = (n: string) => o.states.find((x) => x.name === n)!;
    expect(s('In Progress')).toMatchObject({ allowed: false, reason: expect.stringMatching(/approval/) });
    expect(s('Done').reason).toMatch(/merged/);
    expect(s('Backlog')).toMatchObject({ current: true, allowed: false });
    expect(statusOptions({ ...parseCtx({ issue: { id: 'i', identifier: 'ABC-1', state: { id: 'a', type: 'started', name: 'S' }, team: { key: 'ABC', states: { nodes: [] } } } }, [])!, states: [] }, DEFAULT_WORKFLOW, false, true)).toEqual([]);
  });
});

describe('milestones', () => {
  it('assigns and removes milestones, validated against the issue\'s own project', async () => {
    const { actions, spec } = await setup();
    expect((await actions.milestone('ATL-15', 'm1')).ok).toBe(true);
    expect(spec('ATL-15').ms).toBe('m1');
    expect((await fail(actions.milestone('ATL-15', 'm1'))).code).toBe('no-change');
    expect((await fail(actions.milestone('ATL-15', 'b1'))).code).toBe('foreign-milestone'); // BCN's milestone
    expect((await fail(actions.milestone('ATL-15', 'nope'))).code).toBe('foreign-milestone');
    expect((await actions.milestone('ATL-15', null)).ok).toBe(true);
    expect(spec('ATL-15').ms).toBeUndefined();
  });
  it('verifies that Linear applied the milestone', async () => {
    const { actions } = await setup({ silentNoop: (op) => op === 'IssueUpdate' });
    expect((await fail(actions.milestone('ATL-15', 'm2'))).code).toBe('verify-failed');
  });
});

describe('failures and bad input', () => {
  it('maps Linear failures to controlled errors', async () => {
    const { actions } = await setup({ fail: (op) => op === 'IssueAddLabel' });
    const e = await fail(actions.labels('ATL-3', [LBL.security], []));
    expect([e.status, e.message]).toEqual([502, 'Linear GraphQL error (INTERNAL_SERVER_ERROR)']);
  });
  it('rejects unknown, malformed and out-of-project issues', async () => {
    const { actions } = await setup();
    expect((await fail(actions.options('ZZZ-1'))).code).toBe('not-found');
    expect((await fail(actions.options('not valid'))).code).toBe('bad-identifier');
    expect((await fail(actions.options('ATL-9999'))).code).toBe('not-found');
  });
});

describe('HTTP security boundary', () => {
  async function web() {
    const s = await setup();
    const app = await buildApp(s.service, { distDir: '/none', actions: s.actions });
    const good = { host: 'localhost:4317', origin: 'http://localhost:4317', 'content-type': 'application/json', 'x-devflow-csrf': 'csrf-token-1', 'sec-fetch-site': 'same-origin' };
    const post = (kind: string, body: unknown, headers: Record<string, string> = good) => app.inject({ method: 'POST', url: `/api/actions/${kind}`, headers, payload: JSON.stringify(body) });
    return { ...s, app, good, post };
  }
  it('accepts a same-origin JSON request with the CSRF token', async () => {
    const { post, spec } = await web();
    const r = await post('labels', { identifier: 'ATL-3', add: [LBL.security], remove: [] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, verified: true });
    expect(spec('ATL-3').labels).toContain('Security');
    expect(r.payload).not.toContain(DEMO_WRITE_KEY);
  });
  it('rejects cross-origin, missing/forged CSRF token, form posts, bad hosts and oversize bodies', async () => {
    const { post, ops, good, app } = await web();
    const body = { identifier: 'ATL-3', add: [LBL.security], remove: [] };
    const { origin: _o, ...noOrigin } = good;
    expect((await post('labels', body, noOrigin)).statusCode).toBe(403);
    expect((await post('labels', body, { ...good, origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await post('labels', body, { ...good, origin: 'https://localhost:4317' })).statusCode).toBe(403);
    expect((await post('labels', body, { ...good, 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await post('labels', body, { ...good, 'x-devflow-csrf': 'wrong' })).statusCode).toBe(403);
    const { 'x-devflow-csrf': _c, ...noCsrf } = good;
    expect((await post('labels', body, noCsrf)).statusCode).toBe(403);
    expect((await post('labels', body, { ...good, 'content-type': 'application/x-www-form-urlencoded' })).statusCode).toBe(415);
    expect((await post('labels', body, { ...good, host: 'evil.example', origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/actions/labels', headers: good, payload: JSON.stringify({ identifier: 'ATL-3', pad: 'x'.repeat(20000) }) })).statusCode).toBe(413);
    expect((await app.inject({ method: 'POST', url: '/api/actions/labels', headers: good, payload: '[1,2]' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/actions/labels', headers: good, payload: '{bad json' })).statusCode).toBe(400);
    expect(ops()).toEqual([]);
  });
  it('POST is accepted only under /api/actions; other verbs and unknown actions are refused', async () => {
    const { app, good, post } = await web();
    for (const url of ['/api/snapshot', '/api/issue/ATL-3', '/api/issue-actions/ATL-3', '/', '/api/actions']) expect((await app.inject({ method: 'POST', url, headers: good, payload: '{}' })).statusCode, url).toBe(405);
    for (const method of ['PUT', 'DELETE', 'PATCH'] as const) expect((await app.inject({ method, url: '/api/actions/labels', headers: good, payload: '{}' })).statusCode).toBe(405);
    expect((await post('delete-issue', { identifier: 'ATL-3' })).statusCode).toBe(404);
    expect((await post('merge-pr', { identifier: 'ATL-3' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/actions/labels', headers: good })).statusCode).toBe(404);
  });
  it('surfaces controlled refusals as JSON with the failed checks', async () => {
    const { post } = await web();
    const r = await post('approve', { identifier: 'ATL-17', confirm: 'ATL-17' });
    expect(r.statusCode).toBe(422);
    const j = r.json();
    expect([j.ok, j.code]).toEqual([false, 'ineligible']);
    expect(j.checks.some((c: { ok: boolean }) => !c.ok)).toBe(true);
    const o = await (await web()).app.inject({ url: '/api/issue-actions/ATL-16', headers: { host: 'localhost' } });
    expect(o.json()).toMatchObject({ writeEnabled: true, csrf: 'csrf-token-1' });
  });
});
