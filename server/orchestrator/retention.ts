// Evidence retention and safe pruning for the runs directory. Policy, in order of precedence:
//   1. Never touch an active run, a run with a lock, a run younger than `minAgeDays`, or anything that is not a well-formed DevFlow run
//      directory (real directory directly under runsDir, name ATL-12-<runId>, parseable manifest with a terminal state).
//   2. Failures are preserved longer than successes: escalated/aborted runs keep their evidence `failureDays` (default 90), passed runs `passDays` (30).
//   3. The heavy, reproducible part of a run (the agent's clone, kept after a failure for inspection) is dropped earlier (`cloneDays`, 7; this
//      is not bound by minAgeDays because no evidence is lost) while all evidence (manifest, events, prompts, outputs, CI, reviews, patches, bundles) stays.
//   4. Over the storage limit, only the non-evidence part is dropped early (clones, oldest first). WHOLE runs are never removed before their own retention
//      period, whatever the storage pressure: if that is not enough the report says so. It never deletes evidence to hit a number.
//   Every action runs under the same per-ticket lock the controller uses, re-reading the manifest and directory identity under that lock.
//   5. Everything deleted is recorded in an append-only index (pruned.jsonl) first, and the private git refs of a pruned run are removed too.
// Dry run is the default. `verify()` is the cleanup checkpoint: it re-reads the directory and proves what was kept, removed and left behind.
import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import * as G from './git.ts';
import { RunStore } from './manifest.ts';
import { TERMINAL, type Manifest } from './types.ts';

export interface RetentionPolicy { passDays: number; failureDays: number; cloneDays: number; minAgeDays: number; maxTotalMB: number }
export const DEFAULT_RETENTION: RetentionPolicy = { passDays: 30, failureDays: 90, cloneDays: 7, minAgeDays: 14, maxTotalMB: 2048 };

const RUN_DIR_RE = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}-[a-z0-9]{6,24}$/;
const DAY = 86_400_000;

export interface RunInfo { dev: number; ino: number; born: number; dir: string; name: string; manifest: Manifest; bytes: number; ageDays: number; cloneBytes: number; passed: boolean; locked: boolean }
export interface PruneAction { kind: 'delete-run' | 'drop-clone'; name: string; reason: string; bytes: number }
export interface ScanResult { runs: RunInfo[]; ignored: { name: string; why: string }[]; totalBytes: number; locks: string[] }

/** Bytes used by a tree, counting links as links (never following them). */
export function treeBytes(p: string): number {
  let st; try { st = lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0; for (const e of readdirSync(p)) n += treeBytes(join(p, e));
  return n;
}

export function scan(runsDir: string, now = Date.now()): ScanResult {
  const root = resolve(runsDir);
  const runs: RunInfo[] = [], ignored: ScanResult['ignored'] = [];
  const lockDir = join(root, 'locks');
  const locks = existsSync(lockDir) ? readdirSync(lockDir).filter((f) => f.endsWith('.lock')).map((f) => f.slice(0, -5)) : [];
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    if (name === 'locks' || name === 'pruned.jsonl') continue;
    const dir = join(root, name);
    let st; try { st = lstatSync(dir); } catch { continue; }
    if (st.isSymbolicLink() || !st.isDirectory()) { ignored.push({ name, why: 'not a real directory' }); continue; }
    if (!RUN_DIR_RE.test(name)) { ignored.push({ name, why: 'not a DevFlow run directory name' }); continue; }
    let manifest: Manifest;
    try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest; } catch { ignored.push({ name, why: 'manifest missing or unreadable (kept)' }); continue; }
    if (`${manifest.ticket}-${manifest.runId}` !== name) { ignored.push({ name, why: 'manifest does not match its directory name (kept)' }); continue; }
    const updated = Date.parse(manifest.updatedAt);
    if (!Number.isFinite(updated)) { ignored.push({ name, why: 'manifest has no valid timestamp (kept)' }); continue; }
    runs.push({
      dev: st.dev, ino: st.ino, born: st.birthtimeMs, dir, name, manifest, bytes: treeBytes(dir), ageDays: (now - updated) / DAY, passed: manifest.outcome === 'PASS',
      cloneBytes: existsSync(join(dir, 'clone')) ? treeBytes(join(dir, 'clone')) : 0, locked: locks.includes(manifest.ticket),
    });
  }
  return { runs, ignored, locks, totalBytes: runs.reduce((s, r) => s + r.bytes, 0) };
}

/** What WOULD be done. Pure: no filesystem writes. */
export function plan(s: ScanResult, pol: RetentionPolicy = DEFAULT_RETENTION): { actions: PruneAction[]; warnings: string[] } {
  const actions: PruneAction[] = [], warnings: string[] = [];
  const doomed = new Set<string>();
  const del = (r: RunInfo, reason: string) => { if (!doomed.has(r.name)) { doomed.add(r.name); actions.push({ kind: 'delete-run', name: r.name, reason, bytes: r.bytes }); } };
  for (const r of s.runs) {
    if (!TERMINAL.includes(r.manifest.state) || r.locked) continue; // rule 1
    if (r.passed && r.ageDays >= pol.passDays && r.ageDays >= pol.minAgeDays) del(r, `passed run older than ${pol.passDays} days`);
    else if (!r.passed && r.ageDays >= pol.failureDays && r.ageDays >= pol.minAgeDays) del(r, `failed/escalated run older than ${pol.failureDays} days`);
  }
  for (const r of s.runs) { // rule 3
    if (doomed.has(r.name) || !TERMINAL.includes(r.manifest.state) || r.locked || r.cloneBytes === 0) continue;
    if (r.ageDays >= pol.cloneDays) actions.push({ kind: 'drop-clone', name: r.name, reason: `clone kept after a ${r.passed ? 'pass' : 'failure'} for more than ${pol.cloneDays} days (evidence stays)`, bytes: r.cloneBytes });
  }
  // rule 4: storage pressure may only drop clones (no evidence in them); whole runs wait for their own retention period
  let total = s.totalBytes - actions.reduce((n, a) => n + a.bytes, 0);
  const limit = pol.maxTotalMB * 1024 * 1024;
  if (total > limit) {
    const slimmable = s.runs.filter((r) => !doomed.has(r.name) && TERMINAL.includes(r.manifest.state) && !r.locked && r.cloneBytes > 0 && !actions.some((a) => a.kind === 'drop-clone' && a.name === r.name)).sort((a, b) => b.ageDays - a.ageDays);
    for (const r of slimmable) { if (total <= limit) break; actions.push({ kind: 'drop-clone', name: r.name, reason: `storage limit ${pol.maxTotalMB} MB exceeded (clone only; evidence stays)`, bytes: r.cloneBytes }); total -= r.cloneBytes; }
    if (total > limit) warnings.push(`still ${Math.round((total - limit) / 1024 / 1024)} MB over the ${pol.maxTotalMB} MB limit: the rest is retained evidence that has not reached its retention period (passed ${pol.passDays} days, failed ${pol.failureDays} days). Raise maxTotalMB or shorten retention; nothing was deleted to meet the number`);
  }
  return { actions, warnings };
}

export interface PruneReport { dryRun: boolean; before: { runs: number; bytes: number }; actions: PruneAction[]; applied: string[]; warnings: string[]; after?: { runs: number; bytes: number } }

/** Applies the plan. `repoPath` (optional) lets it delete the private refs/devflow/<run>/* refs of pruned runs. */
export async function prune(runsDir: string, pol: RetentionPolicy = DEFAULT_RETENTION, o: { apply?: boolean; now?: number; repoPath?: string; beforeAction?: (name: string) => void; afterAction?: (name: string) => void } = {}): Promise<PruneReport> {
  const now = o.now ?? Date.now();
  const s = scan(runsDir, now);
  const { actions, warnings } = plan(s, pol);
  const report: PruneReport = { dryRun: !o.apply, before: { runs: s.runs.length, bytes: s.totalBytes }, actions, applied: [], warnings };
  for (const i of s.ignored) report.warnings.push(`ignored ${i.name}: ${i.why}`);
  if (!o.apply) return report;
  const root = realpathSync(runsDir);
  const store = new RunStore(root);
  for (const a of actions) {
    const r = s.runs.find((x) => x.name === a.name)!;
    o.beforeAction?.(a.name); // test seam for scan-to-delete races
    const owner = `prune-${process.pid}`;
    // The controller's own ticket lock: a run that starts after the scan makes this action skip instead of racing it.
    try { store.acquire(r.manifest.ticket, owner); } catch { report.warnings.push(`skipped ${a.name}: ticket ${r.manifest.ticket} is locked (a run is active or interrupted)`); continue; }
    try {
      // Re-decide under the lock from what is on disk NOW, not from the scan.
      let st; try { st = lstatSync(r.dir); } catch { report.warnings.push(`skipped ${a.name}: already gone`); continue; }
      if (st.isSymbolicLink() || !st.isDirectory() || st.ino !== r.ino || st.dev !== r.dev || (r.born > 0 && st.birthtimeMs !== r.born)) { report.warnings.push(`skipped ${a.name}: directory identity changed since the scan`); continue; }
      let fresh: Manifest; try { fresh = JSON.parse(readFileSync(join(r.dir, 'manifest.json'), 'utf8')) as Manifest; } catch { report.warnings.push(`skipped ${a.name}: manifest unreadable now`); continue; }
      const age = (now - Date.parse(fresh.updatedAt)) / DAY;
      const need = a.kind === 'drop-clone' ? pol.cloneDays : (fresh.outcome === 'PASS' ? pol.passDays : pol.failureDays);
      const storagePressure = a.kind === 'drop-clone' && a.reason.startsWith('storage limit');
      if (!TERMINAL.includes(fresh.state) || (!storagePressure && age < need) || (a.kind === 'delete-run' && age < pol.minAgeDays)) { report.warnings.push(`skipped ${a.name}: no longer eligible under the lock`); continue; }
      const target = a.kind === 'delete-run' ? r.dir : join(r.dir, 'clone');
      const real = existsSync(target) ? realpathSync(target) : undefined;
      if (!real || !real.startsWith(root + sep) || lstatSync(target).isSymbolicLink()) { report.warnings.push(`skipped ${a.name}: path did not verify`); continue; } // never delete outside runsDir or through a link
      // the index entry is written BEFORE the deletion, so a crash leaves a record rather than a silent gap
      appendFileSync(join(root, 'pruned.jsonl'), `${JSON.stringify({ at: new Date(now).toISOString(), action: a.kind, run: a.name, ticket: fresh.ticket, outcome: fresh.outcome, approvedSha: fresh.approvedSha, branch: fresh.branch, bytes: a.bytes, reason: a.reason })}\n`, { mode: 0o600 });
      G.makeWritable(real);
      rmSync(real, { recursive: true, force: true });
      if (a.kind === 'delete-run' && o.repoPath) {
        for (const ref of (await G.git(o.repoPath, ['for-each-ref', '--format=%(refname)', `refs/devflow/${fresh.runId}/`]).catch(() => '')).split('\n').filter(Boolean)) await G.deleteRef(o.repoPath, ref);
      }
      report.applied.push(`${a.kind} ${a.name}`);
    } finally { store.release(r.manifest.ticket, owner); }
    o.afterAction?.(a.name);
  }
  const after = scan(runsDir, now);
  report.after = { runs: after.runs.length, bytes: after.totalBytes };
  return report;
}

export interface Checkpoint { ok: boolean; problems: string[]; facts: string[] }

/** The cleanup verification checkpoint: proves the directory is consistent after (or without) a prune. */
export function verify(runsDir: string, repoPath?: string, now = Date.now()): Checkpoint {
  const s = scan(runsDir, now);
  const problems: string[] = [], facts: string[] = [];
  if (!existsSync(runsDir)) return { ok: false, problems: ['runs directory does not exist'], facts };
  for (const i of s.ignored) if (RUN_DIR_RE.test(i.name)) problems.push(`${i.name}: ${i.why}`); // a run-shaped directory we cannot account for is a finding, never silently fine
  facts.push(`${s.runs.length} runs, ${(s.totalBytes / 1024 / 1024).toFixed(1)} MB, ${s.ignored.length} ignored entries`);
  for (const r of s.runs) {
    if (!TERMINAL.includes(r.manifest.state)) { if (!r.locked) problems.push(`${r.name}: non-terminal state "${r.manifest.state}" but no lock (interrupted run: inspect, then orchestrate release ${r.manifest.ticket})`); }
    if (TERMINAL.includes(r.manifest.state) && r.locked) problems.push(`${r.name}: terminal run still holds the ${r.manifest.ticket} lock`);
    for (const f of ['manifest.json', 'events.jsonl']) if (!existsSync(join(r.dir, f))) problems.push(`${r.name}: missing ${f}`);
    if (r.passed && existsSync(join(r.dir, 'clone'))) problems.push(`${r.name}: passed run still has its clone`);
  }
  for (const l of s.locks) if (!s.runs.some((r) => r.manifest.ticket === l && !TERMINAL.includes(r.manifest.state))) problems.push(`lock ${l}: no active run (stale; orchestrate release ${l})`);
  const idx = join(resolve(runsDir), 'pruned.jsonl');
  if (existsSync(idx)) for (const [i, line] of readFileSync(idx, 'utf8').split('\n').filter(Boolean).entries()) { try { JSON.parse(line); } catch { problems.push(`pruned.jsonl line ${i + 1} is not valid JSON`); } }
  if (repoPath && !existsSync(repoPath)) problems.push('repoPath does not exist');
  return { ok: problems.length === 0, problems, facts };
}
