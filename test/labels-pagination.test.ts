import { describe, expect, it } from 'vitest';
import { SnapshotService } from '../server/service.ts';
import { demoConfig, demoFetch, DEMO_READ_KEY, DEMO_WRITE_KEY } from '../server/demo.ts';
import { fakeLabelTotal, type FakeLinearOpts } from '../server/demo-linear.ts';
import { LinearClient } from '../server/linear.ts';
import { LinearWriteClient } from '../server/linear-write.ts';
import { ActionError, LinearActions } from '../server/actions.ts';
import type { Config } from '../server/config.ts';

// Action menus and validation read the team's FULL label list (paginated). The synthetic fake serves labels in pages of
// `labelPageSize` (default 100, the page size the real query asks for), so expected request counts are derived from it.

const now = Date.parse('2026-06-01T12:00:00Z');
const MAX_PAGES = 25; // paginate() cap in server/linear.ts

async function setup(opts: FakeLinearOpts, tweak?: (cfg: Config) => void, labelResponse?: (body: any, after: unknown) => void) {
  const inner = demoFetch(now, opts);
  let labelPages = 0;
  const f = Object.assign((async (u: string | URL | Request, init?: RequestInit) => {
    const isLabels = typeof init?.body === 'string' && init.body.includes('query Labels(');
    if (isLabels) labelPages++;
    const response = await inner(u, init);
    if (isLabels && labelResponse) {
      const body = await response.json();
      labelResponse(body, JSON.parse(init!.body as string).variables.after);
      return Response.json(body);
    }
    return response;
  }) as typeof fetch, { store: inner.store });
  const cfg = demoConfig();
  tweak?.(cfg);
  const service = new SnapshotService(cfg, { linearKey: DEMO_READ_KEY, githubToken: 't', fetchImpl: f, mode: 'demo' }, () => now);
  service.setWriteInfo({ enabled: true });
  await service.get();
  const actions = new LinearActions({ cfg, read: new LinearClient(DEMO_READ_KEY, f), write: new LinearWriteClient(DEMO_WRITE_KEY, f), service, clock: () => now });
  labelPages = 0; // only the action paths below are measured, not the dashboard's own label read
  const measure = async <T>(fn: () => Promise<T>) => {
    const before = labelPages, mutationsBefore = inner.store.mutations.length;
    const result = await fn().then((value) => ({ value, error: undefined as ActionError | undefined }), (error) => ({ value: undefined as T | undefined, error: error as ActionError }));
    return { ...result, pages: labelPages - before, mutations: inner.store.mutations.slice(mutationsBefore).map((m) => m.op) };
  };
  return { f: inner, actions, measure, cfg };
}
const pagesFor = (total: number, size: number) => Math.ceil(total / size);

describe('label pagination: request counts per path', () => {
  const EXTRA = 150, SIZE = 100;
  const total = fakeLabelTotal('ATL', EXTRA);
  const P = pagesFor(total, SIZE); // 2 pages

  it('the menu and each label-dependent action read the full list once; read-backs, status, milestone and revoke read none', async () => {
    expect(P).toBe(2);
    const { actions, measure } = await setup({ extraLabels: EXTRA });

    const opts = await measure(() => actions.options('ATL-3'));
    expect([opts.pages, opts.mutations]).toEqual([P, []]);
    expect(opts.value!.labels.some((l) => l.name === `Extra label ${EXTRA}`)).toBe(true); // a label from page 2 is offered

    const edit = await measure(() => actions.labels('ATL-3', ['lbl-extra-1'], []));
    expect(edit.error).toBeUndefined();
    expect([edit.pages, edit.mutations]).toEqual([P, ['IssueAddLabel']]); // one full read; the read-back needs none

    const approve = await measure(() => actions.approve('ATL-8', 'ATL-8'));
    expect(approve.error).toBeUndefined();
    expect(approve.pages).toBe(P);

    const status = await measure(() => actions.status('ATL-4', 'st-ATL-in-progress'));
    expect(status.error).toBeUndefined();
    expect([status.pages, status.mutations]).toEqual([0, ['IssueUpdate']]);

    const milestone = await measure(() => actions.milestone('ATL-4', 'm1'));
    expect(milestone.error).toBeUndefined();
    expect([milestone.pages, milestone.mutations]).toEqual([0, ['IssueUpdate']]);

    const revoke = await measure(() => actions.revoke('ATL-8', 'ATL-8')); // ATL-8 was just approved, so it carries Ready
    expect(revoke.error).toBeUndefined();
    expect(revoke.pages).toBe(0);

    const refused = await measure(() => actions.labels('ATL-3', ['lbl-ready'], [])); // refusals still read the list, then send nothing
    expect(refused.error?.code).toBe('protected-label');
    expect([refused.pages, refused.mutations]).toEqual([P, []]);
  });
});

describe('a label beyond the first 100', () => {
  const EXTRA = 250, SIZE = 100;
  const P = pagesFor(fakeLabelTotal('ATL', EXTRA), SIZE);

  it('is offered and editable, verified after the write, and a configured protected label out there stays protected', async () => {
    expect(P).toBe(3);
    const { actions, measure, f } = await setup({ extraLabels: EXTRA }, (cfg) => { cfg.projects[0]!.workflow.protectedLabels = ['Extra label 230']; });

    const o = await actions.options('ATL-4');
    const names = o.labels.map((l) => l.name);
    expect(names.indexOf('Extra label 230')).toBeGreaterThan(SIZE); // really past the first page
    expect(o.labels.find((l) => l.name === 'Extra label 230')).toMatchObject({ editable: false, reason: expect.stringMatching(/^Protected: edit it in Linear/) });
    expect(o.labels.find((l) => l.name === 'Extra label 229')).toMatchObject({ editable: true, applied: false });

    const refused = await measure(() => actions.labels('ATL-4', ['lbl-extra-230'], []));
    expect(refused.error?.code).toBe('protected-label');
    expect(refused.error?.message).toMatch(/edit it in Linear/);
    expect([refused.pages, refused.mutations]).toEqual([P, []]);

    const edited = await measure(() => actions.labels('ATL-4', ['lbl-extra-229'], []));
    expect(edited.error).toBeUndefined();
    expect([edited.pages, edited.mutations]).toEqual([P, ['IssueAddLabel']]);
    expect(f.store.issues.ATL!.find((i) => i.n === 4)!.labels).toContain('Extra label 229');
  });
});

describe('incomplete label pagination fails closed', () => {
  it('page cap exhausted: label edits and Approve are refused with zero mutations; the menu reports why; status, milestone and revoke are unaffected', async () => {
    const SIZE = 10, EXTRA = 300;
    expect(pagesFor(fakeLabelTotal('ATL', EXTRA), SIZE)).toBeGreaterThan(MAX_PAGES);
    const { actions, measure } = await setup({ extraLabels: EXTRA, labelPageSize: SIZE });

    const opts = await measure(() => actions.options('ATL-3'));
    expect(opts.error).toBeUndefined();
    expect(opts.pages).toBe(MAX_PAGES);
    expect(opts.value!.labels.every((l) => !l.editable && /full label list/.test(l.reason ?? ''))).toBe(true);
    expect(opts.value!.approve.eligible).toBe(false);
    expect(opts.value!.approve.checks.find((c) => c.id === 'labels')).toMatchObject({ ok: false });
    expect(opts.value!.milestones.canChange).toBe(true);

    const edit = await measure(() => actions.labels('ATL-3', ['lbl-extra-1'], []));
    expect([edit.error?.code, edit.pages, edit.mutations]).toEqual(['labels-incomplete', MAX_PAGES, []]);
    const approve = await measure(() => actions.approve('ATL-8', 'ATL-8'));
    expect([approve.error?.code, approve.pages, approve.mutations]).toEqual(['labels-incomplete', MAX_PAGES, []]);

    const status = await measure(() => actions.status('ATL-4', 'st-ATL-in-progress'));
    expect([status.error, status.pages, status.mutations]).toEqual([undefined, 0, ['IssueUpdate']]);
    const milestone = await measure(() => actions.milestone('ATL-4', 'm1'));
    expect([milestone.error, milestone.pages, milestone.mutations]).toEqual([undefined, 0, ['IssueUpdate']]);
    const revoke = await measure(() => actions.revoke('ATL-6', 'ATL-6')); // needs only the issue's own labels
    expect([revoke.error, revoke.pages]).toEqual([undefined, 0]);
  });

  it('a page that says there is more but gives no cursor: the same refusal after a single page request', async () => {
    const { actions, measure } = await setup({ extraLabels: 150, labelsMissingCursor: true });

    const opts = await measure(() => actions.options('ATL-3'));
    expect(opts.pages).toBe(1);
    expect(opts.value!.labels.every((l) => !l.editable && /full label list/.test(l.reason ?? ''))).toBe(true);

    const edit = await measure(() => actions.labels('ATL-3', ['lbl-extra-1'], []));
    expect([edit.error?.code, edit.pages, edit.mutations]).toEqual(['labels-incomplete', 1, []]);
    const approve = await measure(() => actions.approve('ATL-8', 'ATL-8'));
    expect([approve.error?.code, approve.pages, approve.mutations]).toEqual(['labels-incomplete', 1, []]);
  });
});


describe('malformed and interrupted label connections', () => {
  const cases: [string, (connection: any, after: unknown) => void][] = [
    ['missing pageInfo', (c) => { delete c.pageInfo; }],
    ['non-object pageInfo', (c) => { c.pageInfo = []; }],
    ['missing hasNextPage', (c) => { delete c.pageInfo.hasNextPage; }],
    ['non-boolean hasNextPage', (c) => { c.pageInfo.hasNextPage = 'true'; }],
    ['missing endCursor', (c) => { delete c.pageInfo.endCursor; }],
    ['non-string cursor', (c) => { c.pageInfo.endCursor = 100; }],
    ['blank cursor', (c) => { c.pageInfo.endCursor = ' '; }],
    ['oversized cursor', (c) => { c.pageInfo.endCursor = 'x'.repeat(201); }],
    ['missing nodes', (c) => { delete c.nodes; }],
    ['non-array nodes', (c) => { c.nodes = {}; }],
    ['empty non-final page', (c) => { c.nodes = []; }],
    ['same cursor on next page', (c, after) => { if (after) c.pageInfo.endCursor = after; }],
    ['cursor cycle', (c, after) => { if (after === '200') c.pageInfo.endCursor = '100'; }],
    ['repeated cursor on final page', (c, after) => { if (after === '200') c.pageInfo = { hasNextPage: false, endCursor: after }; }],
  ];
  it.each(cases)('%s disables label-dependent options and sends no mutations', async (_name, corrupt) => {
    const { actions, measure } = await setup({ extraLabels: 350 }, undefined, (b, after) => corrupt(b.data.issueLabels, after));
    const menu = await actions.options('ATL-3');
    expect(menu.approve.eligible).toBe(false);
    expect(menu.approve.checks.find((c) => c.id === 'labels')?.ok).toBe(false);
    expect(menu.labels.some((l) => l.editable)).toBe(false);
    for (const action of [() => actions.labels('ATL-3', ['lbl-extra-1'], []), () => actions.approve('ATL-8', 'ATL-8')]) {
      const result = await measure(action);
      expect(result.error?.code).toBe('labels-incomplete');
      expect(result.mutations).toEqual([]);
    }
  });

  it('later-page transport failure aborts options and both dependent mutations', async () => {
    const { actions, measure } = await setup({ extraLabels: 150 }, undefined, (_b, after) => {
      if (after) throw new TypeError('synthetic connection lost');
    });
    await expect(actions.options('ATL-3')).rejects.toThrow();
    for (const action of [() => actions.labels('ATL-3', ['lbl-extra-1'], []), () => actions.approve('ATL-8', 'ATL-8')]) {
      const result = await measure(action);
      expect(result.error).toBeDefined();
      expect(result.pages).toBe(2);
      expect(result.mutations).toEqual([]);
    }
  });

  it('valid completion exactly at the cap remains complete and permits verified edits and approval', async () => {
    const extra = MAX_PAGES * 100 - fakeLabelTotal('ATL');
    const { actions, measure } = await setup({ extraLabels: extra });
    const menu = await measure(() => actions.options('ATL-3'));
    expect(menu.pages).toBe(MAX_PAGES);
    expect(menu.value!.labels.find((l) => l.name === `Extra label ${extra}`)?.editable).toBe(true);
    expect(menu.value!.approve.eligible).toBe(true);
    const edit = await measure(() => actions.labels('ATL-3', [`lbl-extra-${extra}`], []));
    expect([edit.error, edit.pages, edit.mutations]).toEqual([undefined, MAX_PAGES, ['IssueAddLabel']]);
    expect(edit.value?.verified).toBe(true);
    const approval = await measure(() => actions.approve('ATL-8', 'ATL-8'));
    expect([approval.error, approval.pages, approval.mutations]).toEqual([undefined, MAX_PAGES, ['IssueUpdate', 'IssueAddLabel']]);
    expect(approval.value?.verified).toBe(true);
  });
});
