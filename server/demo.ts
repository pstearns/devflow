// Explicitly-labelled SYNTHETIC data for DEVFLOW_DEMO=1 and tests. It is served through a fake `fetch`,
// so the real client/normalizer code paths run unchanged. Nothing here is real Linear or GitHub data.
import { parseConfig, type Config } from './config.ts';
import { createFakeLinear, type FakeLinearOpts, type FakeLinearStore } from './demo-linear.ts';

export { DEMO_READ_KEY, DEMO_WRITE_KEY } from './demo-linear.ts';

export function demoConfig(): Config {
  return parseConfig({
    staleAfterMinutes: 5, staleDays: 5,
    obsidian: { vault: 'Demo-Vault', vaultPath: '/example/vault' },
    review: { checkName: 'independent-review', passedLabel: 'review:passed', findingsLabel: 'review:findings' },
    projects: [
      // names ONE Linear project of team ATL: "Atlas Labs" and unprojected ATL issues are NOT covered by it
      { id: 'atlas', name: 'Atlas Platform (demo)', linear: { teamKey: 'ATL', projects: ['Atlas'] }, github: { repos: ['demo-org/atlas'] },
        knowledge: [
          { title: 'Atlas architecture', kind: 'obsidian', path: 'Projects/Atlas/Architecture.md' },
          { title: 'Repo contract', kind: 'repo', repo: 'demo-org/atlas', path: 'docs/CONTRACT.md', ref: 'main' },
        ] },
      // legacy whole-team style entry: covers every PROJECT of team BCN (but not its unprojected issues)
      { id: 'beacon', name: 'Beacon Mobile (demo)', linear: { teamKey: 'BCN', projects: [] }, github: { repos: ['demo-org/beacon'] }, knowledge: [] },
    ],
    // explicit team-level entry: its own vocabulary, write allowed, NO GitHub repository
    teams: [{ key: 'ZED', write: true, workflow: { readyLabel: 'Go', discoveryLabels: ['Spike'], classificationLabels: ['Chore'], readiness: { minDescriptionChars: 10 } } }],
  });
}

const H = 3600_000;
const ago = (hours: number, now: number) => new Date(now - hours * H).toISOString();
const day = (offsetDays: number, now: number) => new Date(now + offsetDays * 86400_000).toISOString().slice(0, 10);

type Chk = [name: string, status: string, conclusion?: string];
interface PrSpec { n: number; repo: string; branch: string; title: string; state: 'open' | 'merged' | 'closed'; draft?: boolean; labels?: string[]; checks: Chk[]; reviews?: [string, string][]; ageH: number; body?: string }
const OK: Chk = ['build', 'completed', 'success'];
const PRS: PrSpec[] = [
  { n: 1, repo: 'demo-org/atlas', branch: 'atl-1-skeleton', title: 'ATL-1 service skeleton', state: 'merged', checks: [OK], reviews: [['maria', 'APPROVED']], ageH: 290 },
  { n: 2, repo: 'demo-org/atlas', branch: 'atl-2-health', title: 'ATL-2: health endpoint', state: 'merged', checks: [OK], ageH: 190 },
  { n: 3, repo: 'demo-org/atlas', branch: 'atl-3-ingest', title: 'ATL-3 ingest pipeline', state: 'open', checks: [['build', 'completed', 'failure'], ['lint', 'completed', 'success']], ageH: 3 },
  { n: 4, repo: 'demo-org/atlas', branch: 'atl-4-retry', title: 'ATL-4 retry policy', state: 'open', checks: [OK], ageH: 5 },
  { n: 5, repo: 'demo-org/atlas', branch: 'atl-5-metrics', title: 'ATL-5 metrics exporter', state: 'open', checks: [['build', 'in_progress']], ageH: 1 },
  { n: 11, repo: 'demo-org/atlas', branch: 'atl-11-ratelimit', title: 'ATL-11 rate limiter', state: 'open', checks: [OK], reviews: [['maria', 'CHANGES_REQUESTED']], ageH: 8 },
  { n: 13, repo: 'demo-org/atlas', branch: 'atl-13-audit', title: 'ATL-13 audit log export', state: 'open', checks: [OK, ['independent-review', 'completed', 'success']], ageH: 6 },
  { n: 14, repo: 'demo-org/atlas', branch: 'feature/bulk', title: 'Bulk import for ATL-14 and ATL-7', state: 'open', checks: [OK], ageH: 9 },
  { n: 15, repo: 'demo-org/atlas', branch: 'chore/bump-deps', title: 'Bump dependencies', state: 'open', checks: [OK], ageH: 12 },
  { n: 16, repo: 'demo-org/atlas', branch: 'atl-9-cron', title: 'ATL-9 migrate cron (abandoned)', state: 'closed', checks: [], ageH: 280 },
  { n: 2, repo: 'demo-org/beacon', branch: 'bcn-2-push', title: 'BCN-2 push notifications', state: 'open', draft: true, checks: [], ageH: 2 },
  // scope traps: each mentions a ticket whose project/team is NOT served by this repository, so it must stay unlinked
  { n: 7, repo: 'demo-org/beacon', branch: 'atl-3-from-beacon', title: 'ATL-3 mention from the wrong repository', state: 'open', checks: [OK], ageH: 4 },
  { n: 20, repo: 'demo-org/atlas', branch: 'atl-20-inbox', title: 'ATL-20 unprojected issue (atlas repo is project-scoped)', state: 'open', checks: [OK], ageH: 5 },
  { n: 21, repo: 'demo-org/atlas', branch: 'atl-21-lab-prototype', title: 'ATL-21 lab prototype (project Atlas Labs)', state: 'open', checks: [OK], ageH: 6 },
];
const sha = (repoIdx: number, n: number) => (`${repoIdx}${n.toString(16)}`.padEnd(7, 'a') + 'b'.repeat(33)).slice(0, 40);

export function demoFetch(nowMs = Date.now(), linearOpts: FakeLinearOpts = {}): typeof fetch & { store: FakeLinearStore } {
  const repos = ['demo-org/atlas', 'demo-org/beacon'];
  const lin = createFakeLinear(nowMs, linearOpts);
  const gh = (path: string): unknown => {
    const m = path.match(/^\/repos\/([^/]+\/[^/]+)\/(.*)$/);
    if (!m) return undefined;
    const repo = m[1]!, rest = m[2]!, ri = repos.indexOf(repo);
    const specs = PRS.filter((p) => p.repo === repo);
    const sm = (re: RegExp) => rest.match(re);
    let x: RegExpMatchArray | null;
    if ((x = sm(/^pulls\/(\d+)$/))) return gh(`/repos/${repo}/pulls?page=1`) === undefined ? undefined : (gh(`/repos/${repo}/pulls?page=1`) as { number: number }[]).find((q) => q.number === Number(x![1]));
    if (rest.startsWith('pulls?') || rest === 'pulls') {
      if (new URL('https://x/' + rest).searchParams.get('page') !== '1') return [];
      return specs.map((p) => ({
        number: p.n, title: p.title, html_url: `https://example.invalid/gh/${repo}/pull/${p.n}`, state: p.state === 'open' ? 'open' : 'closed', draft: !!p.draft,
        merged_at: p.state === 'merged' ? ago(p.ageH, nowMs) : null, created_at: ago(p.ageH + 5, nowMs), updated_at: ago(p.ageH, nowMs),
        user: { login: 'demo-dev' }, head: { ref: p.branch, sha: sha(ri, p.n), repo: { html_url: `https://example.invalid/gh/${repo}` } }, base: { ref: 'main', repo: { full_name: repo } }, merged: p.state === 'merged',
        labels: (p.labels ?? []).map((name) => ({ name })),
      }));
    }
    if ((x = sm(/^commits\/(\w+)\/check-runs/))) {
      const p = specs.find((s) => sha(ri, s.n) === x![1]);
      return { total_count: (p?.checks ?? []).length, check_runs: (p?.checks ?? []).map((c, i) => ({ name: c[0], status: c[1], conclusion: c[2] ?? null, html_url: `https://example.invalid/gh/${repo}/runs/${p!.n}${i}`, completed_at: ago(p!.ageH, nowMs) })) };
    }
    if (sm(/^commits\/(\w+)\/status/)) return { state: 'pending', statuses: [] };
    if ((x = sm(/^pulls\/(\d+)\/reviews/))) {
      const p = specs.find((s) => s.n === Number(x![1]));
      return (p?.reviews ?? []).map(([user, state]) => ({ user: { login: user }, state, submitted_at: ago(p!.ageH, nowMs), html_url: `https://example.invalid/gh/${repo}/pull/${p!.n}#review` }));
    }
    if ((x = sm(/^pulls\/(\d+)\/commits/))) {
      const p = specs.find((s) => s.n === Number(x![1]));
      return [{ sha: sha(ri, p!.n), html_url: `https://example.invalid/gh/${repo}/commit/${sha(ri, p!.n)}`, commit: { message: `${p!.title}\n\nbody`, author: { name: 'Demo Dev', date: ago(p!.ageH + 1, nowMs) } } }];
    }
    if (rest.startsWith('actions/runs')) {
      return { workflow_runs: specs.filter((p) => p.checks.length).map((p, i) => {
        const c = p.checks[0]!;
        return { id: 9000 + p.n + ri * 100 + i, name: 'CI', display_title: p.title, status: c[1], conclusion: c[2] ?? null, head_branch: p.branch, head_sha: sha(ri, p.n), html_url: `https://example.invalid/gh/${repo}/actions/runs/${9000 + p.n}`, updated_at: ago(p.ageH, nowMs), event: 'pull_request' };
      }) };
    }
    return undefined;
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' } });
    if (url.hostname === 'api.linear.app') {
      const auth = new Headers(init?.headers).get('authorization') ?? undefined;
      const r = lin.handle(JSON.parse(String(init?.body)), auth);
      if (r.lost) throw new TypeError('fetch failed'); // committed upstream, but the caller never saw the answer
      return json(r.json, r.status);
    }
    if (url.hostname === 'api.github.com') {
      const r = gh(url.pathname + url.search);
      return r === undefined ? json({ message: 'Not Found' }, 404) : json(r);
    }
    return json({}, 404);
  }) as typeof fetch & { store: FakeLinearStore };
  fetchImpl.store = lin.store; // exposed so tests can inspect what was (and was not) mutated
  return fetchImpl;
}
