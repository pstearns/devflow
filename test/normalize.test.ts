import { describe, expect, it } from 'vitest';
import { normalizeIssue, normalizeRef, buildMilestones, LinearClient } from '../server/linear.ts';
import { normalizeCheckRuns, normalizeCommitStatuses, normalizePr, normalizeReviews, GithubClient } from '../server/github.ts';
import { extractIssueIds, safeUrl } from '../server/util.ts';
import { parseConfig } from '../server/config.ts';

describe('Linear normalization', () => {
  it('rejects malformed issues and survives hostile fields', () => {
    expect(normalizeIssue(null, 'p')).toBeUndefined();
    expect(normalizeIssue({ id: 'x', identifier: 'not an id' }, 'p')).toBeUndefined();
    const i = normalizeIssue({ id: 'u', identifier: 'cra-61', title: 42, state: 'weird', url: 'javascript:alert(1)', priority: 'high', labels: { nodes: [1, { name: 'no id' }, { id: 'l1', name: 'ok', color: 'javascript:alert(1)' }] }, relations: 'x' }, 'p')!;
    expect(i.identifier).toBe('CRA-61');
    expect(i.title).toBe('(untitled)');
    expect(i.url).toBeUndefined();
    expect(i.state.type).toBe('unknown');
    expect(i.labels).toEqual([{ id: 'l1', name: 'ok', color: '#8b97a7' }]); // bad color never reaches a style
    expect(i.priority).toBe(0);
  });
  it('maps blocking relations in the right direction and ignores other relation types', () => {
    const ref = (id: string, t: string) => ({ identifier: id, title: id, url: 'https://linear.app/x', state: { name: 'n', type: t } });
    const i = normalizeIssue({
      id: 'u', identifier: 'ABC-2', title: 't', state: { name: 'Todo', type: 'unstarted' },
      inverseRelations: { nodes: [{ type: 'blocks', issue: ref('ABC-1', 'started') }, { type: 'related', issue: ref('ABC-9', 'started') }] },
      relations: { nodes: [{ type: 'blocks', relatedIssue: ref('ABC-3', 'unstarted') }] },
    }, 'p')!;
    expect(i.blockedBy.map((b) => b.identifier)).toEqual(['ABC-1']);
    expect(i.blocks.map((b) => b.identifier)).toEqual(['ABC-3']);
    expect(normalizeRef({ identifier: 'ABC-1', state: { type: 'completed' } })!.resolved).toBe(true);
  });
  it('marks truncated descriptions instead of silently cutting them', () => {
    const i = normalizeIssue({ id: 'u', identifier: 'ABC-1', title: 't', description: 'x'.repeat(12000), state: { name: 'n', type: 'started' } }, 'p')!;
    expect(i.description).toContain('truncated by DevFlow');
    expect(normalizeIssue({ id: 'u', identifier: 'ABC-1', title: 't', description: 'short', state: { name: 'n', type: 'started' } }, 'p')!.description).toBe('short');
  });
  it('only surfaces https links', () => {
    expect(safeUrl('https://github.com/a/b')).toBeTruthy();
    for (const bad of ['http://x.com', 'javascript:alert(1)', 'data:text/html,x', 42, null, 'not a url']) expect(safeUrl(bad)).toBeUndefined();
  });
});

describe('milestone progress', () => {
  const mk = (n: number, type: string, ms?: string) => normalizeIssue({ id: `u${n}`, identifier: `ABC-${n}`, title: 't', state: { name: type, type }, projectMilestone: ms ? { id: ms } : null }, 'p')!;
  it('computes progress from actual states, excludes canceled, never infers', () => {
    const issues = [mk(1, 'completed', 'm'), mk(2, 'started', 'm'), mk(3, 'canceled', 'm'), mk(4, 'unstarted'), mk(5, 'unstarted', 'gone')];
    const ms = buildMilestones('p', [{ id: 'm', name: 'M', description: '', targetDate: '2020-01-01' }, { id: 'empty', name: 'E', description: '', targetDate: '2020-01-01' }], issues, '2026-01-01');
    const m = ms.find((x) => x.id === 'm')!;
    expect([m.total, m.done, m.canceled, m.progress, m.overdue]).toEqual([3, 1, 1, 0.5, true]);
    const empty = ms.find((x) => x.id === 'empty')!;
    expect(empty.progress).toBeNull();
    expect(empty.overdue).toBe(false);
    expect(ms.find((x) => x.id === 'none:p')!.issueIdentifiers).toEqual(['ABC-4']);
    expect(ms.find((x) => x.id === 'unknown:p')!.issueIdentifiers).toEqual(['ABC-5']);
  });
  it('a milestone whose countable issues are all done is not overdue', () => {
    const ms = buildMilestones('p', [{ id: 'm', name: 'M', description: '', targetDate: '2020-01-01' }], [mk(1, 'completed', 'm')], '2026-01-01');
    expect(ms[0]!.overdue).toBe(false);
  });
});

describe('GitHub normalization', () => {
  it('normalizes PRs, drops malformed ones, derives merged state', () => {
    expect(normalizePr({ number: 1, head: { ref: 'a', sha: 'zzz' } })).toBeUndefined();
    expect(normalizePr('x')).toBeUndefined();
    const p = normalizePr({ number: 5, title: 't', state: 'closed', merged_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/o/r/pull/5', head: { ref: 'b', sha: 'abcdef1234' }, base: { ref: 'main' } })!;
    expect(p.state).toBe('merged');
  });
  it('treats cancelled / unrecognised check conclusions as unknown, not pass or fail', () => {
    const c = normalizeCheckRuns({ check_runs: [
      { name: 'a', status: 'completed', conclusion: 'success' }, { name: 'b', status: 'completed', conclusion: 'cancelled' },
      { name: 'c', status: 'in_progress' }, { name: 'd', status: 'completed', conclusion: 'timed_out' }, { status: 'completed' }, 7,
    ] });
    expect(c.map((x) => x.state)).toEqual(['passed', 'unknown', 'pending', 'failed']);
  });
  it('normalizes statuses and reviews defensively', () => {
    expect(normalizeCommitStatuses({ statuses: [{ context: 'x', state: 'error' }, { state: 'success' }] }).map((s) => s.state)).toEqual(['failed']);
    expect(normalizeReviews([{ state: 'APPROVED', user: { login: 'm' } }, { user: {} }, null])).toHaveLength(1);
    expect(normalizeReviews('nope')).toEqual([]);
  });
});

describe('identifier extraction', () => {
  it('respects boundaries', () => {
    expect(extractIssueIds('feature/cra-61-fix')).toEqual(['CRA-61']);
    expect(extractIssueIds('CRA-6 and CRA-61')).toEqual(['CRA-6', 'CRA-61']);
    expect(extractIssueIds('xCRA-61 CRA-612a')).not.toContain('CRA-61'); // different identifiers, never a prefix match
  });
});

describe('read-only guards', () => {
  it('Linear client refuses mutations without making a request', async () => {
    let called = false;
    const c = new LinearClient('k', (async () => { called = true; return new Response('{}'); }) as typeof fetch);
    await expect(c.query('mutation { issueDelete(id: "x") { success } }', {})).rejects.toThrow(/read-only/);
    expect(called).toBe(false);
  });
  it('GitHub client only issues GET to /repos paths', async () => {
    const seen: string[] = [];
    const g = new GithubClient('t', (async (_u: unknown, init?: RequestInit) => { seen.push(init?.method ?? ''); return new Response('[]'); }) as typeof fetch);
    await g.get('/repos/o/r/pulls');
    await expect(g.get('/user')).rejects.toThrow();
    expect(seen).toEqual(['GET']);
  });
});

describe('config', () => {
  it('the shipped example config parses and carries the workflow policy', async () => {
    const { readFileSync } = await import('node:fs');
    const c = parseConfig(JSON.parse(readFileSync(new URL('../devflow.config.example.json', import.meta.url), 'utf8')));
    expect(c.projects[0]!.workflow).toMatchObject({ readyLabel: 'Ready', todoState: 'Todo', backlogState: 'Backlog' });
    expect(c.projects[0]!.workflow.readiness.requireNoOpenBlockers).toBe(true);
  });
  it('workflow settings are per project, validated, and have generic defaults (nothing project-specific built in)', () => {
    const c = parseConfig({ projects: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', workflow: { readyLabel: 'Go', discoveryLabels: ['Spike'], readiness: { minDescriptionChars: 5, requireMilestone: true } } }] });
    expect(c.projects[0]!.workflow.readyLabel).toBe('Ready');
    expect(c.projects[1]!.workflow).toMatchObject({ readyLabel: 'Go', discoveryLabels: ['Spike'] });
    expect(c.projects[1]!.workflow.readiness).toMatchObject({ minDescriptionChars: 5, requireMilestone: true, requireDescription: true });
    expect(() => parseConfig({ projects: [{ id: 'a', name: 'A', workflow: { readyLabel: '  ' } }] })).toThrow(/readyLabel/);
  });
  it('never exits on idle by default (opt-in only)', () => {
    expect(parseConfig({ projects: [] }).idleExitMinutes).toBe(0);
    expect(parseConfig({ projects: [], idleExitMinutes: 30 }).idleExitMinutes).toBe(30);
  });
  it('validates input and applies prompt overrides', () => {
    expect(() => parseConfig({ projects: [{ id: 'a', name: 'A', github: { repos: ['bad repo'] } }] })).toThrow(/owner\/repo/);
    expect(() => parseConfig({ projects: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] })).toThrow(/Duplicate/);
    const c = parseConfig({ projects: [], prompts: { discover: 'custom {{ticket}}' } });
    expect(c.prompts.find((p) => p.id === 'discover')!.template).toBe('custom {{ticket}}');
    expect(c.prompts).toHaveLength(6);
  });
});
