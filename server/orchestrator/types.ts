// Shapes shared by the orchestrator modules. The manifest is the durable record of a run; everything in it is
// controller-written. Agent output only ever enters it after validation (see review.ts).
export type RunState =
  | 'accepted' | 'implementing' | 'verifying-commit' | 'ci' | 'reviewing' | 'publishing' | 'repairing'
  | 'awaiting-owner' | 'escalated' | 'aborted';
export const TERMINAL: RunState[] = ['awaiting-owner', 'escalated', 'aborted'];
export const MAX_REPAIRS = 3;

export type Severity = 'blocker' | 'major' | 'minor' | 'note';
export interface Finding { id: string; severity: Severity; file: string; line?: number; title: string; detail: string; evidence: string }
export interface Review { verdict: 'PASS' | 'FAIL'; commit: string; nonce: string; summary: string; reviewedFiles: string[]; findings: Finding[] }

export interface AttemptRecord {
  n: number; // 0 = initial implementation, 1..3 = repairs
  startSha: string; headSha?: string;
  agent?: { exitCode: number | null; timedOut: boolean; log: string };
  ci?: { state: 'success' | 'failure' | 'timeout'; detail: string; evidence: string };
  review?: { verdict: 'PASS' | 'FAIL'; findings: number; raw: string; parsed: string; treeHash: string };
  failure?: string; // why this attempt did not succeed (controller words)
  files?: number; // files changed by the commit vs the base (controller-computed)
  reviewRetries?: number; // invalid reviewer output re-requested with a fresh nonce (max 1)
  commentId?: string;
}

/** Why a run stopped without PASS. `infrastructure` means the environment failed, NOT the code: no repair attempt was consumed. */
export type FailureClass = 'repairs-exhausted' | 'infrastructure' | 'review-invalid' | 'reviewer-tamper' | 'stale-commit' | 'ticket-changed' | 'ci-timeout' | 'policy-violation' | 'controller-error';
export interface InfraEvent { at: string; step: string; detail: string }

export interface Manifest {
  version: 1; runId: string; ticket: string; issueId: string; title: string; project: string; repo: string; baseBranch: string; baseSha: string;
  branch: string; clone: string; state: RunState; outcome?: string; reason?: string; reasonClass?: FailureClass;
  pr?: { number: number; url: string; draft: true }; linearStates: { startedId: string; approvalId: string; blockedId: string; blockedName: string }; blockedConfirmed?: boolean;
  infra: InfraEvent[]; escalationEvidence?: string;
  gate?: { name: string; ok: boolean; detail: string }[];
  originalStateId: string; startConfirmed?: boolean;
  policyDigest: string; agents: { claude?: string; codex?: string }; authorizedBy?: string;
  attempts: AttemptRecord[]; approvedSha?: string; linearCommentIds: string[];
  createdAt: string; updatedAt: string; cleanup: { clone: 'pending' | 'removed' | 'kept'; note?: string };
}

/** The ONLY branch names DevFlow may push or open a PR from. Anything else (main, release/*, a typo'd base) is refused in code. */
export const RUN_BRANCH_RE = /^devflow\/[a-z][a-z0-9]*-\d{1,7}-[a-z0-9]{6,24}$/;
