// Hermetic world for the orchestrator: a local bare repo as "origin", a clone as repoPath, the synthetic fake Linear, a CI that really
// runs `node --test` on the pushed SHA, and scripted Claude/Codex stand-ins started through the REAL subprocess runner.
// Nothing here touches GitHub, Linear, or a real model.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { demoFetch, DEMO_READ_KEY, DEMO_WRITE_KEY } from '../server/demo.ts';
import { parseConfig } from '../server/config.ts';
import { LinearClient } from '../server/linear.ts';
import { LinearWriteClient } from '../server/linear-write.ts';
import { CliAgents, type AgentRunner } from '../server/orchestrator/agents.ts';
import type { PrState, PullRequests } from '../server/orchestrator/pr.ts';
import type { CiProvider } from '../server/orchestrator/ci.ts';
import { Orchestrator } from '../server/orchestrator/controller.ts';
import { PolicyGuard } from '../server/orchestrator/policy.ts';
import { RunStore } from '../server/orchestrator/manifest.ts';

const FIX = resolve(import.meta.dirname, 'fixtures');
const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' } }).trim();

export const TICKET = 'ATL-22';
export const DESCRIPTION = 'Add `slugify(text)` in src/slugify.mjs. It lowercases, collapses every run of non-alphanumerics into one "-", and trims leading and trailing "-". Examples: "Hello World" -> "hello-world"; "Hello, World!" -> "hello-world"; "  --A  b--" -> "a-b". Add a test.';

/** Local stand-in for GitHub CI: clone the remote, check out EXACTLY the sha, run the repo's tests. */
export class LocalCi implements CiProvider {
  calls: string[] = [];
  constructor(private origin: string, private root: string, private mode: 'real' | 'timeout' = 'real') {}
  snapshotOverride?: 'failure' | 'timeout'; // flips the CURRENT result without touching the recorded one
  async snapshot(_repo: string, sha: string) {
    if (this.snapshotOverride) return { state: this.snapshotOverride, detail: `forced ${this.snapshotOverride}`, checks: [] };
    return this.run(sha);
  }
  async wait(_repo: string, sha: string) {
    this.calls.push(sha);
    return this.run(sha);
  }
  private async run(sha: string) {
    if (this.mode === 'timeout') return { state: 'timeout' as const, detail: 'Timed out waiting for CI: No CI checks reported for this commit yet', checks: [] };
    const dir = mkdtempSync(join(this.root, 'ci-'));
    sh(dir, 'clone', '-q', this.origin, 'w');
    sh(join(dir, 'w'), 'checkout', '-q', sha);
    try {
      execFileSync('node', ['--test'], { cwd: join(dir, 'w'), stdio: 'pipe' });
      return { state: 'success' as const, detail: 'All green: local-ci', checks: [{ name: 'local-ci', state: 'passed' }] };
    } catch (e) {
      return { state: 'failure' as const, detail: `Failed or inconclusive: local-ci — ${String((e as { stdout?: Buffer }).stdout ?? '').split('\n').filter((l) => /not ok|expected|actual|Error/.test(l)).slice(0, 4).join(' | ')}`, checks: [{ name: 'local-ci', state: 'failed' }] };
    }
  }
}

/** In-memory GitHub PR service: remembers what was created (always as a draft) and reports the branch head the way GitHub would. */
export class FakePrs implements PullRequests {
  created: { branch: string; base: string; title: string; draft: true }[] = [];
  headCalls = 0;
  constructor(private origin: string, private mode: 'ok' | 'stale' = 'ok') {}
  async ensureDraft(_repo: string, o: { branch: string; base: string; title: string; body: string }) {
    if (!this.created.some((c) => c.branch === o.branch)) this.created.push({ branch: o.branch, base: o.base, title: o.title, draft: true });
    return { number: 7, url: 'https://example.invalid/gh/demo-org/atlas/pull/7' };
  }
  state: Partial<PrState> = {}; // tests can flip the PR the way a third party could (ready for review, retargeted, closed)
  async inspect(_repo: string, _n: number): Promise<PrState> {
    this.headCalls++;
    const c = this.created[this.created.length - 1]!;
    const headSha = this.mode === 'stale' ? 'e'.repeat(40) : sh(this.origin, 'rev-parse', `refs/heads/${c.branch}`);
    return { headSha, headRef: c.branch, headRepo: 'demo-org/atlas', baseRef: c.base, open: true, draft: true, ...this.state };
  }
}

export interface WorldOpts {
  scenario?: string; labels?: string[]; state?: string; blockedBy?: number[]; project?: string | null; omitOrchestration?: boolean;
  ci?: 'real' | 'timeout'; prs?: 'ok' | 'stale'; noLogin?: boolean; seed?: Record<string, string>; second?: boolean; onSleep?: () => void; linearOpts?: Parameters<typeof demoFetch>[1]; onLinearRead?: (n: number) => void;
  /** Real agents: run the REAL claude/codex binaries with the user's real logins (staged into the sandbox as copies). Synthetic repo/ticket only. */
  live?: { claudeBin: string; codexBin: string; description: string }; wrapAgents?: (inner: AgentRunner, w: { origin: string; repo: string }) => AgentRunner; secrets?: boolean;
}

export function makeWorld(o: WorldOpts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'devflow-m1-'));
  const origin = join(root, 'origin.git'), repo = join(root, 'repo'), runsDir = join(root, 'runs');
  mkdirSync(runsDir); mkdirSync(origin); sh(origin, 'init', '-q', '--bare', '-b', 'main');
  mkdirSync(repo); sh(repo, 'init', '-q', '-b', 'main'); sh(repo, 'remote', 'add', 'origin', origin);
  writeFileSync(join(repo, 'README.md'), '# synthetic repo\n'); mkdirSync(join(repo, 'test'));
  writeFileSync(join(repo, 'test', 'smoke.test.mjs'), "import { test } from 'node:test'; test('smoke', () => {});\n");
  for (const [f, body] of Object.entries(o.seed ?? {})) { mkdirSync(join(repo, f, '..'), { recursive: true }); writeFileSync(join(repo, f), body); }
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'init'); sh(repo, 'push', '-q', 'origin', 'main');

  const cfgObj: { projects: Record<string, unknown>[] } = {
    projects: [{
      id: 'atlas', name: 'Atlas', linear: { teamKey: 'ATL', projects: ['Atlas'] }, github: { repos: ['demo-org/atlas'] },
      orchestration: o.omitOrchestration ? undefined : {
        repo: 'demo-org/atlas', repoPath: repo, baseBranch: 'main', runsDir, ciChecks: ['local-ci'], ciTimeoutMinutes: 1, agentTimeoutMinutes: 1,
        claude: o.live ? { bin: o.live.claudeBin, allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(node:*)', 'Bash(npm test:*)'] } : { bin: join(FIX, 'fake-claude.mjs') },
        codex: { bin: o.live ? o.live.codexBin : join(FIX, 'fake-codex.mjs') }, ...(o.live ? { agentTimeoutMinutes: 15 } : {}),
      },
    }],
  };
  if (o.second) { // a second project of the SAME team with a different tool policy; the ticket lives in it
    const first = cfgObj.projects[0] as { orchestration: Record<string, unknown> };
    cfgObj.projects.push({ id: 'labs', name: 'Atlas Labs', linear: { teamKey: 'ATL', projects: ['Atlas Labs'] }, github: { repos: ['demo-org/atlas'] }, orchestration: { ...first.orchestration, claude: { ...(first.orchestration.claude as object), allowedTools: ['Read', 'Glob'] } } });
  }
  // The owner's trusted config: its own file, outside the repo and the runs directory, owner-only. This is what the PolicyGuard pins.
  const trustedDir = join(root, 'trusted'); mkdirSync(trustedDir, { mode: 0o700 });
  const configPath = join(trustedDir, 'devflow.config.json'); writeFileSync(configPath, JSON.stringify(cfgObj), { mode: 0o600 }); chmodSync(configPath, 0o600);
  const cfg = parseConfig(cfgObj);
  const f = demoFetch(Date.parse('2026-06-01T12:00:00Z'), o.linearOpts);
  f.store.issues.ATL!.push({ n: 22, title: 'Add slugify helper', state: o.state ?? 'Todo', project: o.project === undefined ? (o.second ? 'lp-ATL2' : undefined) : o.project, ageH: 1, labels: o.labels ?? ['Ready', 'Feature'], blockedBy: o.blockedBy, desc: o.live ? o.live.description : `${DESCRIPTION}\n\nSCENARIO: ${o.scenario ?? 'defect-then-fix'}` });
  const ci = new LocalCi(origin, root, o.ci);
  const hostHome = o.live ? homedir() : join(root, 'fake-home'); // the sandbox stages credentials from here: dummy files, so tests never touch the real ~/.claude
  if (o.live) { /* real home: nothing to create */ } else if (!o.noLogin) { mkdirSync(join(hostHome, '.claude'), { recursive: true }); mkdirSync(join(hostHome, '.codex'), { recursive: true }); writeFileSync(join(hostHome, '.claude', '.credentials.json'), '{"fake":true}'); writeFileSync(join(hostHome, '.codex', 'auth.json'), '{"fake":true}'); } else mkdirSync(hostHome)
  const real = new CliAgents(cfg.projects[0]!.orchestration ?? { claude: { bin: join(FIX, 'fake-claude.mjs'), allowedTools: [] }, codex: { bin: join(FIX, 'fake-codex.mjs') } }, { hostHome, env: o.live ? process.env : { PATH: process.env.PATH } });
  const calls = { implement: 0, review: 0 };
  const prs = new FakePrs(origin, o.prs);
  const counted: AgentRunner = {
    preflight: () => real.preflight(),
    implement: (x) => { calls.implement++; return real.implement(x); },
    review: (x) => { calls.review++; return real.review(x); },
  };
  const agents = o.wrapAgents ? o.wrapAgents(counted, { origin, repo }) : counted;
  const logs: string[] = [];
  let reads = 0;
  const factoryCalls: { kind: string; projectId: string; tools: string[] }[] = [];
  const ocOf = (id: string) => cfg.projects.find((p) => p.id === id)!.orchestration!;
  const mk = () => new Orchestrator({ cfg, policy: (oc, pid) => { factoryCalls.push({ kind: 'policy', projectId: pid, tools: oc.claude.allowedTools }); return new PolicyGuard(() => ocOf(pid), configPath); }, read: new LinearClient(DEMO_READ_KEY, ((u: string, i?: RequestInit) => { if (/query ActionIssue/.test(String(i?.body))) o.onLinearRead?.(++reads); return f(u, i); }) as typeof fetch), write: new LinearWriteClient(DEMO_WRITE_KEY, f), ci, prs, agents: (oc, pid) => { factoryCalls.push({ kind: 'agents', projectId: pid, tools: oc.claude.allowedTools }); return agents; }, sleep: async () => { o.onSleep?.(); }, log: (l) => logs.push(l) });
  const issue = () => f.store.issues.ATL!.find((x) => x.n === 22)!;
  return {
    root, origin, repo, runsDir, cfg, configPath, factoryCalls, f, ci, prs, hostHome, calls, logs, mk, orch: mk(), issue, store: () => new RunStore(runsDir),
    comments: () => f.store.comments.filter((c) => c.issue === TICKET).map((c) => c.body),
    remoteHead: (branch: string) => sh(origin, 'rev-parse', `refs/heads/${branch}`),
    mainHead: () => sh(origin, 'rev-parse', 'refs/heads/main'),
    pushFrom: (branch: string) => { // another actor advances the run branch on the remote
      const d = mkdtempSync(join(root, 'other-')); sh(d, 'clone', '-q', origin, 'w'); const w = join(d, 'w');
      sh(w, 'checkout', '-q', branch); writeFileSync(join(w, 'extra.txt'), 'x'); sh(w, 'add', '-A'); sh(w, 'commit', '-q', '-m', 'sneaky'); sh(w, 'push', '-q', 'origin', branch);
    },
    dispose: () => { try { chmodRec(root); rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } },
    exists: existsSync,
  };
}
function chmodRec(p: string) { try { execFileSync('chmod', ['-R', 'u+rwX', p]); } catch { /* ignore */ } }
export { DEMO_WRITE_KEY };
