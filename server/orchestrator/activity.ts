import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { open, readdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunActivityEvent, RunActivityFeedEntry, RunActivitySnapshot } from '../../shared/types.ts';
import { RunStore } from './manifest.ts';
import { TERMINAL, type Manifest } from './types.ts';

const MAX_LOG_BYTES = 64 * 1024;
const MAX_EVENTS = 50;
const ID = /^[a-z0-9]{6,24}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA = /^[a-f0-9]{40}$/;
const PHASES = new Set(['accepted', 'implementing', 'verifying-commit', 'ci', 'reviewing', 'publishing', 'repairing', 'awaiting-owner', 'escalated', 'aborted']);
const EMPTY: RunActivitySnapshot = { runId: null, state: null, activeAgent: null, events: [] };

type Details = Pick<RunActivityEvent, 'actor' | 'title' | 'detail'>;

function describe(row: Record<string, unknown>, run: Manifest): Details | undefined {
  const attempt = typeof row.attempt === 'number' && Number.isInteger(row.attempt) && row.attempt >= 0 && row.attempt <= 3
    ? run.attempts?.find((item) => item.n === row.attempt) : undefined;
  const commit = typeof row.sha === 'string' ? row.sha : attempt?.headSha;
  const sha = typeof commit === 'string' && SHA.test(commit) ? commit.slice(0, 12) : undefined;
  const revision = [attempt && (attempt.n === 0 ? 'Initial attempt' : `Repair ${attempt.n}`), sha].filter(Boolean).join(' · ') || undefined;
  switch (row.what) {
    case 'start-confirmed': return { actor: 'devflow', title: 'Run started' };
    case 'state:implementing': return { actor: 'claude', title: 'Preparing Claude implementation', detail: revision };
    case 'state:verifying-commit': return { actor: 'claude', title: 'Claude returned its changes', detail: revision };
    case 'pr-created': return { actor: 'devflow', title: 'Draft pull request opened', detail: typeof row.number === 'number' && Number.isSafeInteger(row.number) && row.number > 0 ? `PR #${row.number}` : undefined };
    case 'state:ci': return { actor: 'ci', title: 'Commit submitted to CI', detail: revision };
    case 'ci-result':
      if (row.state === 'success') return { actor: 'ci', title: 'CI passed', detail: revision };
      if (row.state === 'failure') return { actor: 'ci', title: 'CI failed', detail: revision };
      if (row.state === 'timeout') return { actor: 'ci', title: 'CI timed out', detail: revision };
      return;
    case 'state:reviewing': return { actor: 'codex', title: 'Preparing Codex review', detail: revision };
    case 'review-validated':
      if (row.verdict === 'PASS') return { actor: 'codex', title: 'Codex passed the review', detail: revision };
      if (row.verdict === 'FAIL') {
        const count = attempt?.review?.findings;
        return { actor: 'codex', title: 'Codex sent findings to DevFlow', detail: [typeof count === 'number' && Number.isInteger(count) && count > 0 && count <= 100 ? `${count} finding${count === 1 ? '' : 's'}` : undefined, revision].filter(Boolean).join(' · ') || undefined };
      }
      return;
    case 'state:repairing': return { actor: 'claude', title: 'Preparing Claude repair', detail: revision };
    case 'state:awaiting-owner': return { actor: 'devflow', title: 'Awaiting owner approval', detail: sha };
    case 'state:escalated': return { actor: 'devflow', title: 'Run escalated to the owner' };
    default: return;
  }
}

/** Read only complete, bounded controller events. No diagnostics or agent-authored text are sent to the browser. */
function readEvents(path: string, run: Manifest): RunActivityEvent[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = fstatSync(fd);
    if (!file.isFile()) return [];
    const start = Math.max(0, file.size - MAX_LOG_BYTES);
    const bytes = Buffer.allocUnsafe(file.size - start);
    const size = readSync(fd, bytes, 0, bytes.length, start);
    const events: RunActivityEvent[] = [];
    let offset = start ? bytes.subarray(0, size).indexOf(10) + 1 : 0;
    if (start && !offset) return [];
    while (offset < size) {
      const end = bytes.subarray(offset, size).indexOf(10);
      if (end < 0) break;
      const id = String(start + offset);
      const text = bytes.toString('utf8', offset, offset + end);
      offset += end + 1;
      try {
        const row = JSON.parse(text);
        if (!row || typeof row.at !== 'string' || !TIME.test(row.at)) continue;
        const event = describe(row, run);
        if (event) events.push({ id, at: row.at, ...event });
      } catch { /* Ignore a corrupt record and keep the rest of the timeline. */ }
    }
    return events.slice(-MAX_EVENTS);
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function activitySnapshot(runsDir: string, run: Manifest, eventLimit = MAX_EVENTS): RunActivitySnapshot {
  const activeAgent = run.state === 'reviewing' ? 'codex' : run.state === 'implementing' || run.state === 'repairing' ? 'claude' : null;
  const events = readEvents(join(runsDir, `${run.ticket}-${run.runId}`, 'events.jsonl'), run);
  return { runId: run.runId, state: run.state, activeAgent, events: events.slice(-eventLimit) };
}

export function runActivity(runsDir: string, issue: { identifier: string; id: string }, project: string, repo: string): RunActivitySnapshot {
  const store = new RunStore(runsDir);
  const run = store.runsFor(issue.identifier).find((item) => item.issueId === issue.id && item.ticket === issue.identifier &&
    item.project === project && item.repo === repo && ID.test(item.runId) && PHASES.has(item.state));
  return run ? activitySnapshot(runsDir, run) : EMPTY;
}

interface FeedScope { runsDir: string; project: string; repo: string; issues: ReadonlyMap<string, string> }

async function feedManifest(path: string): Promise<Manifest | undefined> {
  let fd: FileHandle | undefined;
  try {
    fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = await fd.stat();
    if (!file.isFile() || file.size > 1024 * 1024) return undefined;
    const bytes = Buffer.alloc(file.size);
    const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    return JSON.parse(bytes.toString('utf8', 0, bytesRead)) as Manifest;
  } catch { return undefined; }
  finally { await fd?.close(); }
}

export async function runActivityFeed(scopes: FeedScope[]): Promise<RunActivityFeedEntry[]> {
  const latest = new Map<string, { runsDir: string; run: Manifest }>();
  for (const scope of scopes) {
    let entries;
    try { entries = await readdir(scope.runsDir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const parts = /^([A-Z][A-Z0-9]{0,9}-\d{1,7})-([a-z0-9]{6,24})$/.exec(entry.name);
      if (!parts || !scope.issues.has(parts[1]!)) continue;
      const run = await feedManifest(join(scope.runsDir, entry.name, 'manifest.json'));
      if (!run || run.ticket !== parts[1] || run.runId !== parts[2] || run.issueId !== scope.issues.get(run.ticket)
        || run.project !== scope.project || run.repo !== scope.repo || !PHASES.has(run.state)
        || typeof run.createdAt !== 'string' || !TIME.test(run.createdAt)) continue;
      const previous = latest.get(run.ticket)?.run;
      if (!previous || run.createdAt > previous.createdAt || (run.createdAt === previous.createdAt && run.runId > previous.runId)) {
        latest.set(run.ticket, { runsDir: scope.runsDir, run });
      }
    }
  }
  return [...latest.values()].sort((a, b) => Number(TERMINAL.includes(a.run.state)) - Number(TERMINAL.includes(b.run.state))
    || b.run.createdAt.localeCompare(a.run.createdAt) || b.run.runId.localeCompare(a.run.runId)).slice(0, 12)
    .map(({ runsDir, run }) => ({ identifier: run.ticket, ...activitySnapshot(runsDir, run, 4) }));
}
