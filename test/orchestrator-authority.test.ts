import { describe, expect, it } from 'vitest';
import type { Ctx } from '../server/actions.ts';
import { inspectTriage, scopeDigest, verifyAuthority } from '../server/orchestrator/authority.ts';
import type { Manifest } from '../server/orchestrator/types.ts';

const owner = '11111111-1111-4111-8111-111111111111';
const delegate = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const at = (minute: number) => new Date(Date.UTC(2026, 1, 1, 0, minute)).toISOString();
const by = (id: string) => ({ actorId: id, actors: [{ id }] });
const ready = { id: 'label-record', createdAt: at(5), ...by(owner), addedLabelIds: ['ready'] };
const triage = { id: 'entered-triage', createdAt: at(2), ...by(owner), fromStateId: 'blocked', toStateId: 'triage' };
const promotion = { id: 'promoted', createdAt: at(6), ...by(delegate), fromStateId: 'triage', toStateId: 'todo' };
const ctx = {
  id: 'issue-id', title: 'Repair widgets', description: 'Preserve current API and correct rounding',
  state: { id: 'todo', name: 'Todo', type: 'unstarted' },
  states: [{ id: 'triage', name: 'Triage', type: 'triage', position: 0 }],
} as Ctx;
const failed = { runId: 'failed-run', reasonClass: 'repairs-exhausted', updatedAt: at(1), attempts: [] } as unknown as Manifest;
const findings = {
  id: 'findings', user: { id: delegate }, createdAt: at(3), updatedAt: at(3),
  body: `DevFlow Triage: ${triage.id} ${scopeDigest(ctx)}\n\nCorrection and acceptance evidence`,
};
const approval = {
  id: 'remediation', user: { id: owner }, createdAt: at(4), updatedAt: at(4),
  body: `DevFlow remediation: ${ctx.id} ${failed.runId} ${scopeDigest(ctx)}`,
};
const delegated = [triage, { ...ready, ...by(delegate) }, promotion];

function check(history: unknown[], comments: unknown[] = [], previous: Manifest[] = [], overrides: Record<string, unknown> = {}) {
  return verifyAuthority({
    async query() {
      return { issue: { id: ctx.id, state: ctx.state, title: ctx.title, description: ctx.description,
        history: { nodes: history, pageInfo: { hasNextPage: false } },
        comments: { nodes: comments, pageInfo: { hasNextPage: false } }, ...overrides,
      } };
    },
  }, { owners: [owner], delegates: [delegate] }, ctx, 'ready', previous);
}

describe('controller dispatch authorization', () => {
  it('accepts an initial Ready label from the owner', async () => {
    await expect(check([ready])).resolves.toMatchObject({ readyRecord: ready.id });
  });

  it('accepts a verified delegated promotion following owner-entered Triage', async () => {
    await expect(check(delegated, [findings])).resolves.toMatchObject({ readyRecord: ready.id });
  });

  it.each([
    ['Backlog to Ready', [{ ...ready, ...by(delegate) }, { ...promotion, fromStateId: 'backlog' }], [findings]],
    ['Blocked to Ready', [{ ...ready, ...by(delegate) }, { ...promotion, fromStateId: 'blocked' }], [findings]],
    ['delegate-entered Triage', [{ ...triage, ...by(delegate) }, ...delegated.slice(1)], [findings]],
    ['untrusted owner assertion', [{ ...ready, ...by(other) }], [approval]],
    ['missing delegated findings', delegated, []],
    ['stale delegated scope', delegated, [{ ...findings, body: findings.body.replace(scopeDigest(ctx), 'old') }]],
    ['mixed actor history', [{ ...ready, actors: [{ id: owner }, { id: delegate }] }], []],
    ['reapplied label', [ready, { ...ready, ...by(other), createdAt: at(8) }], []],
    ['revoked label', [ready, { id: 'removed', createdAt: at(8), removedLabelIds: ['ready'], ...by(owner) }], []],
  ])('rejects %s', async (_name, history, comments) => {
    await expect(check(history, comments)).rejects.toThrow();
  });

  it('fails closed on incomplete history or a changed live state', async () => {
    await expect(check([ready], [], [], { history: { nodes: [ready], pageInfo: { hasNextPage: true } } })).rejects.toThrow('incomplete');
    await expect(check([ready], [], [], { state: { id: 'triage' } })).rejects.toThrow('changed');
  });

  it('preserves exhausted repair authority across Ready and Triage promotion', async () => {
    await expect(check([ready], [], [failed])).rejects.toThrow('exhausted');
    await expect(check(delegated, [findings], [failed])).rejects.toThrow('exhausted');
  });

  it('consumes a fresh owner approval bound to the original issue, prior run and scope', async () => {
    await expect(check([ready], [approval], [failed])).resolves.toMatchObject({ remediationApproval: approval.id });
  });

  it.each([
    ['wrong issue', { ...approval, body: approval.body.replace(ctx.id, 'duplicate') }],
    ['wrong run', { ...approval, body: approval.body.replace(failed.runId, 'another-run') }],
    ['stale scope', { ...approval, body: approval.body.replace(scopeDigest(ctx), 'old') }],
    ['stale timestamp', { ...approval, createdAt: at(0), updatedAt: at(0) }],
    ['edited approval', { ...approval, updatedAt: at(5) }],
    ['delegate approval', { ...approval, user: { id: delegate } }],
  ])('rejects remediation with %s', async (_name, comment) => {
    await expect(check([ready], [comment], [failed])).rejects.toThrow('exhausted');
  });

  it('rejects ambiguous or consumed remediation approval', async () => {
    await expect(check([ready], [approval, { ...approval, id: 'second' }], [failed])).rejects.toThrow('exhausted');
    await expect(check([ready], [approval], [{ remediationApproval: approval.id, attempts: [] } as unknown as Manifest, failed])).rejects.toThrow('exhausted');
  });
});

describe('Triage inspection', () => {
  const inTriage = { ...ctx, state: { id: 'triage', name: 'Triage', type: 'triage' as const } };
  const inspect = (entry: typeof triage, previous: Manifest[] = []) => inspectTriage({
    async query() {
      return { issue: { id: inTriage.id, state: inTriage.state, title: inTriage.title, description: inTriage.description,
        history: { nodes: [entry], pageInfo: { hasNextPage: false } },
        comments: { nodes: [], pageInfo: { hasNextPage: false } },
      } };
    },
  }, { owners: [owner], delegates: [delegate] }, inTriage, previous);

  it('returns the verified Triage entry for a subsequent promotion', async () => {
    await expect(inspect(triage)).resolves.toMatchObject({ entry: triage.id, scope: scopeDigest(ctx) });
  });

  it('refuses investigation authority derived from a delegated or unrelated Triage entry', async () => {
    await expect(inspect({ ...triage, ...by(delegate) })).rejects.toThrow('owner authority');
    await expect(inspect({ ...triage, toStateId: 'backlog' })).rejects.toThrow('owner authority');
  });

  it('reports exhausted repair authority while allowing read-only investigation', async () => {
    await expect(inspect(triage, [failed])).resolves.toMatchObject({ remediationHold: expect.stringContaining('exhausted') });
  });
});
