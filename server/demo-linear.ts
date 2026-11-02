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

interface LabelSpec { id: string; name: string; color: string; isGroup?: boolean; parent?: string }
// Workspace labels are shared by every team (same ids); each team also has its own label set with its own ids/names.
const WORKSPACE: LabelSpec[] = [{ id: 'lbl-bug', name: 'Bug', color: '#EB5757' }, { id: 'lbl-feature', name: 'Feature', color: '#4CB782' }];
const TEAM_LABELS: Record<string, LabelSpec[]> = {
  ATL: [
    { id: 'lbl-ready', name: 'Ready', color: '#4EA7FC' }, { id: 'lbl-discovery', name: 'Discovery', color: '#F2C94C' },
    { id: 'lbl-idea', name: 'Idea', color: '#BB87FC' }, { id: 'lbl-research', name: 'Research', color: '#26B5CE' },
    { id: 'lbl-security', name: 'Security', color: '#F2994A' }, { id: 'lbl-techdebt', name: 'Tech Debt', color: '#95A2B3' },
    { id: 'lbl-area', name: 'Area', color: '#6B6F76', isGroup: true }, { id: 'lbl-area-api', name: 'API', color: '#6B6F76', parent: 'Area' },
    { id: 'lbl-newcustom', name: 'Needs Design', color: '#E5A663' }, // proves labels are not hard-coded: unknown labels just work
  ],
  BCN: [{ id: 'lbl-bcn-ready', name: 'Ready', color: '#2D9CDB' }, { id: 'lbl-bcn-idea', name: 'Idea', color: '#9B51E0' }],
  // a team with a completely different vocabulary: its "ready" label is called Go
  ZED: [{ id: 'lbl-zed-go', name: 'Go', color: '#27AE60' }, { id: 'lbl-zed-spike', name: 'Spike', color: '#F2C94C' }, { id: 'lbl-zed-chore', name: 'Chore', color: '#828282' }],
  QAT: [{ id: 'lbl-qat-triage', name: 'Triage', color: '#F2994A' }],
};
const labelsOf = (team: string): LabelSpec[] => [...(TEAM_LABELS[team] ?? []), ...WORKSPACE];
const findLabel = (team: string, name: string) => labelsOf(team).find((l) => l.name === name);

export interface IssueSpec { n: number; title: string; state: string; project?: string | null; ms?: string; blockedBy?: number[]; parent?: number; ageH: number; prio?: number; labels?: string[]; branch?: string; desc?: string }
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
    { n: 18, title: 'Backfill ingest history', state: 'Backlog', blockedBy: [3, 5, 10, 11], ageH: 12, labels: ['Feature'], desc: LONG },
    { n: 19, title: 'Add API pagination', state: 'Backlog', ms: 'm2', ageH: 11, prio: 2, labels: ['Feature'], desc: LONG },
    { n: 20, title: 'Triage inbox cleanup (no project)', state: 'Backlog', project: null, ageH: 8, labels: ['Idea'], desc: LONG },
    { n: 21, title: 'Lab prototype for streaming', state: 'Backlog', project: 'lp-ATL2', ageH: 14, labels: ['Research'], desc: LONG },
  ],
  BCN: [
    { n: 1, title: 'Login screen', state: 'Done', ms: 'b1', ageH: 90, labels: ['Feature'] },
    { n: 2, title: 'Push notifications', state: 'In Progress', ms: 'b1', ageH: 3, prio: 2, labels: ['Feature'] },
    { n: 3, title: 'Offline cache', state: 'Todo', ms: 'b1', blockedBy: [2], ageH: 20, labels: ['Ready'] },
    { n: 4, title: 'Onboarding polish', state: 'Backlog', ageH: 60, labels: ['Idea'] },
    { n: 5, title: 'Unprojected beacon chore', state: 'Backlog', project: null, ageH: 5, labels: ['Idea'], desc: LONG },
  ],
  ZED: [
    { n: 1, title: 'Zed spike: pick a queue', state: 'Backlog', ageH: 30, labels: ['Spike'], desc: LONG },
    { n: 2, title: 'Zed unprojected cleanup', state: 'Backlog', project: null, ageH: 10, labels: ['Chore'], desc: LONG },
    { n: 3, title: 'Zed approved work', state: 'Todo', ageH: 9, labels: ['Go', 'Chore'], desc: LONG },
    { n: 4, title: 'Zed unprojected, short', state: 'Backlog', project: null, ageH: 4, desc: 'tbd' },
  ],
  QAT: [
    { n: 1, title: 'QA triage item', state: 'Backlog', ageH: 20, labels: ['Triage'], desc: LONG },
    { n: 2, title: 'QA unprojected item', state: 'Backlog', project: null, ageH: 3, desc: LONG },
  ],
};
const PROJECTS: Record<string, { id: string; name: string; slugId: string }[]> = {
  ATL: [{ id: 'lp-ATL', name: 'Atlas', slugId: 'atl' }, { id: 'lp-ATL2', name: 'Atlas Labs', slugId: 'atl-labs' }],
  BCN: [{ id: 'lp-BCN', name: 'Beacon', slugId: 'bcn' }],
  ZED: [{ id: 'lp-ZED', name: 'Zed Core', slugId: 'zed' }],
  QAT: [{ id: 'lp-QAT', name: 'QA Board', slugId: 'qat' }],
};
const defaultProject = (team: string) => PROJECTS[team]![0]!.id;
const MILESTONES: Record<string, { id: string; name: string; description: string; off: number }[]> = {
  ATL: [{ id: 'm1', name: 'M1 Foundations', description: 'Service skeleton and ops basics', off: -5 }, { id: 'm2', name: 'M2 Ingest', description: 'Ingest pipeline end to end', off: 10 }],
  BCN: [{ id: 'b1', name: 'Beta', description: 'Closed beta feature set', off: 21 }],
  ZED: [{ id: 'z1', name: 'Zed MVP', description: 'First usable slice', off: 14 }],
};
// milestone -> owning project (milestones belong to exactly one project)
const MILESTONE_PROJECT: Record<string, string> = { m1: 'lp-ATL', m2: 'lp-ATL', b1: 'lp-BCN', z1: 'lp-ZED' };

export interface FakeLinearOpts {
  /** Make a named operation fail with a GraphQL error (used to test failure handling). */
  fail?: (op: string, vars: Record<string, any>) => boolean;
  /** Apply the mutation, then lose the response (a timeout after commit). Used to test ambiguous-outcome handling. */
  lostResponse?: (op: string, vars: Record<string, any>) => boolean;
  /** Report success but apply nothing (used to test read-back verification). */
  silentNoop?: (op: string) => boolean;
  /** Teams the READ key cannot see (to test inaccessible teams). */
  hideTeams?: string[];
}
export interface FakeLinearStore { issues: Record<string, IssueSpec[]>; comments: Map<string, { id: string; body: string; createdAt: string }[]>; mutations: { op: string; vars: Record<string, any> }[]; viewer: string }

export function createFakeLinear(nowMs: number, opts: FakeLinearOpts = {}) {
  const store: FakeLinearStore = { issues: structuredClone(SEED), comments: new Map(), mutations: [], viewer: 'Demo Owner' };
  const stateId = (team: string, name: string) => `st-${team}-${name.toLowerCase().replace(/\W+/g, '-')}`;
  const stateOf = (team: string, name: string) => { const d = STATE_DEFS.find((s) => s[0] === name) ?? STATE_DEFS[0]!; return { id: stateId(team, d[0]), name: d[0], type: d[1] }; };
  const teamStates = (team: string) => STATE_DEFS.map(([name, type], position) => ({ id: stateId(team, name), name, type, position }));
  const find = (ident: string) => { const m = /^([A-Z]+)-(\d+)$/.exec(ident); return m ? { team: m[1]!, spec: store.issues[m[1]!]?.find((x) => x.n === Number(m[2])) } : { team: '', spec: undefined }; };
  const byUuid = (id: string) => find(id.replace(/^uuid-/, ''));
  const projectOf = (team: string, s: IssueSpec): string | null => (s.project === undefined ? defaultProject(team) : s.project);
  const labelNodes = (team: string, s: IssueSpec) => (s.labels ?? []).map((n) => findLabel(team, n)).filter(Boolean).map((l) => ({ id: l!.id, name: l!.name, color: l!.color }));
  const ref = (team: string, n: number) => { const s = store.issues[team]!.find((x) => x.n === n)!; const st = stateOf(team, s.state); return { identifier: `${team}-${n}`, title: s.title, url: `https://example.invalid/linear/${team}-${n}`, state: { name: st.name, type: st.type } }; };

  const raw = (team: string, s: IssueSpec, withDescription: boolean) => {
    const id = `${team}-${s.n}`, st = stateOf(team, s.state);
    return {
      id: `uuid-${id}`, identifier: id, title: s.title, description: withDescription ? (s.desc ?? `${LONG} (${id})`) : undefined,
      url: `https://example.invalid/linear/${id}`, priority: s.prio ?? 0, priorityLabel: ['No priority', 'Urgent', 'High', 'Medium', 'Low'][s.prio ?? 0],
      createdAt: ago(s.ageH + 100, nowMs), updatedAt: ago(s.ageH, nowMs), completedAt: st.type === 'completed' ? ago(s.ageH, nowMs) : null, dueDate: null,
      branchName: s.branch ?? null, state: { id: st.id, name: st.name, type: st.type }, assignee: { name: 'Demo Dev' },
      team: { key: team }, labels: { nodes: labelNodes(team, s) },
      project: projectOf(team, s) ? { id: projectOf(team, s), name: PROJECTS[team]!.find((p) => p.id === projectOf(team, s))?.name ?? '?' } : null,
      projectMilestone: s.ms ? { id: s.ms } : null, parent: s.parent ? { identifier: `${team}-${s.parent}` } : null,
      relations: { nodes: store.issues[team]!.filter((o) => o.blockedBy?.includes(s.n)).map((o) => ({ type: 'blocks', relatedIssue: ref(team, o.n) })) },
      inverseRelations: { nodes: (s.blockedBy ?? []).map((n) => ({ type: 'blocks', issue: ref(team, n) })) },
      attachments: { nodes: [] },
      history: { nodes: [{ createdAt: ago(s.ageH, nowMs), fromState: { name: 'Todo' }, toState: { name: st.name }, actor: { name: 'Demo Dev' } }] },
    };
  };

  const err = (message: string, code: string, status = 200) => ({ status, json: { errors: [{ message, extensions: { code } }] } });
  const ok = (data: unknown) => ({ status: 200, json: { data } });

  function handle(body: { query: string; variables: Record<string, any> }, auth: string | undefined): { status: number; json: unknown; lost?: boolean } {
    const r = handleInner(body, auth);
    const m = /^\s*mutation\s+(\w+)/.exec(body.query);
    return m && opts.lostResponse?.(m[1]!, body.variables ?? {}) && r.status === 200 ? { ...r, lost: true } : r;
  }
  function handleInner(body: { query: string; variables: Record<string, any> }, auth: string | undefined) {
    const op = /^\s*(query|mutation)\s+(\w+)/.exec(body.query);
    const kind = op?.[1], name = op?.[2] ?? '';
    const v = body.variables ?? {};
    if (kind === 'mutation') {
      if (auth !== DEMO_WRITE_KEY) return err('Forbidden', 'FORBIDDEN', 403); // the read key can never mutate
      store.mutations.push({ op: name, vars: v });
      if (opts.fail?.(name, v)) return err('synthetic failure', 'INTERNAL_SERVER_ERROR');
      const noop = opts.silentNoop?.(name) === true;
      if (name === 'IssueAddLabel' || name === 'IssueRemoveLabel') {
        const { team, spec } = byUuid(String(v.id)); const l = labelsOf(team).find((x) => x.id === v.labelId); // labels of ANOTHER team are rejected, as Linear does
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
            if (input.projectMilestoneId !== null && MILESTONE_PROJECT[input.projectMilestoneId] !== projectOf(team, spec)) return err('Invalid milestone', 'INVALID_INPUT');
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
    if (name === 'Teams') {
      return ok({ teams: { nodes: Object.keys(PROJECTS).filter((k) => !opts.hideTeams?.includes(k)).map((key) => ({ id: `t-${key}`, key, name: key === 'ATL' ? 'Atlas' : key === 'BCN' ? 'Beacon' : key === 'ZED' ? 'Zed' : 'QA', projects: { nodes: PROJECTS[key]!.map((p) => ({ id: p.id, name: p.name, slugId: p.slugId, url: `https://example.invalid/linear/project/${p.slugId}` })) } })), pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    if (name === 'TeamProjects') {
      const key = v.key as string;
      if (!store.issues[key] || opts.hideTeams?.includes(key)) return ok({ teams: { nodes: [] } });
      return ok({ teams: { nodes: [{ id: `t-${key}`, key, name: key, projects: { nodes: PROJECTS[key]!.map((p) => ({ id: p.id, name: p.name, slugId: p.slugId, url: `https://example.invalid/linear/project/${p.slugId}`, documents: { nodes: key === 'ATL' && p.id === 'lp-ATL' ? [{ id: 'd1', title: 'Atlas product brief', url: 'https://example.invalid/linear/doc/atlas-brief' }] : [] } })) } }] } });
    }
    if (name === 'Labels') {
      const key = String(v.key);
      return ok({ issueLabels: { nodes: [...(TEAM_LABELS[key] ?? []).map((l) => ({ ...l, team: { key } })), ...WORKSPACE.map((l) => ({ ...l, team: null }))].map((l) => ({ id: l.id, name: l.name, color: l.color, isGroup: !!(l as LabelSpec).isGroup, parent: (l as LabelSpec).parent ? { name: (l as LabelSpec).parent } : null, team: l.team })), pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    if (name === 'Milestones') {
      const pid = String(v.id);
      const team = Object.keys(PROJECTS).find((k) => PROJECTS[k]!.some((p) => p.id === pid)) ?? '';
      return ok({ project: { projectMilestones: { nodes: (MILESTONES[team] ?? []).filter((m) => MILESTONE_PROJECT[m.id] === pid).map((m) => ({ id: m.id, name: m.name, description: m.description, targetDate: day(m.off, nowMs) })), pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (name === 'IssueDetail') {
      const { team, spec } = find(String(v.id));
      return ok({ issue: spec ? raw(team, spec, true) : null });
    }
    if (name === 'ActionIssue') {
      const { team, spec } = find(String(v.id));
      if (!spec) return ok({ issue: null });
      const r = raw(team, spec, true);
      const pj = r.project as { id: string; name: string } | null;
      return ok({ issue: { ...r, team: { id: `t-${team}`, key: team, states: { nodes: teamStates(team) } },
        project: pj ? { id: pj.id, name: pj.name, slugId: PROJECTS[team]!.find((p) => p.id === pj.id)?.slugId, projectMilestones: { nodes: (MILESTONES[team] ?? []).filter((m) => MILESTONE_PROJECT[m.id] === pj.id).map((m) => ({ id: m.id, name: m.name })) } } : null,
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
