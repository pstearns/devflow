// SYNTHETIC in-memory Linear used by DEVFLOW_DEMO=1 and the tests. It models labels (with colors, one group label),
// workflow states, milestones, comments and the few mutations DevFlow is allowed to send. It is never reachable
// in live mode and contains no real data. Mutations require the separate demo WRITE key, mirroring credential isolation.
export const DEMO_READ_KEY = 'demo';
export const DEMO_WRITE_KEY = 'demo-write';

const H = 3600_000;
const ago = (hours: number, now: number) => new Date(now - hours * H).toISOString();
const day = (offsetDays: number, now: number) => new Date(now + offsetDays * 86400_000).toISOString().slice(0, 10);

type StateType = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';
const STATE_DEFS: [name: string, type: StateType][] = [['Backlog', 'backlog'], ['Todo', 'unstarted'], ['In Progress', 'started'], ['In Review', 'started'], ['Done', 'completed'], ['Canceled', 'canceled']];

interface LabelSpec { id: string; name: string; color: string; isGroup?: boolean; parent?: string; workspace?: boolean }
const LABELS: LabelSpec[] = [
  { id: 'lbl-ready', name: 'Ready', color: '#4EA7FC' }, { id: 'lbl-discovery', name: 'Discovery', color: '#F2C94C' },
  { id: 'lbl-idea', name: 'Idea', color: '#BB87FC' }, { id: 'lbl-research', name: 'Research', color: '#26B5CE' },
  { id: 'lbl-security', name: 'Security', color: '#F2994A' }, { id: 'lbl-techdebt', name: 'Tech Debt', color: '#95A2B3' },
  { id: 'lbl-bug', name: 'Bug', color: '#EB5757', workspace: true }, { id: 'lbl-feature', name: 'Feature', color: '#4CB782', workspace: true },
  { id: 'lbl-area', name: 'Area', color: '#6B6F76', isGroup: true }, { id: 'lbl-area-api', name: 'API', color: '#6B6F76', parent: 'Area' },
  { id: 'lbl-newcustom', name: 'Needs Design', color: '#E5A663' }, // proves labels are not hard-coded: unknown labels just work
];

export interface IssueSpec { n: number; title: string; state: string; ms?: string; blockedBy?: number[]; parent?: number; ageH: number; prio?: number; labels?: string[]; branch?: string; desc?: string }
const LONG = 'Synthetic description. Acceptance criteria are written down here so the readiness policy minimum length is satisfied.';
const SEED: Record<string, IssueSpec[]> = {
  ATL: [
    { n: 1, title: 'Set up service skeleton', state: 'Done', ms: 'm1', ageH: 300, labels: ['Feature'] },
    { n: 2, title: 'Add health endpoint', state: 'Done', ms: 'm1', ageH: 200, labels: ['Feature'] },
    { n: 3, title: 'Implement ingest pipeline', state: 'In Progress', ms: 'm2', ageH: 4, prio: 1, labels: ['Feature'] },
    { n: 4, title: 'Add retry policy', state: 'In Review', ms: 'm2', ageH: 6, prio: 2, labels: ['Feature'] },
    { n: 5, title: 'Metrics exporter', state: 'In Progress', ms: 'm2', ageH: 2, prio: 3, labels: ['Tech Debt'] },
    { n: 6, title: 'Dashboards on ingest data', state: 'Todo', ms: 'm2', blockedBy: [3], ageH: 30, prio: 2, labels: ['Ready', 'Feature'] },
    { n: 7, title: 'Config validation', state: 'Todo', ms: 'm2', ageH: 40, prio: 3, labels: ['Ready', 'Feature'] },
    { n: 8, title: 'Investigate multi-region', state: 'Backlog', ageH: 100, labels: ['Research', 'Discovery'] },
    { n: 9, title: 'Migrate legacy cron jobs', state: 'In Progress', ms: 'm1', ageH: 290, prio: 2, labels: ['Tech Debt'] },
    { n: 10, title: 'Ingest schema validation', state: 'In Progress', ms: 'm2', parent: 3, ageH: 5, labels: ['Feature'] },
    { n: 11, title: 'Rate limiter', state: 'In Progress', ms: 'm2', ageH: 8, prio: 2, labels: ['Bug'] },
    { n: 12, title: 'Drop XML support', state: 'Canceled', ms: 'm1', ageH: 250 },
    { n: 13, title: 'Audit log export', state: 'In Review', ms: 'm2', ageH: 7, prio: 2, labels: ['Security'] },
    { n: 14, title: 'Bulk import', state: 'In Review', ms: 'm2', ageH: 9, prio: 3, branch: 'atl-14-bulk-import', labels: ['Feature'] },
    { n: 15, title: 'Plan observability roadmap', state: 'Backlog', ageH: 60, labels: ['Idea'] },
    { n: 16, title: 'Write rate-limit documentation', state: 'Todo', ms: 'm2', ageH: 20, prio: 3, labels: ['Feature'], desc: LONG },
    { n: 17, title: 'Tidy configs', state: 'Backlog', ageH: 15, desc: 'tbd' },
    { n: 18, title: 'Backfill ingest history', state: 'Backlog', blockedBy: [3], ageH: 12, labels: ['Feature'], desc: LONG },
    { n: 19, title: 'Add API pagination', state: 'Backlog', ms: 'm2', ageH: 11, prio: 2, labels: ['Feature'], desc: LONG },
  ],
  BCN: [
    { n: 1, title: 'Login screen', state: 'Done', ms: 'b1', ageH: 90, labels: ['Feature'] },
    { n: 2, title: 'Push notifications', state: 'In Progress', ms: 'b1', ageH: 3, prio: 2, labels: ['Feature'] },
    { n: 3, title: 'Offline cache', state: 'Todo', ms: 'b1', blockedBy: [2], ageH: 20, labels: ['Ready'] },
    { n: 4, title: 'Onboarding polish', state: 'Backlog', ageH: 60, labels: ['Idea'] },
  ],
};
const MILESTONES: Record<string, { id: string; name: string; description: string; off: number }[]> = {
  ATL: [{ id: 'm1', name: 'M1 Foundations', description: 'Service skeleton and ops basics', off: -5 }, { id: 'm2', name: 'M2 Ingest', description: 'Ingest pipeline end to end', off: 10 }],
  BCN: [{ id: 'b1', name: 'Beta', description: 'Closed beta feature set', off: 21 }],
};

export interface FakeLinearOpts {
  /** Make a named operation fail with a GraphQL error (used to test failure handling). */
  fail?: (op: string, vars: Record<string, any>) => boolean;
  /** Report success but apply nothing (used to test read-back verification). */
  silentNoop?: (op: string) => boolean;
}
export interface FakeLinearStore { issues: Record<string, IssueSpec[]>; comments: Map<string, { id: string; body: string; createdAt: string }[]>; mutations: { op: string; vars: Record<string, any> }[]; viewer: string }

export function createFakeLinear(nowMs: number, opts: FakeLinearOpts = {}) {
  const store: FakeLinearStore = { issues: structuredClone(SEED), comments: new Map(), mutations: [], viewer: 'Demo Owner' };
  const stateId = (team: string, name: string) => `st-${team}-${name.toLowerCase().replace(/\W+/g, '-')}`;
  const stateOf = (team: string, name: string) => { const d = STATE_DEFS.find((s) => s[0] === name) ?? STATE_DEFS[0]!; return { id: stateId(team, d[0]), name: d[0], type: d[1] }; };
  const teamStates = (team: string) => STATE_DEFS.map(([name, type], position) => ({ id: stateId(team, name), name, type, position }));
  const find = (ident: string) => { const m = /^([A-Z]+)-(\d+)$/.exec(ident); return m ? { team: m[1]!, spec: store.issues[m[1]!]?.find((x) => x.n === Number(m[2])) } : { team: '', spec: undefined }; };
  const byUuid = (id: string) => find(id.replace(/^uuid-/, ''));
  const label = (name: string) => LABELS.find((l) => l.name === name);
  const labelNodes = (s: IssueSpec) => (s.labels ?? []).map((n) => label(n)).filter(Boolean).map((l) => ({ id: l!.id, name: l!.name, color: l!.color }));
  const ref = (team: string, n: number) => { const s = store.issues[team]!.find((x) => x.n === n)!; const st = stateOf(team, s.state); return { identifier: `${team}-${n}`, title: s.title, url: `https://example.invalid/linear/${team}-${n}`, state: { name: st.name, type: st.type } }; };

  const raw = (team: string, s: IssueSpec, withDescription: boolean) => {
    const id = `${team}-${s.n}`, st = stateOf(team, s.state);
    return {
      id: `uuid-${id}`, identifier: id, title: s.title, description: withDescription ? (s.desc ?? `${LONG} (${id})`) : undefined,
      url: `https://example.invalid/linear/${id}`, priority: s.prio ?? 0, priorityLabel: ['No priority', 'Urgent', 'High', 'Medium', 'Low'][s.prio ?? 0],
      createdAt: ago(s.ageH + 100, nowMs), updatedAt: ago(s.ageH, nowMs), completedAt: st.type === 'completed' ? ago(s.ageH, nowMs) : null, dueDate: null,
      branchName: s.branch ?? null, state: { id: st.id, name: st.name, type: st.type }, assignee: { name: 'Demo Dev' },
      labels: { nodes: labelNodes(s) }, project: { id: `lp-${team}`, name: team === 'ATL' ? 'Atlas' : 'Beacon' },
      projectMilestone: s.ms ? { id: s.ms } : null, parent: s.parent ? { identifier: `${team}-${s.parent}` } : null,
      relations: { nodes: store.issues[team]!.filter((o) => o.blockedBy?.includes(s.n)).map((o) => ({ type: 'blocks', relatedIssue: ref(team, o.n) })) },
      inverseRelations: { nodes: (s.blockedBy ?? []).map((n) => ({ type: 'blocks', issue: ref(team, n) })) },
      attachments: { nodes: [] },
      history: { nodes: [{ createdAt: ago(s.ageH, nowMs), fromState: { name: 'Todo' }, toState: { name: st.name }, actor: { name: 'Demo Dev' } }] },
    };
  };

  const err = (message: string, code: string, status = 200) => ({ status, json: { errors: [{ message, extensions: { code } }] } });
  const ok = (data: unknown) => ({ status: 200, json: { data } });

  function handle(body: { query: string; variables: Record<string, any> }, auth: string | undefined) {
    const op = /^\s*(query|mutation)\s+(\w+)/.exec(body.query);
    const kind = op?.[1], name = op?.[2] ?? '';
    const v = body.variables ?? {};
    if (kind === 'mutation') {
      if (auth !== DEMO_WRITE_KEY) return err('Forbidden', 'FORBIDDEN', 403); // the read key can never mutate
      store.mutations.push({ op: name, vars: v });
      if (opts.fail?.(name, v)) return err('synthetic failure', 'INTERNAL_SERVER_ERROR');
      const noop = opts.silentNoop?.(name) === true;
      if (name === 'IssueAddLabel' || name === 'IssueRemoveLabel') {
        const { spec } = byUuid(String(v.id)); const l = LABELS.find((x) => x.id === v.labelId);
        if (!spec || !l) return err('Entity not found', 'INVALID_INPUT');
        if (!noop) spec.labels = name === 'IssueAddLabel' ? [...new Set([...(spec.labels ?? []), l.name])] : (spec.labels ?? []).filter((x) => x !== l.name);
        return ok({ [name === 'IssueAddLabel' ? 'issueAddLabel' : 'issueRemoveLabel']: { success: true } });
      }
      if (name === 'IssueUpdate') {
        const { team, spec } = byUuid(String(v.id)); const input = v.input ?? {};
        if (!spec) return err('Entity not found', 'INVALID_INPUT');
        if (!noop) {
          if ('stateId' in input) { const s = teamStates(team).find((x) => x.id === input.stateId); if (!s) return err('Invalid state', 'INVALID_INPUT'); spec.state = s.name; }
          if ('projectMilestoneId' in input) {
            if (input.projectMilestoneId !== null && !MILESTONES[team]?.some((m) => m.id === input.projectMilestoneId)) return err('Invalid milestone', 'INVALID_INPUT');
            spec.ms = input.projectMilestoneId ?? undefined;
          }
        }
        return ok({ issueUpdate: { success: true } });
      }
      if (name === 'CommentCreate') {
        const { spec } = byUuid(String(v.input?.issueId));
        if (!spec) return err('Entity not found', 'INVALID_INPUT');
        const key = String(v.input.issueId).replace(/^uuid-/, '');
        if (!noop) store.comments.set(key, [...(store.comments.get(key) ?? []), { id: `c-${store.mutations.length}`, body: String(v.input.body), createdAt: new Date(nowMs).toISOString() }]);
        return ok({ commentCreate: { success: true } });
      }
      return err('Unknown mutation', 'GRAPHQL_VALIDATION_FAILED');
    }
    if (name === 'Viewer') return ok({ viewer: { name: store.viewer } });
    if (name === 'TeamProjects') {
      const key = v.key as string;
      if (!store.issues[key]) return ok({ teams: { nodes: [] } });
      return ok({ teams: { nodes: [{ id: `t-${key}`, key, name: key, projects: { nodes: [{ id: `lp-${key}`, name: key === 'ATL' ? 'Atlas' : 'Beacon', slugId: key.toLowerCase(), url: `https://example.invalid/linear/project/${key}`, documents: { nodes: key === 'ATL' ? [{ id: 'd1', title: 'Atlas product brief', url: 'https://example.invalid/linear/doc/atlas-brief' }] : [] } }] } }] } });
    }
    if (name === 'Labels') {
      return ok({ issueLabels: { nodes: LABELS.map((l) => ({ id: l.id, name: l.name, color: l.color, isGroup: !!l.isGroup, parent: l.parent ? { name: l.parent } : null, team: l.workspace ? null : { key: v.key } })), pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    if (name === 'Milestones') {
      const key = String(v.id).replace('lp-', '');
      return ok({ project: { projectMilestones: { nodes: (MILESTONES[key] ?? []).map((m) => ({ id: m.id, name: m.name, description: m.description, targetDate: day(m.off, nowMs) })), pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (name === 'IssueDetail') {
      const { team, spec } = find(String(v.id));
      return ok({ issue: spec ? raw(team, spec, true) : null });
    }
    if (name === 'ActionIssue') {
      const { team, spec } = find(String(v.id));
      if (!spec) return ok({ issue: null });
      const r = raw(team, spec, true);
      return ok({ issue: { ...r, team: { id: `t-${team}`, key: team, states: { nodes: teamStates(team) } },
        project: { id: `lp-${team}`, name: r.project.name, projectMilestones: { nodes: (MILESTONES[team] ?? []).map((m) => ({ id: m.id, name: m.name })) } },
        projectMilestone: spec.ms ? { id: spec.ms, name: MILESTONES[team]?.find((m) => m.id === spec.ms)?.name ?? '?' } : null,
        comments: { nodes: store.comments.get(`${team}-${spec.n}`) ?? [] } } });
    }
    if (name === 'Issues') {
      const key = v.filter?.team?.key?.eq as string;
      const all = (store.issues[key] ?? []).map((s) => raw(key, s, false)); // list queries omit descriptions
      const start = Number(v.after ?? 0), page = all.slice(start, start + 6), more = start + 6 < all.length; // small pages: pagination exercised
      return ok({ issues: { nodes: page, pageInfo: { hasNextPage: more, endCursor: more ? String(start + 6) : null } } });
    }
    return err('Unknown operation', 'GRAPHQL_VALIDATION_FAILED');
  }
  return { handle, store };
}
