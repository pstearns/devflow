// Agent subprocesses. Controls enforced in code, not prompts:
//  - every agent runs inside a bubblewrap sandbox with explicit mounts and a cleared environment (sandbox.ts);
//  - the implementer sees only its own clone (own .git, no remote, no credentials); the reviewer sees only a read-only snapshot;
//  - neither receives any Linear/GitHub/DevFlow credential, and the reviewer has no git metadata at all.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrchestrationCfg } from '../config.ts';
import { baseEnv, bwrapArgs, bwrapUsable, nodeMounts, readAgentFile, resolveBin, stageHome, type Mount, type SandboxJob, type Staged } from './sandbox.ts';
export { readAgentFile };

export interface ProcResult { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; truncated: boolean; finalMessage?: string }

export function runProcess(bin: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number; maxBytes?: number }): Promise<ProcResult> {
  const max = o.maxBytes ?? 8 * 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, shell: false });
    let out = '', err = '', truncated = false, timedOut = false, done = false;
    const add = (cur: string, d: Buffer) => { if (cur.length + d.length > max) { truncated = true; return cur; } return cur + d.toString('utf8'); };
    child.stdout.on('data', (d: Buffer) => { out = add(out, d); });
    child.stderr.on('data', (d: Buffer) => { err = add(err, d); });
    const killGroup = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, o.timeoutMs);
    const finish = (exitCode: number | null, signal: string | null, extra = '') => {
      if (done) return; done = true; clearTimeout(timer); killGroup();
      resolve({ exitCode, signal, timedOut, stdout: out, stderr: err + extra, truncated });
    };
    child.on('error', (e) => finish(null, null, `spawn error: ${e.message}`));
    child.on('close', (code, signal) => finish(code, signal));
    child.stdin.on('error', () => { /* child exited before reading its prompt */ });
    child.stdin.end(o.stdin ?? '');
  });
}

/** Signals that mean "the environment failed", not "the code is wrong". Such failures never consume a repair attempt. */
const INFRA_RE = /(^bwrap:|not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|\b40[13]\b|rate.?limit|overloaded|\b5(02|03|29)\b|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network error|spawn error|usage limit|hit your [^\n]{0,30}limit|api_error)/im;
export function infraProblem(r: ProcResult): string | undefined {
  if (r.timedOut) return 'the agent timed out';
  if (r.exitCode === 0) return undefined;
  const text = `${r.stderr}\n${r.stdout}`.slice(0, 20000);
  const m = INFRA_RE.exec(text);
  return m ? `agent environment failure (${m[1]!.trim().slice(0, 40)})` : `the agent exited abnormally (${r.exitCode ?? r.signal ?? 'no status'}) without delivering`;
}

/** Flags this controller passes. If a binary's own --help does not list every one of them, it is refused (fail closed). */
export const CLAUDE_FLAGS = ['--print', '--output-format', '--permission-mode', '--no-session-persistence', '--allowedTools'];
export const CODEX_FLAGS = ['--sandbox', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--output-schema', '--cd', '--output-last-message', '--config'];

export interface Preflight { ok: boolean; problems: string[]; detail: string[]; versions?: { claude?: string; codex?: string } }
export interface AgentRunner {
  /** Proves the sandbox starts and both CLIs run and are logged in, from inside the sandbox, before any ticket is touched. */
  preflight(): Promise<Preflight>;
  /** Claude Code in `clone` (its own git repo). It edits and commits; it can neither push nor reach any credential. */
  implement(o: { clone: string; prompt: string; timeoutMs: number }): Promise<ProcResult>;
  /** Codex against a read-only snapshot. `outDir` is the only writable mount; the reviewer's final message is read from it. */
  review(o: { snapshot: string; outDir: string; prompt: string; schemaPath: string; timeoutMs: number }): Promise<ProcResult>;
}

export interface RoleSandbox { job: Omit<SandboxJob, 'cmd' | 'args'>; staged: Staged; cmdPath: string }

/** The exact mounts each role gets. Tests run arbitrary commands through these same builders to prove the negative cases. */
export function implementerSandbox(cfg: Pick<OrchestrationCfg, 'claude'>, clone: string, hostHome: string, env: NodeJS.ProcessEnv = process.env): RoleSandbox {
  const bin = resolveBin(cfg.claude.bin);
  const staged = stageHome('claude', hostHome);
  const pass: Record<string, string> = {};
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) if (env[k]) pass[k] = env[k]!;
  const mounts: Mount[] = [...nodeMounts(), { src: bin.dir, dst: '/opt/agent' }, { src: clone, dst: '/work', rw: true }, ...staged.mounts];
  return {
    staged, cmdPath: `/opt/agent/${bin.file}`,
    job: { mounts, tmpfs: staged.tmpfs, cwd: '/work', env: baseEnv({
      ...pass, ...staged.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'DevFlow Claude', GIT_AUTHOR_EMAIL: 'devflow-agent@localhost.invalid', GIT_COMMITTER_NAME: 'DevFlow Claude', GIT_COMMITTER_EMAIL: 'devflow-agent@localhost.invalid', DEVFLOW_ROLE: 'implementer',
    }) },
  };
}
export function reviewerSandbox(cfg: Pick<OrchestrationCfg, 'codex'>, snapshot: string, outDir: string, schemaPath: string | undefined, hostHome: string, env: NodeJS.ProcessEnv = process.env): RoleSandbox {
  const bin = resolveBin(cfg.codex.bin);
  const staged = stageHome('codex', hostHome);
  const pass: Record<string, string> = {};
  if (env.OPENAI_API_KEY) pass.OPENAI_API_KEY = env.OPENAI_API_KEY;
  const mounts: Mount[] = [...nodeMounts(), { src: bin.dir, dst: '/opt/agent' }, { src: snapshot, dst: '/review' }, { src: outDir, dst: '/out', rw: true }, ...(schemaPath ? [{ src: schemaPath, dst: '/schema.json' }] : []), ...staged.mounts];
  return { staged, cmdPath: `/opt/agent/${bin.file}`, job: { mounts, tmpfs: staged.tmpfs, cwd: '/review', env: baseEnv({ ...pass, ...staged.env, DEVFLOW_ROLE: 'reviewer' }) } };
}

export async function runInSandbox(rs: RoleSandbox, cmd: string, args: string[], o: { stdin?: string; timeoutMs: number }): Promise<ProcResult> {
  try {
    return await runProcess('/usr/bin/bwrap', bwrapArgs({ ...rs.job, cmd, args }), { cwd: '/', env: { PATH: '/usr/bin:/bin' }, stdin: o.stdin, timeoutMs: o.timeoutMs });
  } finally { rs.staged.finish(); }
}

export class CliAgents implements AgentRunner {
  constructor(private cfg: Pick<OrchestrationCfg, 'claude' | 'codex'>, private o: { hostHome?: string; env?: NodeJS.ProcessEnv } = {}) {}
  private get home() { return this.o.hostHome ?? homedir(); }
  private get env() { return this.o.env ?? process.env; }

  async preflight(): Promise<Preflight> {
    const problems: string[] = [], detail: string[] = [], versions: { claude?: string; codex?: string } = {};
    if (!bwrapUsable()) return { ok: false, problems: ['bubblewrap (bwrap) is missing or user namespaces are disabled: refusing to run agents without isolation'], detail };
    const tmp = mkdtempSync(join(tmpdir(), 'devflow-pf-'));
    const out = join(tmp, 'out'); mkdirSync(out, { recursive: true });
    const probe = async (what: string, mk: () => RoleSandbox, args: string[]) => {
      const rs = mk();
      const r = await runInSandbox(rs, rs.cmdPath, args, { timeoutMs: 60_000 });
      detail.push(`${what}: exit ${r.exitCode}: ${(r.stdout + r.stderr).trim().split('\n')[0]?.slice(0, 120)}`);
      return r;
    };
    // Fail closed on a missing, non-executable, unparseable or flag-incompatible binary: the exact flags this controller passes must exist.
    const check = async (name: string, mk: () => RoleSandbox, versionArgs: string[], versionRe: RegExp, helpArgs: string[], flags: string[], auth: () => Promise<string | undefined>) => {
      try { mk().staged.finish(); } catch (e) { problems.push(`${name}: binary unusable (${e instanceof Error ? e.message.slice(0, 160) : 'cannot resolve'})`); return; }
      const v = await probe(`${name} --version`, mk, versionArgs);
      if (v.exitCode !== 0) { problems.push(`${name} does not start inside the sandbox`); return; }
      const ver = versionRe.exec(v.stdout + v.stderr);
      if (!ver) { problems.push(`${name}: version output not recognised ("${(v.stdout + v.stderr).trim().slice(0, 60)}"); refusing an unknown binary`); return; }
      detail.push(`${name} version ${ver[1]}`); versions[name as 'claude' | 'codex'] = ver[1];
      const h = await probe(`${name} help`, mk, helpArgs);
      const missing = flags.filter((f) => !(h.stdout + h.stderr).includes(f));
      if (h.exitCode !== 0 || missing.length) { problems.push(`${name} ${ver[1]} is incompatible: missing ${missing.length ? missing.join(', ') : 'help output'}`); return; }
      const bad = await auth();
      if (bad) problems.push(bad);
    };
    try {
      const claude = () => implementerSandbox(this.cfg, tmp, this.home, this.env);
      await check('claude', claude, ['--version'], /^(\d+\.\d+\.\d+)/m, ['--help'], CLAUDE_FLAGS, async () => {
        const a = await probe('claude auth status', claude, ['auth', 'status']);
        let loggedIn = false;
        try { loggedIn = (JSON.parse(a.stdout) as { loggedIn?: unknown }).loggedIn === true; } catch { /* not JSON */ }
        return !loggedIn && !this.env.ANTHROPIC_API_KEY && !this.env.CLAUDE_CODE_OAUTH_TOKEN ? 'Claude Code is not authenticated (run `claude auth login`, or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN)' : undefined;
      });
      const codex = () => reviewerSandbox(this.cfg, tmp, out, undefined, this.home, this.env);
      await check('codex', codex, ['--version'], /codex-cli\s+(\d+\.\d+\.\d+\S*)/, ['exec', '--help'], CODEX_FLAGS, async () => {
        const cl = await probe('codex login status', codex, ['login', 'status']);
        return (cl.exitCode !== 0 || !/^logged in/im.test(cl.stdout + cl.stderr)) && !this.env.OPENAI_API_KEY ? 'Codex is not authenticated (run `codex login`, or set OPENAI_API_KEY)' : undefined;
      });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
    return { ok: problems.length === 0, problems, detail, versions };
  }

  implement(o: { clone: string; prompt: string; timeoutMs: number }) {
    const rs = implementerSandbox(this.cfg, o.clone, this.home, this.env);
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--no-session-persistence', '--allowedTools', this.cfg.claude.allowedTools.join(',')];
    return runInSandbox(rs, rs.cmdPath, args, { stdin: o.prompt, timeoutMs: o.timeoutMs });
  }

  async review(o: { snapshot: string; outDir: string; prompt: string; schemaPath: string; timeoutMs: number }) {
    const rs = reviewerSandbox(this.cfg, o.snapshot, o.outDir, o.schemaPath, this.home, this.env);
    // Flags verified against `codex exec --help` (codex-cli 0.169). The inner Codex sandbox stays on read-only as a second layer.
    const args = ['exec', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--output-schema', '/schema.json', '--cd', '/review', '-c', 'approval_policy="never"', '-o', '/out/last-message.txt', '-'];
    const r = await runInSandbox(rs, rs.cmdPath, args, { stdin: o.prompt, timeoutMs: o.timeoutMs });
    return { ...r, finalMessage: readAgentFile(join(o.outDir, 'last-message.txt'), 1024 * 1024, o.outDir) };
  }
}
