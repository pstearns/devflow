// Types shared by the server (producer) and the web app (consumer).

/** Five-way evidence state. "unknown" = no evidence either way; "na" = does not apply. */
export type Tri = 'passed' | 'failed' | 'pending' | 'unknown' | 'na';

export interface Evidence {
  source: string; // e.g. "GitHub check run", "Linear state"
  label: string;
  url?: string;
  at?: string;
}

export interface Status {
  value: Tri;
  detail: string;
  evidence: Evidence[];
}

export type Stage = 'discovery' | 'ready' | 'implementation' | 'ci' | 'review' | 'merge' | 'done';
export const STAGES: { id: Stage; label: string }[] = [
  { id: 'discovery', label: 'Discovery' },
  { id: 'ready', label: 'Ready' },
  { id: 'implementation', label: 'Implementation' },
  { id: 'ci', label: 'CI' },
  { id: 'review', label: 'Independent Review' },
  { id: 'merge', label: 'Human Merge' },
  { id: 'done', label: 'Done' },
];

export type StateType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'unknown';

export interface IssueRef {
  identifier: string;
  title: string;
  url?: string;
  stateName: string;
  stateType: StateType;
  resolved: boolean; // completed or canceled
}

export interface Issue {
  id: string;
  identifier: string;
  projectId: string; // DevFlow project id (from config)
  title: string;
  description: string;
  url?: string;
  priority: number; // 0 none, 1 urgent .. 4 low
  priorityLabel: string;
  state: { name: string; type: StateType };
  assignee?: string;
  labels: string[];
  milestoneId?: string; // Linear milestone id, undefined = no milestone
  linearProjectName?: string;
  parentIdentifier?: string;
  childIdentifiers: string[];
  blockedBy: IssueRef[];
  blocks: IssueRef[];
  attachments: { title: string; url: string; kind: string }[];
  branchName?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  dueDate?: string;
  recentChanges: { at: string; from?: string; to?: string; actor?: string }[];
  // derived
  openBlockers: IssueRef[];
  readiness: 'ready' | 'blocked' | 'not-ready' | 'na';
  prKeys: string[];
  primaryPrKey?: string;
  stage?: Stage; // undefined when canceled
  stageEvidence: Evidence[];
  gates: { ci: Status; review: Status; merge: Status };
  rework: string[]; // reasons the work loops back to Implementation
  stale: boolean;
  awaitingHuman: string[]; // concrete human actions pending
  blockedMarker?: string; // set when Linear itself marks the issue blocked (state or label) without relations
  prLinkNote?: string;
  detailAt?: string; // when description/PR evidence were last fetched for this issue specifically
}

export interface Milestone {
  id: string;
  projectId: string;
  name: string;
  description: string;
  targetDate?: string;
  url?: string; // API-provided project URL (Linear exposes no milestone URL)
  issueIdentifiers: string[];
  total: number;
  done: number;
  canceled: number;
  started: number;
  progress: number | null; // done / (total - canceled); null when nothing countable
  overdue: boolean;
  isUnassigned: boolean;
}

export interface CheckItem {
  name: string;
  state: 'passed' | 'failed' | 'pending' | 'unknown';
  rawStatus: string;
  rawConclusion?: string;
  url?: string;
  source: 'check_run' | 'commit_status' | 'workflow_run';
  at?: string;
}

export interface ReviewItem {
  user: string;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  at?: string;
  url?: string;
}

export interface CommitItem { sha: string; message: string; author?: string; at?: string; url?: string }

export interface RunItem {
  id: number; name: string; status: string; conclusion?: string; branch?: string;
  sha: string; url?: string; at?: string; event?: string;
}

export interface PullRequest {
  key: string; // owner/repo#123
  repo: string;
  projectId: string;
  number: number;
  title: string;
  url?: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  author?: string;
  headRef: string;
  headSha: string;
  branchUrl?: string;
  baseRef: string;
  createdAt?: string;
  updatedAt?: string;
  mergedAt?: string;
  labels: string[];
  ticket: { identifier?: string; link: 'linked' | 'ambiguous' | 'unlinked'; candidates: string[]; via: string };
  checks: CheckItem[];
  reviews: ReviewItem[];
  commits: CommitItem[];
  runs: RunItem[];
  detail: { ok: boolean; checksOk: boolean; reviewsOk: boolean; error?: string; checksPartial?: string; reviewsPartial?: string; checkRunsUnavailable?: boolean }; // *Ok=false => unreadable; *Partial => readable but incomplete
  ci: Status;
  humanReview: Status;
  independentReview: Status;
}

export interface ActivityEvent {
  id: string;
  ts: string;
  source: 'github' | 'linear';
  kind: 'pr_opened' | 'pr_merged' | 'pr_closed' | 'pr_updated' | 'ci_run' | 'issue_changed' | 'issue_updated';
  projectId: string;
  title: string;
  detail?: string;
  status?: Tri;
  ticket?: string;
  url?: string;
}

export interface AttentionItem {
  id: string;
  kind: string;
  severity: 'high' | 'medium' | 'low';
  /** true = backed by explicit source evidence; false = an inference/suggestion by DevFlow */
  actionable: boolean;
  projectId: string;
  title: string;
  cause: string;
  evidence: Evidence[];
  nextAction: string;
  ticket?: string;
  prKey?: string;
}

export interface SourceHealth {
  id: string; // linear:<project> | github:<owner/repo>
  label: string;
  state: 'ok' | 'stale' | 'error' | 'not_configured' | 'partial';
  lastSuccess?: string;
  lastAttempt?: string;
  error?: string;
  warnings: string[];
  rateLimit?: { remaining: number; resetAt?: string };
}

export interface KnowledgeLink {
  title: string;
  kind: 'obsidian' | 'repo' | 'linear' | 'url';
  url?: string; // only present when a valid link exists
  copyPath?: string; // fallback for obsidian
  source: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  linearUrl?: string;
  repos: { repo: string; url: string; actionsUrl: string }[];
  knowledge: KnowledgeLink[];
}

export interface PromptDef { id: string; label: string; template: string }

export interface Snapshot {
  generatedAt: string;
  dataAt: string; // age of the oldest successfully-read source; DevFlow never refreshes on a timer
  mode: 'live' | 'demo';
  staleAfterSeconds: number;
  staleDays: number;
  projects: ProjectInfo[];
  issues: Issue[];
  milestones: Milestone[];
  prs: PullRequest[];
  activity: ActivityEvent[];
  attention: AttentionItem[];
  health: SourceHealth[];
  prompts: PromptDef[];
}
