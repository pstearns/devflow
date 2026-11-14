// The ONLY place that can change anything in Linear. It uses its own credential (LINEAR_WRITE_API_KEY), never the
// read key, and can send exactly the operations below. There is no generic "send this GraphQL" method, so API-supplied
// or browser-supplied text can never become an operation. Comments are create-only. Not available: delete, archive, bulk update, team/project edits.
import { linearSend } from './linear.ts';
import { Limiter, SourceError, isObj } from './util.ts';

const OPS = {
  IssueAddLabel: 'mutation IssueAddLabel($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }',
  IssueRemoveLabel: 'mutation IssueRemoveLabel($id: String!, $labelId: String!) { issueRemoveLabel(id: $id, labelId: $labelId) { success } }',
  IssueUpdate: 'mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }',
  CommentCreate: 'mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }',
} as const;
type OpName = keyof typeof OPS;

export const MAX_COMMENT = 30_000;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/; // Linear UUIDs / our synthetic ids

export class LinearWriteClient {
  private limit = new Limiter(1); // writes are strictly serialized
  constructor(private token: string, private fetchImpl: typeof fetch = fetch) {}

  private async run(op: OpName, variables: Record<string, unknown>, field?: string): Promise<Record<string, unknown>> {
    const data = await this.limit.run(() => linearSend(this.fetchImpl, this.token, OPS[op], variables));
    if (field) {
      const r = data[field];
      if (!isObj(r) || r.success !== true) throw new SourceError('http', `Linear did not confirm ${op}`);
    }
    return data;
  }
  private id(v: string) { if (!ID_RE.test(v)) throw new Error('invalid id'); return v; }

  async addLabel(issueId: string, labelId: string) { return this.run('IssueAddLabel', { id: this.id(issueId), labelId: this.id(labelId) }, 'issueAddLabel'); }
  async removeLabel(issueId: string, labelId: string) { return this.run('IssueRemoveLabel', { id: this.id(issueId), labelId: this.id(labelId) }, 'issueRemoveLabel'); }
  async setState(issueId: string, stateId: string) { return this.run('IssueUpdate', { id: this.id(issueId), input: { stateId: this.id(stateId) } }, 'issueUpdate'); }
  /** Adds one comment to an issue. Body is plain markdown composed by the controller; capped so a runaway agent text cannot flood Linear. */
  async createComment(issueId: string, body: string): Promise<string | undefined> {
    if (!body.trim() || body.length > MAX_COMMENT) throw new Error('invalid comment body');
    const data = await this.run('CommentCreate', { input: { issueId: this.id(issueId), body } }, 'commentCreate');
    const c = isObj(data.commentCreate) && isObj(data.commentCreate.comment) ? data.commentCreate.comment : undefined;
    return typeof c?.id === 'string' ? c.id : undefined;
  }
  async setMilestone(issueId: string, milestoneId: string | null) { return this.run('IssueUpdate', { id: this.id(issueId), input: { projectMilestoneId: milestoneId === null ? null : this.id(milestoneId) } }, 'issueUpdate'); }
}
