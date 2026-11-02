// Controlled Linear actions. Every action: (1) re-reads the issue and its team's labels/states from LIVE Linear using the
// READ credential, (2) validates against that live data and the project's configured policy, (3) sends only allowlisted
// mutations with the separate WRITE credential, (4) re-reads Linear and verifies the result, (5) rolls back on failure.
import type { ActionCheck, ActionOptions, Issue, StateType } from '../shared/types.ts';
import type { Config, WorkflowCfg } from './config.ts';
import { resolveScope, type Scope } from './scope.ts';
import { Q_LABELS, normalizeLabel, stateType, type LinearClient, type RawLabel } from './linear.ts';
import type { LinearWriteClient } from './linear-write.ts';
import type { SnapshotService } from './service.ts';
import { SourceError, arr, isObj, nodes, str } from './util.ts';
import { randomUUID } from 'node:crypto';

export class ActionError extends Error {
  constructor(public status: number, public code: string, message: string, public checks?: ActionCheck[]) { super(message); }
}

export const Q_ACTION_ISSUE = `query ActionIssue($id: String!) { issue(id: $id) { id identifier title description priority url
  state { id name type } team { id key states { nodes { id name type position } } }
  labels(first: 50) { nodes { id name color } }
  project { id name slugId projectMilestones(first: 100) { nodes { id name } } } projectMilestone { id name }
  relations(first: 50) { nodes { type relatedIssue { identifier } } }
  inverseRelations(first: 50) { nodes { type issue { identifier title url state { name type } } } } } }`;

interface StateDef { id: string; name: string; type: StateType; position: number }
export interface Ctx {
  id: string; identifier: string; title: string; description: string; priority: number;
  state: { id: string; name: string; type: StateType };
  teamKey: string; states: StateDef[];
  labels: { id: string; name: string }[];
  project?: { id: string; name: string; slugId?: string };
  milestones: { id: string; name: string }[]; milestone?: { id: string; name: string };
  openBlockers: { identifier: string; stateName: string }[]; depsVerifiable: boolean;
  teamLabels: RawLabel[];
}

export function parseCtx(data: Record<string, unknown>, teamLabels: RawLabel[]): Ctx | undefined {
  const i = data.issue;
  if (!isObj(i)) return undefined;
  const id = str(i.id, 100), identifier = str(i.identifier, 40), st = isObj(i.state) ? i.state : undefined, team = isObj(i.team) ? i.team : undefined;
  if (!id || !identifier || !st || !team || !str(st.id, 100) || !str(team.key, 20)) return undefined;
  const states = nodes(isObj(team.states) ? team.states : undefined, 50).flatMap((x): StateDef[] =>
    isObj(x) && str(x.id, 100) && str(x.name, 100) ? [{ id: str(x.id, 100)!, name: str(x.name, 100)!, type: stateType(x.type), position: typeof x.position === 'number' ? x.position : 0 }] : []);
  const inv = nodes(i.inverseRelations, 100);
  const proj = isObj(i.project) ? i.project : undefined;
  return {
    id, identifier: identifier.toUpperCase(), title: str(i.title, 500) ?? '', description: str(i.description, 20000) ?? '',
    priority: typeof i.priority === 'number' ? i.priority : 0,
    state: { id: str(st.id, 100)!, name: str(st.name, 100) ?? '?', type: stateType(st.type) },
    teamKey: str(team.key, 20)!.toUpperCase(), states,
    labels: nodes(i.labels, 100).flatMap((l) => (isObj(l) && str(l.id, 100) && str(l.name, 100) ? [{ id: str(l.id, 100)!, name: str(l.name, 100)! }] : [])),
    project: proj && str(proj.id, 100) ? { id: str(proj.id, 100)!, name: str(proj.name, 200) ?? '', slugId: str(proj.slugId, 100) } : undefined,
    milestones: proj ? nodes(proj.projectMilestones, 200).flatMap((m) => (isObj(m) && str(m.id, 100) ? [{ id: str(m.id, 100)!, name: str(m.name, 200) ?? 'Milestone' }] : [])) : [],
    milestone: isObj(i.projectMilestone) && str(i.projectMilestone.id, 100) ? { id: str(i.projectMilestone.id, 100)!, name: str(i.projectMilestone.name, 200) ?? '' } : undefined,
    openBlockers: inv.flatMap((r) => {
      if (!isObj(r) || r.type !== 'blocks' || !isObj(r.issue)) return [];
      const t = stateType(isObj(r.issue.state) ? r.issue.state.type : undefined);
      return t === 'completed' || t === 'canceled' ? [] : [{ identifier: str(r.issue.identifier, 40) ?? '?', stateName: isObj(r.issue.state) ? str(r.issue.state.name, 100) ?? '?' : '?' }];
    }),
    depsVerifiable: inv.length < 50 && nodes(i.relations, 100).length < 50, // a full page may hide more relations
    teamLabels,
  };
}

const low = (s: string) => s.toLowerCase();
export const isResolvedType = (t: StateType) => t === 'completed' || t === 'canceled';
const isProtected = (name: string, wf: WorkflowCfg) => [wf.readyLabel, ...wf.protectedLabels].map(low).includes(low(name));

export function findTodo(ctx: Ctx, wf: WorkflowCfg): StateDef | undefined {
  const unstarted = ctx.states.filter((s) => s.type === 'unstarted').sort((a, b) => a.position - b.position);
  return unstarted.find((s) => low(s.name) === low(wf.todoState)) ?? unstarted[0];
}
export function findBacklog(ctx: Ctx, wf: WorkflowCfg): StateDef | undefined {
  const b = ctx.states.filter((s) => s.type === 'backlog').sort((a, c) => a.position - c.position);
  return b.find((s) => low(s.name) === low(wf.backlogState)) ?? b[0];
}
export const hasReady = (ctx: Ctx, wf: WorkflowCfg) => ctx.labels.some((l) => low(l.name) === low(wf.readyLabel));

/** Readiness policy evaluation. Every unverifiable prerequisite is a failed check (approval refused), never a silent pass. */
export function evaluateApproval(ctx: Ctx, wf: WorkflowCfg, writeEnabled: boolean, scope: Pick<Scope, 'policy' | 'explicitPolicy' | 'writeAllowed' | 'writeReason'>): { checks: ActionCheck[]; eligible: boolean; already: boolean } {
  const p = wf.readiness;
  const c: ActionCheck[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string) => c.push({ id, label, ok, detail });
  const readyDef = ctx.teamLabels.find((l) => low(l.name) === low(wf.readyLabel) && !l.isGroup);
  const todo = findTodo(ctx, wf);
  const already = hasReady(ctx, wf) && ctx.state.type === 'unstarted';
  add('write', 'Linear write access configured', writeEnabled, writeEnabled ? 'A separate write credential is configured' : 'LINEAR_WRITE_API_KEY is not set');
  add('scope', `DevFlow may write to this ${ctx.project ? 'project' : 'team'}`, scope.writeAllowed, scope.writeAllowed ? `Authorized by configuration (${ctx.teamKey}${ctx.project ? ` / ${ctx.project.name}` : ''})` : (scope.writeReason ?? 'Not authorized'));
  add('policy', 'An explicit readiness policy applies to this scope', scope.explicitPolicy,
    scope.explicitPolicy ? `Using the ${scope.policy === 'project' ? 'project' : 'team'} policy configured for ${ctx.project && scope.policy === 'project' ? ctx.project.name : `team ${ctx.teamKey}`}`
      : `No readiness policy is configured for ${ctx.project ? `project "${ctx.project.name}"` : `unprojected issues`} in team ${ctx.teamKey}; add a teams[] entry with a workflow. Rules from other projects are never inherited.`);
  add('state', 'Issue is not started, done or canceled', ctx.state.type === 'backlog' || ctx.state.type === 'triage' || ctx.state.type === 'unstarted',
    `Current state: ${ctx.state.name} (${ctx.state.type})${ctx.state.type === 'started' ? ' — work has already started' : ''}`);
  add('not-ready', 'Not already approved', !already, already ? `Already ${wf.readyLabel} in ${ctx.state.name}` : 'Not yet approved');
  add('ready-label', `"${wf.readyLabel}" label exists in Linear`, !!readyDef, readyDef ? 'Found in the team/workspace labels' : `No label named "${wf.readyLabel}" was found; DevFlow does not create labels`);
  add('todo-state', `"${wf.todoState}" state exists`, !!todo, todo ? `Will move to ${todo.name}` : 'The team has no unstarted workflow state');
  if (p.requireDescription) add('description', `Ticket information: description ≥ ${p.minDescriptionChars} characters`, ctx.description.trim().length >= p.minDescriptionChars, `${ctx.description.trim().length} characters`);
  if (p.requireNoOpenBlockers) {
    add('deps-readable', 'Dependencies could be fully verified', ctx.depsVerifiable, ctx.depsVerifiable ? 'All relations were read' : 'The relation list is full; dependencies cannot be fully verified');
    add('deps', 'No unresolved blocking dependencies', ctx.openBlockers.length === 0, ctx.openBlockers.length ? `Blocked by ${ctx.openBlockers.map((b) => `${b.identifier} (${b.stateName})`).join(', ')}` : 'No open blockers');
  }
  if (p.requireMilestone) add('milestone', 'Assigned to a milestone', !!ctx.milestone, ctx.milestone ? ctx.milestone.name : 'No milestone');
  if (p.requirePriority) add('priority', 'Priority set', ctx.priority > 0, ctx.priority > 0 ? `Priority ${ctx.priority}` : 'No priority');
  if (p.requireClassificationLabel) {
    const cls = ctx.labels.filter((l) => wf.classificationLabels.map(low).includes(low(l.name)));
    add('classification', 'Has a classification label', cls.length > 0, cls.length ? cls.map((l) => l.name).join(', ') : `One of: ${wf.classificationLabels.join(', ')}`);
  }
  return { checks: c, eligible: c.every((x) => x.ok), already };
}

/** Which workflow transitions the generic status menu allows. Approval/completion cannot be bypassed through it. */
export function statusOptions(ctx: Ctx, wf: WorkflowCfg, mergedPr: boolean, writeEnabled: boolean): ActionOptions['states'] {
  const ready = hasReady(ctx, wf);
  return ctx.states.sort((a, b) => a.position - b.position).map((s) => {
    const current = s.id === ctx.state.id;
    let reason: string | undefined;
    if (!writeEnabled) reason = 'Linear write access is not configured';
    else if (current) reason = 'Current state';
    else if (isResolvedType(ctx.state.type)) reason = 'Closed issues are reopened in Linear';
    else if (s.type === 'canceled') reason = 'Cancel in Linear (not available here)';
    else if (s.type === 'completed') reason = mergedPr ? undefined : 'Done requires a merged linked PR (verified from GitHub)';
    else if (s.type === 'started' && ctx.state.type !== 'started' && !ready) reason = `Starting work requires approval: use "Approve for execution" (${wf.readyLabel})`;
    else if ((s.type === 'backlog' || s.type === 'triage') && ready) reason = `Revoke readiness first (${wf.readyLabel} label is set)`;
    else if (s.type !== 'backlog' && s.type !== 'unstarted' && s.type !== 'started' && s.type !== 'triage') reason = 'State type not supported here';
    return { id: s.id, name: s.name, type: s.type, current, allowed: reason === undefined, reason };
  });
}

type Log = (line: string) => void;

export class LinearActions {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private deps: { cfg: Config; read: LinearClient; write?: LinearWriteClient; service: SnapshotService; log?: Log; clock?: () => number },
  ) {}

  get enabled() { return !!this.deps.write; }

  /** Authorization is decided here from the issue's LIVE team/project and the server's configuration, never from the browser. */
  private scopeOf(ctx: Ctx): Scope {
    return resolveScope(this.deps.cfg, ctx.teamKey, ctx.project ? { id: ctx.project.id, name: ctx.project.name, slugId: ctx.project.slugId } : undefined);
  }
  private authorized(ctx: Ctx): Scope {
    const sc = this.scopeOf(ctx);
    if (!sc.writeAllowed) throw new ActionError(403, 'not-authorized', `DevFlow is not authorized to change ${ctx.identifier}: ${sc.writeReason ?? 'its team/project is not enabled for writes'}`);
    return sc;
  }

  private async load(identifier: string): Promise<Ctx> {
    if (!/^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$/.test(identifier)) throw new ActionError(400, 'bad-identifier', 'Invalid issue identifier');
    const data = await this.deps.read.query(Q_ACTION_ISSUE, { id: identifier.toUpperCase() });
    const first = parseCtx(data, []);
    if (!first) throw new ActionError(404, 'not-found', `Issue ${identifier} was not found in Linear`);
    // The label set is the issue's OWN team's (from Linear's answer), not anything derived from the request.
    const ld = await this.deps.read.query(Q_LABELS, { key: first.teamKey, after: null });
    const labels = arr(isObj(ld.issueLabels) ? ld.issueLabels.nodes : [], 200).map(normalizeLabel).filter((x): x is RawLabel => !!x);
    return { ...first, teamLabels: labels };
  }

  /** CACHED evidence, for display only (the menu). Changing status to Done re-verifies from GitHub. */
  private mergedPr(identifier: string): boolean {
    const snap = this.deps.service.peek();
    const issue = snap?.issues.find((i) => i.identifier === identifier);
    const pr = issue?.primaryPrKey ? snap?.prs.find((p) => p.key === issue.primaryPrKey) : undefined;
    return pr?.state === 'merged';
  }

  /** Live options for the action menu (reads only). */
  async options(identifier: string): Promise<ActionOptions> {
    const ctx = await this.load(identifier);
    const sc = this.scopeOf(ctx);
    const wf = sc.workflow;
    const w = this.enabled && sc.writeAllowed;
    const whyNot = !this.enabled ? 'Linear write access is not configured' : sc.writeReason ?? 'Writes are not enabled for this team/project';
    const ready = hasReady(ctx, wf);
    const ap = evaluateApproval(ctx, wf, this.enabled, sc);
    const labels = ctx.teamLabels.filter((l) => !l.isGroup || ctx.labels.some((x) => x.id === l.id)).map((l) => {
      const applied = ctx.labels.some((x) => x.id === l.id);
      const prot = isProtected(l.name, wf);
      const reason = !w ? whyNot : l.isGroup ? 'Group labels cannot be applied' : prot ? `Protected: use ${applied ? 'Revoke readiness' : 'Approve for execution'}` : undefined;
      return { id: l.id, name: l.name, color: l.color, scope: l.scope, applied, editable: reason === undefined, reason, classification: wf.classificationLabels.map(low).includes(low(l.name)), group: l.parent };
    });
    return {
      writeEnabled: w, reason: w ? undefined : whyNot,
      scope: { teamKey: ctx.teamKey, projectName: ctx.project?.name, policy: sc.policy, explicitPolicy: sc.explicitPolicy },
      identifier: ctx.identifier, title: ctx.title, state: ctx.state, labels,
      states: statusOptions(ctx, wf, this.mergedPr(ctx.identifier), w), // cached PR data: display only; status() re-verifies before any Done
      milestones: { current: ctx.milestone?.id, options: ctx.milestones, canChange: w && !!ctx.project, reason: !w ? whyNot : !ctx.project ? 'The issue is not in a Linear project' : undefined },
      approve: { eligible: ap.eligible, already: ap.already, checks: ap.checks, todoState: findTodo(ctx, wf)?.name },
      revoke: { possible: w && ready && (ctx.state.type === 'unstarted'), reason: !w ? whyNot : !ready ? `Not marked ${wf.readyLabel}` : ctx.state.type !== 'unstarted' ? 'Work has started; change the state in Linear' : undefined },
    };
  }

  /** Serialize all writes: one at a time, so validation and execution never interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private writer() {
    if (!this.deps.write) throw new ActionError(403, 'write-disabled', 'Linear write access is not configured (set LINEAR_WRITE_API_KEY to a separate Linear key with Write permission)');
    return this.deps.write;
  }

  private async finish(identifier: string, message: string) {
    const snapshot = await this.deps.service.getIssue(identifier, true) ?? (await this.deps.service.get(true));
    return { ok: true as const, verified: true as const, message, snapshot };
  }

  private run<T>(action: string, identifier: string, fn: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      try { const r = await fn(); this.deps.log?.(`action=${action} issue=${identifier} outcome=ok`); return r; }
      catch (e) {
        const code = e instanceof ActionError ? e.code : e instanceof SourceError ? e.kind : 'error';
        this.deps.log?.(`action=${action} issue=${identifier} outcome=failed code=${code}`);
        if (e instanceof ActionError) throw e;
        if (e instanceof SourceError) throw new ActionError(e.kind === 'rate_limit' ? 429 : 502, e.kind, e.message);
        throw new ActionError(500, 'error', 'The action failed unexpectedly');
      }
    });
  }

  /** A read that reports failure as "unknown" instead of throwing. */
  private async tryLoad(identifier: string): Promise<Ctx | undefined> {
    try { return await this.load(identifier); } catch { return undefined; }
  }

  /** The action was sent but Linear's own answer does not show the intended result: say what Linear shows, claim nothing else. */
  private notConfirmed(what: string, failure: unknown, after: Ctx | undefined): ActionError {
    const why = failure instanceof SourceError ? failure.message : failure ? 'a Linear write failed' : 'Linear did not reflect the change';
    const seen = after ? `Linear currently shows status "${after.state.name}" with labels: ${after.labels.map((l) => l.name).join(', ') || 'none'}.` : 'Linear could not be read back, so the current state is unknown.';
    return new ActionError(502, failure ? 'write-failed' : 'verify-failed', `${what} was not confirmed (${why}). ${seen} Nothing was rolled back automatically; check the issue in Linear.`);
  }

  // ---- ordinary labels ----
  labels(identifier: string, add: string[], remove: string[]) {
    return this.run('labels', identifier, async () => {
      const w = this.writer();
      const ctx = await this.load(identifier);
      const wf = this.authorized(ctx).workflow;
      const idOk = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(x);
      if (![...add, ...remove].every(idOk) || add.length + remove.length === 0 || add.length + remove.length > 20) throw new ActionError(400, 'bad-input', 'Provide 1–20 valid label ids');
      if (add.some((a) => remove.includes(a))) throw new ActionError(400, 'bad-input', 'A label cannot be both added and removed');
      const live = new Map(ctx.teamLabels.map((l) => [l.id, l]));
      const applied = new Set(ctx.labels.map((l) => l.id));
      for (const id of add) {
        const l = live.get(id);
        if (!l) throw new ActionError(422, 'unknown-label', 'That label does not exist for this team in Linear');
        if (l.isGroup) throw new ActionError(422, 'group-label', `"${l.name}" is a label group and cannot be applied`);
        if (isProtected(l.name, wf)) throw new ActionError(403, 'protected-label', `"${l.name}" is a protected workflow label; use Approve for execution`);
      }
      for (const id of remove) {
        const l = live.get(id) ?? ctx.labels.find((x) => x.id === id);
        if (!l) throw new ActionError(422, 'unknown-label', 'That label does not exist for this team in Linear');
        if (!applied.has(id)) throw new ActionError(422, 'not-applied', `"${l.name}" is not on this issue`);
        if (isProtected(l.name, wf)) throw new ActionError(403, 'protected-label', `"${l.name}" is a protected workflow label; use Revoke readiness`);
      }
      const toAdd = add.filter((id) => !applied.has(id)), toRemove = remove;
      for (const id of toAdd) await w.addLabel(ctx.id, id);
      for (const id of toRemove) await w.removeLabel(ctx.id, id);
      // verify: exactly (previous − removed + added); unrelated labels untouched
      const after = await this.load(identifier);
      const expected = new Set([...applied].filter((x) => !toRemove.includes(x)).concat(toAdd));
      const got = new Set(after.labels.map((l) => l.id));
      if (expected.size !== got.size || [...expected].some((x) => !got.has(x))) throw new ActionError(502, 'verify-failed', 'Linear did not reflect the label change; check the issue in Linear');
      return this.finish(identifier, 'Labels updated and verified in Linear');
    });
  }

  // ---- generic status ----
  status(identifier: string, stateId: string) {
    return this.run('status', identifier, async () => {
      const w = this.writer();
      if (typeof stateId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(stateId)) throw new ActionError(400, 'bad-input', 'Invalid state id');
      const ctx = await this.load(identifier);
      const wf = this.authorized(ctx).workflow;
      const toDone = ctx.states.find((s) => s.id === stateId)?.type === 'completed';
      let merged = false;
      if (toDone) {
        // Done needs FRESH GitHub evidence. The cached snapshot is display-only; a failed or malformed re-read is a refusal, not a pass.
        const since = this.deps.service.nowMs();
        await this.deps.service.getIssue(identifier, true);
        const ev = this.deps.service.prEvidence(ctx.identifier, since);
        if (ev === 'unverified') throw new ActionError(502, 'evidence-unverified', `${ctx.identifier} was not changed: GitHub could not freshly verify the linked PR (unavailable or malformed response). Try again, or complete it in Linear.`);
        merged = ev === 'merged';
      }
      const opt = statusOptions(ctx, wf, merged, true).find((s) => s.id === stateId);
      if (!opt) throw new ActionError(422, 'unknown-state', 'That state does not exist for this team');
      if (!opt.allowed) throw new ActionError(403, 'transition-refused', opt.reason ?? 'Transition not allowed');
      await w.setState(ctx.id, stateId);
      const after = await this.load(identifier);
      if (after.state.id !== stateId) throw new ActionError(502, 'verify-failed', 'Linear did not reflect the state change; check the issue in Linear');
      return this.finish(identifier, `Status changed to ${opt.name} and verified in Linear`);
    });
  }

  // ---- milestone ----
  milestone(identifier: string, milestoneId: string | null) {
    return this.run('milestone', identifier, async () => {
      const w = this.writer();
      const ctx = await this.load(identifier);
      this.authorized(ctx);
      if (!ctx.project) throw new ActionError(422, 'no-project', 'The issue is not in a Linear project, so it cannot have a milestone');
      if (milestoneId !== null && (typeof milestoneId !== 'string' || !ctx.milestones.some((m) => m.id === milestoneId)))
        throw new ActionError(422, 'foreign-milestone', "That milestone does not belong to this issue's project");
      if ((ctx.milestone?.id ?? null) === milestoneId) throw new ActionError(422, 'no-change', 'The issue already has that milestone');
      await w.setMilestone(ctx.id, milestoneId);
      const after = await this.load(identifier);
      if ((after.milestone?.id ?? null) !== milestoneId) throw new ActionError(502, 'verify-failed', 'Linear did not reflect the milestone change; check the issue in Linear');
      return this.finish(identifier, milestoneId === null ? 'Milestone removed and verified in Linear' : 'Milestone assigned and verified in Linear');
    });
  }

  // ---- protected: approval ----
  // Same effect as doing it in Linear: Todo + the Ready label. Send, re-read Linear, report what Linear shows.
  approve(identifier: string, confirm: unknown) {
    return this.run('approve', identifier, async () => {
      const w = this.writer();
      if (typeof confirm !== 'string' || low(confirm.trim()) !== low(identifier)) throw new ActionError(400, 'not-confirmed', `Type the issue identifier (${identifier}) to confirm approval`);
      const ctx = await this.load(identifier);
      const sc = this.authorized(ctx);
      const wf = sc.workflow;
      const ev = evaluateApproval(ctx, wf, true, sc);
      if (!ev.eligible) throw new ActionError(422, 'ineligible', `Cannot approve ${ctx.identifier}: ${ev.checks.filter((c) => !c.ok).map((c) => c.label).join('; ')}`, ev.checks);
      const todo = findTodo(ctx, wf)!;
      const readyLabel = ctx.teamLabels.find((l) => low(l.name) === low(wf.readyLabel) && !l.isGroup)!;
      let failure: unknown;
      try {
        if (ctx.state.id !== todo.id) await w.setState(ctx.id, todo.id);
        if (!hasReady(ctx, wf)) await w.addLabel(ctx.id, readyLabel.id);
      } catch (e) { failure = e; }
      const after = await this.tryLoad(identifier);
      if (after && after.state.id === todo.id && hasReady(after, wf)) return this.finish(identifier, `${ctx.identifier} approved for execution: ${todo.name} + ${readyLabel.name}, verified in Linear`);
      throw this.notConfirmed('Approval', failure, after);
    });
  }

  // ---- protected: revoke ----
  revoke(identifier: string, confirm: unknown) {
    return this.run('revoke', identifier, async () => {
      const w = this.writer();
      if (typeof confirm !== 'string' || low(confirm.trim()) !== low(identifier)) throw new ActionError(400, 'not-confirmed', `Type the issue identifier (${identifier}) to confirm`);
      const ctx = await this.load(identifier);
      const wf = this.authorized(ctx).workflow;
      if (!hasReady(ctx, wf)) throw new ActionError(422, 'not-ready', `${ctx.identifier} is not marked ${wf.readyLabel}`);
      if (ctx.state.type !== 'unstarted') throw new ActionError(422, 'started', `Work on ${ctx.identifier} has started (${ctx.state.name}); change its state in Linear`);
      const readyLabel = ctx.labels.find((l) => low(l.name) === low(wf.readyLabel))!;
      const backlog = findBacklog(ctx, wf);
      if (!backlog) throw new ActionError(422, 'no-backlog', 'The team has no backlog state to return the issue to');
      let failure: unknown;
      try {
        await w.removeLabel(ctx.id, readyLabel.id);
        await w.setState(ctx.id, backlog.id);
      } catch (e) { failure = e; }
      const after = await this.tryLoad(identifier);
      if (after && !hasReady(after, wf) && after.state.id === backlog.id) return this.finish(identifier, `Readiness revoked for ${ctx.identifier} and verified in Linear`);
      throw this.notConfirmed('Revocation', failure, after);
    });
  }
}
export type { Issue };
