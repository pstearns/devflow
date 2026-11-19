// Durable run record + duplicate-dispatch lock. One directory per run: <runsDir>/<ISSUE>-<runId>/. The manifest is
// rewritten atomically (temp file + rename); events.jsonl is append-only. Evidence files are never deleted by cleanup.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { TERMINAL, type Manifest } from './types.ts';

export class DuplicateRun extends Error {}

export class RunStore {
  constructor(readonly runsDir: string) { mkdirSync(join(runsDir, 'locks'), { recursive: true, mode: 0o700 }); }

  runDir(m: Pick<Manifest, 'ticket' | 'runId'>) { return join(this.runsDir, `${m.ticket}-${m.runId}`); }
  private lockPath(ticket: string) { return join(this.runsDir, 'locks', `${ticket}.lock`); }

  /** Atomic create-exclusive. A leftover lock (even from a dead process) blocks: a human must `release` it after looking. */
  acquire(ticket: string, runId: string) {
    try {
      const fd = openSync(this.lockPath(ticket), 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ runId, pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let who = 'unknown run';
      try { const l = JSON.parse(readFileSync(this.lockPath(ticket), 'utf8')) as { runId?: string; pid?: number }; who = `run ${l.runId} (pid ${l.pid})`; } catch { /* unreadable lock still blocks */ }
      throw new DuplicateRun(`${ticket} is already being executed or was interrupted: ${who}. If it is dead, inspect the run and use: orchestrate release ${ticket}`);
    }
  }
  release(ticket: string, runId?: string) {
    const p = this.lockPath(ticket);
    try {
      if (runId) { const l = JSON.parse(readFileSync(p, 'utf8')) as { runId?: string }; if (l.runId !== runId) return; } // never drop someone else's lock
      unlinkSync(p);
    } catch { /* already gone */ }
  }

  /** Every run directory for a ticket, newest manifest first. */
  runsFor(ticket: string): Manifest[] {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir).filter((d) => d.startsWith(`${ticket}-`)).flatMap((d) => {
      try { return [JSON.parse(readFileSync(join(this.runsDir, d, 'manifest.json'), 'utf8')) as Manifest]; } catch { return []; }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  activeRun(ticket: string): Manifest | undefined { return this.runsFor(ticket).find((m) => !TERMINAL.includes(m.state)); }

  save(m: Manifest, now: string) {
    m.updatedAt = now;
    const dir = this.runDir(m);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `manifest.json.${process.pid}.tmp`);
    const fd = openSync(tmp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(m, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, join(dir, 'manifest.json'));
  }
  event(m: Pick<Manifest, 'ticket' | 'runId'>, at: string, what: string, data: Record<string, unknown> = {}) {
    appendFileSync(join(this.runDir(m), 'events.jsonl'), `${JSON.stringify({ at, what, ...data })}\n`, { mode: 0o600 });
  }
  /** Writes an evidence file under the run directory and returns its relative name + sha256 (recorded in the manifest). */
  evidence(m: Pick<Manifest, 'ticket' | 'runId'>, rel: string, content: string | Buffer): string {
    const p = join(this.runDir(m), rel);
    mkdirSync(join(p, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(p, content, { mode: 0o600 });
    return `${rel}#sha256=${createHash('sha256').update(content).digest('hex').slice(0, 16)}`;
  }
}
