import { existsSync, readFileSync, statSync } from 'node:fs';
import { isObj, str, arr } from './util.ts';
import type { PromptDef } from '../shared/types.ts';
import { TOOL_RE } from './orchestrator/policy.ts';

export interface KnowledgeCfg { title: string; kind: 'obsidian' | 'repo' | 'url'; path?: string; repo?: string; ref?: string; url?: string }
/** Names of Linear labels/states that carry lifecycle meaning. Configuration, not code: nothing project-specific is built in. */
export interface WorkflowCfg {
  readyLabel: string;
  discoveryLabels: string[];
  classificationLabels: string[];
  protectedLabels: string[]; // never editable via the ordinary label menu (readyLabel is always protected)
  todoState: string;
  backlogState: string;
}
export const DEFAULT_WORKFLOW: WorkflowCfg = {
  readyLabel: 'Ready', discoveryLabels: ['Discovery'], classificationLabels: ['Idea', 'Bug', 'Security', 'Feature', 'Research', 'Tech Debt'],
  protectedLabels: [], todoState: 'Todo', backlogState: 'Backlog',
};

export interface ProjectCfg {
  id: string;
  name: string;
  workflow: WorkflowCfg;
  linear?: { teamKey: string; projects: string[] };
  repos: string[]; // owner/repo
  knowledge: KnowledgeCfg[];
  /** Human-approved, ordered gate sequence. `deferred` entries are obligations that must be done eventually but do not gate the next step. */
  criticalPath: { ticket: string; deferred: boolean }[];
  /** M1 agent orchestration. Absent => `orchestrate` refuses every ticket of this project. */
  orchestration?: OrchestrationCfg;
}
/** Everything the orchestrator needs to know about ONE repository. Names of Linear states are configuration, not code. */
export interface OrchestrationCfg {
  repo: string; // owner/repo; must also be listed in the project's github.repos
  repoPath: string; // absolute path of a local clone whose `origin` is that repo
  baseBranch: string;
  runsDir: string; // absolute; manifests, evidence and worktrees live here
  startedState: string; // Linear state the ticket moves to when a run is accepted
  approvalState: string; // Linear state that means "waiting for the owner" (PASS)
  blockedState: string; // Linear state for escalations; must exist so a failure can always be recorded
  infraRetries: number; // retries of an infrastructure step; never consumes a repair attempt
  ciChecks: string[]; // check/workflow names that must be green on the SHA (empty = at least one check, all green)
  ciTimeoutMinutes: number;
  agentTimeoutMinutes: number;
  claude: { bin: string; allowedTools: string[] };
  codex: { bin: string };
}
export const DEFAULT_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(npx tsc:*)'];
/** Explicit team-level entry: authorizes writes for the team's issues that no config project covers, and carries the team-level policy. */
export interface TeamCfg {
  key: string;
  write: boolean;
  workflow?: WorkflowCfg; // present => an explicit team-level readiness policy exists
  repos: string[];
  knowledge: KnowledgeCfg[];
}

export interface Config {
  port: number;
  staleAfterMinutes: number; // data older than this is shown as stale and re-read on open/focus; never polled
  staleDays: number;
  idleExitMinutes: number; // server exits after this long with no HTTP request (0 = never, the default); not an API poll
  obsidian?: { vault: string; vaultPath?: string };
  /** Explicit places where independent (e.g. Codex) review results are recorded. Empty => review stays Unknown. */
  review: { checkName?: string; passedLabel?: string; findingsLabel?: string };
  projects: ProjectCfg[];
  teams: TeamCfg[];
  prompts: PromptDef[];
}

export const DEFAULT_PROMPTS: PromptDef[] = [
  { id: 'discover', label: 'Discover ticket', template: 'Discover {{ticket}} in {{project}}. Read the Linear issue and linked project knowledge; list gaps, risks and open questions. Do not implement.' },
  { id: 'execute', label: 'Execute approved ticket', template: 'Execute approved ticket {{ticket}} in {{project}}. Follow the ticket as written and the repo contracts; open a PR when done.' },
  { id: 'review', label: 'Independent review', template: 'Independently review the PR for {{ticket}} in {{project}} against the ticket and repo contracts. Record findings explicitly; do not edit code.' },
  { id: 'resolve', label: 'Resolve review findings', template: 'Resolve the recorded review findings on the PR for {{ticket}} in {{project}}. Address each finding and report what changed.' },
  { id: 'resume', label: 'Resume ticket', template: 'Resume {{ticket}} in {{project}}. Check the current branch, PR, CI and review state first, then continue from where it stopped.' },
  { id: 'milestone', label: 'Review milestone', template: 'Review milestone "{{milestone}}" in {{project}}: summarise task states, blockers, and what is needed to finish it.' },
];

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function strList(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) ? v.map((x) => str(x, 100)).filter((x): x is string => !!x) : fallback;
}
function bool(v: unknown, d: boolean) { return typeof v === 'boolean' ? v : d; }

function parseWorkflow(raw: unknown, id: string): WorkflowCfg {
  const d = DEFAULT_WORKFLOW;
  const w = isObj(raw) ? raw : {};
  const readyLabel = str(w.readyLabel, 100) ?? d.readyLabel;
  if (!readyLabel.trim()) throw new Error(`Project "${id}": workflow.readyLabel must not be empty`);
  return {
    readyLabel, discoveryLabels: strList(w.discoveryLabels, d.discoveryLabels), classificationLabels: strList(w.classificationLabels, d.classificationLabels),
    protectedLabels: strList(w.protectedLabels, d.protectedLabels), todoState: str(w.todoState, 100) ?? d.todoState, backlogState: str(w.backlogState, 100) ?? d.backlogState,
  };
}

const TICKET_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const MAX_PATH = 200;
const MAX_TICKET = 40;
/**
 * The approved sequence is parsed strictly: it is never truncated, coerced or partly ignored, because a silently shortened path
 * could report "Clear" while a later gate is still unresolved. Anything malformed fails startup with a message naming the entry.
 */
function parseCriticalPath(raw: unknown, id: string): { ticket: string; deferred: boolean }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`Project "${id}": criticalPath must be an array`);
  if (raw.length > MAX_PATH) throw new Error(`Project "${id}": criticalPath has ${raw.length} entries; the limit is ${MAX_PATH} (it is never truncated)`);
  const out: { ticket: string; deferred: boolean }[] = [];
  raw.forEach((e, n) => {
    const at = `Project "${id}": criticalPath[${n}]`;
    let ticket: unknown;
    let deferred = false;
    if (typeof e === 'string') ticket = e;
    else if (isObj(e)) {
      const bad = Object.keys(e).filter((k) => k !== 'ticket' && k !== 'deferred');
      if (bad.length) throw new Error(`${at} has unknown field "${bad[0]}" (allowed: ticket, deferred)`);
      if ('deferred' in e && typeof e.deferred !== 'boolean') throw new Error(`${at}.deferred must be true or false`);
      deferred = e.deferred === true;
      ticket = e.ticket;
    } else throw new Error(`${at} must be a ticket identifier string or { "ticket": "ABC-1", "deferred": true }`);
    if (typeof ticket !== 'string') throw new Error(`${at}.ticket must be a string`);
    const t = ticket.trim().toUpperCase();
    if (t.length > MAX_TICKET || !TICKET_RE.test(t)) throw new Error(`${at} "${ticket.slice(0, 60)}" is not a ticket identifier like ABC-12`);
    if (out.some((x) => x.ticket === t)) throw new Error(`Project "${id}": criticalPath lists ${t} twice`);
    out.push({ ticket: t, deferred });
  });
  return out;
}

function parseOrchestration(raw: unknown, id: string, repos: string[]): OrchestrationCfg | undefined {
  if (raw === undefined || raw === null) return undefined;
  const at = `Project "${id}": orchestration`;
  if (!isObj(raw)) throw new Error(`${at} must be an object`);
  const repo = str(raw.repo, 200) ?? '';
  if (!REPO_RE.test(repo) || !repos.includes(repo)) throw new Error(`${at}.repo "${repo}" must be owner/repo and listed in this project's github.repos`);
  const abs = (k: string) => {
    const v = str(raw[k], 500) ?? '';
    if (!v.startsWith('/') || v.includes('\0')) throw new Error(`${at}.${k} must be an absolute path`);
    return v.replace(/\/+$/, '') || '/';
  };
  const mins = (k: string, d: number, max: number) => (typeof raw[k] === 'number' && raw[k] >= 1 ? Math.min(max, raw[k] as number) : d);
  const tools = (v: unknown) => strList(v, DEFAULT_CLAUDE_TOOLS).map((t) => { if (!TOOL_RE.test(t)) throw new Error(`${at}.claude.allowedTools entry "${t.slice(0, 60)}" is not a plain tool pattern like Read or Bash(git commit:*)`); return t; });
  const claude = isObj(raw.claude) ? raw.claude : {};
  const codex = isObj(raw.codex) ? raw.codex : {};
  const bin = (v: unknown, what: string) => { const b = str(v, 500) ?? ''; if (!b.startsWith('/') || /\s/.test(b)) throw new Error(`${at}.${what}.bin must be an explicit absolute path to the executable (no PATH lookup, no arguments)`); return b; };
  return {
    repo, repoPath: abs('repoPath'), baseBranch: str(raw.baseBranch, 100) ?? 'main', runsDir: abs('runsDir'),
    startedState: str(raw.startedState, 100) ?? 'In Progress', approvalState: str(raw.approvalState, 100) ?? 'In Review',
    blockedState: str(raw.blockedState, 100) ?? 'Blocked', infraRetries: typeof raw.infraRetries === 'number' ? Math.min(5, Math.max(0, Math.floor(raw.infraRetries))) : 2,
    ciChecks: strList(raw.ciChecks, []), ciTimeoutMinutes: mins('ciTimeoutMinutes', 20, 120), agentTimeoutMinutes: mins('agentTimeoutMinutes', 30, 240),
    claude: { bin: bin(claude.bin, 'claude'), allowedTools: tools(claude.allowedTools) },
    codex: { bin: bin(codex.bin, 'codex') },
  };
}

function parseKnowledge(v: unknown): KnowledgeCfg[] {
  return arr(v, 50).flatMap((k) => {
    if (!isObj(k)) return [];
    const kind = k.kind === 'obsidian' || k.kind === 'repo' || k.kind === 'url' ? k.kind : undefined;
    const title = str(k.title, 200);
    if (!kind || !title) return [];
    return [{ title, kind, path: str(k.path, 500), repo: str(k.repo, 200), ref: str(k.ref, 100), url: str(k.url, 2048) }];
  });
}

function parseTeams(raw: unknown): TeamCfg[] {
  const out: TeamCfg[] = [];
  for (const t of arr(raw, 50)) {
    if (!isObj(t)) throw new Error('Each teams entry must be an object');
    const key = (str(t.key, 12) ?? '').toUpperCase();
    if (!/^[A-Z][A-Z0-9]*$/.test(key)) throw new Error(`teams[]: key "${str(t.key, 12) ?? ''}" invalid`);
    if (out.some((x) => x.key === key)) throw new Error(`Duplicate teams entry "${key}"`);
    const repos = (isObj(t.github) ? arr(t.github.repos, 50) : []).map((r) => str(r, 200) ?? '').filter((r) => {
      if (!REPO_RE.test(r)) throw new Error(`teams[${key}]: repo "${r}" must be owner/repo`);
      return true;
    });
    // Fail closed: a write-enabled team must say which label means "ready"; the generic default would leave a custom one unprotected.
    if (t.write === true && !isObj(t.workflow)) throw new Error(`teams[${key}]: write: true requires an explicit "workflow" (readyLabel etc.); refusing to enable writes without one`);
    out.push({ key, write: t.write === true, workflow: isObj(t.workflow) ? parseWorkflow(t.workflow, `team ${key}`) : undefined, repos, knowledge: parseKnowledge(t.knowledge) });
  }
  return out;
}

export function parseConfig(raw: unknown): Config {
  if (!isObj(raw)) throw new Error('Config must be a JSON object');
  const projects: ProjectCfg[] = [];
  for (const p of arr(raw.projects, 50)) {
    if (!isObj(p)) throw new Error('Each project must be an object');
    const id = str(p.id, 41) ?? '';
    const name = str(p.name, 100) ?? '';
    if (!ID_RE.test(id)) throw new Error(`Project id "${id}" invalid (letters, digits, - _)`);
    if (!name) throw new Error(`Project "${id}" needs a name`);
    if (projects.some((x) => x.id === id)) throw new Error(`Duplicate project id "${id}"`);
    let linear: ProjectCfg['linear'];
    if (isObj(p.linear)) {
      const teamKey = str(p.linear.teamKey, 12) ?? '';
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(teamKey)) throw new Error(`Project "${id}": linear.teamKey invalid`);
      linear = { teamKey: teamKey.toUpperCase(), projects: arr(p.linear.projects, 50).map((x) => str(x, 200)).filter((x): x is string => !!x) };
    }
    const gh = isObj(p.github) ? arr(p.github.repos, 50) : [];
    const repos = gh.map((r) => str(r, 200) ?? '').filter((r) => {
      if (!REPO_RE.test(r)) throw new Error(`Project "${id}": repo "${r}" must be owner/repo`);
      return true;
    });
    const knowledge: KnowledgeCfg[] = arr(p.knowledge, 50).flatMap((k) => {
      if (!isObj(k)) return [];
      const kind = k.kind === 'obsidian' || k.kind === 'repo' || k.kind === 'url' ? k.kind : undefined;
      const title = str(k.title, 200);
      if (!kind || !title) return [];
      return [{ title, kind, path: str(k.path, 500), repo: str(k.repo, 200), ref: str(k.ref, 100), url: str(k.url, 2048) }];
    });
    projects.push({ id, name, workflow: parseWorkflow(p.workflow, id), linear, repos, knowledge, criticalPath: parseCriticalPath(p.criticalPath, id), orchestration: parseOrchestration(p.orchestration, id, repos) });
  }
  const ob = isObj(raw.obsidian) && str(raw.obsidian.vault, 200) ? { vault: str(raw.obsidian.vault, 200)!, vaultPath: str(raw.obsidian.vaultPath, 500) } : undefined;
  const rv = isObj(raw.review) ? raw.review : {};
  const customPrompts = isObj(raw.prompts) ? raw.prompts : {};
  const prompts = DEFAULT_PROMPTS.map((d) => {
    const c = customPrompts[d.id];
    return typeof c === 'string' && c.trim() ? { ...d, template: c.slice(0, 2000) } : d;
  });
  const stale = typeof raw.staleAfterMinutes === 'number' ? Math.min(120, Math.max(1, raw.staleAfterMinutes)) : 5;
  return {
    port: typeof raw.port === 'number' ? raw.port : 4317,
    staleAfterMinutes: stale,
    idleExitMinutes: typeof raw.idleExitMinutes === 'number' ? Math.min(1440, Math.max(0, raw.idleExitMinutes)) : 0,
    staleDays: typeof raw.staleDays === 'number' ? Math.max(1, raw.staleDays) : 5,
    obsidian: ob,
    review: { checkName: str(rv.checkName, 200), passedLabel: str(rv.passedLabel, 100), findingsLabel: str(rv.findingsLabel, 100) },
    projects,
    teams: parseTeams(raw.teams),
    prompts,
  };
}

export function loadConfig(env = process.env, cwd = process.cwd()): { config: Config; path: string; found: boolean } {
  const p = env.DEVFLOW_CONFIG ?? `${cwd}/devflow.config.json`;
  if (!existsSync(p)) return { config: parseConfig({ projects: [] }), path: p, found: false };
  return { config: parseConfig(JSON.parse(readFileSync(p, 'utf8'))), path: p, found: true };
}

/**
 * The port DevFlow listens on. Precedence is fixed: `DEVFLOW_PORT` (environment, or `.env` when the environment does not set it),
 * then `port` in the config file, then 4317. A DEVFLOW_PORT that is not a positive number falls through to the config port.
 * The server and the launcher both call this, so they cannot disagree.
 */
export function effectivePort(env: NodeJS.ProcessEnv, cfg: Pick<Config, 'port'>): number {
  return Number(env.DEVFLOW_PORT) || cfg.port;
}

/** Loads KEY=VALUE pairs into process.env. Returns a warning (never a value) if the file exists but is unusable. */
export function loadEnvFile(path = '.env'): string | undefined {
  if (!existsSync(path)) return undefined;
  try { process.loadEnvFile(path); } catch { return `${path} exists but could not be parsed; credentials from it were not loaded`; }
  if ((statSync(path).mode & 0o077) !== 0) return `${path} is readable by other users; run: chmod 600 ${path}`;
  return undefined;
}
