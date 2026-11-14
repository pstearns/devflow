// CI evidence for an exact SHA, read from GitHub (GET only, via the existing client). Missing or pending evidence is never a pass.
import type { GithubClient } from '../github.ts';
import { normalizeCheckRuns, normalizeCommitStatuses, normalizeRuns } from '../github.ts';
import type { CheckItem } from '../../shared/types.ts';
import { SourceError, isObj } from '../util.ts';

export interface CiResult { state: 'success' | 'failure' | 'timeout'; detail: string; checks: { name: string; state: string; url?: string }[] }
export interface CiProvider {
  /** One immediate read of the CURRENT results for the SHA (no waiting): used at the gate and at approval, because check results are not immutable. */
  snapshot(repo: string, sha: string, o: { required: string[] }): Promise<CiResult>;
  wait(repo: string, sha: string, o: { required: string[]; timeoutMs: number }): Promise<CiResult>;
}

type Getter = Pick<GithubClient, 'get'>;
const low = (s: string) => s.toLowerCase();

const UNREADABLE_STATUSES: CheckItem = { name: 'commit-statuses', state: 'unknown', rawStatus: 'unreadable', source: 'commit_status' };

export function evaluateChecks(items: CheckItem[], required: string[]): { state: 'success' | 'failure' | 'pending'; detail: string } {
  // Unreadable evidence is a completeness failure no matter which checks are named: a required name could be supplied by the part we cannot see.
  if (items.some((c) => c.rawStatus === 'unreadable')) return { state: 'failure', detail: 'CI evidence is incomplete: commit statuses are not readable by this token (grant "Commit statuses: read"); refusing to treat the rest as green' };
  const considered = required.length ? items.filter((c) => required.some((r) => low(r) === low(c.name))) : items;
  const missing = required.filter((r) => !considered.some((c) => low(c.name) === low(r)));
  const bad = considered.filter((c) => c.state === 'failed' || c.state === 'unknown'); // cancelled/unrecognised is not a pass
  if (bad.length) return { state: 'failure', detail: `Failed or inconclusive: ${bad.map((c) => `${c.name} (${c.rawConclusion ?? c.rawStatus ?? c.state})`).join(', ')}` };
  if (missing.length) return { state: 'pending', detail: `Waiting for required check(s): ${missing.join(', ')}` };
  if (!considered.length) return { state: 'pending', detail: 'No CI checks reported for this commit yet' };
  const pending = considered.filter((c) => c.state === 'pending');
  if (pending.length) return { state: 'pending', detail: `Still running: ${pending.map((c) => c.name).join(', ')}` };
  return { state: 'success', detail: `All green: ${considered.map((c) => c.name).join(', ')}` };
}

export class GithubCi implements CiProvider {
  constructor(private gh: Getter, private o: { pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}) {}

  /**
   * Complete CI evidence for the SHA: check runs (or, if the token cannot read them, the latest workflow run per workflow), PLUS the combined
   * commit statuses of external CI, read independently of which route the first part took. Any part that cannot be read completely is
   * recorded as an explicit "unreadable" marker, which evaluateChecks() treats as a failure regardless of name filtering.
   */
  private async items(repo: string, sha: string): Promise<CheckItem[]> {
    return [...(await this.runs(repo, sha)), ...(await this.statuses(repo, sha))];
  }

  private async runs(repo: string, sha: string): Promise<CheckItem[]> {
    try {
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
    } catch (e) {
      if (!(e instanceof SourceError) || e.kind !== 'auth') throw e;
      // Token cannot read check runs: fall back to the latest workflow run per workflow for exactly this head SHA.
      const raw = await this.gh.get(`/repos/${repo}/actions/runs`, { head_sha: sha, per_page: 100 });
      if (isObj(raw) && typeof raw.total_count === 'number' && Array.isArray(raw.workflow_runs) && raw.total_count > raw.workflow_runs.length) throw new SourceError('invalid', 'incomplete workflow-run list: refusing to treat partial CI evidence as green');
      const runs = normalizeRuns(raw).filter((r) => r.sha === sha);
      const latest = new Map<string, (typeof runs)[number]>();
      for (const r of runs.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))) latest.set(r.name, r);
      return [...latest.values()].map((r): CheckItem => ({
        name: r.name, rawStatus: r.status, rawConclusion: r.conclusion, url: r.url, source: 'workflow_run', at: r.at,
        state: r.status !== 'completed' ? 'pending' : r.conclusion === 'success' || r.conclusion === 'neutral' || r.conclusion === 'skipped' ? 'passed' : r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'startup_failure' ? 'failed' : 'unknown',
      }));
    }
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

  async snapshot(repo: string, sha: string, o: { required: string[] }): Promise<CiResult> {
    const items = await this.items(repo, sha);
    const r = evaluateChecks(items, o.required);
    return { state: r.state === 'pending' ? 'timeout' : r.state, detail: r.state === 'pending' ? `Not green now: ${r.detail}` : r.detail, checks: items.map((c) => ({ name: c.name, state: c.state, url: c.url })) };
  }

  async wait(repo: string, sha: string, o: { required: string[]; timeoutMs: number }): Promise<CiResult> {
    const now = this.o.now ?? Date.now, sleep = this.o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = now() + o.timeoutMs;
    let greens = 0, last = { state: 'pending' as 'success' | 'failure' | 'pending', detail: 'not polled' }, items: CheckItem[] = [];
    for (;;) {
      items = await this.items(repo, sha);
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
