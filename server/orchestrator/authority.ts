import { createHash } from 'node:crypto';
import { fstatSync, openSync, closeSync, readFileSync, constants } from 'node:fs';
import type { Ctx } from '../actions.ts';
import type { LinearClient } from '../linear.ts';
import { isObj } from '../util.ts';
import { repairLimit, type Manifest } from './types.ts';

export class AuthorityError extends Error {}
export interface AuthorityPolicy { owners: string[]; delegates: string[] }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function loadAuthority(): AuthorityPolicy {
  let fd: number | undefined;
  try {
    fd = openSync('/etc/devflow-linear-authority.json', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022 || stat.size > 8192) throw new Error();
    const policy: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!isObj(policy)) throw new Error();
    const { owners, delegates } = policy;
    if (!Array.isArray(owners) || !owners.length || !Array.isArray(delegates)) throw new Error();
    const ids = [...owners, ...delegates];
    if (!ids.every(id => typeof id === 'string' && UUID.test(id)) || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) throw new Error();
    return { owners: owners.map(id => id.toLowerCase()), delegates: delegates.map(id => id.toLowerCase()) };
  } catch {
    throw new AuthorityError('Cannot verify the root-owned Linear authority allowlist');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export const Q_AUTHORITY = `query DispatchAuthority($id: String!) {
  issue(id: $id) {
    id title description state { id }
    history(first: 100) {
      pageInfo { hasNextPage }
      nodes { id createdAt actorId actors { id } fromStateId toStateId addedLabelIds removedLabelIds }
    }
    comments(first: 100) {
      pageInfo { hasNextPage }
      nodes { id body createdAt updatedAt user { id } }
    }
  }
}`;

export function scopeDigest(ctx: Pick<Ctx, 'id' | 'title' | 'description'>): string {
  return createHash('sha256').update(JSON.stringify([ctx.id, ctx.title, ctx.description])).digest('hex');
}

function records(connection: unknown) {
  if (!isObj(connection) || !isObj(connection.pageInfo) || connection.pageInfo.hasNextPage !== false ||
      !Array.isArray(connection.nodes) || !connection.nodes.every(isObj)) {
    throw new AuthorityError('Linear authority records are incomplete');
  }
  return connection.nodes;
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new AuthorityError('Linear authority timestamp is unavailable');
  return Date.parse(value);
}

function newest(entries: Record<string, unknown>[]) {
  const sorted = entries.map(entry => ({ entry, at: timestamp(entry.createdAt) })).sort((a, b) => b.at - a.at);
  if (sorted.length > 1 && sorted[0]!.at === sorted[1]!.at) throw new AuthorityError('Linear authority records have ambiguous ordering');
  return sorted[0]?.entry;
}

function actor(entry: Record<string, unknown> | undefined, allowlist: string[]) {
  return entry && typeof entry.actorId === 'string' && allowlist.includes(entry.actorId.toLowerCase()) &&
    Array.isArray(entry.actors) && entry.actors.length === 1 &&
    isObj(entry.actors[0]) && entry.actors[0].id === entry.actorId;
}

function stateMoves(history: Record<string, unknown>[]) {
  return history.filter(entry => typeof entry.toStateId === 'string');
}

async function readIssue(read: Pick<LinearClient, 'query'>, ctx: Ctx) {
  const { issue } = await read.query(Q_AUTHORITY, { id: ctx.id });
  if (!isObj(issue) || issue.id !== ctx.id || !isObj(issue.state) || issue.state.id !== ctx.state.id ||
      issue.title !== ctx.title || issue.description !== ctx.description) {
    throw new AuthorityError('Linear issue or state changed while verifying dispatch authority');
  }
  return { issue, history: records(issue.history) };
}

export async function inspectTriage(
  read: Pick<LinearClient, 'query'>, policy: AuthorityPolicy, ctx: Ctx, priorRuns: Manifest[],
) {
  if (ctx.state.type !== 'triage' && ctx.state.name.toLowerCase() !== 'triage') throw new AuthorityError('Issue is outside Triage');
  const { issue, history } = await readIssue(read, ctx);
  const entry = newest(stateMoves(history));
  if (!entry || entry.toStateId !== ctx.state.id || !actor(entry, policy.owners) || typeof entry.id !== 'string') {
    throw new AuthorityError('Current Triage entry is missing verified owner authority');
  }
  let remediationHold: string | undefined;
  try {
    verifyRemediation(issue, policy, ctx, priorRuns);
  } catch (error) {
    if (!(error instanceof AuthorityError)) throw error;
    remediationHold = error.message;
  }
  return { entry: entry.id, scope: scopeDigest(ctx), remediationHold };
}

export async function verifyAuthority(
  read: Pick<LinearClient, 'query'>, policy: AuthorityPolicy, ctx: Ctx, readyLabelId: string, priorRuns: Manifest[],
) {
  const { issue, history } = await readIssue(read, ctx);
  const moves = stateMoves(history);
  const move = newest(moves);
  const label = newest(history.filter(h => [h.addedLabelIds, h.removedLabelIds].some(ids => Array.isArray(ids) && ids.includes(readyLabelId))));
  if (!label || typeof label.id !== 'string' || !Array.isArray(label.addedLabelIds) || !label.addedLabelIds.includes(readyLabelId) ||
      (Array.isArray(label.removedLabelIds) && label.removedLabelIds.includes(readyLabelId))) {
    throw new AuthorityError('The current Ready label has no unambiguous application record');
  }

  const triageIds = ctx.states.filter(state => state.type === 'triage' || state.name.toLowerCase() === 'triage').map(state => state.id);
  const entry = move && typeof move.fromStateId === 'string' && triageIds.includes(move.fromStateId)
    ? newest(moves.filter(h => timestamp(h.createdAt) < timestamp(move.createdAt)))
    : undefined;
  const promotion = move && move.toStateId === ctx.state.id && actor(move, policy.delegates) &&
    entry && entry.toStateId === move.fromStateId && actor(entry, policy.owners) &&
    actor(label, policy.delegates) && timestamp(label.createdAt) >= timestamp(entry.createdAt);
  const ownerReady = actor(label, policy.owners) && (!move ||
    (move.toStateId === ctx.state.id && (actor(move, policy.owners) || timestamp(label.createdAt) > timestamp(move.createdAt))));
  const delegated = promotion && typeof entry.id === 'string' && records(issue.comments).some(comment =>
    typeof comment.id === 'string' && isObj(comment.user) && typeof comment.user.id === 'string' &&
    comment.user.id === move.actorId && comment.createdAt === comment.updatedAt &&
    typeof comment.body === 'string' && comment.body.startsWith(`DevFlow Triage: ${entry.id} ${scopeDigest(ctx)}\n\n`) &&
    comment.body.split('\n\n').slice(1).join('\n\n').trim().length > 0 &&
    timestamp(comment.createdAt) >= timestamp(entry.createdAt) &&
    timestamp(comment.createdAt) <= timestamp(move.createdAt) &&
    timestamp(comment.createdAt) <= timestamp(label.createdAt));
  if (!ownerReady && !delegated) throw new AuthorityError('Ready requires owner approval or a delegate promotion from owner-entered Triage');

  return { readyRecord: label.id, scope: scopeDigest(ctx), remediationApproval: verifyRemediation(issue, policy, ctx, priorRuns) };
}

function verifyRemediation(issue: Record<string, unknown>, policy: AuthorityPolicy, ctx: Ctx, priorRuns: Manifest[]) {
  const exhausted = priorRuns.find(exhaustedRepairAuthority);
  if (!exhausted) return;
  const expected = `DevFlow remediation: ${ctx.id} ${exhausted.runId} ${scopeDigest(ctx)}`;
  const comments = records(issue.comments);
  const lastUse = Math.max(timestamp(exhausted.updatedAt), ...priorRuns
    .filter(run => run.remediationApproval && run.updatedAt)
    .map(run => timestamp(run.updatedAt)));
  const approvals = comments.filter(comment => comment.body === expected && isObj(comment.user) &&
    typeof comment.user.id === 'string' && policy.owners.includes(comment.user.id.toLowerCase()) &&
    !priorRuns.some(run => run.remediationApproval === comment.id) && timestamp(comment.createdAt) > lastUse);
  const approval = approvals.length === 1 ? approvals[0] : undefined;
  if (!approval || typeof approval.id !== 'string' || approval.createdAt !== approval.updatedAt) {
    throw new AuthorityError(`Run ${exhausted.runId} exhausted repair authority. A fresh owner remediation approval for this scope is required`);
  }
  return approval.id;
}

export function exhaustedRepairAuthority(run: Manifest): boolean {
  return run.reasonClass === 'repairs-exhausted' || (run.attempts ?? []).some(attempt =>
    attempt.n === repairLimit(run) && attempt.review?.verdict === 'FAIL');
}
