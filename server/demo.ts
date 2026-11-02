// Explicitly-labelled SYNTHETIC data for DEVFLOW_DEMO=1 and tests. It is served through a fake `fetch`,
// so the real client/normalizer code paths run unchanged. Nothing here is real Linear or GitHub data.
import { parseConfig, type Config } from './config.ts';

export function demoConfig(): Config {
  return parseConfig({
    staleAfterMinutes: 5, staleDays: 5,
    obsidian: { vault: 'Demo-Vault', vaultPath: '/example/vault' },
    review: { checkName: 'independent-review', passedLabel: 'review:passed', findingsLabel: 'review:findings' },
    projects: [
      { id: 'atlas', name: 'Atlas Platform (demo)', linear: { teamKey: 'ATL', projects: [] }, github: { repos: ['demo-org/atlas'] },
        knowledge: [
          { title: 'Atlas architecture', kind: 'obsidian', path: 'Projects/Atlas/Architecture.md' },
          { title: 'Repo contract', kind: 'repo', repo: 'demo-org/atlas', path: 'docs/CONTRACT.md', ref: 'main' },
        ] },
      { id: 'beacon', name: 'Beacon Mobile (demo)', linear: { teamKey: 'BCN', projects: [] }, github: { repos: ['demo-org/beacon'] }, knowledge: [] },
    ],
  });
}

const H = 3600_000;
const ago = (hours: number, now: number) => new Date(now - hours * H).toISOString();
const day = (offsetDays: number, now: number) => new Date(now + offsetDays * 86400_000).toISOString().slice(0, 10);

type St = [name: string, type: string];
const S = {
  backlog: ['Backlog', 'backlog'] as St, todo: ['Ready', 'unstarted'] as St, prog: ['In Progress', 'started'] as St,
  rev: ['In Review', 'started'] as St, done: ['Done', 'completed'] as St, canc: ['Canceled', 'canceled'] as St,
};
interface IssueSpec { n: number; title: string; s: St; ms?: string; blockedBy?: number[]; parent?: number; ageH: number; prio?: number; labels?: string[]; branch?: string }

const ISSUES: Record<string, IssueSpec[]> = {
  ATL: [
    { n: 1, title: 'Set up service skeleton', s: S.done, ms: 'm1', ageH: 300 },
    { n: 2, title: 'Add health endpoint', s: S.done, ms: 'm1', ageH: 200 },
    { n: 3, title: 'Implement ingest pipeline', s: S.prog, ms: 'm2', ageH: 4, prio: 1 },
    { n: 4, title: 'Add retry policy', s: S.rev, ms: 'm2', ageH: 6, prio: 2 },
    { n: 5, title: 'Metrics exporter', s: S.prog, ms: 'm2', ageH: 2, prio: 3 },
    { n: 6, title: 'Dashboards on ingest data', s: S.todo, ms: 'm2', blockedBy: [3], ageH: 30, prio: 2 },
    { n: 7, title: 'Config validation', s: S.todo, ms: 'm2', ageH: 40, prio: 3 },
    { n: 8, title: 'Investigate multi-region', s: S.backlog, ageH: 100 },
    { n: 9, title: 'Migrate legacy cron jobs', s: S.prog, ms: 'm1', ageH: 290, prio: 2 },
    { n: 10, title: 'Ingest schema validation', s: S.prog, ms: 'm2', parent: 3, ageH: 5 },
    { n: 11, title: 'Rate limiter', s: S.prog, ms: 'm2', ageH: 8, prio: 2 },
    { n: 12, title: 'Drop XML support', s: S.canc, ms: 'm1', ageH: 250 },
    { n: 13, title: 'Audit log export', s: S.rev, ms: 'm2', ageH: 7, prio: 2 },
    { n: 14, title: 'Bulk import', s: S.rev, ms: 'm2', ageH: 9, prio: 3, branch: 'atl-14-bulk-import' },
  ],
  BCN: [
    { n: 1, title: 'Login screen', s: S.done, ms: 'b1', ageH: 90 },
    { n: 2, title: 'Push notifications', s: S.prog, ms: 'b1', ageH: 3, prio: 2 },
    { n: 3, title: 'Offline cache', s: S.todo, ms: 'b1', blockedBy: [2], ageH: 20 },
    { n: 4, title: 'Onboarding polish', s: S.backlog, ageH: 60 },
  ],
};
const MILESTONES: Record<string, { id: string; name: string; description: string; off: number }[]> = {
  ATL: [{ id: 'm1', name: 'M1 Foundations', description: 'Service skeleton and ops basics', off: -5 }, { id: 'm2', name: 'M2 Ingest', description: 'Ingest pipeline end to end', off: 10 }],
  BCN: [{ id: 'b1', name: 'Beta', description: 'Closed beta feature set', off: 21 }],
};

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
];
const sha = (repoIdx: number, n: number) => (`${repoIdx}${n.toString(16)}`.padEnd(7, 'a') + 'b'.repeat(33)).slice(0, 40);

export function demoFetch(nowMs = Date.now()): typeof fetch {
  const repos = ['demo-org/atlas', 'demo-org/beacon'];
  const raw = (team: string, s: IssueSpec) => {
    const id = `${team}-${s.n}`;
    const rel = (n: number) => ({ identifier: `${team}-${n}`, title: ISSUES[team]!.find((x) => x.n === n)!.title, url: `https://example.invalid/linear/${team}-${n}`, state: { name: ISSUES[team]!.find((x) => x.n === n)!.s[0], type: ISSUES[team]!.find((x) => x.n === n)!.s[1] } });
    return {
      id: `uuid-${id}`, identifier: id, title: s.title, description: `Synthetic description for ${id}.\n\nAcceptance: demo only.`,
      url: `https://example.invalid/linear/${id}`, priority: s.prio ?? 0, priorityLabel: ['No priority', 'Urgent', 'High', 'Medium', 'Low'][s.prio ?? 0],
      createdAt: ago(s.ageH + 100, nowMs), updatedAt: ago(s.ageH, nowMs), completedAt: s.s[1] === 'completed' ? ago(s.ageH, nowMs) : null, dueDate: null,
      branchName: s.branch ?? null, state: { name: s.s[0], type: s.s[1] }, assignee: { name: 'Demo Dev' },
      labels: { nodes: s.n === 9 ? [{ name: 'tech-debt' }] : [] }, project: { id: `lp-${team}`, name: team === 'ATL' ? 'Atlas' : 'Beacon' },
      projectMilestone: s.ms ? { id: s.ms } : null, parent: s.parent ? { identifier: `${team}-${s.parent}` } : null,
      relations: { nodes: ISSUES[team]!.filter((o) => o.blockedBy?.includes(s.n)).map((o) => ({ type: 'blocks', relatedIssue: rel(o.n) })) },
      inverseRelations: { nodes: (s.blockedBy ?? []).map((n) => ({ type: 'blocks', issue: rel(n) })) },
      attachments: { nodes: [] },
      history: { nodes: [{ createdAt: ago(s.ageH, nowMs), fromState: { name: 'Ready' }, toState: { name: s.s[0] }, actor: { name: 'Demo Dev' } }] },
    };
  };
  const linear = (body: { query: string; variables: Record<string, any> }) => {
    const v = body.variables;
    if (body.query.includes('TeamProjects')) {
      const key = v.key as string;
      if (!ISSUES[key]) return { data: { teams: { nodes: [] } } };
      return { data: { teams: { nodes: [{ id: `t-${key}`, key, name: key, projects: { nodes: [{ id: `lp-${key}`, name: key === 'ATL' ? 'Atlas' : 'Beacon', slugId: key.toLowerCase(), url: `https://example.invalid/linear/project/${key}`, documents: { nodes: key === 'ATL' ? [{ id: 'd1', title: 'Atlas product brief', url: 'https://example.invalid/linear/doc/atlas-brief' }] : [] } }] } }] } } };
    }
    if (body.query.includes('IssueDetail')) {
      const m = String(v.id).match(/^([A-Z]+)-(\d+)$/);
      const spec = m && ISSUES[m[1]!]?.find((x) => x.n === Number(m[2]));
      return { data: { issue: spec ? raw(m![1]!, spec) : null } };
    }
    if (body.query.includes('Milestones')) {
      const key = String(v.id).replace('lp-', '');
      return { data: { project: { projectMilestones: { nodes: (MILESTONES[key] ?? []).map((m) => ({ id: m.id, name: m.name, description: m.description, targetDate: day(m.off, nowMs) })), pageInfo: { hasNextPage: false, endCursor: null } } } } };
    }
    const key = v.filter?.team?.key?.eq as string;
    const all = (ISSUES[key] ?? []).map((s) => ({ ...raw(key, s), description: undefined })); // list queries omit descriptions
    const start = Number(v.after ?? 0);
    const page = all.slice(start, start + 6); // small pages so pagination is exercised
    const more = start + 6 < all.length;
    return { data: { issues: { nodes: page, pageInfo: { hasNextPage: more, endCursor: more ? String(start + 6) : null } } } };
  };
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
        user: { login: 'demo-dev' }, head: { ref: p.branch, sha: sha(ri, p.n), repo: { html_url: `https://example.invalid/gh/${repo}` } }, base: { ref: 'main' },
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
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' } });
    if (url.hostname === 'api.linear.app') return json(linear(JSON.parse(String(init?.body))));
    if (url.hostname === 'api.github.com') {
      const r = gh(url.pathname + url.search);
      return r === undefined ? json({ message: 'Not Found' }, 404) : json(r);
    }
    return json({}, 404);
  }) as typeof fetch;
}
