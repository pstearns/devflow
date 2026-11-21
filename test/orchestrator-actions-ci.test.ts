import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../server/config.ts';
import { GithubCi } from '../server/orchestrator/ci.ts';
import { SourceError } from '../server/util.ts';

const repo = 'owner/repo';
const sha = 'a'.repeat(40);
const branch = 'devflow/cra-71-run';
const workflow = '.github/workflows/ci.yml';
const runsPath = `/repos/${repo}/actions/workflows/ci.yml/runs`;
const options = { required: ['gate'], branch, actionsWorkflow: workflow };
const run = {
  id: 101, run_attempt: 2, head_sha: sha, head_branch: branch, event: 'push', path: workflow,
  head_repository: { full_name: repo }, status: 'completed', conclusion: 'success',
};
const gate = { name: 'gate', run_id: 101, head_sha: sha, status: 'completed', conclusion: 'success' };

function fixture(o: {
  runs?: unknown[]; current?: unknown[]; jobs?: unknown[]; laterJobs?: unknown[]; reportedJobCount?: number;
  statuses?: unknown[] | Error;
} = {}) {
  let reads = 0;
  const get = vi.fn(async (path: string, params?: Record<string, string | number>) => {
    if (path === `/repos/${repo}/commits/${sha}/status`) {
      if (o.statuses instanceof Error) throw o.statuses;
      const statuses = o.statuses ?? [];
      return { total_count: statuses.length, statuses };
    }
    if (path === runsPath) {
      expect(params).toEqual({ head_sha: sha, branch, event: 'push', per_page: 100 });
      const runs = (++reads === 1 ? o.runs : o.current ?? o.runs) ?? [run];
      return { total_count: runs.length, workflow_runs: runs };
    }
    if (/^\/repos\/owner\/repo\/actions\/runs\/101\/attempts\/[1-3]\/jobs$/.test(path)) {
      const first = o.jobs ?? [gate];
      const later = o.laterJobs ?? [];
      return { total_count: o.reportedJobCount ?? first.length + later.length, jobs: params?.page === 1 ? first : later };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
  return { ci: new GithubCi({ get }), get };
}

describe('exact-SHA GitHub Actions job evidence', () => {
  it('reads the current attempt and verifies gate even when attempt one is stale', async () => {
    const { ci, get } = fixture();
    const result = await ci.snapshot(repo, sha, options);
    expect(result.state).toBe('success');
    expect(result.checks).toEqual([{ name: 'gate', state: 'passed', url: undefined }]);
    expect(get.mock.calls.map(([path]) => path)).toEqual([
      runsPath, `/repos/${repo}/actions/runs/101/attempts/2/jobs`,
      `/repos/${repo}/commits/${sha}/status`, runsPath,
    ]);
  });

  it.each([
    { head_sha: 'b'.repeat(40) }, { head_branch: 'main' }, { event: 'pull_request' },
    { path: '.github/workflows/other.yml' }, { path: `${workflow}@refs/heads/main` }, { head_repository: { full_name: 'fork/repo' } },
  ])('rejects wrong workflow run identity %j', async (override) => {
    const { ci } = fixture({ runs: [{ ...run, ...override }] });
    await expect(ci.snapshot(repo, sha, options)).rejects.toThrow('expected one workflow run');
  });

  it.each([`${workflow}@${branch}`, `${workflow}@refs/heads/${branch}`])('accepts the workflow path qualified by the expected ref %s', async (path) => {
    const { ci } = fixture({ runs: [{ ...run, path }] });
    expect((await ci.snapshot(repo, sha, options)).state).toBe('success');
  });

  it('rejects duplicate runs or jobs and incomplete lists', async () => {
    for (const o of [{ runs: [run, { ...run, id: 102 }] }, { jobs: [gate, gate] }, { reportedJobCount: 2 }]) {
      await expect(fixture(o).ci.snapshot(repo, sha, options)).rejects.toThrow(/workflow run|duplicate required job|incomplete/);
    }
  });

  it('checks later pages for the required job and duplicates', async () => {
    const otherJobs = Array.from({ length: 100 }, (_, index) => ({ ...gate, name: `build ${index}` }));
    const laterJobs = [gate];
    expect((await fixture({ jobs: otherJobs, laterJobs }).ci.snapshot(repo, sha, options)).state).toBe('success');
    await expect(fixture({ jobs: [gate, ...otherJobs.slice(1)], laterJobs }).ci.snapshot(repo, sha, options))
      .rejects.toThrow('duplicate required job');
  });

  it('rejects a job with the wrong SHA or run ID', async () => {
    for (const job of [{ ...gate, head_sha: 'b'.repeat(40) }, { ...gate, run_id: 99 }]) {
      await expect(fixture({ jobs: [job] }).ci.snapshot(repo, sha, options)).rejects.toThrow('job identity');
    }
  });

  it.each(['skipped', 'failure', 'neutral', null])('rejects a gate conclusion of %s', async (conclusion) => {
    const { ci } = fixture({ jobs: [{ ...gate, conclusion }] });
    expect((await ci.snapshot(repo, sha, options)).state).toBe('failure');
  });

  it('requires the actual gate job even with a commit status of the same name', async () => {
    const statuses = [{ context: 'gate', state: 'success' }];
    const result = await fixture({ jobs: [], statuses }).ci.snapshot(repo, sha, options);
    expect(result.state).toBe('timeout');
    expect(result.detail).toContain('Re-run all jobs');
    expect((await fixture({ runs: [], statuses }).ci.snapshot(repo, sha, options)).state).toBe('timeout');
  });

  it('does not accept success from an attempt superseded while reading jobs', async () => {
    const { ci } = fixture({ current: [{ ...run, run_attempt: 3 }] });
    expect((await ci.snapshot(repo, sha, options)).state).toBe('timeout');
    const { get } = fixture({ current: [{ ...run, run_attempt: 3 }] });
    const sleep = vi.fn(async () => {});
    const polling = new GithubCi({ get }, { sleep });
    expect((await polling.wait(repo, sha, { ...options, timeoutMs: 1000 })).state).toBe('success');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(get.mock.calls.map(([path]) => path)).toContain(`/repos/${repo}/actions/runs/101/attempts/3/jobs`);
  });

  it('rejects a cancelled workflow and waits for the current in-progress attempt', async () => {
    const cancelled = await fixture({ runs: [{ ...run, conclusion: 'cancelled' }] }).ci.snapshot(repo, sha, options);
    expect(cancelled.state).toBe('timeout');
    expect(cancelled.detail).toContain('rerun the workflow for this SHA');
    const cancelledBeforeGate = await fixture({ runs: [{ ...run, run_attempt: 1, conclusion: 'cancelled' }], jobs: [] }).ci.snapshot(repo, sha, options);
    expect(cancelledBeforeGate.state).toBe('timeout');
    expect(cancelledBeforeGate.detail).toContain('rerun the workflow for this SHA');
    const cancelledAfterFailure = await fixture({ runs: [{ ...run, conclusion: 'cancelled' }], jobs: [{ ...gate, conclusion: 'failure' }] }).ci.snapshot(repo, sha, options);
    expect(cancelledAfterFailure.state).toBe('timeout');
    expect(cancelledAfterFailure.checks).toContainEqual({ name: 'gate', state: 'failed', url: undefined });
    const cancelledJob = await fixture({ jobs: [{ ...gate, conclusion: 'cancelled' }] }).ci.snapshot(repo, sha, options);
    expect(cancelledJob.state).toBe('timeout');
    expect((await fixture({ runs: [{ ...run, status: 'in_progress', conclusion: null }] }).ci.snapshot(repo, sha, options)).state).toBe('timeout');
  });

  it('reports the failed gate job and its URL when the workflow failed', async () => {
    const url = 'https://github.com/owner/repo/actions/runs/101/job/1';
    const { ci } = fixture({ runs: [{ ...run, conclusion: 'failure' }], jobs: [{ ...gate, conclusion: 'failure', html_url: url }] });
    const result = await ci.snapshot(repo, sha, options);
    expect(result.state).toBe('failure');
    expect(result.detail).toContain('gate (failure)');
    expect(result.checks).toContainEqual({ name: 'gate', state: 'failed', url });
  });

  it('uses the configured required jobs when a different job fails', async () => {
    const unrelated = { ...gate, name: 'optional', conclusion: 'failure' };
    const { ci } = fixture({ runs: [{ ...run, conclusion: 'failure' }], jobs: [gate, unrelated] });
    expect((await ci.snapshot(repo, sha, options)).state).toBe('success');
  });

  it('retains a failed required job even when a partial rerun omits a second required job', async () => {
    const { ci } = fixture({ runs: [{ ...run, conclusion: 'failure' }], jobs: [{ ...gate, conclusion: 'failure' }] });
    const result = await ci.snapshot(repo, sha, { ...options, required: ['gate', 'build'] });
    expect(result.state).toBe('failure');
    expect(result.detail).toContain('gate (failure)');
    expect(result.checks).toContainEqual({ name: 'build', state: 'pending', url: undefined });
  });

  it('keeps independent commit-status checks', async () => {
    for (const statuses of [new SourceError('auth', 'denied'), [{ context: 'gate', state: 'failure' }]]) {
      expect((await fixture({ statuses }).ci.snapshot(repo, sha, options)).state).toBe('failure');
    }
  });
});

it('validates the raw Actions job list without silently normalizing the names', () => {
  const raw = JSON.parse(readFileSync(new URL('../devflow.config.example.json', import.meta.url), 'utf8'));
  const project = raw.projects.find((p: { orchestration?: unknown }) => p.orchestration);
  project.orchestration.ciActionsWorkflow = workflow;
  for (const names of [['gate', null], ['gate', ''], [' gate'], ['gate', 'Gate']]) {
    project.orchestration.ciChecks = names;
    expect(() => parseConfig(raw)).toThrow('explicit, unique ciChecks');
  }
  const longName = 'gate-' + 'x'.repeat(110);
  project.orchestration.ciChecks = [longName];
  expect(parseConfig(raw).projects.find((p) => p.id === project.id)?.orchestration?.ciChecks).toEqual([longName]);
});
