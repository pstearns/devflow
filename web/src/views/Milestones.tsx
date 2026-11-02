import { useMemo, useState } from 'react';
import type { Issue, Milestone, Snapshot } from '../../../shared/types.ts';
import { Prompts } from '../components/Prompts.tsx';
import { Card, Empty, Ext, Pill, Tag, select } from '../components/ui.tsx';
import { BUCKETS, PRIORITIES, bucketOf, type Route } from '../lib.ts';

function Progress({ m }: { m: Milestone }) {
  if (m.progress === null) return <span className="text-muted">no countable tasks</span>;
  const pct = Math.round(m.progress * 100);
  return (
    <div className="flex items-center gap-2" title={`${m.done} done of ${m.total - m.canceled} (${m.canceled} canceled excluded)`}>
      <div className="h-1.5 w-28 overflow-hidden rounded bg-raised" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-ok" style={{ width: `${pct}%` }} />
      </div>
      <span className="mono tabular">{pct}%</span>
      <span className="text-muted">{m.done}/{m.total - m.canceled}</span>
    </div>
  );
}

function TaskRow({ i, depth, snap, onOpen, parentNote }: { i: Issue; depth: number; snap: Snapshot; onOpen: (id: string) => void; parentNote?: string }) {
  const pr = snap.prs.find((p) => p.key === i.primaryPrKey);
  return (
    <tr className="align-top hover:bg-raised/50">
      <td className="whitespace-nowrap py-1.5 pl-3" style={{ paddingLeft: 12 + depth * 16 }}>
        {depth > 0 && <span className="mr-1 text-muted" aria-hidden>↳</span>}
        <button className="mono text-accent hover:underline" onClick={() => onOpen(i.identifier)}>{i.identifier}</button>
      </td>
      <td className="max-w-[360px] py-1.5">
        <button className="text-left hover:underline" onClick={() => onOpen(i.identifier)}>{i.title}</button>
        {parentNote && <div className="text-[11px] text-muted">sub-task of {parentNote}</div>}
      </td>
      <td className="whitespace-nowrap"><Tag>{i.state.name}</Tag></td>
      <td className="whitespace-nowrap text-muted">{i.priorityLabel}</td>
      <td className="whitespace-nowrap">
        {i.readiness === 'blocked' ? <Tag tone="bad">blocked{i.openBlockers.length ? ` · ${i.openBlockers.map((b) => b.identifier).join(', ')}` : ''}</Tag>
          : i.readiness === 'ready' ? <Tag tone="ok">ready</Tag> : i.readiness === 'not-ready' ? <Tag>not ready</Tag> : <span className="text-muted">—</span>}
      </td>
      <td className="whitespace-nowrap">{pr ? <><Ext href={pr.url} className="mono">#{pr.number}</Ext> <Pill status={pr.ci} compact /></> : <span className="text-muted">{i.stage && !['discovery', 'ready', 'done'].includes(i.stage) ? 'no PR evidence' : '—'}</span>}</td>
      <td className="whitespace-nowrap pr-3">{i.awaitingHuman.length ? <Tag tone="accent">{i.awaitingHuman[0]}</Tag> : i.rework.length ? <Tag tone="bad">↺ {i.rework[0]}</Tag> : i.stale ? <Tag tone="warn">stale</Tag> : ''}</td>
      <td className="whitespace-nowrap pr-3"><Ext href={i.url} title="Open in Linear to edit">Linear</Ext></td>
    </tr>
  );
}

export function Milestones({ snap, issues, project, route, go, onOpen }: {
  snap: Snapshot; issues: Issue[]; project: string; route: Route; go: (p: Partial<Route>) => void; onOpen: (id: string) => void;
}) {
  const f = route.params;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const set = (k: string, v: string) => go({ params: { [k]: v } });

  const issueBy = useMemo(() => new Map(snap.issues.map((i) => [i.identifier, i])), [snap]);
  const match = (i: Issue) =>
    (!f.status || bucketOf(i) === f.status) && (!f.priority || String(i.priority) === f.priority) && (f.blocked !== '1' || i.readiness === 'blocked') &&
    (f.human !== '1' || i.awaitingHuman.length > 0) && (!q || `${i.identifier} ${i.title}`.toLowerCase().includes(q.toLowerCase()));
  const filtering = !!(f.status || f.priority || f.blocked === '1' || f.human === '1' || q);

  const milestones = snap.milestones
    .filter((m) => (project === 'all' || m.projectId === project) && (!f.milestone || m.id === f.milestone))
    .sort((a, b) => Number(a.isUnassigned) - Number(b.isUnassigned) || Number(b.overdue) - Number(a.overdue) || (a.targetDate ?? '9').localeCompare(b.targetDate ?? '9') || a.name.localeCompare(b.name));
  const msOptions = snap.milestones.filter((m) => project === 'all' || m.projectId === project);
  const pname = (id: string) => snap.projects.find((p) => p.id === id)?.name ?? id;
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const rows = (m: Milestone) => {
    const mine = m.issueIdentifiers.map((id) => issueBy.get(id)).filter((x): x is Issue => !!x);
    const shown = mine.filter(match);
    const ids = new Set(shown.map((i) => i.identifier));
    const tops = shown.filter((i) => !i.parentIdentifier || !ids.has(i.parentIdentifier));
    const out: { i: Issue; depth: number; note?: string }[] = [];
    const walk = (i: Issue, d: number) => {
      out.push({ i, depth: d, note: d === 0 && i.parentIdentifier ? i.parentIdentifier : undefined });
      for (const c of shown.filter((x) => x.parentIdentifier === i.identifier)) walk(c, d + 1);
    };
    tops.forEach((t) => walk(t, 0));
    return { out, total: mine.length, shown: shown.length };
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-panel px-3 py-2">
        <select aria-label="Milestone" className={select} value={f.milestone ?? ''} onChange={(e) => set('milestone', e.target.value)}>
          <option value="">All milestones</option>{msOptions.map((m) => <option key={m.id} value={m.id}>{m.name}{project === 'all' ? ` — ${pname(m.projectId)}` : ''}</option>)}
        </select>
        <select aria-label="Status" className={select} value={f.status ?? ''} onChange={(e) => set('status', e.target.value)}>
          <option value="">Any status</option>{BUCKETS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
        </select>
        <select aria-label="Priority" className={select} value={f.priority ?? ''} onChange={(e) => set('priority', e.target.value)}>
          <option value="">Any priority</option>{PRIORITIES.map((p) => <option key={p.v} value={p.v}>{p.l}</option>)}
        </select>
        <label className="flex items-center gap-1"><input type="checkbox" checked={f.blocked === '1'} onChange={(e) => set('blocked', e.target.checked ? '1' : '')} /> Blocked only</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={f.human === '1'} onChange={(e) => set('human', e.target.checked ? '1' : '')} /> Awaiting me</label>
        <input aria-label="Search" placeholder="Search id or title" className={`${select} w-44`} value={q} onChange={(e) => setQ(e.target.value)} />
        {(filtering || f.milestone) && <button className="text-accent" onClick={() => { setQ(''); go({ params: {} }); }}>Clear filters</button>}
        <span className="ml-auto text-[11px] text-muted">Read-only. Edit tasks and milestones in Linear, then refresh.</span>
      </div>

      {milestones.length === 0 && <Card><Empty>No milestones or tasks loaded. Check integration health.</Empty></Card>}
      {milestones.map((m) => {
        const { out, total, shown } = rows(m);
        if (filtering && shown === 0) return null;
        const expanded = open.has(m.id) || (filtering && shown > 0);
        const blockedN = m.issueIdentifiers.filter((id) => issueBy.get(id)?.readiness === 'blocked').length;
        const humanN = m.issueIdentifiers.filter((id) => (issueBy.get(id)?.awaitingHuman.length ?? 0) > 0).length;
        return (
          <section key={m.id} className={`rounded-md border bg-panel ${m.overdue ? 'border-bad/60' : 'border-line'}`}>
            <header className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
              <button className="flex items-center gap-2 text-left" onClick={() => toggle(m.id)} aria-expanded={expanded}>
                <span className="mono w-3 text-muted" aria-hidden>{expanded ? '▾' : '▸'}</span>
                <span className="text-[14px] font-semibold">{m.name}</span>
              </button>
              {project === 'all' && <span className="text-muted">{pname(m.projectId)}</span>}
              {m.isUnassigned ? <Tag>{m.id.startsWith('unknown') ? 'unreadable milestone' : 'unassigned'}</Tag>
                : <span className={m.overdue ? 'text-bad' : 'text-muted'}>{m.targetDate ? `${m.overdue ? 'Overdue · ' : 'Target '}${m.targetDate}` : 'No target date'}</span>}
              <Progress m={m} />
              <span className="text-muted">{m.total} task{m.total === 1 ? '' : 's'}{m.started ? ` · ${m.started} started` : ''}{m.canceled ? ` · ${m.canceled} canceled` : ''}</span>
              {blockedN > 0 && <Tag tone="bad">{blockedN} blocked</Tag>}
              {humanN > 0 && <Tag tone="accent">{humanN} awaiting you</Tag>}
              <span className="ml-auto flex items-center gap-3">
                {!m.isUnassigned && <Ext href={m.url} title={m.url ? 'Linear project (milestones are edited there)' : 'No Linear URL available'}>Edit in Linear</Ext>}
              </span>
            </header>
            {expanded && (
              <div className="border-t border-line">
                {!m.isUnassigned && m.description && <p className="whitespace-pre-wrap px-3 py-2 text-[12px] text-muted">{m.description}</p>}
                {out.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[820px] text-left">
                      <thead className="text-[11px] uppercase tracking-wider text-muted">
                        <tr><th className="py-1 pl-3 font-medium">Task</th><th className="font-medium">Title</th><th className="font-medium">State</th><th className="font-medium">Priority</th><th className="font-medium">Readiness</th><th className="font-medium">PR / CI</th><th className="font-medium">Needs</th><th /></tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {out.map((r) => <TaskRow key={r.i.id} i={r.i} depth={r.depth} snap={snap} onOpen={onOpen} parentNote={r.note} />)}
                      </tbody>
                    </table>
                  </div>
                ) : <Empty>{total ? 'No tasks match the filters.' : 'No tasks in this milestone.'}</Empty>}
                {!m.isUnassigned && (
                  <div className="border-t border-line px-3 py-2">
                    <Prompts prompts={snap.prompts} only={['milestone']} project={pname(m.projectId)} milestone={m.name} />
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
