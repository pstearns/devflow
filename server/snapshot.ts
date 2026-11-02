// Combines Linear + GitHub data into one derived, read-only Snapshot.
import type {
  ActivityEvent, AttentionItem, Evidence, Issue, KnowledgeLink, PullRequest, ProjectInfo, SourceHealth, Snapshot, Stage, Tri,
} from '../shared/types.ts';
import type { Config, ProjectCfg } from './config.ts';
import { buildMilestones, type LinearProjectData } from './linear.ts';
import type { RepoData } from './github.ts';
import { matchPrs } from './match.ts';
import { ciStatus, humanReviewStatus, independentReviewStatus, status } from './status.ts';
import { safeUrl } from './util.ts';

export interface BuildInput {
  cfg: Config;
  now: Date;
  mode: 'live' | 'demo';
  linear: Map<string, LinearProjectData>; // by DevFlow project id
  github: Map<string, RepoData>; // by owner/repo
  health: SourceHealth[];
  dataAt?: string;
}

const DAY = 86400000;
const enc = encodeURIComponent;

function knowledgeFor(p: ProjectCfg, cfg: Config, docs: LinearProjectData['documents']): KnowledgeLink[] {
  const out: KnowledgeLink[] = [];
  for (const k of p.knowledge) {
    if (k.kind === 'obsidian') {
      const path = k.path ?? '';
      const ob = cfg.obsidian;
      out.push({
        title: k.title, kind: 'obsidian', source: 'Configured Obsidian document',
        url: ob && path ? `obsidian://open?vault=${enc(ob.vault)}&file=${enc(path)}` : undefined,
        copyPath: path ? (ob?.vaultPath ? `${ob.vaultPath.replace(/\/$/, '')}/${path}` : path) : undefined,
      });
    } else if (k.kind === 'repo') {
      const ok = k.repo && /^[\w.-]+\/[\w.-]+$/.test(k.repo) && k.path;
      out.push({
        title: k.title, kind: 'repo', source: 'Configured repository document',
        url: ok ? `https://github.com/${k.repo}/blob/${k.ref ? k.ref.split('/').map(enc).join('/') : 'HEAD'}/${k.path!.split('/').map(enc).join('/')}` : undefined,
        copyPath: k.path,
      });
    } else {
      out.push({ title: k.title, kind: 'url', source: 'Configured link', url: safeUrl(k.url) });
    }
  }
  for (const d of docs) out.push({ title: d.title, kind: 'linear', url: d.url, source: 'Linear project document' });
  return out;
}

function pickPrimary(prs: PullRequest[]): PullRequest | undefined {
  const byUpdated = (a: PullRequest, b: PullRequest) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  const open = prs.filter((p) => p.state === 'open').sort(byUpdated);
  return open[0] ?? prs.filter((p) => p.state === 'merged').sort(byUpdated)[0] ?? undefined;
}

export function deriveIssue(issue: Issue, prs: PullRequest[], cfg: Config, now: number): void {
  issue.openBlockers = issue.blockedBy.filter((b) => !b.resolved);
  const t = issue.state.type;
  const resolved = t === 'completed' || t === 'canceled';
  const marker = !resolved && issue.openBlockers.length === 0
    ? (/blocked/i.test(issue.state.name) ? `Linear state "${issue.state.name}"` : issue.labels.find((l) => /^blocked$/i.test(l)) ? 'Linear label "blocked"' : undefined)
    : undefined;
  issue.blockedMarker = marker;
  issue.readiness = resolved ? 'na' : issue.openBlockers.length || marker ? 'blocked' : t === 'unstarted' ? 'ready' : t === 'backlog' || t === 'triage' ? 'not-ready' : 'na';

  const primary = pickPrimary(prs);
  issue.primaryPrKey = primary?.key;
  const lv = (label: string): Evidence => ({ source: 'Linear state', label, url: issue.url });
  const prEv = (pr: PullRequest, label: string): Evidence => ({ source: 'GitHub PR', label, url: pr.url });
  issue.rework = [];
  issue.awaitingHuman = [];
  issue.stageEvidence = [];
  let stage: Stage | undefined;

  if (t === 'canceled') stage = undefined, issue.stageEvidence.push(lv(`State: ${issue.state.name} (canceled)`));
  else if (t === 'completed') stage = 'done', issue.stageEvidence.push(lv(`State: ${issue.state.name}`));
  else if (primary && primary.state === 'merged') {
    stage = 'merge';
    issue.stageEvidence.push(prEv(primary, `PR #${primary.number} merged`), lv(`Linear state is still "${issue.state.name}"`));
  } else if (primary) {
    const { ci, humanReview, independentReview } = primary;
    if (primary.draft) { stage = 'implementation'; issue.stageEvidence.push(prEv(primary, `PR #${primary.number} is a draft`)); }
    else if (ci.value === 'failed') { stage = 'implementation'; issue.rework.push('CI failed'); issue.stageEvidence.push(...ci.evidence); }
    else if (humanReview.value === 'failed' || independentReview.value === 'failed') {
      stage = 'implementation';
      if (humanReview.value === 'failed') issue.rework.push('Review requested changes'), issue.stageEvidence.push(...humanReview.evidence);
      if (independentReview.value === 'failed') issue.rework.push('Independent review recorded findings'), issue.stageEvidence.push(...independentReview.evidence);
    } else if (ci.value !== 'passed') { stage = 'ci'; issue.stageEvidence.push(prEv(primary, `CI is ${ci.value}: ${ci.detail}`)); }
    else if (independentReview.value === 'passed' || humanReview.value === 'passed') {
      stage = 'merge';
      issue.stageEvidence.push(...(independentReview.value === 'passed' ? independentReview.evidence : humanReview.evidence));
      issue.awaitingHuman.push(`Merge decision on PR #${primary.number}`);
    } else { stage = 'review'; issue.stageEvidence.push(prEv(primary, `CI passed; independent review is ${independentReview.value}`)); }
  } else if (t === 'started') {
    stage = /review/i.test(issue.state.name) ? 'review' : 'implementation';
    issue.stageEvidence.push(lv(`State: ${issue.state.name}${stage === 'review' ? ' (no PR evidence)' : ''}`));
  } else if (t === 'unstarted') { stage = 'ready'; issue.stageEvidence.push(lv(`State: ${issue.state.name}`)); }
  else if (t === 'backlog' || t === 'triage') { stage = 'discovery'; issue.stageEvidence.push(lv(`State: ${issue.state.name}`)); }
  issue.stage = stage;

  const noPr = (): ReturnType<typeof status> =>
    t === 'canceled' || !stage || stage === 'discovery' || stage === 'ready'
      ? status('na', 'Work has not reached this gate')
      : status('unknown', 'No linked PR evidence');
  issue.gates = {
    ci: primary ? primary.ci : noPr(),
    review: primary ? primary.independentReview : noPr(),
    merge: primary
      ? primary.state === 'merged' ? status('passed', `PR merged ${primary.mergedAt ?? ''}`.trim(), [prEv(primary, 'Merged')])
        : primary.state === 'open' ? status('pending', 'PR open, not merged', [prEv(primary, `PR #${primary.number} open`)])
        : status('na', 'PR closed without merge')
      : noPr(),
  };
  const last = Math.max(Date.parse(issue.updatedAt ?? '') || 0, ...prs.map((p) => Date.parse(p.updatedAt ?? '') || 0));
  issue.stale = t === 'started' && last > 0 && now - last > cfg.staleDays * DAY;
  if (prs.length && !primary) issue.prLinkNote = 'Linked PR(s) are closed without merge';
}

export function buildSnapshot(inp: BuildInput): Snapshot {
  const { cfg, now, mode } = inp;
  const nowMs = now.getTime();
  const today = now.toISOString().slice(0, 10);
  const issues: Issue[] = [];
  const prs: PullRequest[] = [];
  const milestones = [] as Snapshot['milestones'];
  const projects: ProjectInfo[] = [];

  for (const p of cfg.projects) {
    const ld = inp.linear.get(p.id);
    projects.push({
      id: p.id, name: p.name, linearUrl: ld?.projectUrl,
      repos: p.repos.map((r) => ({ repo: r, url: `https://github.com/${r}`, actionsUrl: `https://github.com/${r}/actions` })),
      knowledge: knowledgeFor(p, cfg, ld?.documents ?? []),
    });
    if (ld) {
      for (const i of ld.issues) i.childIdentifiers = []; // cached issue objects are reused across builds
      const byId = new Map(ld.issues.map((i) => [i.identifier, i]));
      for (const i of ld.issues) if (i.parentIdentifier) byId.get(i.parentIdentifier)?.childIdentifiers.push(i.identifier);
      issues.push(...ld.issues);
      milestones.push(...buildMilestones(p.id, ld.milestones, ld.issues, today));
    }
    for (const repo of p.repos) {
      for (const r of inp.github.get(repo)?.prs ?? []) {
        if (prs.some((x) => x.key === `${repo}#${r.number}`)) continue; // repo shared by two projects: first project owns it
        const pr: PullRequest = {
          ...r, key: `${repo}#${r.number}`, repo, projectId: p.id,
          ticket: { link: 'unlinked', candidates: [], via: '' },
          runs: [],
          ci: ciStatus(r.checks, r.detail.checksOk, r.detail.checksPartial),
          humanReview: humanReviewStatus(r.reviews, r.detail.reviewsOk, r.state, r.detail.reviewsPartial),
          independentReview: independentReviewStatus({ labels: r.labels, checks: r.checks, state: r.state, detailOk: r.detail.checksOk }, cfg.review),
        };
        prs.push(pr);
      }
    }
  }
  matchPrs(prs, issues);
  const prByKey = new Map(prs.map((p) => [p.key, p]));
  // attach workflow runs by head sha / branch
  for (const p of cfg.projects) for (const repo of p.repos) {
    for (const run of inp.github.get(repo)?.runs ?? [])
      for (const pr of prs) if (pr.repo === repo && (pr.headSha === run.sha || pr.headRef === run.branch)) pr.runs.push(run);
  }
  for (const i of issues) deriveIssue(i, i.prKeys.map((k) => prByKey.get(k)!).filter(Boolean), cfg, nowMs);

  const activity = buildActivity(issues, prs, inp.github, cfg);
  const attention = buildAttention(issues, prs, milestones, inp.health, cfg, nowMs);
  return {
    generatedAt: now.toISOString(), dataAt: inp.dataAt ?? now.toISOString(), mode, staleAfterSeconds: cfg.staleAfterMinutes * 60, staleDays: cfg.staleDays,
    projects, issues, milestones, prs, activity, attention, health: inp.health, prompts: cfg.prompts,
  };
}

const runTri = (conclusion?: string, st?: string): Tri =>
  st && st !== 'completed' ? 'pending' : conclusion === 'success' ? 'passed' : conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure' ? 'failed' : 'unknown';

export function buildActivity(issues: Issue[], prs: PullRequest[], github: Map<string, RepoData>, cfg: Config): ActivityEvent[] {
  const ev: ActivityEvent[] = [];
  for (const pr of prs) {
    const base = { source: 'github' as const, projectId: pr.projectId, ticket: pr.ticket.identifier, url: pr.url };
    const t = `#${pr.number} ${pr.title}`;
    if (pr.createdAt) ev.push({ ...base, id: `${pr.key}:open`, ts: pr.createdAt, kind: 'pr_opened', title: t, detail: `Opened by ${pr.author ?? 'unknown'}` });
    if (pr.mergedAt) ev.push({ ...base, id: `${pr.key}:merged`, ts: pr.mergedAt, kind: 'pr_merged', title: t, detail: 'Merged', status: 'passed' });
    else if (pr.state === 'closed' && pr.updatedAt) ev.push({ ...base, id: `${pr.key}:closed`, ts: pr.updatedAt, kind: 'pr_closed', title: t, detail: 'Closed without merge' });
    else if (pr.state === 'open' && pr.updatedAt && pr.updatedAt !== pr.createdAt) ev.push({ ...base, id: `${pr.key}:upd:${pr.updatedAt}`, ts: pr.updatedAt, kind: 'pr_updated', title: t, detail: 'Updated' });
  }
  for (const p of cfg.projects) for (const repo of p.repos) {
    for (const run of github.get(repo)?.runs ?? []) {
      if (!run.at) continue;
      const pr = prs.find((x) => x.repo === repo && (x.headSha === run.sha || x.headRef === run.branch));
      ev.push({
        id: `${repo}:run:${run.id}`, ts: run.at, source: 'github', kind: 'ci_run', projectId: p.id,
        title: `${run.name} (${repo})`, detail: `${run.branch ?? 'unknown branch'} @ ${run.sha.slice(0, 7)} — ${run.conclusion ?? run.status}`,
        status: runTri(run.conclusion, run.status), ticket: pr?.ticket.identifier, url: run.url,
      });
    }
  }
  for (const i of issues) {
    const base = { source: 'linear' as const, projectId: i.projectId, ticket: i.identifier, url: i.url };
    for (const c of i.recentChanges)
      ev.push({ ...base, id: `${i.identifier}:chg:${c.at}`, ts: c.at, kind: 'issue_changed', title: `${i.identifier} ${i.title}`, detail: `${c.from ?? '?'} → ${c.to ?? '?'}${c.actor ? ` by ${c.actor}` : ''}` });
    const newest = i.recentChanges.map((c) => Date.parse(c.at)).sort((a, b) => b - a)[0] ?? 0;
    if (i.updatedAt && Date.parse(i.updatedAt) - newest > 60000)
      ev.push({ ...base, id: `${i.identifier}:upd:${i.updatedAt}`, ts: i.updatedAt, kind: 'issue_updated', title: `${i.identifier} ${i.title}`, detail: `Updated (state: ${i.state.name})` });
  }
  return ev.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 400);
}

export function buildAttention(
  issues: Issue[], prs: PullRequest[], milestones: Snapshot['milestones'], health: SourceHealth[], cfg: Config, nowMs: number,
): AttentionItem[] {
  const out: AttentionItem[] = [];
  const issueBy = new Map(issues.map((i) => [i.identifier, i]));
  const sev = { high: 0, medium: 1, low: 2 };

  for (const h of health) {
    if (h.state === 'not_configured')
      out.push({ id: `health:${h.id}`, kind: 'integration', severity: 'medium', actionable: true, projectId: '', title: `${h.label} is not configured`, cause: h.error ?? 'Missing credentials', evidence: [{ source: 'DevFlow config', label: h.id }], nextAction: 'Add the missing credential to .env (see .env.example), then restart DevFlow.' });
    else if (h.state === 'error' || h.state === 'stale')
      out.push({ id: `health:${h.id}`, kind: 'integration', severity: 'high', actionable: true, projectId: '', title: `${h.label} ${h.state === 'stale' ? 'is serving stale data' : 'failed'}`, cause: h.error ?? 'Unknown error', evidence: [{ source: 'DevFlow health', label: `Last success: ${h.lastSuccess ?? 'never'}` }], nextAction: 'Fix the cause shown (token, permission, rate limit); data refreshes automatically.' });
  }

  for (const pr of prs) {
    if (pr.state !== 'open') continue;
    const issue = pr.ticket.identifier ? issueBy.get(pr.ticket.identifier) : undefined;
    const common = { projectId: pr.projectId, ticket: pr.ticket.identifier, prKey: pr.key };
    const name = `${pr.ticket.identifier ?? 'Unlinked'} · PR #${pr.number}`;
    if (pr.ci.value === 'failed')
      out.push({ ...common, id: `ci:${pr.key}`, kind: 'ci_failed', severity: 'high', actionable: true, title: `${name}: CI failing`, cause: pr.ci.detail, evidence: pr.ci.evidence, nextAction: 'Open the failing check, fix or rerun, push to the branch.' });
    if (pr.humanReview.value === 'failed')
      out.push({ ...common, id: `chg:${pr.key}`, kind: 'changes_requested', severity: 'high', actionable: true, title: `${name}: changes requested`, cause: pr.humanReview.detail, evidence: pr.humanReview.evidence, nextAction: 'Address the review comments on the PR.' });
    if (pr.independentReview.value === 'failed')
      out.push({ ...common, id: `rv:${pr.key}`, kind: 'review_findings', severity: 'high', actionable: true, title: `${name}: independent review findings`, cause: pr.independentReview.detail, evidence: pr.independentReview.evidence, nextAction: 'Resolve the recorded findings (prompt: Resolve review findings).' });
    if (!pr.draft && pr.ci.value === 'passed' && pr.humanReview.value !== 'failed' && pr.independentReview.value !== 'failed') {
      const rv = pr.independentReview.value;
      out.push({
        ...common, id: `merge:${pr.key}`, kind: 'awaiting_merge', severity: 'medium', actionable: true, title: `${name}: ready for your merge decision`,
        cause: `CI passed. Independent review: ${rv}${rv !== 'passed' ? ` (${pr.independentReview.detail})` : ''}. Human review: ${pr.humanReview.value}.`,
        evidence: [...pr.ci.evidence.slice(0, 2), ...pr.independentReview.evidence, ...pr.humanReview.evidence],
        nextAction: rv === 'passed' ? 'Review the diff and merge, or send back.' : 'Confirm independent review happened before merging; DevFlow has no record of it.',
      });
    }
    if (pr.ticket.link === 'unlinked')
      out.push({ ...common, id: `unl:${pr.key}`, kind: 'unlinked_pr', severity: 'low', actionable: false, title: `PR #${pr.number} is not linked to a ticket`, cause: pr.ticket.via, evidence: [{ source: 'GitHub PR', label: pr.title, url: pr.url }], nextAction: 'Suggestion: include the Linear identifier in the branch or title.' });
    if (pr.ticket.link === 'ambiguous')
      out.push({ ...common, id: `amb:${pr.key}`, kind: 'ambiguous_pr', severity: 'low', actionable: false, title: `PR #${pr.number} references several tickets`, cause: pr.ticket.via, evidence: [{ source: 'GitHub PR', label: pr.title, url: pr.url }], nextAction: 'Suggestion: split the PR or name a single ticket; DevFlow will not guess.' });
    void issue;
  }

  for (const i of issues) {
    if (i.state.type === 'completed' || i.state.type === 'canceled') continue;
    const common = { projectId: i.projectId, ticket: i.identifier };
    const lev = (l: string): Evidence => ({ source: 'Linear', label: l, url: i.url });
    if (i.openBlockers.length && (i.state.type === 'started' || i.state.type === 'unstarted'))
      out.push({ ...common, id: `blk:${i.identifier}`, kind: 'blocked', severity: i.state.type === 'started' ? 'high' : 'medium', actionable: true, title: `${i.identifier}: blocked by ${i.openBlockers.map((b) => b.identifier).join(', ')}`, cause: `Unresolved blocking relation(s): ${i.openBlockers.map((b) => `${b.identifier} (${b.stateName})`).join(', ')}`, evidence: i.openBlockers.map((b) => ({ source: 'Linear relation', label: `${b.identifier} blocks ${i.identifier}`, url: b.url })), nextAction: 'Resolve or re-plan the blocker in Linear.' });
    else if (i.blockedMarker)
      out.push({ ...common, id: `blk:${i.identifier}`, kind: 'blocked', severity: 'medium', actionable: true, title: `${i.identifier}: marked blocked`, cause: `${i.blockedMarker}; no blocking relation recorded`, evidence: [lev(i.blockedMarker)], nextAction: 'Record the blocker in Linear or unblock the issue.' });
    if (i.stale)
      out.push({ ...common, id: `stale:${i.identifier}`, kind: 'stale', severity: 'low', actionable: false, title: `${i.identifier}: no activity for ${cfg.staleDays}+ days`, cause: `In "${i.state.name}" with no Linear or PR update since ${i.updatedAt?.slice(0, 10)}`, evidence: [lev(`Updated ${i.updatedAt}`)], nextAction: 'Suggestion: check whether work is stuck (prompt: Resume ticket).' });
    const pr = i.primaryPrKey ? prs.find((p) => p.key === i.primaryPrKey) : undefined;
    if (pr?.state === 'merged')
      out.push({ ...common, id: `mm:${i.identifier}`, kind: 'state_mismatch', severity: 'low', actionable: false, title: `${i.identifier}: PR merged but issue is "${i.state.name}"`, cause: `PR #${pr.number} merged ${pr.mergedAt}, Linear not completed`, evidence: [lev(`State ${i.state.name}`), { source: 'GitHub PR', label: `#${pr.number} merged`, url: pr.url }], nextAction: 'Suggestion: update the issue state in Linear.' });
  }

  const today = new Date(nowMs).toISOString().slice(0, 10);
  for (const m of milestones) {
    if (m.overdue)
      out.push({ id: `ms:${m.id}`, kind: 'milestone_overdue', severity: 'high', actionable: true, projectId: m.projectId, title: `Milestone "${m.name}" is overdue`, cause: `Target ${m.targetDate} (today ${today}); ${m.done} of ${m.total - m.canceled} done`, evidence: [{ source: 'Linear milestone', label: `Target ${m.targetDate}`, url: m.url }], nextAction: 'Re-plan the date or the scope in Linear.' });
  }
  return out.sort((a, b) => sev[a.severity] - sev[b.severity] || Number(b.actionable) - Number(a.actionable));
}
