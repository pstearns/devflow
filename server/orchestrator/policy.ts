// Trusted controller policy. The controller is privileged (Linear writes, git push, PRs, agent dispatch), so its authority comes from ONE
// owner-controlled file that no agent can reach: devflow.config.json next to DevFlow, loaded by the controller itself. Nothing found in a
// ticket, a repository, a commit, an agent's output or its environment is ever read as policy. This module checks that the trusted inputs
// are what they claim to be, snapshots them when a run starts, and re-verifies the snapshot before every privileged step. If anything
// cannot be verified, the run stops (fail closed).
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrchestrationCfg } from '../config.ts';
import { nodePrefix } from './sandbox.ts';

export class PolicyError extends Error {}

const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const unsafeMode = (mode: number) => (mode & 0o022) !== 0; // group- or world-writable

/** The DevFlow application directory (holds .env and the config by default). Works from source and from the compiled build. */
function appRootDir(): string | undefined {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++, d = dirname(d)) { try { if (statSync(resolve(d, 'package.json')).isFile() && statSync(resolve(d, 'server')).isDirectory()) return d; } catch { /* keep walking */ } }
  return undefined;
}

export interface PolicyView { digest: string; configPath: string; checkedAt: string }

/** Characters/shapes an --allowedTools entry may have: a tool name with an optional (pattern). No leading dash, no commas, no newlines. */
export const TOOL_RE = /^[A-Za-z][A-Za-z0-9_]*(\([^,\n\r)]{1,120}\))?$/;

function fileFacts(p: string, what: string, opts: { exec?: boolean } = {}) {
  let real: string;
  try { real = realpathSync(p); } catch { throw new PolicyError(`${what} does not exist: cannot verify trusted policy`); }
  const st = statSync(real);
  if (!st.isFile()) throw new PolicyError(`${what} is not a regular file`);
  if (st.uid !== process.getuid!() && st.uid !== 0) throw new PolicyError(`${what} is owned by another user`);
  if (unsafeMode(st.mode)) throw new PolicyError(`${what} is group- or world-writable`);
  if (opts.exec) { try { accessSync(real, constants.X_OK); } catch { throw new PolicyError(`${what} is not executable`); } }
  return { real, sig: `${real}|${st.ino}|${st.size}|${st.mtimeMs}` };
}

/**
 * Verifies the trusted inputs for one orchestration config and returns a digest of everything the controller will rely on.
 * `configPath` is the file the policy was loaded from; it must be the owner's, not writable by others, and outside every agent-reachable tree.
 */
export const SYSTEM_MOUNTS = ['/usr', '/etc/resolv.conf', '/etc/ssl', '/etc/ca-certificates', '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group', '/etc/localtime', '/etc/alternatives'];
/** Canonical form (symlinks resolved) when the path exists, lexical otherwise: aliases and ancestors cannot hide a sensitive directory. */
const canon = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

export function verifyPolicy(oc: OrchestrationCfg, configPath: string, now = new Date(), toolchainDir: string | undefined = nodePrefix(), extra: { home?: string; systemMounts?: string[] } = {}): PolicyView {
  const cfgReal = fileFacts(configPath, 'controller config');
  const repo = resolve(oc.repoPath), runs = resolve(oc.runsDir);
  for (const [name, p] of [['repoPath', repo], ['runsDir', runs]] as const) {
    let st; try { st = lstatSync(p); } catch { throw new PolicyError(`${name} does not exist`); }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new PolicyError(`${name} must be a real directory (not a symlink)`);
  }
  if (within(runs, repo) || within(repo, runs)) throw new PolicyError('runsDir and repoPath must not contain each other (agent-reachable repository content could alter run evidence)');
  if (within(cfgReal.real, repo) || within(cfgReal.real, runs)) throw new PolicyError('the controller config lives inside a repository or run directory that agents can influence: refusing to treat it as trusted policy');
  const sigs: string[] = [cfgReal.sig];
  const appRoot = appRootDir();
  const home = extra.home ?? homedir();
  const protectedDirs = [dirname(cfgReal.real), repo, runs, join(home, '.claude'), join(home, '.codex'), join(home, '.ssh'), join(home, '.config'), join(home, '.local', 'share', 'devflow'), ...(appRoot ? [appRoot] : [])].map(canon);
  // EVERY host path the sandbox mounts (system trees included, not only agent binaries) must be free of controller data.
  for (const m of extra.systemMounts ?? SYSTEM_MOUNTS) { const cm = canon(m); const hit = protectedDirs.find((d) => within(d, cm)); if (hit) throw new PolicyError(`the system mount ${m} contains controller-sensitive paths (config, .env, repositories, run data or credentials): install DevFlow outside system directories`); }
  // Every directory the sandbox will mount from the host must be free of controller data, not just the agent binaries' directories.
  const np = toolchainDir ? canon(toolchainDir) : undefined;
  if (np) {
    const hit = protectedDirs.find((d) => within(d, np));
    if (hit) throw new PolicyError('the Node toolchain directory mounted into the sandbox contains controller-sensitive paths (config, .env, repositories or credentials); install node under a dedicated directory');
    if (unsafeMode(statSync(np).mode)) throw new PolicyError('the Node toolchain directory is group- or world-writable');
  }
  for (const [what, bin] of [['claude', oc.claude.bin], ['codex', oc.codex.bin]] as const) {
    const f = fileFacts(bin, `${what} executable`, { exec: true });
    const dir = dirname(f.real); // f.real is already canonical
    if (within(f.real, repo) || within(f.real, runs)) throw new PolicyError(`${what} executable lives inside a repository or run directory: agents could replace it`);
    const hit = protectedDirs.find((d) => within(d, dir)); // the whole bin directory gets mounted: it must not contain anything sensitive
    if (hit) throw new PolicyError(`${what} executable's directory contains controller-sensitive paths; it would be exposed to the agent`);
    if (unsafeMode(statSync(dir).mode)) throw new PolicyError(`${what} executable's directory is group- or world-writable`);
    sigs.push(f.sig);
  }
  for (const t of oc.claude.allowedTools) if (!TOOL_RE.test(t)) throw new PolicyError(`claude.allowedTools entry "${t.slice(0, 60)}" is not a plain tool pattern`);
  const body = JSON.stringify({ repo: oc.repo, repoPath: repo, runsDir: runs, base: oc.baseBranch, started: oc.startedState, approval: oc.approvalState, blocked: oc.blockedState,
    ci: oc.ciChecks, tools: oc.claude.allowedTools, claude: oc.claude.bin, codex: oc.codex.bin, cfgBytes: createHash('sha256').update(readFileSync(cfgReal.real)).digest('hex'), sigs });
  return { digest: createHash('sha256').update(body).digest('hex'), configPath: cfgReal.real, checkedAt: now.toISOString() };
}

export interface Pinned { digest: string; view: PolicyView; verify(): void }

/** Pins the trusted inputs for ONE run when it is accepted; `verify()` throws if any of them changed or became unverifiable since. */
export class PolicyGuard {
  constructor(private oc: () => OrchestrationCfg, private configPath: string, private clock: () => Date = () => new Date()) {}
  pin(): Pinned {
    const view = verifyPolicy(this.oc(), this.configPath, this.clock());
    return {
      digest: view.digest, view,
      verify: () => { if (verifyPolicy(this.oc(), this.configPath, this.clock()).digest !== view.digest) throw new PolicyError('trusted policy changed while the run was in progress'); },
    };
  }
}
