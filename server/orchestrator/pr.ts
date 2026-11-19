// Draft pull requests. This is the ONLY GitHub write DevFlow can perform: create a PR with draft:true. There is no method to mark it
// ready, merge, close, comment or edit. It uses its own token (GITHUB_WRITE_TOKEN), never the read token and never an ambient `gh` login.
import type { GithubClient } from '../github.ts';
import { SourceError, fetchJson, isObj, safeUrl, str } from '../util.ts';
import { RUN_BRANCH_RE } from './types.ts';

export interface PullRequest { number: number; url: string }
export interface PrState { headSha: string; headRef: string; headRepo: string; baseRef: string; open: boolean; draft: boolean }
export interface PullRequests {
  /** Returns the open PR for `branch`, creating a DRAFT one if none exists. */
  ensureDraft(repo: string, o: { branch: string; base: string; title: string; body: string }): Promise<PullRequest>;
  /** What GitHub currently shows for the PR. The controller refuses to proceed unless it is an open DRAFT from the run branch onto the configured base, at the reviewed SHA. */
  inspect(repo: string, number: number): Promise<PrState>;
  /** Whether the base branch is protected on GitHub (undefined if unreadable). Recorded as evidence; DevFlow's own writes never target it. */
  baseProtected?(repo: string, base: string): Promise<boolean | undefined>;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,200}$/;

export class GithubPrs implements PullRequests {
  constructor(private read: Pick<GithubClient, 'get'>, private writeToken: string, private fetchImpl: typeof fetch = fetch) {}

  async ensureDraft(repo: string, o: { branch: string; base: string; title: string; body: string }): Promise<PullRequest> {
    if (!REPO_RE.test(repo) || !BRANCH_RE.test(o.branch) || !BRANCH_RE.test(o.base)) throw new Error('invalid repo or branch name');
    if (!RUN_BRANCH_RE.test(o.branch) || RUN_BRANCH_RE.test(o.base)) throw new Error('invalid: pull requests may only be opened from a devflow/<ticket>-<run> branch');
    const owner = repo.split('/')[0]!;
    const open = await this.read.get(`/repos/${repo}/pulls`, { state: 'open', head: `${owner}:${o.branch}`, per_page: 5 });
    if (Array.isArray(open) && isObj(open[0]) && typeof open[0].number === 'number') {
      // Reusing a PR (e.g. after a lost response) must not accept one somebody changed: it has to be an open draft on the right base and head.
      const st = this.shape(open[0]);
      if (!st.open || !st.draft || st.baseRef !== o.base || st.headRef !== o.branch || st.headRepo !== repo) throw new Error(`existing pull request #${open[0].number} is not an open draft from ${o.branch} onto ${o.base}; refusing to reuse it`);
      return { number: open[0].number, url: safeUrl(open[0].html_url) ?? '' };
    }
    const res = await fetchJson(this.fetchImpl, `https://api.github.com/repos/${repo}/pulls`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${this.writeToken}`, 'content-type': 'application/json', 'x-github-api-version': '2022-11-28', 'user-agent': 'devflow-orchestrator' },
      body: JSON.stringify({ title: o.title.slice(0, 250), head: o.branch, base: o.base, body: o.body.slice(0, 20000), draft: true, maintainer_can_modify: false }),
    });
    if (res.status === 401 || res.status === 403) throw new SourceError('auth', 'GitHub rejected the write token for creating a pull request (needs Pull requests: write)');
    if (!res.ok || !isObj(res.json) || typeof res.json.number !== 'number') throw new SourceError('http', `GitHub did not create the pull request (HTTP ${res.status})`);
    if (res.json.draft !== true) throw new Error('GitHub created a non-draft pull request; refusing to continue'); // never silently accept a ready PR
    return { number: res.json.number, url: safeUrl(str(res.json.html_url, 500)) ?? '' };
  }

  async baseProtected(repo: string, base: string): Promise<boolean | undefined> {
    if (!REPO_RE.test(repo) || !BRANCH_RE.test(base)) return undefined;
    const b = await this.read.get(`/repos/${repo}/branches/${base}`);
    return isObj(b) && typeof b.protected === 'boolean' ? b.protected : undefined;
  }

  private shape(pr: unknown): PrState {
    const head = isObj(pr) && isObj(pr.head) ? pr.head : {}, base = isObj(pr) && isObj(pr.base) ? pr.base : {};
    const sha = str(head.sha, 64);
    if (!isObj(pr) || !sha) throw new SourceError('invalid', 'GitHub returned a pull request without a head SHA');
    return {
      headSha: sha, headRef: str(head.ref, 300) ?? '', headRepo: isObj(head.repo) ? str(head.repo.full_name, 200) ?? '' : '', baseRef: str(base.ref, 300) ?? '',
      open: pr.state === 'open', draft: pr.draft === true,
    };
  }

  async inspect(repo: string, number: number): Promise<PrState> {
    if (!REPO_RE.test(repo) || !Number.isInteger(number)) throw new Error('invalid repo or pull request number');
    return this.shape(await this.read.get(`/repos/${repo}/pulls/${number}`));
  }
}
