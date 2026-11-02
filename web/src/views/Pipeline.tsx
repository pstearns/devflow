import { STAGES, type Issue, type PullRequest, type Snapshot } from '../../../shared/types.ts';
import { Ext, Pill, Tag, Time } from '../components/ui.tsx';

function TicketCard({ i, pr, onOpen, now }: { i: Issue; pr?: PullRequest; onOpen: (id: string) => void; now: number }) {
  const hot = i.rework.length > 0;
  return (
    <div className={`rounded border bg-raised p-2 ${hot ? 'border-bad/70' : i.readiness === 'blocked' ? 'border-warn/70' : 'border-line'}`}>
      <div className="flex items-center justify-between gap-1">
        <button className="mono font-semibold text-accent hover:underline" onClick={() => onOpen(i.identifier)}>{i.identifier}</button>
        <Ext href={i.url} title="Open in Linear">Linear</Ext>
      </div>
      <button className="mt-0.5 block text-left leading-snug hover:underline" onClick={() => onOpen(i.identifier)}>{i.title}</button>
      <div className="mt-1 flex flex-wrap gap-1">
        <Tag>{i.state.name}</Tag>
        {i.readiness === 'blocked' && <Tag tone="warn">blocked{i.openBlockers.length ? ` by ${i.openBlockers.map((b) => b.identifier).join(', ')}` : ''}</Tag>}
        {hot && <Tag tone="bad">↺ {i.rework.join('; ')}</Tag>}
        {i.stale && <Tag tone="warn">stale</Tag>}
        {i.awaitingHuman.length > 0 && <Tag tone="accent">awaiting you</Tag>}
      </div>
      {pr ? (
        <div className="mt-1.5 space-y-0.5 text-[12px]">
          <div><Ext href={pr.url} className="mono">PR #{pr.number}</Ext> <span className="text-muted">{pr.draft ? 'draft' : pr.state} · <Time iso={pr.updatedAt} now={now} /></span></div>
          <div className="flex gap-3"><span title="CI"><span className="text-muted">CI </span><Pill status={pr.ci} /></span></div>
          <div className="flex gap-3"><span><span className="text-muted">Review </span><Pill status={pr.independentReview} label={pr.independentReview.value === 'unknown' ? 'Unknown' : undefined} /></span></div>
        </div>
      ) : (i.stage && !['discovery', 'ready'].includes(i.stage)) ? <div className="mt-1 text-[12px] text-muted">No linked PR evidence</div> : null}
    </div>
  );
}

export function Pipeline({ snap, issues, onOpen, now }: { snap: Snapshot; issues: Issue[]; onOpen: (id: string) => void; now: number }) {
  const prOf = (i: Issue) => snap.prs.find((p) => p.key === i.primaryPrKey);
  const canceled = issues.filter((i) => i.state.type === 'canceled').length;
  const noStage = issues.filter((i) => !i.stage && i.state.type !== 'canceled');
  const unlinked = snap.prs.filter((p) => p.state === 'open' && p.ticket.link !== 'linked' && issues.some((i) => i.projectId === p.projectId));
  return (
    <div className="space-y-3">
      <div className="flex gap-2 overflow-x-auto pb-2">
        {STAGES.map((s) => {
          let list = issues.filter((i) => i.stage === s.id);
          const total = list.length;
          if (s.id === 'done') list = list.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')).slice(0, 10);
          return (
            <section key={s.id} className="w-[250px] shrink-0 rounded-md border border-line bg-panel">
              <header className="flex items-center justify-between border-b border-line px-2.5 py-1.5">
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{s.label}</h2>
                <span className="mono tabular">{total}</span>
              </header>
              <div className="space-y-2 p-2">
                {list.map((i) => <TicketCard key={i.id} i={i} pr={prOf(i)} onOpen={onOpen} now={now} />)}
                {!list.length && <div className="py-4 text-center text-muted">—</div>}
                {s.id === 'done' && total > list.length && <div className="text-center text-[11px] text-muted">latest {list.length} of {total}; see Milestones & Tasks for all</div>}
              </div>
            </section>
          );
        })}
      </div>
      {noStage.length > 0 && <p className="text-muted">{noStage.length} ticket(s) have an unrecognised Linear state and no stage evidence: {noStage.map((i) => i.identifier).join(', ')}</p>}
      <p className="text-[12px] text-muted">{canceled} canceled ticket(s) are not shown. Stage = furthest stage with evidence (Linear state + linked PR, CI and review records). Tickets with failing CI or review findings stay in Implementation and are marked ↺.</p>
      {unlinked.length > 0 && (
        <div className="rounded-md border border-line bg-panel p-2.5">
          <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Open PRs not linked to a ticket ({unlinked.length})</h2>
          <ul>{unlinked.map((p) => <li key={p.key}><Ext href={p.url}>#{p.number} {p.title}</Ext> <span className="text-muted">— {p.ticket.link}: {p.ticket.via}</span></li>)}</ul>
        </div>
      )}
    </div>
  );
}
