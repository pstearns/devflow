import { existsSync, readFileSync, statSync } from 'node:fs';
import { isObj, str, arr } from './util.ts';
import type { PromptDef } from '../shared/types.ts';

export interface KnowledgeCfg { title: string; kind: 'obsidian' | 'repo' | 'url'; path?: string; repo?: string; ref?: string; url?: string }
export interface ReadinessPolicy {
  requireDescription: boolean;
  minDescriptionChars: number;
  requireMilestone: boolean;
  requirePriority: boolean;
  requireClassificationLabel: boolean;
  requireNoOpenBlockers: boolean;
}
/** Names of Linear labels/states that carry lifecycle meaning. Configuration, not code: nothing project-specific is built in. */
export interface WorkflowCfg {
  readyLabel: string;
  discoveryLabels: string[];
  classificationLabels: string[];
  protectedLabels: string[]; // never editable via the ordinary label menu (readyLabel is always protected)
  todoState: string;
  backlogState: string;
  readiness: ReadinessPolicy;
}
export const DEFAULT_WORKFLOW: WorkflowCfg = {
  readyLabel: 'Ready', discoveryLabels: ['Discovery'], classificationLabels: ['Idea', 'Bug', 'Security', 'Feature', 'Research', 'Tech Debt'],
  protectedLabels: [], todoState: 'Todo', backlogState: 'Backlog',
  readiness: { requireDescription: true, minDescriptionChars: 40, requireMilestone: false, requirePriority: false, requireClassificationLabel: false, requireNoOpenBlockers: true },
};

export interface ProjectCfg {
  id: string;
  name: string;
  workflow: WorkflowCfg;
  linear?: { teamKey: string; projects: string[] };
  repos: string[]; // owner/repo
  knowledge: KnowledgeCfg[];
}
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
  const r = isObj(w.readiness) ? w.readiness : {};
  const readyLabel = str(w.readyLabel, 100) ?? d.readyLabel;
  if (!readyLabel.trim()) throw new Error(`Project "${id}": workflow.readyLabel must not be empty`);
  return {
    readyLabel, discoveryLabels: strList(w.discoveryLabels, d.discoveryLabels), classificationLabels: strList(w.classificationLabels, d.classificationLabels),
    protectedLabels: strList(w.protectedLabels, d.protectedLabels), todoState: str(w.todoState, 100) ?? d.todoState, backlogState: str(w.backlogState, 100) ?? d.backlogState,
    readiness: {
      requireDescription: bool(r.requireDescription, d.readiness.requireDescription),
      minDescriptionChars: typeof r.minDescriptionChars === 'number' ? Math.max(0, Math.min(5000, r.minDescriptionChars)) : d.readiness.minDescriptionChars,
      requireMilestone: bool(r.requireMilestone, d.readiness.requireMilestone), requirePriority: bool(r.requirePriority, d.readiness.requirePriority),
      requireClassificationLabel: bool(r.requireClassificationLabel, d.readiness.requireClassificationLabel), requireNoOpenBlockers: bool(r.requireNoOpenBlockers, d.readiness.requireNoOpenBlockers),
    },
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
    projects.push({ id, name, workflow: parseWorkflow(p.workflow, id), linear, repos, knowledge });
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

/** Loads KEY=VALUE pairs into process.env. Returns a warning (never a value) if the file exists but is unusable. */
export function loadEnvFile(path = '.env'): string | undefined {
  if (!existsSync(path)) return undefined;
  try { process.loadEnvFile(path); } catch { return `${path} exists but could not be parsed; credentials from it were not loaded`; }
  if ((statSync(path).mode & 0o077) !== 0) return `${path} is readable by other users; run: chmod 600 ${path}`;
  return undefined;
}
