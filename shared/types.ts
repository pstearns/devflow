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

export type Stage = 'backlog' | 'discovery' | 'ready' | 'implementation' | 'ci' | 'review' | 'merge' | 'done';
export const STAGES: { id: Stage; label: string }[] = [
  { id: 'backlog', label: 'Backlog' },
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

/** A Linear label as returned by Linear (id, name and color are never invented). */
export interface LabelRef { id: string; name: string; color: string }

export interface LabelDef extends LabelRef {
  teamKey: string; // team the label set was retrieved for (team labels + applicable workspace labels)
  isGroup: boolean; // group labels cannot be applied to issues
  parent?: string;
  scope: 'team' | 'workspace';
  protected: boolean; // lifecycle authorization labels (e.g. Ready): never editable through the ordinary label menu
  classification: boolean; // issue classification (Bug, Idea, …), separate from lifecycle stages
}

/** Where an issue's workflow/readiness policy comes from. Never inherited across projects or teams. */
export type PolicySource = 'project' | 'team' | 'default';

export interface Issue {
  id: string;
  identifier: string;
  teamKey: string; // Linear team the issue really belongs to (from Linear, never from the browser)
  linearProjectId?: string; // undefined = not in any Linear project ("unprojected")
  configProjectId?: string; // DevFlow config project that covers it, if any
  policy: PolicySource; // which readiness policy applies to this issue
  write: { allowed: boolean; reason?: string }; // config authorization for DevFlow writes to THIS issue's team/project (server re-checks)
  title: string;
  description: string;
  url?: string;
  priority: number; // 0 none, 1 urgent .. 4 low
  priorityLabel: string;
  state: { name: string; type: StateType };
  assignee?: string;
  labels: LabelRef[];
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

/**
 * The earliest unresolved gate on a project's configured, human-approved critical path.
 * blocked = an open blocker stands in the way (link goes to that blocker); needs-authorization = unblocked but not yet authorized (Ready);
 * executable = ready and authorized; in-flight = already being worked or awaiting review/merge; unknown = path ticket not in the loaded data.
 */
export interface MilestoneGate {
  projectId: string; // DevFlow config project
  projectName: string;
  teamKey?: string; // Linear team of the config project (scopes the card when its tickets are not loaded yet)
  state: 'blocked' | 'needs-authorization' | 'executable' | 'in-flight' | 'unknown' | 'clear';
  gate?: string; // the path ticket that is the earliest unresolved gate
  advanceTicket?: string; // the ticket that can advance the milestone (the gate itself, or its first open blocker)
  title?: string; // title of advanceTicket when known
  reason: string;
  deferred: string[]; // unresolved deferred obligations, shown separately: they do not block
  pathTickets: string[]; // every identifier on the path (used to scope the card to the current selection)
  remaining: number; // unresolved non-deferred path tickets, including the gate
}

export interface Milestone {
  id: string;
  teamKey: string;
  linearProjectId?: string; // undefined for the team-level "no project" group
  kind: 'milestone' | 'no-milestone' | 'no-project' | 'unreadable';
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

export interface PrScope { teamKey: string; projectIds: string[] | null; includeUnprojected: boolean } // projectIds null = every project of the team

export interface PullRequest {
  key: string; // owner/repo#123
  repo: string;
  scope: PrScope; // which team/projects this PR may be shown under (derived from the repo's configuration)
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
  teamKey: string;
  linearProjectId?: string;
  scope?: PrScope; // set for GitHub events that are not tied to one issue
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
  teamKey: string; // '' = global (integration health)
  linearProjectId?: string;
  scope?: PrScope;
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

export interface WorkflowInfo { readyLabel: string; discoveryLabels: string[]; classificationLabels: string[]; protectedLabels: string[] }

/** A Linear project inside a team, enriched with whatever DevFlow is configured to know about it. */
export interface TeamProjectInfo {
  id: string; // Linear project id
  name: string;
  slugId?: string;
  url?: string; // API-provided
  configId?: string; // config project covering it
  repos: { repo: string; url: string; actionsUrl: string }[]; // only repos configured for THIS project
  knowledge: KnowledgeLink[];
  policy: PolicySource;
  write: { allowed: boolean; reason?: string };
  workflow: WorkflowInfo;
}

export interface TeamInfo {
  key: string;
  id: string;
  name: string;
  loaded: boolean; // issues/labels/milestones read yet (unloaded teams are read when first selected)
  configured: boolean;
  projects: TeamProjectInfo[];
  /** Applies to the team's unprojected issues. */
  teamLevel: { policy: PolicySource; write: { allowed: boolean; reason?: string }; repos: { repo: string; url: string; actionsUrl: string }[]; knowledge: KnowledgeLink[]; workflow: WorkflowInfo };
  error?: string;
}

export interface PromptDef { id: string; label: string; template: string }

export interface Snapshot {
  generatedAt: string;
  dataAt: string; // age of the oldest successfully-read source; DevFlow never refreshes on a timer
  mode: 'live' | 'demo';
  staleAfterSeconds: number;
  staleDays: number;
  teams: TeamInfo[]; // discovered dynamically from Linear
  issues: Issue[];
  milestones: Milestone[];
  prs: PullRequest[];
  activity: ActivityEvent[];
  attention: AttentionItem[];
  gates: MilestoneGate[];
  health: SourceHealth[];
  prompts: PromptDef[];
  labels: LabelDef[]; // retrieved from Linear for the configured teams (live), not hard-coded
  write: { enabled: boolean; reason?: string }; // Linear write credential configured? (GitHub is always read-only)
}

// ---- controlled Linear actions (the only write surface; GitHub is never written) ----
export interface ActionCheck { id: string; label: string; ok: boolean; detail: string }

export interface ActionOptions {
  writeEnabled: boolean;
  reason?: string; // why writes are disabled
  scope: { teamKey: string; projectName?: string; policy: PolicySource; explicitPolicy: boolean }; // resolved server-side from the issue's live team/project
  identifier: string;
  title: string;
  state: { id: string; name: string; type: StateType };
  /** The issue scope's own workflow names, so dialogs never assume "Ready" / "Backlog". */
  names: { ready: string; backlog?: string };
  labels: { id: string; name: string; color: string; scope: 'team' | 'workspace'; applied: boolean; editable: boolean; reason?: string; classification: boolean; group?: string }[];
  states: { id: string; name: string; type: StateType; current: boolean; allowed: boolean; reason?: string }[];
  milestones: { current?: string; options: { id: string; name: string }[]; canChange: boolean; reason?: string };
  approve: { eligible: boolean; already: boolean; checks: ActionCheck[]; todoState?: string };
  revoke: { possible: boolean; reason?: string };
}

export interface ActionResult { ok: true; verified: true; message: string; snapshot: Snapshot }
export interface ActionFailure { ok: false; code: string; error: string; checks?: ActionCheck[] }
