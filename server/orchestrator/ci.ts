// CI evidence for an exact SHA, read from GitHub (GET only, via the existing client). Missing or pending evidence is never a pass.
import type { GithubClient } from '../github.ts';
import { normalizeCheckRuns, normalizeCommitStatuses } from '../github.ts';
import type { CheckItem } from '../../shared/types.ts';
import { SourceError, isObj } from '../util.ts';

export interface CiResult { state: 'success' | 'failure' | 'timeout'; detail: string; checks: { name: string; state: string; url?: string }[] }
interface CiSelection { required: string[]; actionsWorkflow?: string; branch?: string }

export interface CiProvider {
  /** One immediate read of the CURRENT results for the SHA (no waiting): used at the gate and at approval, because check results are not immutable. */
  snapshot(repo: string, sha: string, o: CiSelection): Promise<CiResult>;
  wait(repo: string, sha: string, o: CiSelection & { timeoutMs: number }): Promise<CiResult>;
}

type Getter = Pick<GithubClient, 'get'>;
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const low = (s: string) => s.toLowerCase();

const UNREADABLE_STATUSES: CheckItem = { name: 'commit-statuses', state: 'unknown', rawStatus: 'unreadable', source: 'commit_status' };

export function evaluateChecks(items: CheckItem[], required: string[]): { state: 'success' | 'failure' | 'pending'; detail: string } {
  // Unreadable evidence is a completeness failure no matter which checks are named: a required name could be supplied by the part we cannot see.
  if (items.some((c) => c.rawStatus === 'unreadable')) return { state: 'failure', detail: 'CI evidence is incomplete: commit statuses are not readable by this token (grant "Commit statuses: read"); refusing to treat the rest as green' };
  if (items.some((c) => c.source === 'workflow_run' && c.state === 'pending')) {
    return { state: 'pending', detail: 'Actions workflow attempt was cancelled; rerun the workflow for this SHA' };
  }
  const considered = required.length ? items.filter((c) => required.some((r) => low(r) === low(c.name))) : items;
  const missing = required.filter((r) => !considered.some((c) => low(c.name) === low(r)));
  const bad = considered.filter((c) => c.state === 'failed' || c.state === 'unknown'); // cancelled/unrecognised is not a pass
  if (bad.length) return { state: 'failure', detail: `Failed or inconclusive: ${bad.map((c) => `${c.name} (${c.rawConclusion ?? c.rawStatus ?? c.state})`).join(', ')}` };
  if (missing.length) return { state: 'pending', detail: `Waiting for required check(s): ${missing.join(', ')}` };
  if (!considered.length) return { state: 'pending', detail: 'No CI checks reported for this commit yet' };
  const pending = considered.filter((c) => c.state === 'pending');
  if (pending.length) return { state: 'pending', detail: `Still running: ${pending.map((c) => `${c.name} (${c.rawStatus})`).join(', ')}` };
  return { state: 'success', detail: `All green: ${considered.map((c) => c.name).join(', ')}` };
}

export class GithubCi implements CiProvider {
  constructor(private gh: Getter, private o: { pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}) {}

  private async items(repo: string, sha: string, o: CiSelection): Promise<CheckItem[]> {
    if (o.actionsWorkflow !== undefined) {
      return this.actionsEvidence(repo, sha, o.actionsWorkflow, o.branch, o.required);
    }
    const checks = await this.runs(repo, sha).catch((error: unknown) => {
      if (!(error instanceof SourceError) || error.kind !== 'auth') throw error;
      throw new SourceError('auth', 'GitHub Checks are unreadable. Grant Checks: read or configure ciActionsWorkflow and required ciChecks job names.');
    });
    return [...checks, ...await this.statuses(repo, sha)];
  }

  private async runs(repo: string, sha: string): Promise<CheckItem[]> {
    const out: CheckItem[] = [];
    let seen = 0, total = Infinity;
    for (let page = 1; seen < total; page++) {
      if (page > 20) throw new SourceError('invalid', 'too many check runs to read completely: refusing to treat partial CI evidence as green');
      const raw = await this.gh.get(`/repos/${repo}/commits/${sha}/check-runs`, { per_page: 100, page });
      const list = isObj(raw) && Array.isArray(raw.check_runs) ? raw.check_runs : [];
      total = isObj(raw) && typeof raw.total_count === 'number' ? raw.total_count : list.length;
      seen += list.length; out.push(...normalizeCheckRuns({ check_runs: list }));
      if (!list.length) break;
    }
    if (seen < total) throw new SourceError('invalid', 'incomplete check-run list: refusing to treat partial CI evidence as green');
    return out;
  }

  private async actionsEvidence(repo: string, sha: string, workflow: string, branch: string | undefined, required: string[]): Promise<CheckItem[]> {
    const invalid = (reason: string) => new SourceError('invalid', `GitHub Actions evidence: ${reason}`);
    if (!/^[0-9a-f]{40}$/.test(sha) || !branch || !required.length) throw invalid('full SHA, branch and required job names are necessary');
    const workflowFile = encodeURIComponent(workflow.slice(workflow.lastIndexOf('/') + 1));
    const workflowPaths = [workflow, `${workflow}@${branch}`, `${workflow}@refs/heads/${branch}`];
    const getRun = async () => {
      const raw = await this.gh.get(`/repos/${repo}/actions/workflows/${workflowFile}/runs`, { head_sha: sha, branch, event: 'push', per_page: 100 });
      if (!isObj(raw) || !Array.isArray(raw.workflow_runs) || raw.total_count !== raw.workflow_runs.length) throw invalid('incomplete or malformed workflow-run list');
      if (raw.workflow_runs.length === 0) return undefined;
      const run: unknown = raw.workflow_runs[0];
      if (raw.workflow_runs.length !== 1 || !isObj(run) || run.head_sha !== sha || run.head_branch !== branch
        || run.event !== 'push' || typeof run.path !== 'string' || !workflowPaths.includes(run.path) || !positiveId(run.id) || !positiveId(run.run_attempt)
        || !isObj(run.head_repository) || typeof run.head_repository.full_name !== 'string'
        || low(run.head_repository.full_name) !== low(repo)
        || typeof run.status !== 'string') throw invalid('expected one workflow run matching the trusted workflow, repository, SHA, branch and push event');
      return run;
    };
    const unresolved = (state: 'pending' | 'unknown', reason: string): CheckItem[] =>
      required.map((name) => ({ name, state, rawStatus: reason, source: 'check_run' }));
    const run = await getRun();
    if (!run || run.status !== 'completed') {
      return [...unresolved('pending', run ? 'workflow attempt not completed' : 'workflow run missing'), ...await this.statuses(repo, sha)];
    }
    if (typeof run.conclusion !== 'string' || !run.conclusion) throw invalid('completed workflow has no conclusion');

    const jobs: CheckItem[] = [];
    let seen = 0;
    let total: number | undefined;
    for (let page = 1; total === undefined || seen < total; page++) {
      if (page > 20) throw invalid('incomplete job list: pagination limit exceeded');
      const raw = await this.gh.get(`/repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, { per_page: 100, page });
      if (!isObj(raw) || !Array.isArray(raw.jobs) || typeof raw.total_count !== 'number'
        || !Number.isSafeInteger(raw.total_count) || raw.total_count < 0
        || (total !== undefined && raw.total_count !== total)) throw invalid('incomplete or malformed job list');
      total = raw.total_count;
      seen += raw.jobs.length;
      if (seen > total || (seen < total && raw.jobs.length === 0)) throw invalid('incomplete or malformed job list');
      for (const job of raw.jobs as unknown[]) {
        if (!isObj(job) || typeof job.name !== 'string' || job.head_sha !== sha || job.run_id !== run.id) throw invalid('job identity does not match the selected run and SHA');
        if (!required.includes(job.name)) continue;
        if (jobs.some((item) => item.name === job.name)) throw invalid('duplicate required job');
        jobs.push({
          name: job.name, state: job.conclusion === 'cancelled' ? 'pending'
            : job.status === 'completed' && job.conclusion === 'success' ? 'passed' : 'failed',
          rawStatus: typeof job.status === 'string' ? job.status : 'unknown',
          rawConclusion: typeof job.conclusion === 'string' ? job.conclusion : undefined,
          url: typeof job.html_url === 'string' ? job.html_url : undefined, source: 'check_run',
        });
      }
    }
    const statuses = await this.statuses(repo, sha);
    const current = await getRun();
    if (!current || current.id !== run.id || current.run_attempt !== run.run_attempt || current.status !== 'completed' || current.conclusion !== run.conclusion) {
      return [...unresolved('pending', 'workflow attempt was superseded'), ...statuses];
    }
    const missing = required.filter((name) => !jobs.some((job) => job.name === name));
    const partial = missing.length > 0 && run.run_attempt !== 1;
    for (const name of missing) {
      jobs.push({
        name, state: 'pending', source: 'check_run',
        rawStatus: partial ? 'required Actions job missing from this attempt; use Re-run all jobs for a partial rerun' : 'required Actions job missing',
      });
    }
    const cancelled = run.conclusion === 'cancelled' || jobs.some((job) => job.rawConclusion === 'cancelled');
    if (cancelled) {
      jobs.push({
        name: workflow, state: 'pending', rawStatus: 'completed', rawConclusion: 'cancelled', source: 'workflow_run',
      });
    }
    return [...jobs, ...statuses];
  }

  private async statuses(repo: string, sha: string): Promise<CheckItem[]> {
    try {
      const out: unknown[] = [];
      let total = Infinity;
      for (let page = 1; out.length < total; page++) {
        if (page > 10) throw new SourceError('invalid', 'incomplete commit-status list: refusing to treat partial CI evidence as green');
        const st = await this.gh.get(`/repos/${repo}/commits/${sha}/status`, { per_page: 100, page });
        const sl = isObj(st) && Array.isArray(st.statuses) ? st.statuses : [];
        total = isObj(st) && typeof st.total_count === 'number' ? st.total_count : sl.length;
        out.push(...sl);
        if (!sl.length) break;
      }
      if (out.length < total) throw new SourceError('invalid', 'incomplete commit-status list: refusing to treat partial CI evidence as green');
      return normalizeCommitStatuses({ statuses: out });
    } catch (e) {
      if (!(e instanceof SourceError) || e.kind !== 'auth') throw e;
      return [UNREADABLE_STATUSES]; // external CI cannot be ruled out: never green
    }
  }

  async snapshot(repo: string, sha: string, o: CiSelection): Promise<CiResult> {
    const items = await this.items(repo, sha, o);
    const r = evaluateChecks(items, o.required);
    return { state: r.state === 'pending' ? 'timeout' : r.state, detail: r.state === 'pending' ? `Not green now: ${r.detail}` : r.detail, checks: items.map((c) => ({ name: c.name, state: c.state, url: c.url })) };
  }

  async wait(repo: string, sha: string, o: CiSelection & { timeoutMs: number }): Promise<CiResult> {
    const now = this.o.now ?? Date.now, sleep = this.o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = now() + o.timeoutMs;
    let greens = 0, last = { state: 'pending' as 'success' | 'failure' | 'pending', detail: 'not polled' }, items: CheckItem[] = [];
    for (;;) {
      items = await this.items(repo, sha, o);
      last = evaluateChecks(items, o.required);
      // Without a configured check list, "all green" must hold on two consecutive polls so a late-registered check cannot be missed.
      greens = last.state === 'success' ? greens + 1 : 0;
      const view = items.map((c) => ({ name: c.name, state: c.state, url: c.url }));
      if (last.state === 'failure') return { state: 'failure', detail: last.detail, checks: view };
      if (last.state === 'success' && (o.required.length || greens >= 2)) return { state: 'success', detail: last.detail, checks: view };
      if (now() >= deadline) return { state: 'timeout', detail: `Timed out waiting for CI: ${last.detail}`, checks: view };
      await sleep(this.o.pollMs ?? 15_000);
    }
  }
}
