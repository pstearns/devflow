import type { AttentionItem, Issue, IssueRef, KnowledgeLink, ProjectInfo, PullRequest, Snapshot } from '../../../shared/types.ts';
import { Lifecycle } from './Lifecycle.tsx';
import { Prompts } from './Prompts.tsx';
import { Card, EvidenceList, Ext, Pill, Tag, Time, btn } from './ui.tsx';
import { copyText } from '../lib.ts';
import { useState } from 'react';

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[110px_1fr] gap-2 py-0.5"><dt className="text-muted">{k}</dt><dd className="min-w-0">{children}</dd></div>;
}

export function KnowledgeItem({ k }: { k: KnowledgeLink }) {
  const [copied, setCopied] = useState(false);
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-0.5">
      <Tag>{k.kind}</Tag>
      {k.url ? <Ext href={k.url}>{k.title}</Ext> : <span>{k.title}</span>}
      {k.kind === 'obsidian' && k.copyPath && (
        <button className="text-[11px] text-muted underline" onClick={async () => { setCopied(await copyText(k.copyPath!)); setTimeout(() => setCopied(false), 1500); }}>
          {copied ? 'copied' : 'copy path'}
        </button>
      )}
      {!k.url && k.kind !== 'obsidian' && <span className="text-[11px] text-muted">(no valid link configured)</span>}
      <span className="text-[11px] text-muted">· {k.source}</span>
    </li>
  );
}

function RefList({ refs, empty }: { refs: IssueRef[]; empty: string }) {
  if (!refs.length) return <span className="text-muted">{empty}</span>;
  return (
    <ul>
      {refs.map((r) => (
        <li key={r.identifier}>
          <Ext href={r.url} className="mono">{r.identifier}</Ext> {r.title}{' '}
          <Tag tone={r.resolved ? 'ok' : 'warn'}>{r.stateName}{r.resolved ? '' : ' · unresolved'}</Tag>
        </li>
      ))}
    </ul>
  );
}

function PrBlock({ pr }: { pr: PullRequest }) {
  return (
    <div className="rounded border border-line p-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <Ext href={pr.url} className="font-medium">#{pr.number} {pr.title}</Ext>
        <Tag tone={pr.state === 'merged' ? 'ok' : pr.state === 'open' ? 'accent' : 'muted'}>{pr.draft ? 'draft' : pr.state}</Tag>
      </div>
      <div className="text-[12px] text-muted">
        {pr.repo} · branch <Ext href={pr.branchUrl} className="mono" title={pr.branchUrl ? undefined : 'Branch link only available for open PRs'}>{pr.headRef}</Ext> → {pr.baseRef}
        {' '}· updated <Time iso={pr.updatedAt} />
      </div>
      <div className="text-[11px] text-muted">Linked via {pr.ticket.via}</div>
      <dl className="mt-1.5">
        <Row k="CI"><Pill status={pr.ci} /> <span className="text-muted">{pr.ci.detail}</span></Row>
        <Row k="Independent review"><Pill status={pr.independentReview} /> <span className="text-muted">{pr.independentReview.detail}</span></Row>
        <Row k="Human review"><Pill status={pr.humanReview} /> <span className="text-muted">{pr.humanReview.detail}</span></Row>
      </dl>
      {(!pr.detail.checksOk || !pr.detail.reviewsOk) && <p className="text-[12px] text-warn">Some evidence unavailable: {[!pr.detail.checksOk && 'checks', !pr.detail.reviewsOk && 'reviews'].filter(Boolean).join(', ')} (see integration health)</p>}
      {pr.checks.length > 0 && (
        <details className="mt-1" open={pr.ci.value === 'failed'}>
          <summary className="cursor-pointer text-[12px] text-muted">Checks ({pr.checks.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {pr.checks.map((c, i) => (
              <li key={i} className="flex gap-2"><Pill value={c.state} compact /><Ext href={c.url}>{c.name}</Ext><span className="text-muted">{c.rawConclusion ?? c.rawStatus} · {c.source === 'check_run' ? 'check run' : c.source === 'workflow_run' ? 'workflow run' : 'commit status'}</span></li>
            ))}
          </ul>
        </details>
      )}
      {pr.runs.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[12px] text-muted">Workflow runs ({pr.runs.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {pr.runs.slice(0, 8).map((r) => (
              <li key={r.id} className="flex gap-2"><Ext href={r.url}>{r.name}</Ext><span className="text-muted">{r.conclusion ?? r.status} · <Time iso={r.at} /></span></li>
            ))}
          </ul>
        </details>
      )}
      {pr.reviews.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[12px] text-muted">Review records ({pr.reviews.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {pr.reviews.map((r, i) => <li key={i}><Ext href={r.url}>{r.user}: {r.state}</Ext> <Time iso={r.at} /></li>)}
          </ul>
        </details>
      )}
      {pr.commits.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[12px] text-muted">Commits ({pr.commits.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {pr.commits.map((c) => <li key={c.sha}><Ext href={c.url} className="mono">{c.sha.slice(0, 7)}</Ext> {c.message} <span className="text-muted">{c.author}</span></li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

export function TicketDetail({ issue, snap, onOpen, loading, error }: { issue: Issue; snap: Snapshot; onOpen: (id: string) => void; loading?: boolean; error?: string }) {
  const project = snap.projects.find((p) => p.id === issue.projectId);
  const ms = snap.milestones.find((m) => m.id === issue.milestoneId);
  const prs = issue.prKeys.map((k) => snap.prs.find((p) => p.key === k)).filter((p): p is PullRequest => !!p);
  const attention = snap.attention.filter((a) => a.ticket === issue.identifier);
  const children = issue.childIdentifiers.map((id) => snap.issues.find((i) => i.identifier === id)).filter((x): x is Issue => !!x);
  const g = issue.gates;
  return (
    <div className="space-y-3">
      <div>
        <div className="flex flex-wrap items-baseline gap-2">
          <Ext href={issue.url} className="mono text-[13px] font-semibold">{issue.identifier}</Ext>
          <Tag>{issue.state.name}</Tag>
          {issue.rework.length > 0 && <Tag tone="bad">rework</Tag>}
          {issue.readiness === 'blocked' && <Tag tone="bad">blocked</Tag>}
          {issue.stale && <Tag tone="warn">stale</Tag>}
        </div>
        <h3 className="mt-0.5 text-[15px] font-semibold leading-snug">{issue.title}</h3>
        <div className="text-[12px] text-muted">{project?.name} · opens in Linear for editing; DevFlow is read-only</div>
      </div>

      <Card title="Lifecycle"><div className="p-2"><Lifecycle issue={issue} /></div></Card>

      <Card title="Gates & evidence">
        <dl className="p-2">
          <Row k="CI"><Pill status={g.ci} /><div className="text-muted">{g.ci.detail}</div></Row>
          <Row k="Independent review"><Pill status={g.review} /><div className="text-muted">{g.review.detail}</div></Row>
          <Row k="Human merge"><Pill status={g.merge} /><div className="text-muted">{g.merge.detail}</div></Row>
          <Row k="Stage evidence"><EvidenceList items={issue.stageEvidence} /></Row>
          {issue.awaitingHuman.length > 0 && <Row k="Awaiting you"><span className="text-warn">{issue.awaitingHuman.join('; ')}</span></Row>}
        </dl>
      </Card>

      {attention.length > 0 && <Card title="Needs attention"><AttentionList items={attention} compact /></Card>}

      <Card title="Linear">
        <dl className="p-2">
          <Row k="Priority">{issue.priorityLabel}</Row>
          <Row k="Assignee">{issue.assignee ?? <span className="text-muted">unassigned</span>}</Row>
          <Row k="Milestone">{ms && !ms.isUnassigned ? <><Ext href={ms.url}>{ms.name}</Ext> {ms.targetDate && <span className="text-muted">target {ms.targetDate}</span>}</> : <span className="text-muted">none</span>}</Row>
          <Row k="Labels">{issue.labels.length ? issue.labels.map((l) => <Tag key={l}>{l}</Tag>) : <span className="text-muted">none</span>}</Row>
          <Row k="Parent">{issue.parentIdentifier ? <button className="mono text-accent" onClick={() => onOpen(issue.parentIdentifier!)}>{issue.parentIdentifier}</button> : <span className="text-muted">none</span>}</Row>
          <Row k="Sub-tasks">{children.length ? children.map((c) => <div key={c.id}><button className="mono text-accent" onClick={() => onOpen(c.identifier)}>{c.identifier}</button> {c.title} <Tag>{c.state.name}</Tag></div>) : <span className="text-muted">none</span>}</Row>
          <Row k="Blocked by"><RefList refs={issue.blockedBy} empty="nothing" /></Row>
          <Row k="Blocks"><RefList refs={issue.blocks} empty="nothing" /></Row>
          <Row k="Due">{issue.dueDate ?? <span className="text-muted">none</span>}</Row>
          <Row k="Updated"><Time iso={issue.updatedAt} /></Row>
          {issue.branchName && <Row k="Linear branch"><span className="mono">{issue.branchName}</span></Row>}
          {issue.attachments.length > 0 && <Row k="Links">{issue.attachments.map((a) => <div key={a.url}><Ext href={a.url}>{a.title}</Ext> <span className="text-muted">({a.kind})</span></div>)}</Row>}
          {issue.recentChanges.length > 0 && <Row k="State history">{issue.recentChanges.map((c, i) => <div key={i}>{c.from ?? '?'} → {c.to ?? '?'} <Time iso={c.at} /></div>)}</Row>}
        </dl>
      </Card>

      <Card title="GitHub">
        <div className="space-y-2 p-2">
          {prs.length ? prs.map((p) => <PrBlock key={p.key} pr={p} />) : (
            <p className="text-muted">No PR is linked. DevFlow links only on an explicit identifier in the branch/PR title or a Linear attachment.{issue.prLinkNote ? ` ${issue.prLinkNote}.` : ''}</p>
          )}
        </div>
      </Card>

      <Card title="Description">
        <div className="max-h-72 overflow-auto whitespace-pre-wrap break-words p-2 text-[12px]">{issue.description || (loading ? <span className="text-muted">Loading description and PR evidence…</span>
          : !issue.detailAt ? <span className="text-warn">{error ? `Could not load details: ${error}` : 'Description not loaded yet.'}</span>
          : <span className="text-muted">No description.</span>)}</div>
      </Card>

      <Card title="Prompts">
        <div className="p-2"><Prompts prompts={snap.prompts} project={project?.name ?? issue.projectId} ticket={issue.identifier} milestone={ms && !ms.isUnassigned ? ms.name : undefined} /></div>
      </Card>
    </div>
  );
}

export function ProjectDetail({ project, snap }: { project: ProjectInfo; snap: Snapshot }) {
  const health = snap.health.filter((h) => h.id.startsWith(`linear:${project.id}`) || project.repos.some((r) => h.id === `github:${r.repo}`));
  return (
    <div className="space-y-3">
      <h3 className="text-[15px] font-semibold">{project.name}</h3>
      <Card title="Go to source">
        <ul className="space-y-1 p-2">
          <li><span className="inline-block w-24 text-muted">Linear</span>{project.linearUrl ? <Ext href={project.linearUrl}>Project</Ext> : <span className="text-muted">no project URL (not loaded, or several Linear projects)</span>}</li>
          {project.repos.map((r) => (
            <li key={r.repo}><span className="inline-block w-24 text-muted">GitHub</span><Ext href={r.url}>{r.repo}</Ext> · <Ext href={`${r.url}/pulls`}>PRs</Ext> · <Ext href={r.actionsUrl}>Actions</Ext></li>
          ))}
        </ul>
      </Card>
      <Card title="Project knowledge">
        {project.knowledge.length ? <ul className="p-2">{project.knowledge.map((k, i) => <KnowledgeItem key={i} k={k} />)}</ul>
          : <p className="p-2 text-muted">None configured. Add "knowledge" entries to devflow.config.json.</p>}
      </Card>
      <Card title="Integration health">
        <ul className="space-y-1 p-2">{health.map((h) => <li key={h.id}><b>{h.label}</b>: {h.state}{h.error ? ` — ${h.error}` : ''} {h.lastSuccess && <span className="text-muted">last ok <Time iso={h.lastSuccess} /></span>}</li>)}</ul>
      </Card>
      <Card title="Prompts">
        <div className="p-2"><Prompts prompts={snap.prompts} project={project.name} /><p className="mt-1 text-[11px] text-muted">Select a ticket to fill in its identifier.</p></div>
      </Card>
    </div>
  );
}

export function AttentionList({ items, onOpen, compact }: { items: AttentionItem[]; onOpen?: (ticket: string) => void; compact?: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((a) => (
        <li key={a.id} className="flex gap-2 px-3 py-2">
          <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${a.severity === 'high' ? 'bg-bad' : a.severity === 'medium' ? 'bg-warn' : 'bg-muted'}`} title={`${a.severity} severity`} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2">
              {a.ticket && onOpen ? <button className="text-left font-medium hover:underline" onClick={() => onOpen(a.ticket!)}>{a.title}</button> : <span className="font-medium">{a.title}</span>}
              <Tag tone={a.actionable ? 'accent' : 'muted'}>{a.actionable ? 'actionable' : 'suggestion'}</Tag>
            </div>
            <div className="text-[12px]"><span className="text-muted">Cause: </span>{a.cause}</div>
            {!compact && <div className="text-[12px]"><span className="text-muted">Evidence: </span><EvidenceList items={a.evidence} /></div>}
            {compact && a.evidence.length > 0 && <div className="text-[12px]"><EvidenceList items={a.evidence} /></div>}
            <div className="text-[12px]"><span className="text-muted">Next: </span>{a.nextAction}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export { btn };
