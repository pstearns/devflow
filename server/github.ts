// GitHub REST client (GET only) and normalization of untrusted payloads.
import type { CheckItem, CommitItem, ReviewItem, RunItem } from '../shared/types.ts';
import { Limiter, Memo, SourceError, arr, fetchJson, isObj, iso, num, safeUrl, str } from './util.ts';

const API = 'https://api.github.com';

export class GithubClient {
  rateLimit?: { remaining: number; resetAt?: string };
  private memo = new Memo();
  private limit = new Limiter(4);
  constructor(private token: string, private fetchImpl: typeof fetch = fetch) {}

  /** Read-only: the only HTTP verb this client can send is GET. */
  async get(path: string, params: Record<string, string | number> = {}): Promise<unknown> {
    if (!path.startsWith('/repos/')) throw new Error('GithubClient only reads /repos/ endpoints');
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await this.limit.run(() => fetchJson(this.fetchImpl, url.href, {
      method: 'GET',
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${this.token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'devflow-readonly' },
    }));
    const remHeader = res.headers.get('x-ratelimit-remaining');
    const remaining = remHeader === null ? NaN : Number(remHeader); // absent header must not read as "0 left"
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : undefined;
    if (Number.isFinite(remaining)) this.rateLimit = { remaining, resetAt };
    const retryAfter = Number(res.headers.get('retry-after'));
    const message = isObj(res.json) ? (str(res.json.message, 300) ?? '') : '';
    // Primary limit (remaining 0), secondary/abuse limit (403/429 + Retry-After or message), or plain 429.
    const limited = res.status === 429 || (res.status === 403 && (remaining === 0 || Number.isFinite(retryAfter) && retryAfter > 0 || /rate limit|abuse/i.test(message)));
    if (res.status === 401) throw new SourceError('auth', 'GitHub rejected the token (check GITHUB_TOKEN)');
    if (limited) {
      const until = Number.isFinite(retryAfter) && retryAfter > 0 ? new Date(Date.now() + retryAfter * 1000).toISOString() : resetAt;
      throw new SourceError('rate_limit', 'GitHub rate limit reached', until);
    }
    if (res.status === 403) {
      const need = (res.headers.get('x-accepted-github-permissions') ?? '').replace(/[^\w=,; -]/g, '').slice(0, 80);
      throw new SourceError('auth', `GitHub denied access${need ? ` (token needs: ${need})` : ' (token lacks a required read permission)'}`);
    }
    if (res.status === 404) throw new SourceError('not_found', 'GitHub resource not found (wrong repo name, or token cannot see it)');
    if (!res.ok) throw new SourceError('http', `GitHub returned HTTP ${res.status}`);
    if (res.json === undefined) throw new SourceError('invalid', 'GitHub returned a non-JSON response');
    return res.json;
  }

  cached<T>(key: string, ttl: number | ((v: T) => number), fn: () => Promise<T>, force = false) { return this.memo.get(key, ttl, fn, force); }
}

export interface RawPr {
  number: number; title: string; url?: string; state: 'open' | 'closed' | 'merged'; draft: boolean; author?: string;
  headRef: string; headSha: string; branchUrl?: string; baseRef: string; createdAt?: string; updatedAt?: string; mergedAt?: string; labels: string[];
}

export function normalizePr(raw: unknown): RawPr | undefined {
  if (!isObj(raw)) return undefined;
  const number = num(raw.number);
  const head = isObj(raw.head) ? raw.head : {};
  const base = isObj(raw.base) ? raw.base : {};
  const headRef = str(head.ref, 300);
  const headSha = str(head.sha, 64);
  if (number === undefined || !headRef || !headSha || !/^[0-9a-f]{7,64}$/i.test(headSha)) return undefined;
  const mergedAt = iso(raw.merged_at);
  const state = mergedAt ? 'merged' : raw.state === 'open' ? 'open' : 'closed';
  const repoUrl = isObj(head.repo) ? safeUrl(head.repo.html_url) : undefined;
  return {
    number, title: str(raw.title, 500) ?? '', url: safeUrl(raw.html_url), state, draft: raw.draft === true,
    author: isObj(raw.user) ? str(raw.user.login, 100) : undefined,
    headRef, headSha, baseRef: str(base.ref, 300) ?? '',
    branchUrl: state === 'open' && repoUrl ? `${repoUrl}/tree/${encodeURIComponent(headRef).replace(/%2F/g, '/')}` : undefined,
    createdAt: iso(raw.created_at), updatedAt: iso(raw.updated_at), mergedAt,
    labels: arr(raw.labels, 30).map((l) => (isObj(l) ? str(l.name, 100) : undefined)).filter((x): x is string => !!x),
  };
}

export function normalizeCheckRuns(raw: unknown): CheckItem[] {
  const runs = isObj(raw) ? arr(raw.check_runs, 300) : [];
  return runs.flatMap((r): CheckItem[] => {
    if (!isObj(r)) return [];
    const name = str(r.name, 200);
    if (!name) return [];
    const status = str(r.status, 30) ?? 'unknown';
    const conclusion = str(r.conclusion, 30);
    let state: CheckItem['state'] = 'unknown';
    if (status === 'completed') {
      if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') state = 'passed';
      else if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure' || conclusion === 'action_required') state = 'failed';
      else state = 'unknown'; // cancelled, stale, or unrecognised: not evidence of pass or fail
    } else if (status === 'queued' || status === 'in_progress' || status === 'waiting' || status === 'pending' || status === 'requested') state = 'pending';
    return [{ name, state, rawStatus: status, rawConclusion: conclusion, url: safeUrl(r.html_url), source: 'check_run', at: iso(r.completed_at) ?? iso(r.started_at) }];
  });
}

export function normalizeCommitStatuses(raw: unknown): CheckItem[] {
  const list = isObj(raw) ? arr(raw.statuses, 300) : [];
  return list.flatMap((s): CheckItem[] => {
    if (!isObj(s)) return [];
    const name = str(s.context, 200);
    if (!name) return [];
    const st = str(s.state, 20) ?? 'unknown';
    const state: CheckItem['state'] = st === 'success' ? 'passed' : st === 'failure' || st === 'error' ? 'failed' : st === 'pending' ? 'pending' : 'unknown';
    return [{ name, state, rawStatus: st, url: safeUrl(s.target_url), source: 'commit_status', at: iso(s.updated_at) }];
  });
}

export function normalizeReviews(raw: unknown): ReviewItem[] {
  return arr(raw, 300).flatMap((r): ReviewItem[] => {
    if (!isObj(r)) return [];
    const state = str(r.state, 30);
    const user = isObj(r.user) ? str(r.user.login, 100) : undefined;
    return state ? [{ user: user ?? 'unknown', state, at: iso(r.submitted_at), url: safeUrl(r.html_url) }] : [];
  });
}

export function normalizeCommits(raw: unknown): CommitItem[] {
  return arr(raw, 100).flatMap((c): CommitItem[] => {
    if (!isObj(c)) return [];
    const sha = str(c.sha, 64);
    const commit = isObj(c.commit) ? c.commit : {};
    if (!sha) return [];
    const author = isObj(commit.author) ? commit.author : {};
    return [{ sha, message: (str(commit.message, 1000) ?? '').split('\n')[0]!, author: str(author.name, 100), at: iso(author.date), url: safeUrl(c.html_url) }];
  });
}

export function normalizeRuns(raw: unknown): RunItem[] {
  const list = isObj(raw) ? arr(raw.workflow_runs, 100) : [];
  return list.flatMap((r): RunItem[] => {
    if (!isObj(r)) return [];
    const id = num(r.id);
    const sha = str(r.head_sha, 64);
    if (id === undefined || !sha) return [];
    return [{ id, name: str(r.name, 200) ?? str(r.display_title, 200) ?? 'workflow', status: str(r.status, 30) ?? 'unknown', conclusion: str(r.conclusion, 30), branch: str(r.head_branch, 300), sha, url: safeUrl(r.html_url), at: iso(r.updated_at) ?? iso(r.created_at), event: str(r.event, 40) }];
  });
}

export interface PrEvidenceState {
  ok: boolean; checksOk: boolean; reviewsOk: boolean; error?: string;
  checksPartial?: string; // CI evidence readable but incomplete (never reported as Passed)
  noFallback?: boolean; // check-runs response was malformed: do not substitute workflow runs
  checkRunsUnavailable?: boolean; // token cannot read check runs: CI comes from Actions workflow runs; check-run details are Unavailable
  reviewsPartial?: string;
}

export interface RepoData {
  prs: (RawPr & { checks: CheckItem[]; reviews: ReviewItem[]; commits: CommitItem[]; detail: PrEvidenceState })[];
  runs: RunItem[];
  warnings: string[];
}

const DETAIL_DAYS = 14;
const MAX_DETAIL = 30;
const MAX_PAGES = 3; // per resource: up to 300 items before evidence is declared truncated
const PENDING_TTL = 15_000; // evidence that is still moving
const SETTLED_TTL = 120_000; // evidence that looks final: still re-readable (checks can be re-run, reviews dismissed)
type PrDetail = RepoData['prs'][number];

/** A collection field must really be an array; a 200 with another shape is malformed evidence, not "nothing". */
function shaped(raw: unknown, field: string, label: string): unknown[] {
  if (!isObj(raw) || !Array.isArray(raw[field])) throw new SourceError('invalid', `GitHub ${label}: unexpected response shape`);
  return arr(raw[field], 100);
}

export type Denied = Map<string, string>; // resource -> first error message (reported once, not per PR)

interface Paged { items: unknown[]; truncated: boolean; extra?: Record<string, unknown> }

/** Bounded pagination. `truncated` means the budget ended before the server said there was no more. */
async function readPages(
  client: GithubClient, path: string, pick: (raw: unknown) => { items: unknown[]; total?: number; extra?: Record<string, unknown> },
): Promise<Paged> {
  const items: unknown[] = [];
  let extra: Record<string, unknown> | undefined;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const got = pick(await client.get(path, { per_page: 100, page }));
    items.push(...got.items);
    extra = got.extra ?? extra;
    const more = got.total !== undefined ? items.length < got.total && got.items.length > 0 : got.items.length === 100;
    if (!more) return { items, truncated: false, extra };
  }
  return { items, truncated: true, extra };
}

const checksTtl = (v: Paged) =>
  v.items.length > 0 && v.items.every((r) => isObj(r) && r.status === 'completed') ? SETTLED_TTL : PENDING_TTL;
const statusTtl = (v: Paged) => (v.extra?.state === 'pending' || v.items.length === 0 ? PENDING_TTL : SETTLED_TTL);

/** Reads checks/statuses/reviews/commits for ONE PR. `force` bypasses every cached entry. */
export async function fetchPrDetail(client: GithubClient, repo: string, p: RawPr, denied: Denied, force = false): Promise<PrDetail> {
  const base = `/repos/${repo}`;
  const settle = async <T>(what: string, pr: Promise<T>): Promise<T | undefined> => {
    try { return await pr; } catch (e) {
      if (e instanceof SourceError && (e.kind === 'rate_limit' || e.kind === 'network')) throw e;
      if (!denied.has(what)) denied.set(what, e instanceof SourceError ? e.message : 'unexpected error');
      return undefined;
    }
  };
  let malformedChecks = false;
  let unavailableChecks = false;
  const [runs, statuses, reviews, commits] = await Promise.all([
    settle('check runs', client.cached(`${repo}:checks:${p.headSha}`, checksTtl, () =>
      readPages(client, `${base}/commits/${p.headSha}/check-runs`, (r) => ({ items: shaped(r, 'check_runs', 'check runs'), total: isObj(r) ? num(r.total_count) : undefined })), force)
      .catch((e) => {
        if (e instanceof SourceError && e.kind === 'invalid') malformedChecks = true;
        // No access to check runs is an expected, labelled condition (not a warning and not a prompt): see ciStatus().
        if (e instanceof SourceError && e.kind === 'auth') { unavailableChecks = true; return undefined; }
        throw e;
      })),
    settle('commit statuses', client.cached(`${repo}:status:${p.headSha}`, statusTtl, () =>
      readPages(client, `${base}/commits/${p.headSha}/status`, (r) => ({ items: shaped(r, 'statuses', 'commit statuses'), total: isObj(r) ? num(r.total_count) : undefined, extra: { state: isObj(r) ? r.state : undefined } })), force)
      .catch((e) => { if (e instanceof SourceError && e.kind === 'auth') return undefined; throw e; })), // quiet: handled via checksPartial/Unavailable
    settle('reviews', client.cached(`${repo}:reviews:${p.number}:${p.updatedAt}`, SETTLED_TTL, () =>
      readPages(client, `${base}/pulls/${p.number}/reviews`, (r) => { if (!Array.isArray(r)) throw new SourceError('invalid', 'GitHub reviews: unexpected response shape'); return { items: arr(r, 100) }; }), force)),
    settle('commits', client.cached(`${repo}:commits:${p.number}:${p.headSha}`, SETTLED_TTL, () => client.get(`${base}/pulls/${p.number}/commits`, { per_page: 50 }).then((c) => { if (!Array.isArray(c)) throw new SourceError('invalid', 'GitHub commits: unexpected response shape'); return c; }), force)),
  ]);
  const checksOk = runs !== undefined;
  const reasons: string[] = [];
  if (runs?.truncated) reasons.push('check list truncated');
  if (checksOk && statuses === undefined) reasons.push('commit statuses unreadable');
  if (statuses?.truncated) reasons.push('status list truncated');
  return {
    ...p,
    checks: [...(runs ? normalizeCheckRuns({ check_runs: runs.items }) : []), ...(statuses ? normalizeCommitStatuses({ statuses: statuses.items }) : [])],
    reviews: normalizeReviews(reviews?.items), commits: normalizeCommits(commits),
    detail: {
      ok: checksOk && reviews !== undefined, checksOk, reviewsOk: reviews !== undefined, error: checksOk ? undefined : 'Check runs unreadable',
      checksPartial: reasons.length ? reasons.join('; ') : undefined, reviewsPartial: reviews?.truncated ? 'review list truncated' : undefined,
      noFallback: malformedChecks || undefined, checkRunsUnavailable: unavailableChecks || undefined,
    },
  };
}

/** Fallback CI evidence: latest workflow run per workflow name on the PR's head commit. */
export function applyRunFallback(prs: PrDetail[], runs: RunItem[]): void {
  for (const pr of prs) {
    if (pr.detail.checksOk || pr.detail.noFallback || !runs.length) continue;
    const latest = new Map<string, RunItem>();
    for (const r of runs.filter((x) => x.sha === pr.headSha).sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))) latest.set(r.name, r);
    if (!latest.size) continue;
    pr.checks.push(...[...latest.values()].map((r): CheckItem => ({
      name: r.name, rawStatus: r.status, rawConclusion: r.conclusion, url: r.url, source: 'workflow_run', at: r.at,
      state: r.status !== 'completed' ? 'pending' : r.conclusion === 'success' || r.conclusion === 'neutral' || r.conclusion === 'skipped' ? 'passed' : r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'startup_failure' ? 'failed' : 'unknown',
    })));
    pr.detail.checksOk = true; // evidence exists, from workflow runs only
  }
}

export async function fetchRepo(client: GithubClient, repo: string, force = false, now = Date.now()): Promise<RepoData> {
  const warnings: string[] = [];
  const base = `/repos/${repo}`;
  const raw: unknown[] = [];
  for (let page = 1; page <= 2; page++) {
    const batch = await client.get(`${base}/pulls`, { state: 'all', sort: 'updated', direction: 'desc', per_page: 50, page });
    if (!Array.isArray(batch)) throw new SourceError('invalid', 'GitHub pulls: unexpected response shape');
    raw.push(...batch);
    if (batch.length < 50) break;
    if (page === 2) warnings.push('Only the 100 most recently updated PRs are read');
  }
  const prs = raw.map(normalizePr).filter((x): x is RawPr => !!x);
  if (prs.length < raw.length) warnings.push(`${raw.length - prs.length} malformed PR(s) skipped`);

  const cutoff = now - DETAIL_DAYS * 86400000;
  const wantsDetail = (p: RawPr) => p.state === 'open' || Date.parse(p.updatedAt ?? '') > cutoff;
  let budget = MAX_DETAIL;
  const out: PrDetail[] = [];
  const denied: Denied = new Map();
  for (const p of prs) {
    if (!wantsDetail(p) || budget <= 0) {
      out.push({ ...p, checks: [], reviews: [], commits: [], detail: { ok: false, checksOk: false, reviewsOk: false, error: 'Details not fetched (older PR)' } });
      continue;
    }
    budget--;
    out.push(await fetchPrDetail(client, repo, p, denied, force));
  }
  let runs: RunItem[] = [];
  try {
    runs = normalizeRuns(await client.cached(`${repo}:runs`, PENDING_TTL, async () => {
      const r = await client.get(`${base}/actions/runs`, { per_page: 40 });
      if (!isObj(r) || !Array.isArray(r.workflow_runs)) throw new SourceError('invalid', 'GitHub workflow runs: unexpected response shape');
      return r;
    }, force));
  } catch (e) {
    if (e instanceof SourceError && (e.kind === 'rate_limit' || e.kind === 'network')) throw e;
    denied.set('workflow runs', e instanceof SourceError ? e.message : 'error');
  }
  applyRunFallback(out, runs);
  const partial = out.filter((x) => x.detail.checksPartial || x.detail.reviewsPartial);
  if (partial.length) warnings.push(`${partial.length} PR(s) have incomplete evidence (${[...new Set(partial.flatMap((x) => [x.detail.checksPartial, x.detail.reviewsPartial]).filter(Boolean))].join('; ')}); shown as Unknown, not Passed`);
  for (const [what, msg] of denied) warnings.push(`${what}: ${msg}`);
  return { prs: out, runs, warnings };
}
