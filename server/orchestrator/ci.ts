// CI evidence for an exact SHA, read from GitHub (GET only, via the existing client). Missing or pending evidence is never a pass.
import type { GithubClient } from '../github.ts';
import { normalizeCheckRuns, normalizeRuns } from '../github.ts';
import type { CheckItem } from '../../shared/types.ts';
import { SourceError } from '../util.ts';

export interface CiResult { state: 'success' | 'failure' | 'timeout'; detail: string; checks: { name: string; state: string; url?: string }[] }
export interface CiProvider {
  /** One immediate read of the CURRENT results for the SHA (no waiting): used at the gate and at approval, because check results are not immutable. */
  snapshot(repo: string, sha: string, o: { required: string[] }): Promise<CiResult>;
  wait(repo: string, sha: string, o: { required: string[]; timeoutMs: number }): Promise<CiResult>;
}

type Getter = Pick<GithubClient, 'get'>;
const low = (s: string) => s.toLowerCase();

export function evaluateChecks(items: CheckItem[], required: string[]): { state: 'success' | 'failure' | 'pending'; detail: string } {
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

  private async items(repo: string, sha: string): Promise<CheckItem[]> {
    try {
      return normalizeCheckRuns(await this.gh.get(`/repos/${repo}/commits/${sha}/check-runs`, { per_page: 100 }));
    } catch (e) {
      if (!(e instanceof SourceError) || e.kind !== 'auth') throw e;
      // Token cannot read check runs: fall back to the latest workflow run per workflow for exactly this head SHA.
      const runs = normalizeRuns(await this.gh.get(`/repos/${repo}/actions/runs`, { head_sha: sha, per_page: 50 })).filter((r) => r.sha === sha);
      const latest = new Map<string, (typeof runs)[number]>();
      for (const r of runs.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))) latest.set(r.name, r);
      return [...latest.values()].map((r): CheckItem => ({
        name: r.name, rawStatus: r.status, rawConclusion: r.conclusion, url: r.url, source: 'workflow_run', at: r.at,
        state: r.status !== 'completed' ? 'pending' : r.conclusion === 'success' || r.conclusion === 'neutral' || r.conclusion === 'skipped' ? 'passed' : r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'startup_failure' ? 'failed' : 'unknown',
      }));
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
