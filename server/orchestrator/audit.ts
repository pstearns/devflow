// Human-readable audit trail for Linear. Every milestone comment has the same shape: a header line, WHAT happened, WHY it happened, and
// the EVIDENCE that supports it. The detailed technical record stays in the controller's manifest/events.jsonl/evidence files; these
// comments are the readable summary. Rules enforced here: only controller-derived facts are stated as fact; anything an agent wrote is
// shown quoted and labelled as unverified; no filesystem paths of the host, environment, or credentials are ever included.
import type { AttemptRecord, Finding, Manifest, Review } from './types.ts';
import { MAX_REPAIRS } from './types.ts';

const TOTAL = 6;
export const MILESTONES = { started: 1, implemented: 2, ci: 3, review: 4, repair: 5, final: 6 } as const;
const TITLES: Record<number, string> = { 1: 'Execution authorized and started', 2: 'Implementation completed', 3: 'CI verified', 4: 'Independent review completed', 5: 'Repair requested', 6: 'Final status' };

const defang = (s: string) => s.replace(/@/g, '@\u200b').replace(/\u0000/g, '').replace(/!\[/g, '!\\[').replace(/\]\(/g, '] (');
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** Agent-authored text: quoted line by line, so it can never impersonate a controller heading or a verified fact. */
export const quote = (s: string, n = 600) => clip(defang(s), n).split('\n').map((l) => `> ${l}`).join('\n');
const short = (sha?: string) => (sha ? sha.slice(0, 12) : '—');
const commit = (m: Manifest, sha?: string) => (sha ? `[\`${short(sha)}\`](https://github.com/${m.repo}/commit/${sha})` : '—');
const pr = (m: Manifest) => (m.pr ? `[#${m.pr.number}](${m.pr.url || '#'}) (draft)` : '—');
/** Evidence is referenced relative to the runs directory: enough to find it on the DevFlow host, nothing about where that host keeps it. */
export const ev = (m: Manifest, ref: string) => `\`${m.ticket}-${m.runId}/${ref}\``;

/** A human reading the ticket wants the run's status, not the controller's internal micro-state. */
const statusOf = (m: Manifest) => (m.state === 'awaiting-owner' ? 'awaiting owner approval' : m.state === 'escalated' ? 'escalated' : m.state === 'aborted' ? 'aborted' : 'in progress');

function frame(m: Manifest, n: number, title: string | undefined, at: string, body: { what: string; why: string; evidence: string[]; extra?: string }) {
  return [
    `### DevFlow run \`${m.runId}\` · Milestone ${n}/${TOTAL} — ${title ?? TITLES[n]}`,
    `**Ticket** ${m.ticket} · **Run** \`${m.runId}\` · **Run status** ${statusOf(m)} · **Time** ${at}`,
    '',
    `**What happened.** ${body.what}`,
    '',
    `**Why.** ${body.why}`,
    '',
    '**Evidence**',
    ...(body.evidence.length ? body.evidence.map((e) => `- ${e}`) : ['- _none recorded for this step_']),
    ...(body.extra ? ['', body.extra] : []),
  ].join('\n');
}

export interface StartFacts {
  authorizer?: string; authorizedAt?: string; readyLabel: string; scope: string; claude?: string; codex?: string; policyDigest: string; baseProtected?: boolean | 'unknown'; operator: string;
}
export function started(m: Manifest, at: string, f: StartFacts) {
  return frame(m, 1, undefined, at, {
    what: `Execution of ${m.ticket} was authorized and the run started. The ticket moved to its in-progress state.`,
    why: `The ticket carried the explicit \`${f.readyLabel}\` approval label, was unstarted and unblocked, and sits inside a write-authorized scope. Authorized by: **${f.authorizer ?? 'not shown in Linear history'}**${f.authorizedAt ? ` at ${f.authorizedAt}` : ''}.`,
    evidence: [
      `Approved scope: ${f.scope}; repository \`${m.repo}\`, base \`${m.baseBranch}\` @ ${commit(m, m.baseSha)}; base branch protected on GitHub: ${String(f.baseProtected ?? 'unknown')}.`,
      `Agents (all inside a bubblewrap sandbox, no controller credentials): **implementer** Claude Code ${f.claude ?? '(version unknown)'}; **independent reviewer** Codex ${f.codex ?? '(version unknown)'}. The controller (${f.operator}) alone writes to Linear and GitHub.`,
      `Trusted controller policy digest \`${f.policyDigest.slice(0, 16)}\` (owner-controlled config; repository files are never policy).`,
      `Limits: initial attempt + ${MAX_REPAIRS} repairs; environment failures are retried separately and never use a repair.`,
      `Run record: ${ev(m, 'manifest.json')} and ${ev(m, 'events.jsonl')} (retained on the DevFlow host).`,
    ],
  });
}

export function implemented(m: Manifest, a: AttemptRecord, at: string, f: { files: number; sha: string }) {
  const repair = a.n > 0;
  return frame(m, 2, repair ? `Repair ${a.n} completed` : undefined, at, {
    what: `${repair ? `Claude's repair ${a.n} of ${MAX_REPAIRS}` : "Claude's initial implementation"} produced commit ${commit(m, f.sha)} (${f.files} file${f.files === 1 ? '' : 's'} changed) on branch \`${m.branch}\`; pushed; PR ${pr(m)}.`,
    why: repair ? `The previous commit ${commit(m, a.startSha)} was rejected (see the preceding CI/review milestone); Claude was re-dispatched with the verified findings.` : 'The ticket was approved for execution; Claude implemented it in an isolated clone and committed.',
    evidence: [
      `Commit ${commit(m, f.sha)} (parent ${commit(m, a.startSha)}); the controller verified it descends from the previous commit and edits no protected files.`,
      `Remote branch head == this SHA and the PR head == this SHA (checked by the controller after push).`,
      `Claude run: exit ${a.agent?.exitCode ?? '?'}${a.agent?.timedOut ? ' (timed out)' : ''}; output ${a.agent ? ev(m, a.agent.log.split('#')[0]!) : '—'}.`,
      `Infrastructure retries so far: ${m.infra.length}.`,
    ],
  });
}

export function ciVerified(m: Manifest, a: AttemptRecord, at: string, ci: { state: string; detail: string; checks: { name: string; state: string; url?: string }[] }, sha: string) {
  const ok = ci.state === 'success';
  return frame(m, 3, ok ? undefined : 'CI failed', at, {
    what: `CI ${ok ? 'passed' : 'FAILED'} on commit ${commit(m, sha)}.`,
    why: ok ? 'A review is only requested for a commit whose CI is green; the controller read the result for this exact SHA.' : 'A failing commit is not sent to the reviewer; it is returned to Claude for repair.',
    evidence: [
      `Result: ${clip(ci.detail, 400)}`,
      ...ci.checks.slice(0, 12).map((c) => `Check \`${c.name}\`: ${c.state}${c.url ? ` — ${c.url}` : ''}`),
      a.ci ? `Retained: ${ev(m, a.ci.evidence.split('#')[0]!)}` : '',
    ].filter(Boolean),
    extra: ok ? undefined : repairRequested(m, a.n, `CI failed: ${clip(ci.detail, 200)}`),
  });
}

export interface GateCheck { name: string; ok: boolean; detail: string }
export function reviewed(m: Manifest, a: AttemptRecord, at: string, r: Review, gate: GateCheck[], versions: { codex?: string }) {
  const pass = r.verdict === 'PASS';
  const findings = r.findings.length
    ? r.findings.map((f: Finding) => `- **${f.severity}** \`${defang(f.file)}${f.line ? `:${f.line}` : ''}\`\n${quote(`${f.title}\n${f.detail}\nEvidence: ${f.evidence}`, 900)}`).join('\n')
    : '_No findings._';
  return frame(m, 4, undefined, at, {
    what: `Independent review of ${commit(m, r.commit)}: **${r.verdict}** (${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}; reviewer Codex ${versions.codex ?? ''}; retries of malformed output: ${a.reviewRetries ?? 0}).`,
    why: pass ? 'The reviewer attested every changed file, and the controller independently verified the result before accepting it (table below). The reviewer’s word alone advances nothing.' : 'The reviewer reported blocking findings with evidence; the controller validated the format, SHA and file references before relaying them.',
    evidence: [
      `Controller verification: ${gate.map((g) => `${g.ok ? '✅' : '❌'} ${g.name}`).join(' · ')}`,
      ...gate.filter((g) => !g.ok).map((g) => `Failed: ${g.name} — ${g.detail}`),
      a.review ? `Retained: ${ev(m, a.review.parsed.split('#')[0]!)}, raw output ${ev(m, a.review.raw.split('#')[0]!)}` : '',
    ].filter(Boolean),
    extra: `**Reviewer summary and findings (agent-authored, quoted, unverified prose):**\n${quote(r.summary, 900)}\n\n${findings}${pass ? '' : `\n\n${repairRequested(m, a.n, `${r.findings.length} review finding(s)`)}`}`,
  });
}

export function repairRequested(m: Manifest, n: number, reason: string) {
  return n < MAX_REPAIRS
    ? `**Milestone 5/${TOTAL} — Repair requested.** Repair ${n + 1} of ${MAX_REPAIRS} requested from Claude. Reason: ${reason}. Retries used so far: repairs ${n}/${MAX_REPAIRS}, infrastructure ${m.infra.length}.`
    : `**Milestone 5/${TOTAL} — No repair available.** ${reason}. All ${MAX_REPAIRS} repair attempts are used; the run will escalate.`;
}

export function final(m: Manifest, at: string, f: { kind: 'awaiting-owner' | 'escalated'; summary: string; reason?: string; cls?: string; gate?: GateCheck[]; evidenceRef?: string; blockedConfirmed?: boolean }) {
  const pass = f.kind === 'awaiting-owner';
  const rows = m.attempts.map((a) => `| ${a.n === 0 ? 'initial' : `repair ${a.n}`} | ${commit(m, a.headSha)} | ${a.ci ? a.ci.state : '—'} | ${a.review ? a.review.verdict : a.failure ? 'n/a' : '—'} | ${a.failure ? clip(a.failure, 90) : 'accepted'} |`);
  return frame(m, 6, pass ? 'Awaiting owner approval' : 'Escalated to the owner', at, {
    what: pass ? `Commit ${commit(m, m.approvedSha)} passed CI and independent review and is **awaiting owner approval**. The ticket moved to its approval state.` : `The run **stopped and escalated** (${f.cls}). The ticket was moved to \`${m.linearStates.blockedName}\`${f.blockedConfirmed === false ? ' — **the transition was NOT confirmed; please check the ticket**' : ''}. No further automated attempts will be made.`,
    why: pass ? 'All controller gates held for this exact SHA (below). DevFlow never merges and never marks the PR ready.' : clip(defang(f.reason ?? ''), 1200),
    evidence: [
      pass ? `Gate: ${(f.gate ?? []).map((g) => `${g.ok ? '✅' : '❌'} ${g.name}`).join(' · ')}` : '',
      `Branch \`${m.branch}\` · draft PR ${pr(m)} · base \`${m.baseBranch}\` @ ${commit(m, m.baseSha)}`,
      `Repair attempts used: ${m.attempts.filter((x) => x.n > 0).length}/${MAX_REPAIRS} · infrastructure retries: ${m.infra.length}${m.infra.length ? ` (${[...new Set(m.infra.map((i) => i.step))].join(', ')})` : ''} · review retries: ${m.attempts.reduce((s, x) => s + (x.reviewRetries ?? 0), 0)}`,
      `Run record ${ev(m, 'manifest.json')}${f.evidenceRef ? `, escalation record ${ev(m, f.evidenceRef)}` : ''}; event log ${ev(m, 'events.jsonl')}.`,
    ].filter(Boolean),
    extra: `${pass ? '**Owner action required:** review the draft PR and approve or reject it. Nothing is merged or deployed automatically.' : '**Owner action required:** read the reason above, fix the cause, and re-approve the ticket if you want another run.'}\n\n| Attempt | Commit | CI | Review | Outcome |\n|---|---|---|---|---|\n${rows.join('\n')}`,
  });
}
