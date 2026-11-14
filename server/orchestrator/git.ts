// Thin, shell-free git helpers. Every call is execFile with an argument array: no string is ever interpreted by a shell.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_BRANCH_RE } from './types.ts';

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env, maxBuffer = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${(stderr || err.message).trim().slice(0, 500)}`));
      else resolve(stdout);
    });
  });
}
const SHA_RE = /^[0-9a-f]{40}$/;
export const isSha = (s: string) => SHA_RE.test(s);

export const head = async (cwd: string) => (await git(cwd, ['rev-parse', 'HEAD'])).trim();
export const resolveRef = async (cwd: string, ref: string) => (await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
export async function isAncestor(cwd: string, a: string, b: string) {
  try { await git(cwd, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; }
}
export const isClean = async (cwd: string) => (await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])).trim() === '';
export const currentBranch = async (cwd: string) => (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
export async function changedFiles(cwd: string, base: string, sha: string) {
  // --no-renames: a moved file must show as BOTH a deletion and an addition, or a protected source path could hide behind its new name
  return (await git(cwd, ['diff', '--no-renames', '--name-only', '-z', `${base}..${sha}`])).split('\0').filter(Boolean);
}
export const patch = (cwd: string, base: string, sha: string) => git(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-renames', `${base}..${sha}`]);
export async function lineCount(cwd: string, sha: string, file: string): Promise<number | undefined> {
  if (file.startsWith('-') || file.includes('\0')) return undefined;
  try {
    const blob = await new Promise<Buffer>((resolve, reject) => execFile('git', ['cat-file', 'blob', `${sha}:${file}`], { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(out))));
    return blob.toString('utf8').split('\n').length;
  } catch { return undefined; }
}
/** SHA of a branch on origin, or undefined if it does not exist. Asks the remote, never a possibly stale local ref. */
export async function remoteHead(cwd: string, branch: string) {
  const out = (await git(cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])).trim();
  return out ? out.split(/\s+/)[0] : undefined;
}

/**
 * The implementer's workspace: a standalone repository (its own .git, objects copied not hardlinked, NO remote), seeded from the
 * base commit. Nothing in it points back at the user's repository, so a sandboxed agent can neither alter that repo nor push.
 */
export async function initClone(repo: string, baseRef: string, clone: string, branch: string) {
  mkdirSync(clone, { recursive: true, mode: 0o700 });
  await git(clone, ['init', '-q', '-b', branch]);
  await git(clone, ['fetch', '-q', '--no-tags', repo, baseRef]);
  await git(clone, ['checkout', '-q', '-B', branch, 'FETCH_HEAD']);
}

/**
 * Brings the agent's commits into the CONTROLLER's repository as a private ref. The agent's repository directory is never read by a
 * privileged git: the commits arrive as a self-contained BUNDLE file that was created inside the sandbox (where links pointing at host
 * paths dangle) and copied out through a verified regular-file read. Hooks are disabled on the command line for the fetch regardless.
 */
export async function importBundle(repo: string, bundleFile: string, branch: string, ref: string) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  await git(repo, ['-c', 'core.hooksPath=/dev/null', 'bundle', 'verify', bundleFile], env); // checks prerequisites are in OUR repo and the file is well-formed
  await git(repo, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'fetch', '-q', '--no-tags', '--no-write-fetch-head', bundleFile, `+refs/heads/${branch}:${ref}`], env);
  return resolveRef(repo, ref);
}
export const deleteRef = (repo: string, ref: string) => git(repo, ['update-ref', '-d', ref]).catch(() => '');
/** Non-force push of one private ref to one branch. Runs in the controller only, with the user's own git credentials. */
export function pushRef(repo: string, ref: string, branch: string) {
  // Feature-branch-only writes, enforced here and not just by remote protection: no other destination name can be pushed, ever.
  if (!RUN_BRANCH_RE.test(branch)) throw new Error(`refusing to push: "${branch.slice(0, 80)}" is not a DevFlow run branch (devflow/<ticket>-<run>)`);
  if (!/^refs\/devflow\/[A-Za-z0-9]+\/attempt-\d$/.test(ref)) throw new Error('refusing to push: source must be a private refs/devflow/<run>/attempt-N ref');
  return git(repo, ['push', '--no-follow-tags', 'origin', `${ref}:refs/heads/${branch}`]); // never --force
}

/**
 * Exports the exact tree of `sha` (no .git, no history) into dest. Uses a temporary index + checkout-index rather than `git archive`,
 * because archive honours in-tree .gitattributes `export-ignore`: a committed file could hide itself from the reviewer.
 */
export async function exportTree(repo: string, sha: string, dest: string) {
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const idx = join(dest, '..', `.index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx, GIT_CONFIG_NOSYSTEM: '1' };
  try {
    await git(repo, ['read-tree', sha], env);
    await git(repo, ['-c', 'core.attributesFile=/dev/null', 'checkout-index', '-a', '-f', `--prefix=${dest}/`], env);
  } finally { rmSync(idx, { force: true }); }
}

/** Content hash of a directory (names, modes, bytes, symlink targets). Used to prove the reviewer changed nothing. */
export function hashDir(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name), r = `${rel}/${name}`, st = lstatSync(p);
      if (st.isSymbolicLink()) h.update(`L ${r} ${readlinkSync(p)}\n`);
      else if (st.isDirectory()) { h.update(`D ${r}\n`); walk(p, r); }
      else h.update(`F ${r} ${st.mode & 0o111 ? 'x' : '-'} `).update(readFileSync(p)).update('\n');
    }
  };
  walk(dir, '');
  return h.digest('hex');
}
/** Kernel-enforced read-only: no write bit anywhere. Independent of whatever the reviewer's own sandbox does. */
export function makeReadOnly(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) makeReadOnly(p);
    else chmodSync(p, st.mode & 0o555);
  }
  chmodSync(dir, lstatSync(dir).mode & 0o555);
}
export function makeWritable(dir: string) {
  chmodSync(dir, lstatSync(dir).mode | 0o700);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) makeWritable(p);
    else chmodSync(p, st.mode | 0o600);
  }
}
