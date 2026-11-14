import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { utimesSync as _u, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RETENTION, plan, prune, scan, verify, type RetentionPolicy } from '../server/orchestrator/retention.ts';
import { parseConfig } from '../server/config.ts';

const NOW = Date.parse('2026-11-13T00:00:00Z');
const DAY = 86_400_000;
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'devflow-ret-')); mkdirSync(join(root, 'locks')); });
afterEach(() => { try { execFileSync('chmod', ['-R', 'u+rwX', root]); } catch { /* */ } rmSync(root, { recursive: true, force: true }); });

let n = 0;
interface Opt { state?: string; outcome?: string; ageDays: number; kb?: number; cloneKb?: number; ticket?: string; locked?: boolean }
function run(o: Opt) {
  const ticket = o.ticket ?? `ATL-${++n}`, runId = `r${String(n).padStart(6, '0')}abc`, name = `${ticket}-${runId}`, dir = join(root, name);
  mkdirSync(dir); writeFileSync(join(dir, 'events.jsonl'), '{}\n'); writeFileSync(join(dir, 'blob.bin'), Buffer.alloc((o.kb ?? 1) * 1024));
  if (o.cloneKb) { mkdirSync(join(dir, 'clone')); writeFileSync(join(dir, 'clone', 'x.bin'), Buffer.alloc(o.cloneKb * 1024)); }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ticket, runId, state: o.state ?? (o.outcome === 'PASS' ? 'awaiting-owner' : 'escalated'), outcome: o.outcome ?? 'ESCALATED', updatedAt: new Date(NOW - o.ageDays * DAY).toISOString(), branch: `devflow/${ticket.toLowerCase()}-${runId}`, approvedSha: o.outcome === 'PASS' ? 'a'.repeat(40) : undefined }));
  if (o.locked) writeFileSync(join(root, 'locks', `${ticket}.lock`), '{}');
  return name;
}
const small: RetentionPolicy = { ...DEFAULT_RETENTION };

describe('retention policy', () => {
  it('dry run (the default) changes nothing and says what it would do', async () => {
    const old = run({ outcome: 'PASS', ageDays: 40 });
    const r = await prune(root, small, { now: NOW });
    expect(r.dryRun).toBe(true);
    expect(r.actions.map((a) => `${a.kind} ${a.name}`)).toEqual([`delete-run ${old}`]);
    expect(existsSync(join(root, old))).toBe(true);
    expect(existsSync(join(root, 'pruned.jsonl'))).toBe(false);
  });

  it('failures are kept longer than successes; both only after their period', async () => {
    const passOld = run({ outcome: 'PASS', ageDays: 31 }), passNew = run({ outcome: 'PASS', ageDays: 29 });
    const failMid = run({ ageDays: 60 }), failOld = run({ ageDays: 91 });
    const r = await prune(root, small, { apply: true, now: NOW });
    expect(r.applied.sort()).toEqual([`delete-run ${failOld}`, `delete-run ${passOld}`].sort());
    expect(existsSync(join(root, passNew))).toBe(true);
    expect(existsSync(join(root, failMid))).toBe(true); // a 60-day-old FAILURE survives although a 31-day-old pass did not
    expect(existsSync(join(root, passOld))).toBe(false);
  });

  it('never touches an active run, a locked ticket, or a run younger than minAgeDays, however old the policy says', async () => {
    const active = run({ state: 'implementing', outcome: undefined, ageDays: 400 });
    const locked = run({ outcome: 'PASS', ageDays: 400, locked: true, ticket: 'ATL-900' });
    const young = run({ outcome: 'PASS', ageDays: 10 });
    const aggressive: RetentionPolicy = { passDays: 1, failureDays: 1, cloneDays: 1, minAgeDays: 14, maxTotalMB: 100 };
    const r = await prune(root, aggressive, { apply: true, now: NOW });
    expect(r.applied).toEqual([]);
    for (const x of [active, locked, young]) expect(existsSync(join(root, x))).toBe(true);
  });

  it('drops only the clone of an old failed run: all evidence stays', async () => {
    const f = run({ ageDays: 8, kb: 5, cloneKb: 300 });
    const r = await prune(root, small, { apply: true, now: NOW });
    expect(r.applied).toEqual([`drop-clone ${f}`]);
    expect(existsSync(join(root, f, 'clone'))).toBe(false);
    for (const keep of ['manifest.json', 'events.jsonl', 'blob.bin']) expect(existsSync(join(root, f, keep))).toBe(true);
    expect(r.after!.bytes).toBeLessThan(r.before.bytes);
  });

  it('under storage pressure only clones are dropped early (oldest first); whole runs are NEVER removed before their retention period, and the report says so', async () => {
    const pol: RetentionPolicy = { passDays: 3650, failureDays: 3650, cloneDays: 3650, minAgeDays: 14, maxTotalMB: 100 };
    const mb = 1024; // kb
    const a = run({ outcome: 'PASS', ageDays: 50, kb: 1, cloneKb: 60 * mb }), b = run({ ageDays: 20, kb: 1, cloneKb: 60 * mb }), c = run({ outcome: 'PASS', ageDays: 3, kb: 1, cloneKb: 60 * mb });
    const p = plan(scan(root, NOW), pol);
    expect(p.actions.map((x) => `${x.kind} ${x.name}`)).toEqual([`drop-clone ${a}`, `drop-clone ${b}`]); // 180 MB -> 60 MB, oldest first, stops when under the limit
    expect(p.warnings).toEqual([]);
    expect(c).toBeDefined();
    // evidence-only pressure: a 15-day-old escalated run of 150 MB must NOT be deleted although the limit is exceeded
    run({ ageDays: 15, kb: 150 * mb });
    const q = plan(scan(root, NOW), { ...pol, maxTotalMB: 100, failureDays: 90 });
    expect(q.actions.every((x) => x.kind === 'drop-clone')).toBe(true);
    expect(q.warnings.join(' ')).toMatch(/over the 100 MB limit.*nothing was deleted to meet the number/);
  });

  it('re-decides under the ticket lock: a run that starts, changes state, or swaps its directory between the scan and the delete is skipped', async () => {
    const mk = () => { const name = run({ outcome: 'PASS', ageDays: 45 }); return { name, ticket: name.split('-').slice(0, 2).join('-') }; };
    // 1. another controller takes the ticket lock after the scan
    let x = mk();
    let r = await prune(root, small, { apply: true, now: NOW, beforeAction: (n) => { if (n === x.name) writeFileSync(join(root, 'locks', `${x.ticket}.lock`), '{}'); } });
    expect(r.applied).toEqual([]); expect(r.warnings.join('\n')).toMatch(/is locked/); expect(existsSync(join(root, x.name))).toBe(true);
    rmSync(join(root, 'locks', `${x.ticket}.lock`)); rmSync(join(root, x.name), { recursive: true });
    // 2. the run's manifest flips to an active state
    x = mk();
    r = await prune(root, small, { apply: true, now: NOW, beforeAction: (n) => { if (n === x.name) { const f = join(root, x.name, 'manifest.json'); writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), state: 'implementing' })); } } });
    expect(r.applied).toEqual([]); expect(r.warnings.join('\n')).toMatch(/no longer eligible/); expect(existsSync(join(root, x.name))).toBe(true);
    rmSync(join(root, x.name), { recursive: true });
    // 3. the directory is replaced (new inode) by something else of the same name
    x = mk();
    const victim = mkdtempSync(join(tmpdir(), 'devflow-victim-')); writeFileSync(join(victim, 'precious'), 'x');
    r = await prune(root, small, { apply: true, now: NOW, beforeAction: (n) => { if (n === x.name) { const m = readFileSync(join(root, x.name, 'manifest.json'), 'utf8'); renameSync(join(root, x.name), join(root, `${x.name}.moved`)); mkdirSync(join(root, x.name)); writeFileSync(join(root, x.name, 'manifest.json'), m); } } });
    expect(r.applied).toEqual([]); expect(r.warnings.join('\n')).toMatch(/identity changed/); expect(existsSync(join(victim, 'precious'))).toBe(true);
    rmSync(victim, { recursive: true, force: true });
  });

  it('the lock it takes is released afterwards, and a normal prune leaves no lock behind', async () => {
    run({ outcome: 'PASS', ageDays: 45 });
    await prune(root, small, { apply: true, now: NOW });
    expect(readdirSync(join(root, 'locks'))).toEqual([]);
  });

  it('writes an append-only index entry BEFORE deleting, and removes the pruned run’s private git refs', async () => {
    const repo = join(root, 'repo-x'); mkdirSync(repo);
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });
    g('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'a'), 'a'); g('add', '-A'); g('commit', '-q', '-m', 'i');
    const name = run({ outcome: 'PASS', ageDays: 45 }); const runId = name.split('-').slice(2).join('-');
    g('update-ref', `refs/devflow/${runId}/attempt-0`, 'HEAD'); g('update-ref', 'refs/devflow/keep/attempt-0', 'HEAD');
    const runsDir = join(root);
    await prune(runsDir, small, { apply: true, now: NOW, repoPath: repo });
    const idx = readFileSync(join(root, 'pruned.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(idx).toHaveLength(1);
    expect(idx[0]).toMatchObject({ action: 'delete-run', run: name, outcome: 'PASS', approvedSha: 'a'.repeat(40) });
    expect(g('for-each-ref', '--format=%(refname)', 'refs/devflow/').trim()).toBe('refs/devflow/keep/attempt-0');
  });

  it('ignores and keeps anything that is not a well-formed run directory (symlinks, odd names, bad or mismatched manifests)', async () => {
    const victim = mkdtempSync(join(tmpdir(), 'devflow-victim-')); writeFileSync(join(victim, 'precious'), 'x');
    symlinkSync(victim, join(root, 'ATL-1-linkedrun1')); // a symlink that LOOKS like a run dir
    mkdirSync(join(root, 'notes')); writeFileSync(join(root, 'notes', 'manifest.json'), '{}');
    mkdirSync(join(root, 'ATL-2-badmanifest')); writeFileSync(join(root, 'ATL-2-badmanifest', 'manifest.json'), 'not json');
    mkdirSync(join(root, 'ATL-3-mismatchxx')); writeFileSync(join(root, 'ATL-3-mismatchxx', 'manifest.json'), JSON.stringify({ ticket: 'ATL-9', runId: 'other', state: 'escalated', updatedAt: new Date(NOW - 999 * DAY).toISOString() }));
    const r = await prune(root, { passDays: 1, failureDays: 1, cloneDays: 1, minAgeDays: 1, maxTotalMB: 100 }, { apply: true, now: NOW });
    try {
      expect(r.applied).toEqual([]);
      expect(existsSync(join(victim, 'precious'))).toBe(true);
      expect(['ATL-2-badmanifest', 'ATL-3-mismatchxx', 'notes']).toSatisfy((names: string[]) => names.every((x) => existsSync(join(root, x))));
      expect(r.warnings.join('\n')).toMatch(/not a real directory/);
      expect(r.warnings.join('\n')).toMatch(/unreadable|does not match/);
    } finally { rmSync(victim, { recursive: true, force: true }); }
  });

  it('refuses to delete through a symlink swapped in for a run directory after the scan', async () => {
    const name = run({ outcome: 'PASS', ageDays: 45 });
    const victim = mkdtempSync(join(tmpdir(), 'devflow-victim-')); writeFileSync(join(victim, 'precious'), 'x');
    const s = scan(root, NOW); const { actions } = plan(s, small);
    expect(actions).toHaveLength(1);
    rmSync(join(root, name), { recursive: true }); symlinkSync(victim, join(root, name)); // swap
    // prune() re-scans, so the swapped entry is now ignored rather than followed
    const r = await prune(root, small, { apply: true, now: NOW });
    expect(r.applied).toEqual([]);
    expect(existsSync(join(victim, 'precious'))).toBe(true);
    rmSync(victim, { recursive: true, force: true });
  });

  it('deletes read-only evidence trees (review snapshots are chmod a-w) without leaving anything behind', async () => {
    const name = run({ outcome: 'PASS', ageDays: 45 });
    mkdirSync(join(root, name, 'attempt-0', 'review', 'context'), { recursive: true }); writeFileSync(join(root, name, 'attempt-0', 'review', 'context', 'files.txt'), 'x');
    execFileSync('chmod', ['-R', 'a-w', join(root, name, 'attempt-0')]);
    await prune(root, small, { apply: true, now: NOW });
    expect(existsSync(join(root, name))).toBe(false);
  });
});

describe('cleanup verification checkpoint', () => {
  it('is OK for a tidy directory and reports every kind of inconsistency', async () => {
    const ok = run({ outcome: 'PASS', ageDays: 2 }); void ok;
    expect(verify(root, undefined, NOW)).toMatchObject({ ok: true, problems: [] });
    run({ state: 'verifying-commit', outcome: undefined, ageDays: 2 });                       // interrupted, no lock
    run({ outcome: 'PASS', ageDays: 2, locked: true, ticket: 'ATL-700' });                    // terminal but still locked
    writeFileSync(join(root, 'locks', 'ATL-701.lock'), '{}');                                 // stale lock without a run
    const c1 = run({ outcome: 'PASS', ageDays: 2 }); mkdirSync(join(root, c1, 'clone'));       // passed run that kept its clone
    const c2 = run({ ageDays: 2 }); rmSync(join(root, c2, 'events.jsonl'));                    // evidence missing
    writeFileSync(join(root, 'pruned.jsonl'), '{"ok":1}\nbroken\n');
    const c = verify(root, undefined, NOW);
    expect(c.ok).toBe(false);
    const text = c.problems.join('\n');
    for (const re of [/non-terminal state "verifying-commit" but no lock/, /terminal run still holds the ATL-700 lock/, /lock ATL-701: no active run/, /passed run still has its clone/, /missing events\.jsonl/, /pruned\.jsonl line 2/]) expect(text).toMatch(re);
  });
  it('a missing runs directory, or a run-shaped directory with a missing/corrupt/mismatched manifest, is a checkpoint FAILURE (and is still preserved)', () => {
    expect(verify(join(root, 'nope'), undefined, NOW)).toMatchObject({ ok: false });
    mkdirSync(join(root, 'ATL-5-nomanifest1')); mkdirSync(join(root, 'ATL-6-corrupt1xx')); writeFileSync(join(root, 'ATL-6-corrupt1xx', 'manifest.json'), '{nope');
    mkdirSync(join(root, 'notes')); // not run-shaped: fine
    const c = verify(root, undefined, NOW);
    expect(c.ok).toBe(false);
    expect(c.problems.join('\n')).toMatch(/ATL-5-nomanifest1: manifest missing or unreadable/);
    expect(c.problems.join('\n')).toMatch(/ATL-6-corrupt1xx/);
    expect(c.problems.join('\n')).not.toMatch(/notes/);
    expect(existsSync(join(root, 'ATL-5-nomanifest1'))).toBe(true);
  });
  it('after an applied prune the checkpoint holds and every remaining manifest still parses', async () => {
    run({ outcome: 'PASS', ageDays: 50 }); const keep = run({ ageDays: 30, cloneKb: 10 }); run({ ageDays: 120 });
    const r = await prune(root, small, { apply: true, now: NOW });
    expect(r.applied.length).toBeGreaterThanOrEqual(2);
    expect(verify(root, undefined, NOW).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(root, keep, 'manifest.json'), 'utf8')).ticket).toMatch(/^ATL-/);
    chmodSync(root, 0o700);
  });
});

describe('retention configuration', () => {
  const base = { id: 'p', name: 'P', linear: { teamKey: 'ABC', projects: [] }, github: { repos: ['o/r'] } };
  const o = { repo: 'o/r', repoPath: '/x/repo', runsDir: '/x/runs', claude: { bin: '/x/claude' }, codex: { bin: '/x/codex' } };
  it('defaults, bounds, and "failures are kept at least as long as successes"', () => {
    expect(parseConfig({ projects: [{ ...base, orchestration: o }] }).projects[0]!.orchestration!.retention).toEqual(DEFAULT_RETENTION);
    expect(parseConfig({ projects: [{ ...base, orchestration: { ...o, retention: { passDays: 7, failureDays: 30 } } }] }).projects[0]!.orchestration!.retention).toMatchObject({ passDays: 7, failureDays: 30, cloneDays: 7 });
    expect(() => parseConfig({ projects: [{ ...base, orchestration: { ...o, retention: { passDays: 0 } } }] })).toThrow(/passDays/);
    expect(() => parseConfig({ projects: [{ ...base, orchestration: { ...o, retention: { maxTotalMB: 5 } } }] })).toThrow(/maxTotalMB/);
    expect(() => parseConfig({ projects: [{ ...base, orchestration: { ...o, retention: { passDays: 60, failureDays: 30 } } }] })).toThrow(/failures are preserved at least as long/);
  });
});

describe('stale credential staging sweep', () => {
  const setup = async () => {
    const sb = await import('../server/orchestrator/sandbox.ts');
    const parent = mkdtempSync(join(tmpdir(), 'devflow-sweep-'));
    const mk = (name: string, ageMin: number, owner?: 'alive' | 'dead' | 'recycled') => {
      const d = join(parent, name); mkdirSync(d); writeFileSync(join(d, 'auth.json'), '{}');
      const t = (Date.now() - ageMin * 60_000) / 1000; _u(d, t, t);
      if (owner === 'alive') sb.claimOwner(d);
      if (owner === 'dead') writeFileSync(`${d}.owner`, JSON.stringify({ pid: 999_999, start: '1' }));
      if (owner === 'recycled') writeFileSync(`${d}.owner`, JSON.stringify({ pid: process.pid, start: 'not-my-start-time' })); // same PID, different process
      return d;
    };
    return { sb, parent, mk };
  };
  it('NEVER removes a directory whose owner process (same PID and start time) is alive, however old it is', async () => {
    const { sb, parent, mk } = await setup();
    const live = mk('devflow-codex-home-live11', 24 * 60, 'alive');
    try { expect(sb.sweepStaleStaging({ parent })).toEqual([]); expect(existsSync(live)).toBe(true); } finally { rmSync(parent, { recursive: true, force: true }); }
  });
  it('removes dead-owner dirs (after a short grace), PID-reuse look-alikes, and ownerless orphans only once they are older than any permitted run', async () => {
    const { sb, parent, mk } = await setup();
    const dead = mk('devflow-codex-home-dead11', 5, 'dead'), recycled = mk('devflow-pf-recyc1', 5, 'recycled'), freshDead = mk('devflow-bundle-fresh1', 0, 'dead');
    const orphanOld = mk('devflow-claude-home-orph11', 7 * 60), orphanMid = mk('devflow-claude-home-orph22', 3 * 60);
    try {
      const removed = sb.sweepStaleStaging({ parent });
      expect(removed.sort()).toEqual(['devflow-claude-home-orph11', 'devflow-codex-home-dead11', 'devflow-pf-recyc1']);
      for (const keep of [freshDead, orphanMid]) expect(existsSync(keep)).toBe(true); // too new to call abandoned
      for (const gone of [dead, recycled, orphanOld]) { expect(existsSync(gone)).toBe(false); expect(existsSync(`${gone}.owner`)).toBe(false); }
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
  it('only touches exactly-named staging dirs of this user, never follows links, never touches unrelated names', async () => {
    const { sb, parent, mk } = await setup();
    const other = mk('devflow-unrelated-xyz789', 900), odd = mk('devflow-codex-home-has space', 900);
    const victim = mkdtempSync(join(tmpdir(), 'devflow-victim-')); writeFileSync(join(victim, 'precious'), 'x');
    symlinkSync(victim, join(parent, 'devflow-bundle-link123'));
    try { expect(sb.sweepStaleStaging({ parent })).toEqual([]); for (const k of [other, odd]) expect(existsSync(k)).toBe(true); expect(existsSync(join(victim, 'precious'))).toBe(true); }
    finally { rmSync(parent, { recursive: true, force: true }); rmSync(victim, { recursive: true, force: true }); }
  });
  it('staging dirs created by the product carry an owner record outside the directory and lose it with the directory', async () => {
    const sb = await import('../server/orchestrator/sandbox.ts');
    const parent = mkdtempSync(join(tmpdir(), 'devflow-sweep-')); const home = mkdtempSync(join(tmpdir(), 'devflow-fakehome-'));
    try {
      mkdirSync(join(home, '.codex')); writeFileSync(join(home, '.codex', 'auth.json'), '{"x":1}');
      const st = sb.stageHome('codex', home, parent);
      expect(existsSync(`${st.dir}.owner`)).toBe(true);
      expect(readdirSync(st.dir)).not.toContain('.owner'); // never inside the mounted directory
      st.finish();
      expect(existsSync(st.dir)).toBe(false); expect(existsSync(`${st.dir}.owner`)).toBe(false);
    } finally { rmSync(parent, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });
});
