// Thin, shell-free git helpers. Every call is execFile with an argument array: no string is ever interpreted by a shell.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { RUN_BRANCH_RE } from './types.ts';

/**
 * Environment for every git call that only reads or rewrites local objects. It ignores the user's global and system git configuration, so no
 * filter driver, credential helper or alias defined there can be selected by repository content (.gitattributes) or run by this process.
 * Only network operations that need the owner's credentials (push, ls-remote, fetch origin) pass the ambient environment explicitly.
 */
export const cleanEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...extra });
export const ambientEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' });

/** Removes each secret, and its base64 (Basic auth) and URL-encoded forms, from text. */
const redact = (text: string, secrets: string[]) => secrets.filter(Boolean).reduce((t, x) => [x, encodeURIComponent(x), Buffer.from(`x-access-token:${x}`).toString('base64'), Buffer.from(x).toString('base64')].reduce((u, v) => u.split(v).join('***'), t), text);
export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = cleanEnv(), maxBuffer = 64 * 1024 * 1024, secrets: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${redact(stderr || err.message, secrets).trim().slice(0, 500)}`)); // redact first, then truncate
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
  const env = cleanEnv();
  await git(repo, ['-c', 'core.hooksPath=/dev/null', 'bundle', 'verify', bundleFile], env); // checks prerequisites are in OUR repo and the file is well-formed
  await git(repo, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true', 'fetch', '-q', '--no-tags', '--no-write-fetch-head', bundleFile, `+refs/heads/${branch}:${ref}`], env);
  return resolveRef(repo, ref);
}
export const deleteRef = (repo: string, ref: string) => git(repo, ['update-ref', '-d', ref]).catch(() => '');
/** Secret-free askpass: git runs it as `script "<prompt>"`; the token arrives only through the child's environment. */
const ASKPASS = `#!/bin/sh
case "$1" in
  Username*) printf '%s\\n' x-access-token ;;
  *) printf '%s\\n' "$DEVFLOW_PUSH_TOKEN" ;;
esac
`;
const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** The only variables a GitHub-facing git child inherits (TLS trust, proxy, search path). Everything else, including every GIT_* and credential variable, is dropped. */
const GH_ENV_KEEP = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
const GH_C = ['-c', 'credential.helper=', '-c', 'http.extraHeader=', '-c', 'http.followRedirects=false'];

/**
 * Runs `fn` against ONE fixed destination, `<host>/<repo>.git`, where `repo` is the approved "owner/name" and `host` is https://github.com (the
 * parameter exists only so tests can point at a local server; production never passes it). `fn` gets the exact URL, a private 0700 directory
 * bare repository (removed afterwards) and an environment that holds only the allowlisted variables, HOME in the scratch directory, config files off, and the explicit
 * write `token` supplied through a secret-free askpass. `origin`, pushurl, URL rewrites and every inherited git setting are never consulted.
 */
async function toGitHub<T>(repo: string, token: string | undefined, host: string, fn: (url: string, dir: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  if (!REPO_SLUG.test(repo) || repo.split('/').some((x) => x === '.' || x === '..')) throw new Error('refusing to use GitHub: repository must be "owner/name"');
  if (!token || /\s/.test(token)) throw new Error('refusing to use GitHub: no GITHUB_WRITE_TOKEN supplied');
  const dir = mkdtempSync(join(tmpdir(), 'devflow-push-')); // mode 0700
  try {
    const script = join(dir, 'askpass.sh'); writeFileSync(script, ASKPASS, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      HOME: dir, XDG_CONFIG_HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: new URL(host).protocol.slice(0, -1), GIT_ASKPASS: script, DEVFLOW_PUSH_TOKEN: token,
    };
    for (const k of GH_ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
    const bare = join(dir, 'r.git');
    await git(dir, ['init', '-q', '--bare', '--template=', bare], env);
    return await fn(`${host}/${repo}.git`, bare, env);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** SHA of a run branch on the approved GitHub repository, or undefined if it does not exist. Asks the remote itself, never a local ref or `origin`. */
export async function remoteHead(branch: string, repo: string, token: string | undefined, host = 'https://github.com') {
  if (!RUN_BRANCH_RE.test(branch)) throw new Error(`refusing to read: "${branch.slice(0, 80)}" is not a DevFlow run branch`);
  return toGitHub(repo, token, host, async (url, bare, env) => {
    const out = (await git(bare, [...GH_C, 'ls-remote', '--heads', url, `refs/heads/${branch}`], env, undefined, [token!])).trim();
    return out ? out.split(/\s+/)[0] : undefined;
  });
}

/**
 * Non-force push of one private ref to one run branch of the fixed destination (see toGitHub). The commit is handed to a throwaway bare
 * repository by SHA and the source's object directory (alternates), so nothing in the source repository's own configuration, including
 * upload-pack settings such as hideRefs or hooks, is ever consulted; the push runs from that throwaway repository. No token, no push.
 */
export async function pushRef(repoPath: string, ref: string, branch: string, repo: string, token: string | undefined, host = 'https://github.com') {
  // Feature-branch-only writes, enforced here and not just by remote protection: no other destination name can be pushed, ever.
  if (!RUN_BRANCH_RE.test(branch)) throw new Error(`refusing to push: "${branch.slice(0, 80)}" is not a DevFlow run branch (devflow/<ticket>-<run>)`);
  if (!/^refs\/devflow\/[A-Za-z0-9]+\/attempt-\d$/.test(ref)) throw new Error('refusing to push: source must be a private refs/devflow/<run>/attempt-N ref');
  return toGitHub(repo, token, host, async (url, bare, env) => {
    const sha = await resolveRef(repoPath, ref), objects = (await git(repoPath, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])).trim();
    writeFileSync(join(bare, 'objects', 'info', 'alternates'), `${objects}\n`);
    await git(bare, ['update-ref', ref, sha], env);
    // Explicit URL: no remote exists. Never --force. The token is not in argv.
    return git(bare, [...GH_C, 'push', '--no-follow-tags', url, `${ref}:refs/heads/${branch}`], env, undefined, [token!]);
  });
}

function blobs(repo: string, oids: string[]): Promise<Buffer[]> {
  return new Promise((resolveP, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: repo, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let total = 0;
    child.stdout.on('data', (d: Buffer) => { total += d.length; if (total > 512 * 1024 * 1024) { child.kill(); reject(new Error('tree too large to export')); } else chunks.push(d); });
    child.on('error', reject);
    child.on('close', () => {
      const buf = Buffer.concat(chunks), out: Buffer[] = []; let off = 0;
      for (const oid of oids) {
        const nl = buf.indexOf(0x0a, off); if (nl < 0) return reject(new Error('git cat-file ended early'));
        const m = /^([0-9a-f]{40}) blob (\d+)$/.exec(buf.subarray(off, nl).toString('utf8'));
        if (!m || m[1] !== oid) return reject(new Error('unexpected git cat-file output'));
        const size = Number(m[2]); out.push(buf.subarray(nl + 1, nl + 1 + size)); off = nl + 1 + size + 1;
      }
      resolveP(out);
    });
    child.stdin.end(`${oids.join('\n')}\n`);
  });
}

/**
 * Exports the exact committed bytes of `sha` (no .git, no history, no conversion) into dest by reading tree and blob OBJECTS directly.
 * No checkout machinery runs, so no filter, smudge/process driver, eol or ident rewriting, or `export-ignore` can alter or hide anything,
 * whatever the repository's .gitattributes say. Paths come from agent-influenced trees, so each is validated before it is written.
 */
export async function exportTree(repo: string, sha: string, dest: string) {
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const root = realpathSync(dest);
  const rows = (await git(repo, ['ls-tree', '-r', '-z', '--full-tree', sha])).split('\0').filter(Boolean).flatMap((row) => {
    const m = /^(\d{6}) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(row);
    return m ? [{ mode: m[1]!, type: m[2]!, oid: m[3]!, path: m[4]! }] : [];
  }).filter((r) => r.type === 'blob'); // submodule pointers have no content to export
  const data = rows.length ? await blobs(repo, rows.map((r) => r.oid)) : [];
  rows.forEach((r, i) => {
    const segs = r.path.split('/');
    if (r.path.startsWith('/') || segs.some((x) => x === '' || x === '.' || x === '..' || x.toLowerCase() === '.git' || x.includes('\0'))) throw new Error(`refusing to export suspicious path "${r.path.slice(0, 80)}"`);
    const target = join(root, r.path);
    mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
    if (!realpathSync(join(target, '..')).startsWith(root + sep) && realpathSync(join(target, '..')) !== root) throw new Error('refusing to write outside the export directory');
    if (r.mode === '120000') symlinkSync(data[i]!.toString('utf8'), target);
    else writeFileSync(target, data[i]!, { mode: r.mode === '100755' ? 0o755 : 0o644 });
  });
}

/** Every path touched by ANY commit in start..sha (merge commits diffed against each parent), so a change made and reverted inside the history is still seen. */
export async function touchedByCommits(cwd: string, start: string, sha: string, max = 300): Promise<string[]> {
  const revs = (await git(cwd, ['rev-list', `${start}..${sha}`])).split('\n').filter(Boolean);
  if (revs.length > max) throw new Error(`too many new commits (${revs.length} > ${max})`);
  const out = new Set<string>();
  for (const c of revs) for (const f of (await git(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--root', '--no-renames', '-z', c])).split('\0').filter(Boolean)) out.add(f);
  return [...out];
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
