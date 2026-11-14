// Process isolation for agent subprocesses, via bubblewrap (user/mount/pid/ipc/uts namespaces; no daemon, no root, no image).
// Everything an agent can see is an explicit mount below: a read-only system, its own tmpfs HOME, and the one directory it is
// meant to work in. The host home directory, DevFlow's repo/.env, SSH keys, the Docker socket and /mnt are simply not there.
// Network stays on because both agents must reach their model API (see README: egress is not filtered).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, constants as fsc } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export interface Mount { src: string; dst: string; rw?: boolean }
export interface SandboxJob { mounts: Mount[]; tmpfs?: string[]; env: Record<string, string>; cwd: string; cmd: string; args: string[] }

const ETC = ['resolv.conf', 'ssl', 'ca-certificates', 'hosts', 'nsswitch.conf', 'passwd', 'group', 'localtime', 'alternatives'];

export function bwrapUsable(): boolean {
  const r = spawnSync('bwrap', ['--unshare-all', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '/usr/bin/true'], { stdio: 'ignore' });
  return r.status === 0;
}

/** Node (and npm) usually live outside /usr (nvm); the agent's tooling needs them, so mount that one prefix read-only at the same path. */
export function nodePrefix(): string | undefined {
  const real = realpathSync(process.execPath);
  return real.startsWith('/usr/') ? undefined : dirname(dirname(real));
}

/** The host paths bwrapArgs actually binds from the system (one list, used by BOTH the sandbox and the policy check). */
export function hostSystemMounts(): string[] {
  const out = ['/usr'];
  for (const d of ['bin', 'sbin', 'lib', 'lib64']) { try { if (!lstatSync(`/${d}`).isSymbolicLink()) out.push(`/${d}`); } catch { /* absent */ } }
  for (const e of ETC) if (existsSync(`/etc/${e}`)) out.push(`/etc/${e}`);
  return out;
}

export function bwrapArgs(job: SandboxJob): string[] {
  const a = ['--unshare-all', '--share-net', '--die-with-parent', '--new-session', '--hostname', 'devflow-sandbox', '--clearenv'];
  for (const [k, v] of Object.entries(job.env)) a.push('--setenv', k, v);
  a.push('--ro-bind', '/usr', '/usr');
  for (const d of ['bin', 'sbin', 'lib', 'lib64']) {
    try { if (lstatSync(`/${d}`).isSymbolicLink()) a.push('--symlink', `usr/${d}`, `/${d}`); else a.push('--ro-bind', `/${d}`, `/${d}`); } catch { /* absent on this host */ }
  }
  a.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  for (const e of ETC) if (existsSync(`/etc/${e}`)) a.push('--ro-bind', `/etc/${e}`, `/etc/${e}`);
  for (const t of job.tmpfs ?? []) a.push('--tmpfs', t);
  for (const m of job.mounts) a.push(m.rw ? '--bind' : '--ro-bind', m.src, m.dst);
  a.push('--remount-ro', '/'); // the sandbox root itself is read-only: only the explicit rw mounts, /tmp and tmpfs homes are writable, and none of them persist or reach the host
  a.push('--chdir', job.cwd, '--', job.cmd, ...job.args);
  return a;
}

export function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const np = nodePrefix();
  return { PATH: `${np ? `${np}/bin:` : ''}/usr/local/bin:/usr/bin:/bin`, HOME: '/home/agent', LANG: 'C.UTF-8', TERM: 'dumb', TZ: 'UTC', DISABLE_AUTOUPDATER: '1', ...extra };
}
export function nodeMounts(): Mount[] { const np = nodePrefix(); return np ? [{ src: np, dst: np }] : []; }

/** Resolve an agent binary to the directory that must be mounted (Codex needs its sibling helper binaries) and the file inside it. */
export function resolveBin(bin: string): { dir: string; file: string } {
  let p = bin;
  if (!bin.includes('/')) {
    p = (process.env.PATH ?? '').split(':').map((d) => join(d, bin)).find((c) => existsSync(c)) ?? bin;
  }
  const real = realpathSync(p);
  return { dir: dirname(real), file: basename(real) };
}

/**
 * Reads a file the AGENT could have written. The path sits in a directory the agent controls, so it (or a parent directory) may be a symlink
 * to anything on the host. Parent directories must be real directories, the file is opened O_NOFOLLOW, must be a regular file under the size
 * cap, and only the bytes read through that verified descriptor are returned.
 */
export function readAgentBytes(path: string, maxBytes: number, mustStayInside?: string): Buffer | undefined {
  try {
    if (mustStayInside) {
      let d = dirname(path);
      while (d.length > mustStayInside.length && d.startsWith(mustStayInside)) { if (lstatSync(d).isSymbolicLink() || !lstatSync(d).isDirectory()) return undefined; d = dirname(d); }
    }
    if (!lstatSync(path).isFile()) return undefined;
    const fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > maxBytes) return undefined;
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n <= 0) break; off += n; }
      return buf.subarray(0, off);
    } finally { closeSync(fd); }
  } catch { return undefined; }
}
export function readAgentFile(path: string, maxBytes: number, mustStayInside?: string): string | undefined { return readAgentBytes(path, maxBytes, mustStayInside)?.toString('utf8'); }

// ---------------------------------------------------------------- credentials: copies, never the user's real home
const shaOf = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

export interface Staged { dir: string; mounts: Mount[]; tmpfs: string[]; env: Record<string, string>; finish: () => void }

/**
 * Builds a throw-away agent home containing ONLY the login credential file (no settings.json, hooks, MCP servers, CLAUDE.md or history).
 * OAuth tokens refresh inside the sandbox; if the staged file changed and the host's copy did not meanwhile, it is written back
 * atomically so a rotated token is never lost. The staged directory is deleted either way. Lives outside the run directory so
 * credentials can never end up in preserved evidence.
 */
export function stageHome(kind: 'claude' | 'codex', hostHome: string, parent = tmpdir()): Staged {
  const dir = mkdtempSync(join(parent, `devflow-${kind}-home-`));
  const cred = kind === 'claude' ? { host: join(hostHome, '.claude', '.credentials.json'), rel: join('.claude', '.credentials.json') } : { host: join(hostHome, '.codex', 'auth.json'), rel: 'auth.json' };
  const staged = join(dir, cred.rel);
  mkdirSync(dirname(staged), { recursive: true, mode: 0o700 });
  let before: string | undefined;
  if (existsSync(cred.host)) { copyFileSync(cred.host, staged); before = shaOf(readFileSync(cred.host)); }
  if (kind === 'claude') writeFileSync(join(dir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
  else writeFileSync(join(dir, 'config.toml'), '', { mode: 0o600 });
  const finish = () => {
    try {
      // The staged file was writable by the agent: it may have become a symlink (or sit under one). Only bytes read through a no-follow
      // descriptor, from a regular JSON-object file, are ever written back, and only if the host copy did not change meanwhile.
      const fresh = readAgentFile(staged, 1024 * 1024, dir);
      if (before && fresh !== undefined && existsSync(cred.host)) {
        let valid = false; try { const j = JSON.parse(fresh) as unknown; valid = typeof j === 'object' && j !== null && !Array.isArray(j); } catch { /* not JSON: refuse */ }
        if (valid && shaOf(fresh) !== before && shaOf(readFileSync(cred.host)) === before) {
          const tmp = `${cred.host}.devflow.tmp`;
          writeFileSync(tmp, fresh, { mode: 0o600 }); renameSync(tmp, cred.host);
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  return kind === 'claude'
    ? { dir, mounts: [{ src: dir, dst: '/home/agent', rw: true }], tmpfs: [], env: {}, finish }
    : { dir, mounts: [{ src: dir, dst: '/codexhome', rw: true }], tmpfs: ['/home/agent'], env: { CODEX_HOME: '/codexhome' }, finish };
}
