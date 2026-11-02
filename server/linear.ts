// Linear GraphQL client (queries only) and normalization of untrusted payloads.
import type { Issue, IssueRef, LabelDef, LabelRef, Milestone, StateType } from '../shared/types.ts';
import { Limiter, SourceError, arr, dateOnly, fetchJson, isObj, iso, nodes, num, safeUrl, str } from './util.ts';

export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
const MAX_PAGES = 25;

export const Q_TEAM_PROJECTS = `query TeamProjects($key: String!) {
  teams(filter: { key: { eq: $key } }, first: 1) { nodes { id key name
    projects(first: 100) { nodes { id name slugId url
      documents(first: 50) { nodes { id title url } } } } } } }`;

export const Q_LABELS = `query Labels($key: String!, $after: String) {
  issueLabels(first: 100, after: $after, filter: { or: [{ team: { key: { eq: $key } } }, { team: { null: true } }] }) {
    nodes { id name color isGroup parent { name } team { key } }
    pageInfo { hasNextPage endCursor } } }`;

export const Q_MILESTONES = `query Milestones($id: String!, $after: String) {
  project(id: $id) { projectMilestones(first: 50, after: $after) {
    nodes { id name description targetDate }
    pageInfo { hasNextPage endCursor } } } }`;

// List queries omit `description` (the heaviest field); it is fetched per issue when someone opens it.
const ISSUE_FIELDS = `id identifier title url priority priorityLabel createdAt updatedAt completedAt dueDate branchName
      state { name type } assignee { name } labels(first: 20) { nodes { id name color } }
      project { id name } projectMilestone { id } parent { identifier }
      relations(first: 20) { nodes { type relatedIssue { identifier title url state { name type } } } }
      inverseRelations(first: 20) { nodes { type issue { identifier title url state { name type } } } }
      attachments(first: 10) { nodes { title url sourceType } }
      history(first: 5) { nodes { createdAt fromState { name } toState { name } actor { name } } }`;

export const Q_ISSUES = `query Issues($filter: IssueFilter, $after: String) {
  issues(first: 40, after: $after, filter: $filter, orderBy: updatedAt) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor } } }`;

export const Q_ISSUE_DETAIL = `query IssueDetail($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} description } }`;

/** Shared transport: auth, rate-limit/auth/HTTP error mapping, controlled messages. Callers decide WHICH operations may be sent. */
export async function linearSend(fetchImpl: typeof fetch, token: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetchJson(fetchImpl, LINEAR_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: token },
    body: JSON.stringify({ query, variables }),
  });
  const body = res.json;
  const errs = isObj(body) ? arr(body.errors) : [];
  const code = errs.map((e) => (isObj(e) && isObj(e.extensions) ? str(e.extensions.code, 40) : undefined)).find((c) => c && /^[A-Z_]+$/.test(c));
  if (res.status === 429 || code === 'RATELIMITED') {
    const reset = Number(res.headers.get('x-ratelimit-requests-reset')); // epoch ms
    throw new SourceError('rate_limit', 'Linear rate limit reached', Number.isFinite(reset) && reset > 0 ? new Date(reset).toISOString() : undefined);
  }
  if (res.status === 401 || res.status === 403 || code === 'AUTHENTICATION_ERROR' || code === 'FORBIDDEN')
    throw new SourceError('auth', 'Linear rejected the API key (check the key and its permission)');
  if (!res.ok) throw new SourceError('http', `Linear returned HTTP ${res.status}`);
  if (!isObj(body)) throw new SourceError('invalid', 'Linear returned a non-JSON response');
  // Upstream error text is never forwarded (it could echo request content); only a vetted code is.
  if (errs.length) throw new SourceError('http', `Linear GraphQL error${code ? ` (${code})` : ''}`);
  if (!isObj(body.data)) throw new SourceError('invalid', 'Linear response had no data');
  return body.data;
}

export class LinearClient {
  private limit = new Limiter(4);
  constructor(private token: string, private fetchImpl: typeof fetch = fetch) {}

  async query(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Hard read-only guard: this client can only send `query` operations.
    if (!/^\s*query\b/.test(query)) throw new Error('LinearClient is read-only: only query operations are allowed');
    return this.limit.run(() => linearSend(this.fetchImpl, this.token, query, variables));
  }
}

export function stateType(v: unknown): StateType {
  const t = str(v, 20);
  if (t === 'duplicate') return 'canceled'; // Linear's duplicate state is resolved, not open work
  return t === 'triage' || t === 'backlog' || t === 'unstarted' || t === 'started' || t === 'completed' || t === 'canceled' ? t : 'unknown';
}
export const isResolved = (t: StateType) => t === 'completed' || t === 'canceled';

export function normalizeRef(raw: unknown): IssueRef | undefined {
  if (!isObj(raw)) return undefined;
  const identifier = str(raw.identifier, 40);
  if (!identifier) return undefined;
  const st = isObj(raw.state) ? raw.state : {};
  const type = stateType(st.type);
  return { identifier, title: str(raw.title, 300) ?? '', url: safeUrl(raw.url), stateName: str(st.name, 100) ?? 'Unknown', stateType: type, resolved: isResolved(type) };
}

/** Only #rgb/#rrggbb colors from Linear are ever used in styles. */
export function color(v: unknown): string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : '#8b97a7';
}

const DESC_CAP = 10000;
function describe(v: unknown): string {
  const t = typeof v === 'string' ? v : '';
  return t.length > DESC_CAP ? `${t.slice(0, DESC_CAP)}\n\n… [truncated by DevFlow after ${DESC_CAP} characters; open the issue in Linear for the full text]` : t;
}

/** Returns a partially-derived Issue; derived fields are filled by buildSnapshot. */
export function normalizeIssue(raw: unknown, projectId: string): Issue | undefined {
  if (!isObj(raw)) return undefined;
  const identifier = str(raw.identifier, 40);
  const id = str(raw.id, 100);
  if (!identifier || !id || !/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(identifier)) return undefined;
  const st = isObj(raw.state) ? raw.state : {};
  const blockedBy = nodes(raw.inverseRelations, 50).flatMap((r) => (isObj(r) && r.type === 'blocks' ? [normalizeRef(r.issue)] : [])).filter((x): x is IssueRef => !!x);
  const blocks = nodes(raw.relations, 50).flatMap((r) => (isObj(r) && r.type === 'blocks' ? [normalizeRef(r.relatedIssue)] : [])).filter((x): x is IssueRef => !!x);
  const priority = num(raw.priority) ?? 0;
  return {
    id, identifier: identifier.toUpperCase(), projectId,
    title: str(raw.title, 500) ?? '(untitled)',
    description: describe(raw.description),
    url: safeUrl(raw.url),
    priority, priorityLabel: str(raw.priorityLabel, 40) ?? (priority === 0 ? 'No priority' : String(priority)),
    state: { name: str(st.name, 100) ?? 'Unknown', type: stateType(st.type) },
    assignee: isObj(raw.assignee) ? str(raw.assignee.name, 100) : undefined,
    labels: nodes(raw.labels, 30).flatMap((l): LabelRef[] => (isObj(l) && str(l.id, 100) && str(l.name, 100) ? [{ id: str(l.id, 100)!, name: str(l.name, 100)!, color: color(l.color) }] : [])),
    milestoneId: isObj(raw.projectMilestone) ? str(raw.projectMilestone.id, 100) : undefined,
    linearProjectName: isObj(raw.project) ? str(raw.project.name, 200) : undefined,
    parentIdentifier: isObj(raw.parent) ? str(raw.parent.identifier, 40)?.toUpperCase() : undefined,
    childIdentifiers: [],
    blockedBy, blocks,
    attachments: nodes(raw.attachments, 20).flatMap((a) => {
      if (!isObj(a)) return [];
      const url = safeUrl(a.url);
      return url ? [{ title: str(a.title, 200) ?? url, url, kind: str(a.sourceType, 40) ?? 'link' }] : [];
    }),
    branchName: str(raw.branchName, 250),
    createdAt: iso(raw.createdAt), updatedAt: iso(raw.updatedAt), completedAt: iso(raw.completedAt), dueDate: dateOnly(raw.dueDate),
    recentChanges: nodes(raw.history, 10).flatMap((h) => {
      if (!isObj(h)) return [];
      const at = iso(h.createdAt);
      const from = isObj(h.fromState) ? str(h.fromState.name, 100) : undefined;
      const to = isObj(h.toState) ? str(h.toState.name, 100) : undefined;
      // only state transitions are surfaced as "changes"; other history rows carry no evidence we model
      return at && (from || to) ? [{ at, from, to, actor: isObj(h.actor) ? str(h.actor.name, 100) : undefined }] : [];
    }),
    openBlockers: [], readiness: 'na', prKeys: [], stageEvidence: [],
    gates: { ci: { value: 'na', detail: '', evidence: [] }, review: { value: 'na', detail: '', evidence: [] }, merge: { value: 'na', detail: '', evidence: [] } },
    rework: [], stale: false, awaitingHuman: [],
  };
}

export interface RawLabel { id: string; name: string; color: string; isGroup: boolean; parent?: string; scope: 'team' | 'workspace' }

export function normalizeLabel(raw: unknown): RawLabel | undefined {
  if (!isObj(raw)) return undefined;
  const id = str(raw.id, 100), name = str(raw.name, 100);
  if (!id || !name) return undefined;
  return { id, name, color: color(raw.color), isGroup: raw.isGroup === true, parent: isObj(raw.parent) ? str(raw.parent.name, 100) : undefined, scope: isObj(raw.team) ? 'team' : 'workspace' };
}

export interface LinearProjectData {
  issues: Issue[];
  labels: RawLabel[];
  milestones: { id: string; name: string; description: string; targetDate?: string; url?: string }[];
  projectUrl?: string;
  documents: { title: string; url: string }[];
  warnings: string[];
}

async function paginate(
  client: LinearClient, query: string, vars: Record<string, unknown>, pick: (d: Record<string, unknown>) => unknown, warnings: string[], what: string,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const conn = pick(await client.query(query, { ...vars, after }));
    if (!isObj(conn)) throw new SourceError('invalid', `Linear ${what}: unexpected response shape`);
    out.push(...arr(conn.nodes, 100));
    const pi = isObj(conn.pageInfo) ? conn.pageInfo : {};
    if (pi.hasNextPage !== true) return out;
    after = str(pi.endCursor, 200);
    if (!after) break;
  }
  warnings.push(`Linear ${what}: stopped after ${MAX_PAGES} pages; data is partial`);
  return out;
}

export async function fetchLinearProject(
  client: LinearClient, dfProjectId: string, cfg: { teamKey: string; projects: string[] },
): Promise<LinearProjectData> {
  const warnings: string[] = [];
  const data = await client.query(Q_TEAM_PROJECTS, { key: cfg.teamKey });
  const team = isObj(data.teams) ? nodes(data.teams, 1)[0] : undefined;
  if (!isObj(team)) throw new SourceError('not_found', `Linear team "${cfg.teamKey}" not found or not visible to this key`);
  const all = nodes(team.projects, 100).filter(isObj);
  const wanted = cfg.projects.map((w) => w.toLowerCase());
  const selected = wanted.length
    ? all.filter((p) => [str(p.id), str(p.name), str(p.slugId)].some((v) => v && wanted.includes(v.toLowerCase())))
    : all;
  if (wanted.length && !selected.length) warnings.push(`None of the configured Linear projects (${cfg.projects.join(', ')}) matched team ${cfg.teamKey}`);

  const milestones: LinearProjectData['milestones'] = [];
  const documents: LinearProjectData['documents'] = [];
  for (const p of selected) {
    const pid = str(p.id, 100);
    const purl = safeUrl(p.url);
    if (!pid) continue;
    for (const d of nodes(p.documents, 50)) {
      const url = isObj(d) ? safeUrl(d.url) : undefined;
      if (isObj(d) && url) documents.push({ title: str(d.title, 200) ?? 'Document', url });
    }
    const ms = await paginate(client, Q_MILESTONES, { id: pid }, (d) => (isObj(d.project) ? d.project.projectMilestones : undefined), warnings, 'milestones');
    for (const m of ms) {
      if (!isObj(m)) continue;
      const id = str(m.id, 100);
      if (!id) continue;
      milestones.push({ id, name: str(m.name, 200) ?? 'Milestone', description: str(m.description, 5000) ?? '', targetDate: dateOnly(m.targetDate), url: purl });
    }
  }

  // Labels are read live per team (+ workspace labels). A failure here must not hide the issues themselves.
  let labels: RawLabel[] = [];
  try {
    const raw = await paginate(client, Q_LABELS, { key: cfg.teamKey }, (d) => d.issueLabels, warnings, 'labels');
    labels = raw.map(normalizeLabel).filter((x): x is RawLabel => !!x);
  } catch (e) {
    if (e instanceof SourceError && (e.kind === 'rate_limit' || e.kind === 'network' || e.kind === 'auth')) throw e;
    warnings.push('Linear labels could not be read; label filters and editing are unavailable');
  }

  const filter: Record<string, unknown> = { team: { key: { eq: cfg.teamKey } } };
  if (wanted.length) filter.project = { id: { in: selected.map((p) => str(p.id, 100)).filter(Boolean) } };
  const rawIssues = wanted.length && !selected.length ? [] : await paginate(client, Q_ISSUES, { filter }, (d) => d.issues, warnings, 'issues');
  const issues = rawIssues.map((r) => normalizeIssue(r, dfProjectId)).filter((x): x is Issue => !!x);
  if (issues.length < rawIssues.length) warnings.push(`${rawIssues.length - issues.length} malformed Linear issue(s) skipped`);
  return {
    issues, labels, milestones, documents, warnings,
    projectUrl: selected.length === 1 ? safeUrl(selected[0]!.url) : undefined,
  };
}

export function buildMilestones(dfProjectId: string, defs: LinearProjectData['milestones'], issues: Issue[], today: string): Milestone[] {
  const mk = (id: string, name: string, description: string, targetDate: string | undefined, url: string | undefined, list: Issue[], unassigned: boolean): Milestone => {
    const canceled = list.filter((i) => i.state.type === 'canceled').length;
    const done = list.filter((i) => i.state.type === 'completed').length;
    const countable = list.length - canceled;
    return {
      id, projectId: dfProjectId, name, description, targetDate, url,
      issueIdentifiers: list.map((i) => i.identifier), total: list.length, done, canceled,
      started: list.filter((i) => i.state.type === 'started').length,
      progress: countable > 0 ? done / countable : null,
      overdue: !!targetDate && targetDate < today && countable > 0 && done < countable,
      isUnassigned: unassigned,
    };
  };
  const out = defs.map((d) => mk(d.id, d.name, d.description, d.targetDate, d.url, issues.filter((i) => i.milestoneId === d.id), false));
  const known = new Set(defs.map((d) => d.id));
  // Issues pointing at a milestone we could not read are grouped separately, never dropped.
  const orphan = issues.filter((i) => i.milestoneId && !known.has(i.milestoneId));
  if (orphan.length) out.push(mk(`unknown:${dfProjectId}`, 'Milestone not readable', 'Issues reference a milestone that was not returned by Linear.', undefined, undefined, orphan, true));
  out.push(mk(`none:${dfProjectId}`, 'No milestone', 'Tasks not assigned to any milestone.', undefined, undefined, issues.filter((i) => !i.milestoneId), true));
  return out;
}

/** Reads ONE issue (with description). Linear accepts the human identifier (e.g. ABC-12) as the id. */
export async function fetchLinearIssue(client: LinearClient, dfProjectId: string, identifier: string): Promise<Issue> {
  const data = await client.query(Q_ISSUE_DETAIL, { id: identifier });
  const issue = normalizeIssue(data.issue, dfProjectId);
  if (!issue) throw new SourceError('not_found', `Linear issue ${identifier} not found or not readable`);
  return issue;
}
