// NEGATIVE tests: each one tries to do something an agent must not be able to do, through the SAME sandbox builders production uses,
// and asserts that it fails. They need bubblewrap (skipped, loudly, where user namespaces are unavailable).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { implementerSandbox, makeBundle, reviewerSandbox, runInSandbox, type RoleSandbox } from '../server/orchestrator/agents.ts';
import { bwrapArgs, bwrapUsable, stageHome } from '../server/orchestrator/sandbox.ts';
import * as G from '../server/orchestrator/git.ts';
import { GithubPrs } from '../server/orchestrator/pr.ts';
import { SourceError } from '../server/util.ts';

const usable = bwrapUsable();
const FIX = resolve(import.meta.dirname, 'fixtures');
const REAL_ENV = resolve(import.meta.dirname, '..', '.env'); // the real DevFlow credentials file, if present on this machine
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' };
const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8', env: gitEnv }).trim();

let root: string;
let last: { snap: string; out: string };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'devflow-iso-')); });
afterEach(() => { try { execFileSync('chmod', ['-R', 'u+rwX', root]); } catch { /* */ } rmSync(root, { recursive: true, force: true }); });

let n = 0;
const uniq = (p: string) => join(root, `${p}-${++n}`);
function fakeHome() {
  const h = uniq('home'); mkdirSync(join(h, '.claude'), { recursive: true }); mkdirSync(join(h, '.codex'), { recursive: true });
  writeFileSync(join(h, '.claude', '.credentials.json'), '{"claude":"cred"}'); writeFileSync(join(h, '.codex', 'auth.json'), '{"codex":"cred"}');
  // things that must NOT cross: user settings (hooks!), history, ssh keys
  writeFileSync(join(h, '.claude', 'settings.json'), '{"hooks":{"evil":true}}'); mkdirSync(join(h, '.ssh')); writeFileSync(join(h, '.ssh', 'id_ed25519'), 'PRIVATE');
  return h;
}
function sourceRepo() {
  const r = uniq('source'); mkdirSync(r); sh(r, 'init', '-q', '-b', 'main'); writeFileSync(join(r, 'a.txt'), 'a\n'); sh(r, 'add', '-A'); sh(r, 'commit', '-q', '-m', 'init');
  sh(r, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return r;
}
const cfg = { claude: { bin: join(FIX, 'fake-claude.mjs'), allowedTools: [] }, codex: { bin: join(FIX, 'fake-codex.mjs') } };
const run = (rs: () => RoleSandbox, cmd: string) => runInSandbox(rs(), '/bin/sh', ['-c', cmd], { timeoutMs: 20_000 });
const SECRETS = { LINEAR_WRITE_API_KEY: 'lw-secret', LINEAR_API_KEY: 'lr-secret', GITHUB_TOKEN: 'gh-secret', GITHUB_WRITE_TOKEN: 'ghw-secret', GH_TOKEN: 'gh2-secret', DEVFLOW_X: 'd-secret', SSH_AUTH_SOCK: '/tmp/sock' };

function reviewer(extraEnv: NodeJS.ProcessEnv = {}) {
  const snap = uniq('snap'); mkdirSync(join(snap, 'src'), { recursive: true }); writeFileSync(join(snap, 'src', 'a.txt'), 'a'); G.makeReadOnly(snap);
  const out = uniq('out'); mkdirSync(out);
  last = { snap, out };
  const home = fakeHome();
  return () => reviewerSandbox(cfg, snap, out, undefined, home, { PATH: process.env.PATH, ...extraEnv }); // a sandbox is single-use: finish() deletes its staged home
}
function implementer(extraEnv: NodeJS.ProcessEnv = {}) {
  const src = sourceRepo(); const clone = uniq('clone');
  const home = fakeHome();
  return G.initClone(src, 'refs/remotes/origin/main', clone, 'devflow/x').then(() => ({ src, clone, rs: () => implementerSandbox(cfg, clone, home, { PATH: process.env.PATH, ...extraEnv }) }));
}

describe.skipIf(!usable)('reviewer sandbox: cannot write, cannot act on Git or Linear', () => {
  it('the snapshot, the system, the agent binary and the root are read-only; only /out (and ephemeral /tmp, tmpfs home) accept writes', async () => {
    const rs = reviewer();
    for (const target of ['/review/src/a.txt', '/review/new.txt', '/review/context.txt', '/etc/x', '/usr/x', '/opt/agent/x', '/x', '/schema.json']) {
      const r = await run(rs, `echo pwn > ${target}`);
      expect(r.exitCode, target).not.toBe(0);
    }
    expect((await run(reviewer(), 'echo ok > /out/last-message.txt')).exitCode).toBe(0); // the one intended write channel
    expect(readFileSync(join(last.out, 'last-message.txt'), 'utf8')).toBe('ok\n');
    expect(readFileSync(join(last.snap, 'src', 'a.txt'), 'utf8')).toBe('a'); // host copy untouched
  });
  it('has no git metadata and cannot run any git action against anything', async () => {
    const rs = reviewer();
    expect((await run(rs, 'find /review -name .git | grep -q .')).exitCode).not.toBe(0);
    for (const cmd of ['git -C /review status', 'git -C /review rev-parse HEAD', 'git -C /review remote -v && false', 'git -C /review push origin HEAD', 'git ls-remote https://github.com/x/y.git']) {
      const r = await run(reviewer(), cmd);
      expect(r.exitCode, cmd).not.toBe(0);
    }
  });
  it('sees none of the controller credentials, in its environment or via /proc', async () => {
    Object.assign(process.env, SECRETS);
    try {
      const rs = reviewer(SECRETS);
      const r = await run(rs, 'env; cat /proc/*/environ 2>/dev/null | tr "\\0" "\\n"');
      expect(r.exitCode).toBe(0);
      for (const [k, v] of Object.entries(SECRETS)) { expect(r.stdout).not.toContain(k); expect(r.stdout).not.toContain(v); }
      expect(r.stdout).toContain('DEVFLOW_ROLE=reviewer');
    } finally { for (const k of Object.keys(SECRETS)) delete process.env[k]; }
  });
  it('cannot see the host: home directory, ssh keys, claude credentials, DevFlow .env, runs, docker socket, /mnt', async () => {
    const home = process.env.HOME!;
    const paths = [`${home}/.ssh`, `${home}/.claude`, `${home}/.codex`, REAL_ENV, root, '/var/run/docker.sock', '/run/docker.sock', '/mnt', '/mnt/c', '/home/agent/.claude', '/home/agent/.ssh'];
    const r = await run(reviewer(), paths.map((p) => `test -e ${JSON.stringify(p)} && echo VISIBLE:${p}`).join('; ') + '; true');
    expect(r.stdout).toBe('');
    // the only thing under the user's home is the read-only node toolchain prefix (when node lives in ~/.nvm), nothing else
    expect((await run(reviewer(), `ls -A ${home}`)).stdout.trim()).toMatch(/^(\.nvm)?$/);
    expect((await run(reviewer(), `ls -A ${home}/.nvm`)).stdout.trim()).toMatch(/^(versions)?$/);
  });
  it('gets only the Codex login (a copy), never the Claude login or the user settings', async () => {
    const rs = reviewer();
    const r = await run(rs, 'ls -A /codexhome; echo ---; ls -A /home/agent; echo ---; cat /codexhome/auth.json');
    expect(r.stdout).toBe('auth.json\nconfig.toml\n---\n---\n{"codex":"cred"}');
  });
  it('is isolated in its own pid/ipc/uts/net-namespace setup (host processes invisible)', async () => {
    const r = await run(reviewer(), 'ls /proc | grep -E "^[0-9]+$" | wc -l');
    expect(Number(r.stdout.trim())).toBeLessThan(12);
  });
});

describe.skipIf(!usable)('implementer sandbox: own clone only, no remote, no credentials', () => {
  it('can edit and commit in its clone (positive control) but nowhere else', async () => {
    const { rs, clone } = await implementer();
    expect((await run(rs, 'echo b > b.txt && git add b.txt && git commit -q -m x && git log --oneline | wc -l')).stdout.trim()).toBe('2');
    expect(sh(clone, 'log', '--oneline').split('\n')).toHaveLength(2);
    for (const target of ['/etc/x', '/usr/x', '/x', '/opt/agent/x', `${process.env.HOME}/x`, '/home/agent/../x']) {
      expect((await run((await implementer()).rs, `echo pwn > ${target}`)).exitCode, target).not.toBe(0);
    }
  });
  it('has a standalone .git with no remote, so it cannot push anywhere', async () => {
    const { rs, src } = await implementer();
    expect((await run(rs, 'test -d /work/.git && ! test -f /work/.git')).exitCode).toBe(0); // a real directory, not a pointer into the user repo
    expect((await run(rs, 'git remote')).stdout.trim()).toBe('');
    expect((await run(rs, 'git rev-parse --git-common-dir')).stdout.trim()).toBe('.git');
    for (const cmd of ['git push origin HEAD', `git push ${src} HEAD:refs/heads/pwn`, `git -C ${src} log`, `git fetch ${src}`]) expect((await run((await implementer()).rs, cmd)).exitCode, cmd).not.toBe(0);
    expect(sh(src, 'branch', '--list', 'pwn')).toBe(''); // the source repo never saw anything
  });
  it('sees none of the controller credentials and none of the user\'s files', async () => {
    Object.assign(process.env, SECRETS);
    try {
      const { rs } = await implementer(SECRETS);
      const home = process.env.HOME!;
      const r = await run(rs, `env; cat /proc/*/environ 2>/dev/null | tr "\\0" "\\n"; ${[`${home}/.ssh`, `${home}/.claude`, `${home}/.codex`, REAL_ENV, "/mnt", "/var/run/docker.sock", "/codexhome"].map((p) => `test -e ${JSON.stringify(p)} && echo VISIBLE:${p}`).join('; ')}; true`);
      for (const [k, v] of Object.entries(SECRETS)) { expect(r.stdout).not.toContain(k); expect(r.stdout).not.toContain(v); }
      expect(r.stdout).not.toContain('VISIBLE:');
      expect(r.stdout).toContain('GIT_CONFIG_GLOBAL=/dev/null');
    } finally { for (const k of Object.keys(SECRETS)) delete process.env[k]; }
  });
  it('gets only a copy of the Claude login: no settings.json/hooks, history, ssh keys', async () => {
    const { rs } = await implementer();
    const r = await run(rs, 'cd /home/agent && find . -type f | sort; cat .claude/.credentials.json');
    expect(r.stdout.trim()).toBe('./.claude.json\n./.claude/.credentials.json\n{"claude":"cred"}');
  });
});

describe('credential staging', () => {
  it('copies only the login file, removes the staged home, and writes a refreshed token back only if the host copy is unchanged', () => {
    const h = fakeHome();
    const a = stageHome('claude', h, root);
    writeFileSync(join(a.dir, '.claude', '.credentials.json'), '{"claude":"refreshed"}');
    a.finish();
    expect(readFileSync(join(h, '.claude', '.credentials.json'), 'utf8')).toBe('{"claude":"refreshed"}');
    expect(existsSync(a.dir)).toBe(false);
    // host changed while the agent ran (e.g. user re-logged in): the stale staged copy must not clobber it
    const b = stageHome('codex', h, root);
    writeFileSync(join(b.dir, 'auth.json'), '{"codex":"agent-version"}');
    writeFileSync(join(h, '.codex', 'auth.json'), '{"codex":"user-relogin"}');
    b.finish();
    expect(readFileSync(join(h, '.codex', 'auth.json'), 'utf8')).toBe('{"codex":"user-relogin"}');
    // unchanged staged file: no write-back at all
    const c = stageHome('codex', h, root); c.finish();
    expect(readFileSync(join(h, '.codex', 'auth.json'), 'utf8')).toBe('{"codex":"user-relogin"}');
    expect(readdirSync(root).filter((d) => d.startsWith('devflow-'))).toEqual([]);
  });
  it('bwrap arguments start from a cleared environment and a read-only root', () => {
    const args = bwrapArgs({ mounts: [{ src: '/a', dst: '/a' }], env: { A: '1' }, cwd: '/a', cmd: '/bin/true', args: [] });
    expect(args).toContain('--clearenv');
    expect(args.indexOf('--clearenv')).toBeLessThan(args.indexOf('--setenv'));
    expect(args.join(' ')).toContain('--remount-ro /');
    expect(args).toContain('--unshare-all');
    expect(args).not.toContain('--bind-try');
  });
});

describe.skipIf(!usable)('untrusted clone cannot execute code in, or read from, the controller', () => {
  const BR = 'devflow/atl-1-abcdef1';
  const bundleOf = (clone: string, base: string) => makeBundle({ claude: cfg.claude }, clone, fakeHome(), {}, BR, base);
  const commitIn = (clone: string) => { writeFileSync(join(clone, 'new.txt'), 'n\n'); execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'filter.evil.clean=cat', 'add', '-A'], { cwd: clone, env: gitEnv }); execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'filter.evil.clean=cat', 'commit', '-q', '-m', 'work'], { cwd: clone, env: gitEnv }); };

  it('hooks, fsmonitor, packObjectsHook and filters planted in the clone never run in the controller during bundle import, diff, export or line counts', async () => {
    const src = sourceRepo(), clone = uniq('clone'), marker = join(root, 'PWNED');
    await G.initClone(src, 'refs/remotes/origin/main', clone, BR);
    const evil = `#!/bin/sh\ntouch ${marker}\n`;
    for (const h of ['post-upload-pack', 'pre-upload-pack', 'reference-transaction', 'post-checkout', 'pre-auto-gc', 'update']) { writeFileSync(join(clone, '.git', 'hooks', h), evil); chmodSync(join(clone, '.git', 'hooks', h), 0o755); }
    writeFileSync(join(clone, '.git', 'config'), `${readFileSync(join(clone, '.git', 'config'), 'utf8')}[core]\n\tfsmonitor = touch ${marker}\n\thooksPath = ${join(clone, '.git', 'hooks')}\n[uploadpack]\n\tpackObjectsHook = ${join(clone, '.git', 'hooks', 'update')}\n[filter "evil"]\n\tclean = touch ${marker}\n\tsmudge = touch ${marker}\n[diff "evil"]\n\ttextconv = touch ${marker}\n`);
    writeFileSync(join(clone, '.gitattributes'), '* filter=evil diff=evil\n');
    commitIn(clone);
    rmSync(marker, { force: true }); // setup ran git INSIDE the hostile clone (which obeys its own config); everything below is the controller
    const base = sh(src, 'rev-parse', 'refs/remotes/origin/main');
    const bundle = await bundleOf(clone, base);
    expect(bundle).toBeDefined();
    const file = uniq('b') + '.bundle'; writeFileSync(file, bundle!);
    const sha = await G.importBundle(src, file, BR, 'refs/devflow/r/attempt-0');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    await G.changedFiles(src, base, sha); await G.patch(src, base, sha); await G.lineCount(src, sha, 'new.txt');
    await G.exportTree(src, sha, join(root, 'export'));
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(root, 'export', 'new.txt'), 'utf8')).toBe('n\n');
  });
  it('a .git/objects symlink to the controller repository cannot be followed: no bundle is built and nothing is imported', async () => {
    const src = sourceRepo(), clone = uniq('clone');
    await G.initClone(src, 'refs/remotes/origin/main', clone, BR);
    commitIn(clone);
    // the controller repo has a private branch the agent must never be able to import
    writeFileSync(join(src, 'private.txt'), 'CONTROLLER-SECRET'); sh(src, 'add', '-A'); sh(src, 'commit', '-q', '-m', 'private'); sh(src, 'branch', 'private-branch');
    rmSync(join(clone, '.git', 'objects'), { recursive: true }); execFileSync('ln', ['-s', join(src, '.git', 'objects'), join(clone, '.git', 'objects')]);
    mkdirSync(join(clone, '.git', 'refs', 'heads', 'devflow'), { recursive: true }); rmSync(join(clone, '.git', 'refs', 'heads', 'devflow', 'atl-1-abcdef1'), { force: true });
    execFileSync('ln', ['-s', join(src, '.git', 'refs', 'heads', 'private-branch'), join(clone, '.git', 'refs', 'heads', 'devflow', 'atl-1-abcdef1')]);
    const base = sh(src, 'rev-parse', 'refs/remotes/origin/main');
    expect(await bundleOf(clone, base)).toBeUndefined(); // links dangle inside the sandbox
    expect(sh(src, 'for-each-ref', '--format=%(refname)')).not.toMatch(/devflow/);
  });
  it('an alternates file pointing at the controller repository does not smuggle its objects into the bundle', async () => {
    const src = sourceRepo(), clone = uniq('clone');
    await G.initClone(src, 'refs/remotes/origin/main', clone, BR);
    commitIn(clone);
    writeFileSync(join(clone, '.git', 'objects', 'info', 'alternates'), `${join(src, '.git', 'objects')}\n`);
    const base = sh(src, 'rev-parse', 'refs/remotes/origin/main');
    const b = await bundleOf(clone, base); // may or may not build; either way it can only contain the clone's own objects
    if (b) { const f = uniq('b') + '.bundle'; writeFileSync(f, b); const sha = await G.importBundle(src, f, BR, 'refs/devflow/r/a'); expect(await G.changedFiles(src, base, sha)).toEqual(['new.txt']); }
  });
  it('a file hidden with export-ignore in .gitattributes still reaches the reviewer snapshot', async () => {
    const src = sourceRepo();
    writeFileSync(join(src, '.gitattributes'), 'secret.js export-ignore\n'); writeFileSync(join(src, 'secret.js'), 'evil()\n');
    sh(src, 'add', '-A'); sh(src, 'commit', '-q', '-m', 'hide');
    await G.exportTree(src, sh(src, 'rev-parse', 'HEAD'), join(root, 'snap'));
    expect(readFileSync(join(root, 'snap', 'secret.js'), 'utf8')).toBe('evil()\n');
  });
  it('only the named branch is in the bundle (other branches and tags in the clone are not transferred)', async () => {
    const src = sourceRepo(), clone = uniq('clone');
    await G.initClone(src, 'refs/remotes/origin/main', clone, BR);
    sh(clone, 'branch', 'sneaky'); commitIn(clone); sh(clone, 'tag', 'v1');
    const base = sh(src, 'rev-parse', 'refs/remotes/origin/main');
    const f = uniq('b') + '.bundle'; writeFileSync(f, (await bundleOf(clone, base))!);
    await G.importBundle(src, f, BR, 'refs/devflow/r/a');
    expect(sh(src, 'for-each-ref', '--format=%(refname)')).not.toMatch(/sneaky|v1/);
  });
  it('refuses to bundle for a branch or exclusion that is not a run branch / full SHA', async () => {
    const src = sourceRepo(), clone = uniq('clone');
    await G.initClone(src, 'refs/remotes/origin/main', clone, BR);
    for (const [b, x] of [['main', 'a'.repeat(40)], [BR, 'main'], [BR, '--all'], ['devflow/x; touch y', 'a'.repeat(40)]] as const) expect(await makeBundle({ claude: cfg.claude }, clone, fakeHome(), {}, b, x)).toBeUndefined();
  });
});

describe('git push surface: feature branches only', () => {
  it('refuses any destination that is not a devflow run branch, and any source that is not a private run ref', async () => {
    const src = sourceRepo();
    for (const branch of ['main', 'master', 'release/1', 'devflow/x', 'devflow/atl-1', 'HEAD', 'refs/heads/main', 'devflow/atl-1-abcdef1 --force'])
      expect(() => G.pushRef(src, 'refs/devflow/abc123/attempt-0', branch), branch).toThrow(/not a DevFlow run branch/);
    for (const ref of ['refs/heads/main', 'HEAD', 'refs/devflow/abc/attempt-0 --delete', '+refs/devflow/abc/attempt-0'])
      expect(() => G.pushRef(src, ref, 'devflow/atl-1-abcdef1'), ref).toThrow(/private refs\/devflow/);
  });
  it('a real push goes only to the run branch and never touches main', async () => {
    const src = sourceRepo(), bare = uniq('bare.git');
    mkdirSync(bare); sh(bare, 'init', '-q', '--bare', '-b', 'main'); sh(src, 'remote', 'add', 'origin', bare); sh(src, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const main = sh(bare, 'rev-parse', 'refs/heads/main');
    writeFileSync(join(src, 'n.txt'), 'n'); sh(src, 'add', '-A'); sh(src, 'commit', '-q', '-m', 'work'); sh(src, 'update-ref', 'refs/devflow/abc123/attempt-0', 'HEAD');
    await G.pushRef(src, 'refs/devflow/abc123/attempt-0', 'devflow/atl-1-abcdef1');
    expect(sh(bare, 'rev-parse', 'refs/heads/main')).toBe(main);
    expect(sh(bare, 'rev-parse', 'refs/heads/devflow/atl-1-abcdef1')).toBe(sh(src, 'rev-parse', 'HEAD'));
    expect(sh(bare, 'for-each-ref', '--format=%(refname)').split('\n').sort()).toEqual(['refs/heads/devflow/atl-1-abcdef1', 'refs/heads/main']);
  });
});

describe('GitHub write surface: draft PR only', () => {
  const READ = (rows: unknown) => ({ get: async () => rows }) as never;
  const reply = (status: number, body: unknown) => { const calls: { url: string; init: RequestInit }[] = []; const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch; return { f, calls }; };
  it('creates exactly one POST, with draft:true, using the WRITE token', async () => {
    const { f, calls } = reply(201, { number: 9, html_url: 'https://github.com/o/r/pull/9', draft: true });
    const pr = await new GithubPrs(READ([]), 'write-token', f).ensureDraft('o/r', { branch: 'devflow/atl-1-abcdef1', base: 'main', title: 'T', body: 'B' });
    expect(pr).toEqual({ number: 9, url: 'https://github.com/o/r/pull/9' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.github.com/repos/o/r/pulls');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ draft: true, head: 'devflow/atl-1-abcdef1', base: 'main', maintainer_can_modify: false });
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer write-token');
  });
  it('reuses an existing open PR instead of creating a second one', async () => {
    const { f, calls } = reply(201, {});
    const pr = await new GithubPrs(READ([{ number: 3, html_url: 'https://github.com/o/r/pull/3', state: 'open', draft: true, head: { sha: 'a'.repeat(40), ref: 'devflow/atl-1-abcdef1', repo: { full_name: 'o/r' } }, base: { ref: 'main' } }]), 't', f).ensureDraft('o/r', { branch: 'devflow/atl-1-abcdef1', base: 'main', title: 'T', body: 'B' });
    expect(pr.number).toBe(3); expect(calls).toHaveLength(0);
  });
  it('refuses to continue if GitHub hands back a non-draft PR, rejects a bad write token, and rejects hostile repo/branch names', async () => {
    await expect(new GithubPrs(READ([]), 't', reply(201, { number: 1, html_url: 'https://github.com/o/r/pull/1', draft: false }).f).ensureDraft('o/r', { branch: 'devflow/atl-1-abcdef1', base: 'main', title: 'T', body: 'B' })).rejects.toThrow(/non-draft/);
    await expect(new GithubPrs(READ([]), 't', reply(403, {}).f).ensureDraft('o/r', { branch: 'devflow/atl-1-abcdef1', base: 'main', title: 'T', body: 'B' })).rejects.toBeInstanceOf(SourceError);
    const { f, calls } = reply(201, {});
    await expect(new GithubPrs(READ([]), 't', f).ensureDraft('o/r/../../x', { branch: 'devflow/atl-1-abcdef1', base: 'main', title: 'T', body: 'B' })).rejects.toThrow(/invalid/);
    await expect(new GithubPrs(READ([]), 't', f).ensureDraft('o/r', { branch: 'devflow/atl-1-abcdef1; rm -rf', base: 'main', title: 'T', body: 'B' })).rejects.toThrow(/invalid/);
    expect(calls).toHaveLength(0);
  });
  it('feature-branch-only: a PR can only come from a devflow/<ticket>-<run> branch, and never target one', async () => {
    const { f, calls } = reply(201, { number: 1, html_url: 'https://github.com/o/r/pull/1', draft: true });
    const prs = new GithubPrs(READ([]), 't', f);
    for (const branch of ['main', 'release/1.0', 'devflow/x', 'feature/atl-1-abcdef1', 'devflow/../main']) await expect(prs.ensureDraft('o/r', { branch, base: 'main', title: 'T', body: 'B' }), branch).rejects.toThrow(/invalid/);
    await expect(prs.ensureDraft('o/r', { branch: 'devflow/atl-1-abcdef1', base: 'devflow/atl-2-abcdef1', title: 'T', body: 'B' })).rejects.toThrow(/invalid/);
    expect(calls).toHaveLength(0);
  });
  it('exposes no way to mark ready, merge, close, comment or edit', () => {
    expect(Object.getOwnPropertyNames(GithubPrs.prototype).sort()).toEqual(['baseProtected', 'constructor', 'ensureDraft', 'inspect', 'shape']);
  });
});
