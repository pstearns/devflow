// M1 controller: accepted ticket -> Claude (sandboxed clone) -> push + draft PR -> CI on the exact SHA -> Codex (sandboxed read-only
// snapshot) -> validated review -> Linear. The controller is the only component holding Linear/GitHub credentials or pushing.
// Two budgets are kept strictly apart: REPAIR attempts (the code was wrong; max 3) and INFRASTRUCTURE retries (the environment failed;
// never consumes a repair). It never merges and never marks a PR ready.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Config, OrchestrationCfg } from '../config.ts';
import { resolveScope } from '../scope.ts';
import { Q_ACTION_ISSUE, hasReady, isResolvedType, parseCtx, type Ctx } from '../actions.ts';
import type { LinearClient } from '../linear.ts';
import { MAX_COMMENT, type LinearWriteClient } from '../linear-write.ts';
import { infraProblem, type AgentRunner } from './agents.ts';
import type { CiProvider } from './ci.ts';
import * as G from './git.ts';
import { RunStore } from './manifest.ts';
import type { PullRequests } from './pr.ts';
import { REVIEW_SCHEMA, ReviewInvalid, parseReviewOutput, validateReview } from './review.ts';
import { MAX_REPAIRS, type AttemptRecord, type FailureClass, type Finding, type Manifest, type Review } from './types.ts';

/** The ticket may not be executed (authorization, state, duplicate, configuration, failed preflight). Nothing was started. */
export class Rejected extends Error {}
/** An environment step kept failing after its retries. Not the agent's fault; never consumes a repair attempt. */
export class InfraError extends Error { constructor(public step: string, message: string) { super(message); } }

export interface Deps {
  cfg: Config;
  read: Pick<LinearClient, 'query'>;
  write: Pick<LinearWriteClient, 'createComment' | 'setState'>;
  ci: CiProvider;
  prs: PullRequests;
  agents: AgentRunner;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

const low = (s: string) => s.toLowerCase();
const defang = (s: string) => s.replace(/@/g, '@​'); // agent text must not trigger Linear mentions/notifications
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const IDENT = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$/;
/** CI definitions the implementer may not change: otherwise "green CI" could be authored by the thing being checked. */
const PROTECTED = ['.github/'];
type Auth = ReturnType<Orchestrator['authorize']>;

export class Orchestrator {
  constructor(private d: Deps) {}
  private at() { return (this.d.now?.() ?? new Date()).toISOString(); }
  private log(l: string) { this.d.log?.(l); }
  private nap(ms: number) { return (this.d.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms); }

  // ---------------------------------------------------------------- acceptance
  private async load(identifier: string): Promise<Ctx> {
    const ctx = parseCtx(await this.d.read.query(Q_ACTION_ISSUE, { id: identifier.toUpperCase() }), []);
    if (!ctx) throw new Rejected(`Issue ${identifier} was not found in Linear`);
    return ctx;
  }

  /** Everything that must be true before any work starts, decided from LIVE Linear and server configuration only. */
  private authorize(ctx: Ctx) {
    const sc = resolveScope(this.d.cfg, ctx.teamKey, ctx.project);
    if (!sc.writeAllowed) throw new Rejected(`${ctx.identifier} is not authorized: ${sc.writeReason ?? 'its team/project is not enabled for writes'}`);
    const oc = sc.configProject?.orchestration;
    if (!sc.configProject || !oc) throw new Rejected(`${ctx.identifier}: its project has no "orchestration" configuration, so DevFlow will not execute it`);
    if (!hasReady(ctx, sc.workflow)) throw new Rejected(`${ctx.identifier} is not explicitly approved: it does not carry the "${sc.workflow.readyLabel}" label`);
    if (ctx.state.type !== 'unstarted') throw new Rejected(`${ctx.identifier} is in "${ctx.state.name}", not an unstarted state: it is already started, finished, or being executed`);
    if (!ctx.depsVerifiable) throw new Rejected(`${ctx.identifier}: blockers could not be fully read, so readiness cannot be confirmed`);
    if (ctx.openBlockers.length) throw new Rejected(`${ctx.identifier} is blocked by ${ctx.openBlockers.map((b) => b.identifier).join(', ')}`);
    if (!ctx.description.trim()) throw new Rejected(`${ctx.identifier} has no description to implement`);
    const state = (name: string) => ctx.states.find((s) => low(s.name) === low(name));
    const started = state(oc.startedState), approval = state(oc.approvalState), blocked = state(oc.blockedState);
    if (!started || started.type !== 'started') throw new Rejected(`State "${oc.startedState}" does not exist as a started-type state in team ${ctx.teamKey}`);
    if (!approval || isResolvedType(approval.type)) throw new Rejected(`State "${oc.approvalState}" must exist and must not be a completed/canceled state: DevFlow never completes work itself`);
    if (!blocked || isResolvedType(blocked.type)) throw new Rejected(`State "${oc.blockedState}" must exist (and not be completed/canceled) so an escalation can always be recorded; create it in Linear or set orchestration.blockedState`);
    return { oc, started, approval, blocked, projectId: sc.configProject.id };
  }

  async run(identifierRaw: string): Promise<Manifest> {
    if (!IDENT.test(identifierRaw)) throw new Rejected('Invalid issue identifier');
    const ticket = identifierRaw.toUpperCase();
    // Preliminary read only to find where this ticket's runs live. Authorization is redone under the lock.
    const preAuth = this.authorize(await this.load(ticket));
    const store = new RunStore(preAuth.oc.runsDir);
    const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
    store.acquire(ticket, runId); // atomic: a second concurrent dispatch dies here
    let m: Manifest | undefined;
    try {
      const active = store.activeRun(ticket);
      if (active) throw new Rejected(`${ticket} already has a non-terminal run (${active.runId}, ${active.state})`);
      const ctx = await this.load(ticket); // authoritative read AFTER the lock
      const auth = this.authorize(ctx);
      const oc = auth.oc;
      // Prove isolation + both CLIs + their logins from inside the sandbox BEFORE the ticket is touched.
      const pf = await this.d.agents.preflight();
      if (!pf.ok) throw new Rejected(`Preflight failed (infrastructure; the ticket was not touched): ${pf.problems.join('; ')}`);
      await G.git(oc.repoPath, ['fetch', 'origin', oc.baseBranch]);
      const baseSha = await G.resolveRef(oc.repoPath, `origin/${oc.baseBranch}`);
      m = {
        version: 1, runId, ticket, issueId: ctx.id, title: ctx.title, project: auth.projectId, repo: oc.repo, baseBranch: oc.baseBranch, baseSha,
        branch: `devflow/${ticket.toLowerCase()}-${runId}`, clone: '', state: 'accepted', attempts: [], linearCommentIds: [], infra: [],
        linearStates: { startedId: auth.started.id, approvalId: auth.approval.id, blockedId: auth.blocked.id, blockedName: auth.blocked.name },
        createdAt: this.at(), updatedAt: this.at(), cleanup: { clone: 'pending' },
      };
      m.clone = join(store.runDir(m), 'clone');
      this.save(store, m, 'accepted', { baseSha, preflight: pf.detail });
      // Leaving the unstarted state is what makes a second dispatch (by any controller) fail acceptance.
      await this.infra(store, m, 'linear-start', () => this.d.write.setState(ctx.id, auth.started.id));
      const after = await this.load(ticket);
      if (after.state.id !== auth.started.id) throw new Error(`Linear did not confirm the move to "${oc.startedState}" (shows "${after.state.name}")`);
      await G.initClone(oc.repoPath, `refs/remotes/origin/${oc.baseBranch}`, m.clone, m.branch);
      return await this.loop(store, m, ctx, auth);
    } catch (e) {
      if (!m) { store.release(ticket, runId); throw e; } // rejected before any state existed
      if (e instanceof InfraError) return this.escalate(store, m, 'infrastructure', `Infrastructure failure at "${e.step}": ${e.message}. No repair attempt was consumed; the code was not judged.`);
      return this.escalate(store, m, 'controller-error', `controller error: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  /** Runs an environment step, retrying with backoff. Exhaustion throws InfraError, which is never counted as a failed repair. */
  private async infra<T>(store: RunStore, m: Manifest, step: string, fn: () => Promise<T>): Promise<T> {
    const max = this.d.cfg.projects.find((p) => p.id === m.project)?.orchestration?.infraRetries ?? 2;
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        const detail = e instanceof Error ? e.message.slice(0, 300) : 'unknown error';
        this.recordInfra(store, m, step, detail);
        if (i >= max) throw new InfraError(step, detail);
        await this.nap(2000 * (i + 1));
      }
    }
  }
  private recordInfra(store: RunStore, m: Manifest, step: string, detail: string) {
    m.infra.push({ at: this.at(), step, detail }); this.save(store, m, 'infra-failure', { step, detail });
  }

  // ---------------------------------------------------------------- the loop (n counts REPAIR attempts only)
  private async loop(store: RunStore, m: Manifest, ctx: Ctx, auth: Auth): Promise<Manifest> {
    const oc = auth.oc;
    let findings: Finding[] = [];
    let ciFailure: string | undefined;
    let startSha = m.baseSha;
    for (let n = 0; n <= MAX_REPAIRS; n++) {
      const a: AttemptRecord = { n, startSha };
      m.attempts.push(a);
      this.state(store, m, n === 0 ? 'implementing' : 'repairing', { attempt: n });
      const dir = `attempt-${n}`;

      // 1. Claude implements / repairs, inside the sandbox. Environment failures retry without consuming this attempt.
      const prompt = n === 0 ? implementPrompt(ctx, m) : repairPrompt(ctx, m, findings, ciFailure, n);
      store.evidence(m, `${dir}/claude-prompt.txt`, prompt);
      await this.runClaude(store, m, a, oc, prompt, dir);

      // 2. Bring the commit across the trust boundary into the controller's repo and judge it THERE
      this.state(store, m, 'verifying-commit', { attempt: n });
      const bad = await this.importAndVerify(m, a, oc);
      if (bad) {
        a.failure = bad; this.save(store, m, 'attempt-failed', { attempt: n, reason: bad });
        if (n === 0) return this.escalate(store, m, 'repairs-exhausted', `The first implementation attempt produced nothing reviewable: ${bad}`);
        findings = [controllerFinding(bad)]; ciFailure = undefined;
        if (n === MAX_REPAIRS) break;
        continue;
      }
      const sha = a.headSha!;
      startSha = sha;

      // 3. push, confirm the REMOTE has exactly this SHA, ensure a DRAFT PR, confirm GitHub's PR head is this SHA
      await this.infra(store, m, 'push', async () => {
        await G.pushRef(oc.repoPath, this.ref(m, n), m.branch);
        const remote = await G.remoteHead(oc.repoPath, m.branch);
        if (remote !== sha) throw new Error(`remote branch is at ${remote?.slice(0, 12) ?? 'nothing'} after push, expected ${sha.slice(0, 12)}`);
      });
      await this.infra(store, m, 'pull-request', async () => {
        if (!m.pr) {
          const pr = await this.d.prs.ensureDraft(m.repo, { branch: m.branch, base: m.baseBranch, title: `${m.ticket}: ${m.title}`.slice(0, 250), body: prBody(m) });
          m.pr = { ...pr, draft: true }; this.save(store, m, 'pr-created', { number: pr.number });
        }
        const head = await this.d.prs.headSha(m.repo, m.pr.number);
        if (head !== sha) throw new Error(`the pull request head is ${head.slice(0, 12)}, expected ${sha.slice(0, 12)}`);
      });

      // 4. CI must be green on that exact SHA before a reviewer is spent
      this.state(store, m, 'ci', { attempt: n, sha });
      const ci = await this.infra(store, m, 'ci', () => this.d.ci.wait(m.repo, sha, { required: oc.ciChecks, timeoutMs: oc.ciTimeoutMinutes * 60_000 }));
      a.ci = { state: ci.state, detail: ci.detail, evidence: store.evidence(m, `${dir}/ci.json`, JSON.stringify({ sha, ...ci }, null, 2)) };
      this.save(store, m, 'ci-result', { attempt: n, state: ci.state });
      if (ci.state === 'timeout') return this.escalate(store, m, 'ci-timeout', ci.detail); // no verdict at all: not something Claude can repair
      if (ci.state === 'failure') {
        a.failure = `CI failed: ${ci.detail}`;
        await this.comment(store, m, a, `**DevFlow run ${m.runId}: CI FAILED** on \`${sha.slice(0, 12)}\` (attempt ${n})${prLine(m)}.\n\n${defang(clip(ci.detail, 1500))}\n\n${n < MAX_REPAIRS ? `Re-dispatching Claude (repair ${n + 1} of ${MAX_REPAIRS}).` : 'No repair attempts remain.'}`);
        findings = []; ciFailure = ci.detail;
        if (n === MAX_REPAIRS) break;
        continue;
      }

      // 5. independent review of that exact SHA (one retry for malformed output; environment failures retry separately)
      this.state(store, m, 'reviewing', { attempt: n, sha });
      const outcome = await this.review(store, m, a, ctx, oc, sha);
      if ('fail' in outcome) return this.escalate(store, m, outcome.cls, outcome.fail);
      const review = outcome.review;

      // 6. publish the controller-validated result, but only if the reviewed SHA is still the branch head (stale results are never published)
      this.state(store, m, 'publishing', { attempt: n, sha });
      if ((await G.remoteHead(oc.repoPath, m.branch)) !== sha) return this.escalate(store, m, 'stale-commit', 'Branch moved while the review ran (stale commit); the result was not published');
      await this.comment(store, m, a, renderReview(m, n, review));
      if (review.verdict === 'PASS') return this.pass(store, m, auth, sha);
      a.failure = `Review FAIL with ${review.findings.length} finding(s)`;
      findings = review.findings; ciFailure = undefined;
      if (n === MAX_REPAIRS) break;
    }
    return this.escalate(store, m, 'repairs-exhausted', `${MAX_REPAIRS} repair attempts did not produce a passing, CI-green, independently reviewed commit`);
  }

  private ref(m: Manifest, n: number) { return `refs/devflow/${m.runId}/attempt-${n}`; }

  private async runClaude(store: RunStore, m: Manifest, a: AttemptRecord, oc: OrchestrationCfg, prompt: string, dir: string) {
    for (let i = 0; ; i++) {
      const res = await this.d.agents.implement({ clone: m.clone, prompt, timeoutMs: oc.agentTimeoutMinutes * 60_000 });
      const log = store.evidence(m, `${dir}/claude-output${i ? `-retry${i}` : ''}.txt`, logOf(res));
      a.agent = { exitCode: res.exitCode, timedOut: res.timedOut, log };
      const p = infraProblem(res);
      if (!p) return;
      this.recordInfra(store, m, 'claude', p);
      if (i >= oc.infraRetries) throw new InfraError('claude', p);
      await this.nap(2000 * (i + 1));
    }
  }

  /** Imports the agent's branch as a private ref in the CONTROLLER's repo and verifies it there. Returns a reason if unusable. */
  private async importAndVerify(m: Manifest, a: AttemptRecord, oc: OrchestrationCfg): Promise<string | undefined> {
    let sha: string;
    try { sha = await G.importBranch(oc.repoPath, m.clone, m.branch, this.ref(m, a.n)); } catch { return 'The agent left no usable commit on the run branch'; }
    a.headSha = sha;
    if (sha === a.startSha) return 'Claude made no new commit';
    if (!(await G.isAncestor(oc.repoPath, a.startSha, sha))) return 'The new commit does not descend from the previous one (history was rewritten)';
    const files = await G.changedFiles(oc.repoPath, m.baseSha, sha);
    if (!files.length) return 'The branch has no changes relative to the base';
    const prot = files.filter((f) => PROTECTED.some((p) => f.startsWith(p)));
    if (prot.length) return `The commit modifies protected CI configuration (${prot.slice(0, 3).join(', ')}); the implementer may not change what verifies it`;
    return undefined;
  }

  // ---------------------------------------------------------------- review
  private async review(store: RunStore, m: Manifest, a: AttemptRecord, ctx: Ctx, oc: OrchestrationCfg, sha: string): Promise<{ review: Review } | { fail: string; cls: FailureClass }> {
    if ((await G.remoteHead(oc.repoPath, m.branch)) !== sha) return { fail: 'The branch moved before review started (stale commit)', cls: 'stale-commit' };
    const base = join(store.runDir(m), `attempt-${a.n}`);
    const files = await G.changedFiles(oc.repoPath, m.baseSha, sha);
    const diff = await G.patch(oc.repoPath, m.baseSha, sha);
    const patchRef = store.evidence(m, `attempt-${a.n}/changes.patch`, diff);
    mkdirSync(base, { recursive: true });
    const schemaPath = join(base, 'review-schema.json');
    store.evidence(m, `attempt-${a.n}/review-schema.json`, JSON.stringify(REVIEW_SCHEMA));
    let invalid = 0, infra = 0;
    for (let t = 0; ; t++) {
      const suffix = t ? `-try${t}` : '';
      const rdir = join(base, `review${suffix}`), out = join(base, `out${suffix}`);
      const nonce = randomBytes(16).toString('hex'); // fresh per invocation: a retry can never replay an earlier answer
      await G.exportTree(oc.repoPath, sha, join(rdir, 'src'));
      store.evidence(m, `attempt-${a.n}/review${suffix}/context/files.txt`, `${files.join('\n')}\n`);
      store.evidence(m, `attempt-${a.n}/review${suffix}/context/ticket.md`, `# ${ctx.identifier}: ${ctx.title}\n\n${ctx.description}\n`);
      store.evidence(m, `attempt-${a.n}/review${suffix}/context/changes.patch`, diff);
      mkdirSync(out, { recursive: true, mode: 0o700 });
      G.makeReadOnly(rdir);
      const before = G.hashDir(rdir);
      const prompt = reviewPrompt(ctx, sha, nonce);
      store.evidence(m, `attempt-${a.n}/codex-prompt${suffix}.txt`, prompt);
      const res = await this.d.agents.review({ snapshot: rdir, outDir: out, prompt, schemaPath, timeoutMs: oc.agentTimeoutMinutes * 60_000 });
      const rawRef = store.evidence(m, `attempt-${a.n}/codex-output${suffix}.txt`, logOf(res));
      const after = G.hashDir(rdir);
      this.removeTemp(store, m, rdir); this.removeTemp(store, m, out);
      // A reviewer that changed its read-only inputs is a security signal, not a flaky answer: no retry, no review.
      if (after !== before) return { fail: 'The reviewer modified its read-only environment; the review is discarded', cls: 'reviewer-tamper' };
      const p = infraProblem(res);
      if (p) {
        this.recordInfra(store, m, 'codex', p);
        if (infra++ >= oc.infraRetries) throw new InfraError('codex', p);
        await this.nap(2000 * infra);
        continue;
      }
      try {
        const counts = new Map<string, number | undefined>();
        const message = res.finalMessage ?? res.stdout;
        for (const f of new Set(extractFiles(message))) counts.set(f, await G.lineCount(oc.repoPath, sha, f));
        const review = validateReview(parseReviewOutput(message), { sha, nonce, changedFiles: files, lineCount: (f) => counts.get(f) });
        a.review = { verdict: review.verdict, findings: review.findings.length, raw: rawRef, parsed: store.evidence(m, `attempt-${a.n}/review.json`, JSON.stringify({ ...review, patch: patchRef }, null, 2)), treeHash: before };
        this.save(store, m, 'review-validated', { attempt: a.n, verdict: review.verdict, tries: t + 1 });
        return { review };
      } catch (e) {
        if (!(e instanceof ReviewInvalid)) throw e;
        this.save(store, m, 'review-invalid', { attempt: a.n, try: t, reason: e.message });
        if (invalid++ >= 1) return { fail: `Reviewer output rejected twice (fresh nonce on the retry): ${e.message}`, cls: 'review-invalid' };
        a.reviewRetries = invalid; // never transformed into PASS: the retry is a brand-new review of the same SHA
      }
    }
  }

  // ---------------------------------------------------------------- outcomes
  private async pass(store: RunStore, m: Manifest, auth: Auth, sha: string): Promise<Manifest> {
    const now = await this.load(m.ticket);
    if (now.state.id !== auth.started.id) return this.escalate(store, m, 'ticket-changed', `Ticket moved to "${now.state.name}" in Linear during the run; not changing it`);
    await this.infra(store, m, 'linear-approval', () => this.d.write.setState(m.issueId, auth.approval.id));
    const verify = await this.load(m.ticket);
    if (verify.state.id !== auth.approval.id) return this.escalate(store, m, 'controller-error', `Linear did not confirm the move to "${auth.approval.name}" (shows "${verify.state.name}")`);
    m.approvedSha = sha; m.outcome = 'PASS'; m.reason = `Awaiting owner approval of ${sha}. Draft PR${m.pr ? ` #${m.pr.number}` : ''} not merged.`;
    this.state(store, m, 'awaiting-owner', { sha });
    await this.cleanup(store, m, auth.oc.repoPath, sha);
    store.release(m.ticket, m.runId);
    return m;
  }

  /** Stops the run, preserves evidence, tells Linear and moves the ticket to the Blocked state. Always releases the lock. */
  private async escalate(store: RunStore, m: Manifest, cls: FailureClass, reason: string): Promise<Manifest> {
    m.outcome = 'ESCALATED'; m.reason = reason; m.reasonClass = cls;
    const last = m.attempts[m.attempts.length - 1];
    try {
      m.escalationEvidence = store.evidence(m, 'escalation.json', JSON.stringify({
        runId: m.runId, ticket: m.ticket, class: cls, reason, branch: m.branch, pr: m.pr, baseSha: m.baseSha, attempts: m.attempts, infra: m.infra,
        repairsUsed: Math.max(0, m.attempts.filter((x) => x.n > 0).length), at: this.at(),
      }, null, 2));
    } catch { /* evidence is best effort here; the manifest below still records the reason */ }
    this.state(store, m, 'escalated', { reason, class: cls });
    const infraNote = cls === 'infrastructure' || cls === 'ci-timeout' ? '\n\nThis is an **infrastructure** stop: the code was not judged and no repair attempt was consumed. Fix the environment, then re-approve the ticket.' : '';
    try {
      await this.comment(store, m, last ?? ({ n: -1, startSha: m.baseSha } as AttemptRecord),
        `**DevFlow run ${m.runId}: ESCALATED to the owner (${cls}).** No further automated attempts will be made.\n\nReason: ${defang(clip(reason, 2000))}${infraNote}\n\nRepair attempts used: ${m.attempts.filter((x) => x.n > 0).length} of ${MAX_REPAIRS}. Infrastructure retries recorded: ${m.infra.length}. Branch \`${m.branch}\`${prLine(m)}. Evidence: \`${m.escalationEvidence ?? 'see manifest.json'}\` in the run directory.`);
    } catch (e) { store.event(m, this.at(), 'escalation-comment-failed', { error: e instanceof Error ? e.message : 'unknown' }); }
    try {
      await this.d.write.setState(m.issueId, m.linearStates.blockedId);
      m.blockedConfirmed = (await this.load(m.ticket)).state.id === m.linearStates.blockedId;
    } catch (e) { m.blockedConfirmed = false; store.event(m, this.at(), 'blocked-transition-failed', { error: e instanceof Error ? e.message : 'unknown' }); }
    this.save(store, m, 'escalation-recorded', { blockedConfirmed: m.blockedConfirmed });
    await this.cleanup(store, m).catch(() => undefined);
    store.release(m.ticket, m.runId);
    return m;
  }

  private async comment(store: RunStore, m: Manifest, a: AttemptRecord, body: string) {
    const text = clip(body, MAX_COMMENT - 200);
    let id: string | undefined;
    try { id = await this.d.write.createComment(m.issueId, text); } catch { id = await this.d.write.createComment(m.issueId, text); } // one retry, then the error propagates
    if (id) { m.linearCommentIds.push(id); a.commentId = id; }
    this.save(store, m, 'linear-comment', { commentId: id });
  }

  /** Deletes only what is safe to lose. Evidence is never touched; the clone goes only after PASS, when its commit is on the remote. */
  private async cleanup(store: RunStore, m: Manifest, repoPath?: string, sha?: string) {
    if (!repoPath || !sha) { m.cleanup = { clone: 'kept', note: 'kept for inspection (run did not pass)' }; this.save(store, m, 'cleanup'); return; }
    try {
      const onRemote = (await G.remoteHead(repoPath, m.branch)) === sha;
      const root = resolve(store.runDir(m)) + sep;
      if (!onRemote) m.cleanup = { clone: 'kept', note: 'kept: the approved commit is not on the remote branch' };
      else if (!resolve(m.clone).startsWith(root)) m.cleanup = { clone: 'kept', note: 'kept: clone is outside the run directory' };
      else {
        rmSync(m.clone, { recursive: true, force: true });
        for (const x of m.attempts) await G.deleteRef(repoPath, this.ref(m, x.n)); // private refs; the branch on origin holds the commits
        m.cleanup = { clone: 'removed' };
      }
    } catch (e) { m.cleanup = { clone: 'kept', note: `cleanup skipped: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}` }; }
    this.save(store, m, 'cleanup');
  }

  private removeTemp(store: RunStore, m: Manifest, dir: string) {
    const root = resolve(store.runDir(m)) + sep;
    const d = resolve(dir);
    if (!d.startsWith(root) || !existsSync(d)) return; // only our own scratch inside the run dir
    G.makeWritable(d);
    if (/review(-try\d+)?$/.test(d)) rmSync(join(d, 'src'), { recursive: true, force: true }); // snapshot is reproducible from the SHA; context/ stays as evidence
    else rmSync(d, { recursive: true, force: true });
  }

  private save(store: RunStore, m: Manifest, what: string, data: Record<string, unknown> = {}) {
    store.save(m, this.at());
    store.event(m, this.at(), what, data);
    this.log(`${m.ticket} ${m.runId} ${what}`);
  }
  private state(store: RunStore, m: Manifest, s: Manifest['state'], data: Record<string, unknown> = {}) { m.state = s; this.save(store, m, `state:${s}`, data); }
}

// ------------------------------------------------------------------ text builders (controller-owned)
const logOf = (r: { exitCode: number | null; signal: string | null; timedOut: boolean; truncated: boolean; stdout: string; stderr: string }) => `exit=${r.exitCode} signal=${r.signal} timedOut=${r.timedOut} truncated=${r.truncated}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n`;
const controllerFinding = (why: string): Finding => ({ id: 'controller-1', severity: 'blocker', file: '-', title: 'Controller check failed', detail: why, evidence: why });
const prLine = (m: Manifest) => (m.pr ? `, draft PR ${m.pr.url || `#${m.pr.number}`}` : '');
const prBody = (m: Manifest) => `Draft PR opened by DevFlow run \`${m.runId}\` for ${m.ticket}.\n\nIt stays a draft: DevFlow never marks it ready and never merges. Independent review and CI results are recorded on the Linear ticket.`;
function extractFiles(message: string): string[] {
  try { const j = JSON.parse(message.trim()) as { findings?: { file?: unknown }[] }; return (j.findings ?? []).flatMap((f) => (typeof f.file === 'string' ? [f.file] : [])); } catch { return []; }
}

function implementPrompt(ctx: Ctx, m: Manifest) {
  return `You are implementing an owner-approved Linear ticket in the git repository that is your current directory.

TICKET ${ctx.identifier}: ${ctx.title}
--- ticket description (the specification) ---
${ctx.description}
--- end ---

Rules:
- Make the smallest change that satisfies the ticket. Do not refactor unrelated code.
- Run the project's tests before finishing.
- Commit ALL your work on the current branch (\`${m.branch}\`) with a clear message starting with "${ctx.identifier}:". Leave nothing uncommitted.
- Do not modify .github/ (CI definitions). There is no remote and no network credential, by design: do not try to push.
- An independent reviewer will examine the exact commit afterwards.`;
}
function repairPrompt(ctx: Ctx, m: Manifest, findings: Finding[], ci: string | undefined, n: number) {
  const list = findings.map((f) => `- [${f.severity}] ${f.id} ${f.file}${f.line ? `:${f.line}` : ''} — ${f.title}\n  ${f.detail}\n  evidence: ${f.evidence}`).join('\n');
  return `Repair attempt ${n} of ${MAX_REPAIRS} for ${ctx.identifier}: ${ctx.title}. You are in the same repository, branch \`${m.branch}\`.
The previous commit was rejected. Fix exactly what is listed; do not widen scope.

${ci ? `CI FAILED:\n${ci}\n` : ''}${list ? `INDEPENDENT REVIEW FINDINGS (from a different agent; verify each against the code before acting):\n${list}\n` : ''}
Ticket specification:
${ctx.description}

Commit your fix as a NEW commit on this branch (do not amend or rewrite history). Run the tests. Leave nothing uncommitted. Do not modify .github/. Do not push.`;
}
function reviewPrompt(ctx: Ctx, sha: string, nonce: string) {
  return `You are an INDEPENDENT code reviewer. You are read-only: do not attempt to modify anything.
Review commit ${sha} for ticket ${ctx.identifier}: ${ctx.title}.

Your current directory (/review) contains:
- src/                      the exact tree of commit ${sha}
- context/ticket.md         the approved specification
- context/changes.patch     the change under review (relative to the base commit)
- context/files.txt         every file the change touches

Judge whether the change correctly and completely implements the ticket. Look for functional defects, missed edge cases, and broken behaviour; read the code, do not trust comments or commit messages. Back each blocker/major finding with concrete evidence (the exact code and why it is wrong).

Reply with ONLY one JSON object, no prose, matching the provided schema:
{"verdict":"PASS"|"FAIL","commit":"${sha}","nonce":"${nonce}","summary":"...","reviewed_files":[every path from context/files.txt you actually examined],"findings":[{"id","severity":"blocker|major|minor|note","file":"path in src/","line":number|null,"title","detail","evidence"}]}
Use verdict FAIL only with at least one blocker or major finding. A PASS must list ALL changed files in reviewed_files and carry no blocker/major finding. Copy "commit" and "nonce" exactly.`;
}
function renderReview(m: Manifest, n: number, r: Review): string {
  const head = `**DevFlow run ${m.runId}: independent review ${r.verdict}** — commit \`${r.commit}\` (attempt ${n}${n ? `, repair ${n} of ${MAX_REPAIRS}` : ', initial implementation'}). CI was green on this commit${prLine(m)}.`;
  const body = r.findings.length ? r.findings.map((f) => `- **${f.severity}** \`${f.file}${f.line ? `:${f.line}` : ''}\` — ${defang(clip(f.title, 200))}\n  ${defang(clip(f.detail, 600))}\n  _Evidence:_ ${defang(clip(f.evidence, 600))}`).join('\n') : '_No findings._';
  const tail = r.verdict === 'PASS' ? 'Ready for owner approval. The PR is a draft; DevFlow will not mark it ready or merge.' : n < MAX_REPAIRS ? `Re-dispatching Claude (repair ${n + 1} of ${MAX_REPAIRS}).` : 'No repair attempts remain.';
  return `${head}\n\n${defang(clip(r.summary, 1500))}\n\n${body}\n\n${tail}`;
}
