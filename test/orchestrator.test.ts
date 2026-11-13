import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorld, DEMO_WRITE_KEY } from './orchestrator-harness.ts';
import { bwrapUsable } from '../server/orchestrator/sandbox.ts';
import { Rejected } from '../server/orchestrator/controller.ts';
import { DuplicateRun } from '../server/orchestrator/manifest.ts';
import { runProcess } from '../server/orchestrator/agents.ts';
import { ReviewInvalid, validateReview } from '../server/orchestrator/review.ts';
import { evaluateChecks } from '../server/orchestrator/ci.ts';
import { parseConfig } from '../server/config.ts';
import type { AgentRunner } from '../server/orchestrator/agents.ts';

const sandboxed = bwrapUsable();
const FAKE_CODEX = join(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const worlds: ReturnType<typeof makeWorld>[] = [];
const world = (...a: Parameters<typeof makeWorld>) => { const w = makeWorld(...a); worlds.push(w); return w; };
afterEach(() => { while (worlds.length) worlds.pop()!.dispose(); });
const PASS_POSTED = (w: ReturnType<typeof makeWorld>) => w.comments().some((b) => /Milestone 4\/6/.test(b) && b.includes('**PASS**'));
const stateOf = (w: ReturnType<typeof makeWorld>) => w.issue().state;
const runDir = (w: ReturnType<typeof makeWorld>, id: string) => join(w.runsDir, `${id}-${w.store().runsFor(id)[0]!.runId}`);

describe('M1 acceptance: defect -> findings -> repair -> verified -> owner approval', () => {
  it('Claude implements, Codex finds the planted defect, Claude repairs, CI + Codex verify the new SHA, Linear records it, run stops at approval', async () => {
    const w = world();
    const mainBefore = w.mainHead();
    const m = await w.orch.run('atl-22');

    expect(m.state).toBe('awaiting-owner');
    expect(m.outcome).toBe('PASS');
    expect(m.attempts).toHaveLength(2);
    const [first, second] = m.attempts;
    // attempt 0: CI is GREEN (the defect is not covered by the tests) yet the independent review catches it
    expect(first!.ci!.state).toBe('success');
    expect(first!.review!.verdict).toBe('FAIL');
    expect(first!.failure).toMatch(/Review FAIL/);
    // attempt 1 is a NEW sha on top of the old one, verified by CI and review
    expect(second!.headSha).not.toBe(first!.headSha);
    expect(second!.startSha).toBe(first!.headSha);
    expect(second!.ci!.state).toBe('success');
    expect(second!.review!.verdict).toBe('PASS');
    expect(m.approvedSha).toBe(second!.headSha);
    expect(w.remoteHead(m.branch)).toBe(m.approvedSha); // the approved commit is exactly what is on the remote
    expect(w.ci.calls).toEqual([first!.headSha, second!.headSha]); // CI asked about each exact SHA
    expect(w.calls).toEqual({ implement: 2, review: 2 });

    // Claude's second run was given the reviewer's findings
    const repairPrompt = readFileSync(join(runDir(w, 'ATL-22'), 'attempt-1', 'claude-prompt.txt'), 'utf8');
    expect(repairPrompt).toContain('trailing dash');
    expect(repairPrompt).toContain('Repair attempt 1 of 3');

    // Linear audit trail: six-milestone, same ticket, structured. 8 comments for a run with one repair.
    const c = w.comments();
    expect(c).toHaveLength(8);
    expect(c.every((b) => b.startsWith(`### DevFlow run \`${m.runId}\``))).toBe(true);
    expect(c[0]).toContain('Milestone 1/6 — Execution authorized and started');
    expect(c[0]).toContain('Authorized by: **Demo Owner**');
    expect(c[0]).toContain('Agents (all inside a bubblewrap sandbox');
    expect(c[0]).toContain(`policy digest \`${m.policyDigest.slice(0, 16)}\``);
    expect(c[1]).toContain('Milestone 2/6 — Implementation completed');
    expect(c[1]).toContain(first!.headSha!);
    expect(c[2]).toContain('Milestone 3/6 — CI verified');
    expect(c[2]).toContain('CI passed');
    expect(c[3]).toContain('Milestone 4/6 — Independent review completed');
    expect(c[3]).toContain('**FAIL**');
    expect(c[3]).toContain('slugify(\"Hello, World!\") returned'.replace(/\\/g, ''));
    expect(c[3]).toContain('Milestone 5/6 — Repair requested');
    expect(c[3]).toContain('> '); // agent prose is quoted, never presented as controller fact
    expect(c[4]).toContain('Milestone 2/6 — Repair 1 completed');
    expect(c[4]).toContain(second!.headSha!);
    expect(c[6]).toContain('**PASS**');
    expect(c[6]).toContain('✅ review is for this SHA');
    expect(c[6]).toContain('✅ trusted policy intact');
    expect(c[7]).toContain('Milestone 6/6 — Awaiting owner approval');
    expect(c[7]).toContain('Owner action required');
    expect(c[7]).toContain('| repair 1 |');
    expect(stateOf(w)).toBe('In Review');
    expect(w.f.store.mutations.map((x) => x.op)).toEqual(['IssueUpdate', ...Array(7).fill('CommentCreate'), 'IssueUpdate', 'CommentCreate']);
    // one DRAFT PR, created on the first push, verified against each pushed SHA, referenced from the Linear record
    expect(w.prs.created).toEqual([{ branch: m.branch, base: 'main', title: 'ATL-22: Add slugify helper', draft: true }]);
    expect(m.pr).toMatchObject({ number: 7, draft: true });
    expect(w.prs.headCalls).toBeGreaterThanOrEqual(4); // each push + each gate
    expect(c[1]).toContain('PR [#7](https://example.invalid/gh/demo-org/atlas/pull/7) (draft)');
    // the audit comments never carry host paths, env or credentials
    expect(c.join('\n')).not.toMatch(/\/tmp\/|\/home\/|devflow-m1-|TOKEN|API_KEY/);

    // never merged or touched the base branch; lock released; clean worktree safely removed
    expect(w.mainHead()).toBe(mainBefore);
    expect(existsSync(join(w.runsDir, 'locks', 'ATL-22.lock'))).toBe(false);
    expect(m.cleanup.clone).toBe('removed');
    expect(existsSync(m.clone)).toBe(false);
  });

  it('preserves evidence and a durable manifest on disk', async () => {
    const w = world();
    const m = await w.orch.run('ATL-22');
    const dir = runDir(w, 'ATL-22');
    const disk = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(disk.state).toBe('awaiting-owner');
    expect(disk.linearCommentIds).toEqual(m.linearCommentIds);
    for (const f of ['attempt-0/claude-output.txt', 'attempt-0/ci.json', 'attempt-0/codex-output.txt', 'attempt-0/review.json', 'attempt-1/review.json', 'events.jsonl', 'attempt-0/review/context/changes.patch']) expect(existsSync(join(dir, f)), f).toBe(true);
    expect(existsSync(join(dir, 'attempt-0', 'review', 'src'))).toBe(false); // reproducible snapshot cleaned; evidence kept
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).what);
    expect(events).toContain('state:reviewing');
    expect(events).toContain('state:awaiting-owner');
  });

  it('a correct first attempt needs no repair', async () => {
    const w = world({ scenario: 'correct-first' });
    const m = await w.orch.run('ATL-22');
    expect(m.outcome).toBe('PASS');
    expect(m.attempts).toHaveLength(1);
    expect(w.comments()).toHaveLength(5); // start, implemented, CI, review, final
  });

  it('red CI is repaired from the CI failure and never reaches the reviewer until green', async () => {
    const w = world({ scenario: 'red-ci' });
    const m = await w.orch.run('ATL-22');
    expect(m.attempts[0]!.ci!.state).toBe('failure');
    expect(m.attempts[0]!.review).toBeUndefined();
    expect(w.comments()[2]).toContain('CI failed');
    expect(w.comments()[2]).toContain('Milestone 5/6 — Repair requested');
    expect(readFileSync(join(runDir(w, 'ATL-22'), 'attempt-1', 'claude-prompt.txt'), 'utf8')).toContain('CI FAILED');
    expect(m.outcome).toBe('PASS');
    expect(w.calls.review).toBe(1);
  });
});

describe('three failed repairs escalate', () => {
  it('stops after the initial attempt plus exactly three repairs, escalates in Linear, never reaches owner approval', async () => {
    const w = world({ scenario: 'never-fixes' });
    const m = await w.orch.run('ATL-22');
    expect(m.state).toBe('escalated');
    expect(m.attempts).toHaveLength(4);
    expect(w.calls).toEqual({ implement: 4, review: 4 });
    const c = w.comments();
    expect(c.filter((b) => /Milestone 4\/6/.test(b) && b.includes('**FAIL**'))).toHaveLength(4);
    expect(c.at(-1)).toContain('Milestone 6/6 — Escalated to the owner');
    expect(c.at(-1)).toContain('repairs-exhausted');
    expect(c.at(-1)).toContain('Repair attempts used: 3/3');
    expect(c.at(-2)).toContain('No repair available');
    expect(stateOf(w)).toBe('Blocked'); // recorded in Linear, never handed over
    expect(m.blockedConfirmed).toBe(true);
    expect(m.reasonClass).toBe('repairs-exhausted');
    expect(m.approvedSha).toBeUndefined();
    expect(m.cleanup.clone).toBe('kept'); // evidence for the owner
    expect(existsSync(m.clone)).toBe(true);
    expect(existsSync(join(w.runsDir, 'locks', 'ATL-22.lock'))).toBe(false);
  });

  it('a Claude run that commits nothing on the first attempt escalates without spending a reviewer', async () => {
    const w = world({ scenario: 'no-commit' });
    const m = await w.orch.run('ATL-22');
    expect(m.state).toBe('escalated');
    expect(m.reason).toMatch(/no new commit|nothing acceptable/);
    expect(w.calls.review).toBe(0);
  });

  it('a CI timeout escalates (no verdict is not repairable) without invoking the reviewer', async () => {
    const w = world({ ci: 'timeout' });
    const m = await w.orch.run('ATL-22');
    expect(m.state).toBe('escalated');
    expect(m.reason).toMatch(/Timed out waiting for CI/);
    expect(w.calls).toEqual({ implement: 1, review: 0 });
  });
});

describe('fabricated, stale and tampered reviews are rejected', () => {
  const cases: [scenario: string, reason: RegExp][] = [
    ['fabricated-pass-bare', /rejected twice.*(missing field|unexpected)/],
    ['fabricated-pass-nonce', /rejected twice.*nonce/],
    ['fabricated-pass-partial', /rejected twice.*does not account for changed file/],
    ['wrong-commit', /rejected twice.*stale or wrong commit/],
    ['prose', /rejected twice.*not a single JSON object/],
  ];
  for (const [scenario, reason] of cases) {
    it(`${scenario}: no PASS is published and the ticket is not handed over`, async () => {
      const w = world({ scenario });
      const m = await w.orch.run('ATL-22');
      expect(m.state).toBe('escalated');
      expect(m.reason).toMatch(reason);
      expect(PASS_POSTED(w)).toBe(false);
      expect(stateOf(w)).toBe('Blocked');
    });
  }
  it('hash backstop: a reviewer that managed to modify its inputs (sandbox bypassed on purpose here) is discarded though it printed PASS', async () => {
    const w = world({ scenario: 'tamper', wrapAgents: (inner) => ({ ...inner, preflight: () => inner.preflight(), implement: inner.implement,
      review: (x) => runProcess(FAKE_CODEX, [], { cwd: x.snapshot, env: { PATH: process.env.PATH }, stdin: x.prompt, timeoutMs: 30_000 }) }) });
    const m = await w.orch.run('ATL-22');
    expect(m.state).toBe('escalated');
    expect(m.reasonClass).toBe('reviewer-tamper');
    expect(m.reason).toMatch(/modified its read-only environment/);
    expect(PASS_POSTED(w)).toBe(false);
    expect(w.calls.review).toBe(0); // (the counted wrapper was bypassed, so this is 0) ...
    expect(m.attempts[0]!.review).toBeUndefined(); // ... and no review was ever accepted
  });
  it.skipIf(!sandboxed)('inside the real sandbox the reviewer cannot write src, root or /etc, and sees only the allowlisted environment', async () => {
    const w = world({ scenario: 'correct-first' });
    const m = await w.orch.run('ATL-22');
    expect(m.outcome).toBe('PASS');
    const review = JSON.parse(readFileSync(join(runDir(w, 'ATL-22'), 'attempt-0', 'review.json'), 'utf8')) as { summary: string };
    expect(review.summary).toContain('"write_src":"EROFS"');
    expect(review.summary).toContain('"write_root":"EROFS"');
    expect(review.summary).toContain('"write_etc":"EROFS"');
    const env = /\[env ([^\]]*)\]/.exec(review.summary)![1]!.split(',');
    expect(env.sort()).toEqual(['DEVFLOW_ROLE', 'DISABLE_AUTOUPDATER', 'HOME', 'LANG', 'PATH', 'PWD', 'TERM', 'TZ', 'CODEX_HOME'].sort());
  });
  it('a branch that moves while the review runs is stale: the result is not published', async () => {
    let branch = '';
    const w = world({ scenario: 'correct-first', wrapAgents: (inner, x) => ({ preflight: () => inner.preflight(), implement: async (o) => { const r = await inner.implement(o); branch = (await import('node:child_process')).execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: o.clone, encoding: 'utf8' }).trim(); return r; },
      review: async (o) => { const r = await inner.review(o); w2.pushFrom(branch); void x; return r; } }) });
    const w2 = w;
    const m = await w.orch.run('ATL-22');
    expect(m.state).toBe('escalated');
    expect(m.reasonClass).toBe('stale-commit');
    expect(m.reason).toMatch(/Controller verification failed.*remote branch at this SHA/);
    expect(PASS_POSTED(w)).toBe(false);
    expect(stateOf(w)).toBe('Blocked');
  });
});

describe('authorization and duplicate dispatch', () => {
  const refused = async (w: ReturnType<typeof makeWorld>, re: RegExp) => {
    await expect(w.orch.run('ATL-22')).rejects.toThrow(re);
    expect(w.f.store.mutations).toEqual([]); // nothing written anywhere
    expect(w.calls).toEqual({ implement: 0, review: 0 });
    expect(existsSync(join(w.runsDir, 'locks', 'ATL-22.lock'))).toBe(false);
  };
  it('refuses a ticket without the explicit Ready label', async () => refused(world({ labels: ['Feature'] }), /not explicitly approved/));
  it('refuses a ticket that is already started', async () => refused(world({ state: 'In Progress' }), /not an unstarted state/));
  it('refuses a ticket blocked by open work', async () => refused(world({ blockedBy: [3] }), /blocked by ATL-3/));
  it('refuses an unprojected ticket (not covered by any authorized scope)', async () => refused(world({ project: null }), /not authorized/));
  it('refuses a project with no orchestration configuration', async () => refused(world({ omitOrchestration: true }), /no "orchestration" configuration/));
  it('refuses an identifier that is not an issue key', async () => { const w = world(); await expect(w.orch.run('ATL-22; rm -rf /')).rejects.toBeInstanceOf(Rejected); });

  it('two simultaneous dispatches execute exactly once', async () => {
    const w = world({ scenario: 'correct-first' });
    const second = w.mk();
    const results = await Promise.allSettled([w.orch.run('ATL-22'), second.run('ATL-22')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toSatisfy((e: unknown) => e instanceof DuplicateRun || e instanceof Rejected);
    expect(w.calls.implement).toBe(1);
    expect(w.f.store.mutations.filter((x) => x.op === 'IssueUpdate')).toHaveLength(2); // started + approval, once
  });
  it('a finished ticket cannot be dispatched again', async () => {
    const w = world({ scenario: 'correct-first' });
    await w.orch.run('ATL-22');
    await expect(w.mk().run('ATL-22')).rejects.toThrow(/not an unstarted state/);
    expect(w.calls.implement).toBe(1);
  });
  it('a leftover lock from an interrupted run blocks until a human releases it', async () => {
    const w = world();
    w.store().acquire('ATL-22', 'dead-run');
    await expect(w.orch.run('ATL-22')).rejects.toBeInstanceOf(DuplicateRun);
    expect(w.calls.implement).toBe(0);
    w.store().release('ATL-22');
    await expect(w.orch.run('ATL-22')).resolves.toMatchObject({ state: 'awaiting-owner' });
  });
});

describe('credential isolation', () => {
  it('agents never receive Linear, GitHub or DevFlow credentials, even when the controller process has them', async () => {
    const secrets = { LINEAR_WRITE_API_KEY: 'lw', LINEAR_API_KEY: 'lr', GITHUB_TOKEN: 'gh', GITHUB_WRITE_TOKEN: 'ghw', GH_TOKEN: 'gh2', DEVFLOW_SECRET: 'd', SSH_AUTH_SOCK: '/tmp/agent' };
    const saved = Object.fromEntries(Object.keys(secrets).map((k) => [k, process.env[k]]));
    Object.assign(process.env, secrets);
    try {
      let claudeKeys: string[] = [];
      const w = world({ scenario: 'correct-first', wrapAgents: (inner) => ({ preflight: () => inner.preflight(), review: inner.review,
        implement: async (o) => { const r = await inner.implement(o); claudeKeys = JSON.parse(readFileSync(join(o.clone, 'claude-env.json'), 'utf8')).keys; return r; } }) });
      const m = await w.orch.run('ATL-22');
      expect(m.outcome).toBe('PASS');
      const review = JSON.parse(readFileSync(join(runDir(w, 'ATL-22'), 'attempt-0', 'review.json'), 'utf8')) as { summary: string };
      const codexKeys = /\[env ([^\]]*)\]/.exec(review.summary)![1]!.split(',');
      for (const keys of [claudeKeys, codexKeys]) for (const k of Object.keys(secrets)) expect(keys).not.toContain(k);
      expect(claudeKeys.length).toBeGreaterThan(3);
      const all = readdirSync(runDir(w, 'ATL-22'), { recursive: true }).map(String).filter((p) => /\.(txt|json|jsonl)$/.test(p)).map((p) => readFileSync(join(runDir(w, 'ATL-22'), p), 'utf8')).join('\n');
      expect(all).not.toContain(DEMO_WRITE_KEY);
      expect(all).not.toMatch(/"(lw|lr|gh|ghw|gh2)"/);
    } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  });
});

describe('hardening: draft PR, retries, infrastructure vs repair, Blocked state', () => {
  it('a branch whose PR head never matches the pushed SHA is an infrastructure stop, not a repair, and not reviewed', async () => {
    const w = world({ scenario: 'correct-first', prs: 'stale' });
    const m = await w.orch.run('ATL-22');
    expect(m.state).toBe('escalated');
    expect(m.reasonClass).toBe('infrastructure');
    expect(m.attempts).toHaveLength(1); // no repair attempt consumed
    expect(m.infra.length).toBeGreaterThanOrEqual(3);
    expect(w.calls).toEqual({ implement: 1, review: 0 });
    expect(stateOf(w)).toBe('Blocked');
  });
  it('a transient Claude failure (401/ECONNRESET) is retried without consuming a repair attempt', async () => {
    const w = world({ scenario: 'infra-claude-once' });
    const m = await w.orch.run('ATL-22');
    expect(m.outcome).toBe('PASS');
    expect(m.attempts).toHaveLength(1);
    expect(m.infra).toHaveLength(1);
    expect(m.infra[0]).toMatchObject({ step: 'claude' });
    expect(w.calls.implement).toBe(2);
  });
  it('a persistent Claude environment failure escalates as infrastructure with repairs untouched', async () => {
    const w = world({ scenario: 'infra-claude-always' });
    const m = await w.orch.run('ATL-22');
    expect(m.reasonClass).toBe('infrastructure');
    expect(m.attempts).toHaveLength(1);
    expect(m.attempts[0]!.n).toBe(0);
    expect(w.calls.implement).toBe(3); // 1 + infraRetries(2)
    expect(w.calls.review).toBe(0);
    expect(w.comments().at(-1)).toContain('infrastructure');
    expect(w.comments().at(-1)).toContain('Repair attempts used: 0/3');
    expect(w.comments().at(-1)).toContain('infrastructure retries: 3 (claude)');
    expect(stateOf(w)).toBe('Blocked');
  });
  it('invalid reviewer output is retried ONCE with a fresh nonce; a clean retry can pass, and the invalid output is never turned into PASS', async () => {
    const prompts: string[] = [];
    const w = world({ scenario: 'correct-first', wrapAgents: (inner) => { let n = 0; return { preflight: () => inner.preflight(), implement: inner.implement,
      review: async (x) => { prompts.push(x.prompt); if (n++ === 0) return { exitCode: 0, signal: null, timedOut: false, stdout: 'PASS - looks fine to me', stderr: '', truncated: false }; return inner.review(x); } }; } });
    const m = await w.orch.run('ATL-22');
    expect(m.outcome).toBe('PASS');
    expect(m.attempts[0]!.reviewRetries).toBe(1);
    expect(prompts).toHaveLength(2);
    const nonce = (p: string) => /"nonce":"([0-9a-f]+)"/.exec(p)![1];
    expect(nonce(prompts[0]!)).not.toBe(nonce(prompts[1]!));
    expect(w.comments().filter((b) => /Milestone 4\/6/.test(b) && b.includes('**PASS**'))).toHaveLength(1); // exactly one PASS, from the real second review
  });
  it('invalid reviewer output twice escalates as review-invalid (no third try, no PASS)', async () => {
    const w = world({ scenario: 'prose' });
    const m = await w.orch.run('ATL-22');
    expect(m.reasonClass).toBe('review-invalid');
    expect(m.reason).toMatch(/rejected twice/);
    expect(w.calls.review).toBe(2);
    expect(PASS_POSTED(w)).toBe(false);
    expect(stateOf(w)).toBe('Blocked');
  });
  it('a commit that edits .github/ is rejected as an implementation failure (the implementer may not rewrite its own CI)', async () => {
    const w = world({ scenario: 'touch-ci' });
    const m = await w.orch.run('ATL-22');
    expect(m.attempts[0]!.failure).toMatch(/protected configuration\/CI\/agent-instruction files/);
    expect(m.state).toBe('escalated'); // attempt 0 produced nothing acceptable
    expect(w.ci.calls).toEqual([]);
    expect(w.prs.created).toEqual([]);
  });
  it('escalation writes durable evidence, hashes it into the Linear comment, and moves the ticket to the configured Blocked state', async () => {
    const w = world({ scenario: 'never-fixes' });
    const m = await w.orch.run('ATL-22');
    expect(m.escalationEvidence).toMatch(/^escalation\.json#sha256=[0-9a-f]{16}$/);
    const ev = JSON.parse(readFileSync(join(runDir(w, 'ATL-22'), 'escalation.json'), 'utf8'));
    expect(ev).toMatchObject({ class: 'repairs-exhausted', repairsUsed: 3, ticket: 'ATL-22' });
    expect(w.comments().at(-1)).toContain(m.escalationEvidence!);
    expect(w.comments().at(-1)).toContain('(draft)');
    expect(stateOf(w)).toBe('Blocked');
  });
  it('refuses to start when the Blocked state does not exist (an escalation must always be recordable)', async () => {
    const w = world();
    w.cfg.projects[0]!.orchestration!.blockedState = 'Nonexistent';
    await expect(w.orch.run('ATL-22')).rejects.toThrow(/must exist/);
    expect(w.f.store.mutations).toEqual([]);
  });
  it.skipIf(!sandboxed)('a failed preflight (CLI not logged in) refuses the run before the ticket is touched', async () => {
    const w = world({ scenario: 'correct-first', wrapAgents: (inner) => ({ ...inner, preflight: async () => ({ ok: false, problems: ['Codex is not authenticated'], detail: [] }), implement: inner.implement, review: inner.review }) });
    await expect(w.orch.run('ATL-22')).rejects.toThrow(/Preflight failed.*Codex is not authenticated/);
    expect(w.f.store.mutations).toEqual([]);
    expect(w.calls.implement).toBe(0);
    expect(existsSync(join(w.runsDir, 'locks', 'ATL-22.lock'))).toBe(false);
  });
  it.skipIf(!sandboxed)('the real preflight runs both CLIs inside the sandbox, sees the staged login, and detects a missing one', async () => {
    const { CliAgents } = await import('../server/orchestrator/agents.ts');
    const good = world(), bad = world({ noLogin: true });
    const ok = await new CliAgents(good.cfg.projects[0]!.orchestration!, { hostHome: good.hostHome, env: { PATH: process.env.PATH } }).preflight();
    expect(ok.problems).toEqual([]);
    expect(ok.detail.join('\n')).toContain('codex login status: exit 0: Logged in using ChatGPT');
    const none = await new CliAgents(bad.cfg.projects[0]!.orchestration!, { hostHome: bad.hostHome, env: { PATH: process.env.PATH } }).preflight();
    expect(none.ok).toBe(false);
    expect(none.problems.join(' ')).toMatch(/Claude Code is not authenticated/);
    expect(none.problems.join(' ')).toMatch(/Codex is not authenticated/);
    await expect(bad.orch.run('ATL-22')).rejects.toThrow(/Preflight failed/);
    expect(bad.f.store.mutations).toEqual([]);
  });
});

describe('review validation (unit)', () => {
  const sha = 'a'.repeat(40), nonce = 'n0nce';
  const ctx = { sha, nonce, changedFiles: ['a.ts', 'b.ts'], lineCount: (f: string) => (f === 'a.ts' || f === 'b.ts' ? 10 : undefined) };
  const ok = { verdict: 'PASS', commit: sha, nonce, summary: 's', reviewed_files: ['a.ts', 'b.ts'], findings: [] };
  const fail = { verdict: 'FAIL', commit: sha, nonce, summary: 's', reviewed_files: ['a.ts'], findings: [{ id: '1', severity: 'major', file: 'a.ts', line: 3, title: 't', detail: 'd', evidence: 'e' }] };
  it('accepts honest PASS and FAIL', () => { expect(validateReview(ok, ctx).verdict).toBe('PASS'); expect(validateReview(fail, ctx).findings).toHaveLength(1); });
  it.each([
    ['unknown field', { ...ok, extra: 1 }], ['lowercase verdict', { ...ok, verdict: 'pass' }], ['short sha', { ...ok, commit: 'abc123' }],
    ['other sha', { ...ok, commit: 'b'.repeat(40) }], ['bad nonce', { ...ok, nonce: 'x' }], ['PASS missing a file', { ...ok, reviewed_files: ['a.ts'] }],
    ['PASS with major finding', { ...ok, findings: fail.findings }], ['FAIL without blocking finding', { ...fail, findings: [{ ...fail.findings[0], severity: 'minor' }] }],
    ['finding in file not in commit', { ...fail, findings: [{ ...fail.findings[0], file: 'ghost.ts' }] }], ['line outside file', { ...fail, findings: [{ ...fail.findings[0], line: 999 }] }],
    ['blocking finding without evidence', { ...fail, findings: [{ ...fail.findings[0], evidence: '' }] }], ['duplicate ids', { ...fail, findings: [fail.findings[0], fail.findings[0]] }],
  ])('rejects %s', (_n, raw) => { expect(() => validateReview(raw, ctx)).toThrow(ReviewInvalid); });
  it('a PASS for a commit with no changed files is meaningless and rejected', () => { expect(() => validateReview(ok, { ...ctx, changedFiles: [] })).toThrow(ReviewInvalid); });
});

describe('CI evaluation (unit)', () => {
  const c = (name: string, state: 'passed' | 'failed' | 'pending' | 'unknown') => ({ name, state, source: 'check_run' as const, rawStatus: 'completed' });
  it('pending, missing and unknown never count as pass', () => {
    expect(evaluateChecks([], []).state).toBe('pending');
    expect(evaluateChecks([c('build', 'passed')], ['build', 'lint']).state).toBe('pending');
    expect(evaluateChecks([c('build', 'passed'), c('x', 'pending')], []).state).toBe('pending');
    expect(evaluateChecks([c('build', 'unknown')], ['build']).state).toBe('failure');
    expect(evaluateChecks([c('build', 'failed')], ['build']).state).toBe('failure');
    expect(evaluateChecks([c('build', 'passed'), c('other', 'failed')], ['build']).state).toBe('success'); // only required checks gate
    expect(evaluateChecks([c('Build', 'passed')], ['build']).state).toBe('success');
  });
});

describe('orchestration config', () => {
  const base = { id: 'p', name: 'P', linear: { teamKey: 'ABC', projects: [] }, github: { repos: ['o/r'] } };
  it('requires absolute paths, a listed repo and single-token binaries', () => {
    const o = { repo: 'o/r', repoPath: '/x/repo', runsDir: '/x/runs', claude: { bin: '/x/claude' }, codex: { bin: '/x/codex' } };
    expect(parseConfig({ projects: [{ ...base, orchestration: o }] }).projects[0]!.orchestration!.approvalState).toBe('In Review');
    expect(() => parseConfig({ projects: [{ ...base, orchestration: { ...o, repoPath: 'rel' } }] })).toThrow(/absolute/);
    expect(() => parseConfig({ projects: [{ ...base, orchestration: { ...o, repo: 'o/other' } }] })).toThrow(/listed/);
    expect(() => parseConfig({ projects: [{ ...base, orchestration: { ...o, codex: { bin: 'codex --yolo' } } }] })).toThrow(/explicit absolute path/);
    expect(() => parseConfig({ projects: [{ ...base, orchestration: { ...o, codex: { bin: 'codex' } } }] })).toThrow(/explicit absolute path/); // no PATH lookup
    expect(() => parseConfig({ projects: [{ ...base, orchestration: { ...o, claude: { bin: '/x/claude', allowedTools: ['Read', '--dangerously-skip-permissions'] } } }] })).toThrow(/plain tool pattern/);
    expect(() => parseConfig({ projects: [{ ...base, orchestration: { ...o, claude: { bin: '/x/claude', allowedTools: ['Bash(git status:*),Bash(rm -rf /)'] } } }] })).toThrow(/plain tool pattern/);
  });
  it('is absent unless configured', () => expect(parseConfig({ projects: [base] }).projects[0]!.orchestration).toBeUndefined());
});
