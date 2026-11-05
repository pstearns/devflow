import type { Issue, Snapshot } from '../../../shared/types.ts';
import { AttentionList } from '../components/Detail.tsx';
import { Card, Empty, Ext, Pill, Tag, Time } from '../components/ui.tsx';
import { READY_TILE_FILTER, attentionInSel, eventInSel, matchesStatusFilter, prInSel, type Route, type Sel } from '../lib.ts';

export function Overview({ snap, issues, sel, go, now }: {
  snap: Snapshot; issues: Issue[]; sel: Sel; go: (p: Partial<Route>, replace?: boolean) => void; now: number;
}) {
  const open = (id: string) => go({ ticket: id, panel: undefined });
  const weekAgo = now - 7 * 86400000;
  const tiles: { label: string; n: number; sub?: string; params: Record<string, string>; tone?: 'bad' }[] = [
    // the count and the link use the same filter as the Milestones view, so the list the tile opens is exactly this count
    { label: 'Ready', n: issues.filter((i) => matchesStatusFilter(i, READY_TILE_FILTER)).length, sub: 'unblocked, not started', params: { ...READY_TILE_FILTER } },
    { label: 'In progress', n: issues.filter((i) => i.stage === 'implementation' || i.stage === 'ci').length, sub: 'implementation / CI', params: { status: 'progress' } },
    { label: 'In review', n: issues.filter((i) => i.stage === 'review' || i.stage === 'merge').length, sub: 'review / awaiting merge', params: { status: 'review' } },
    { label: 'Blocked', n: issues.filter((i) => i.readiness === 'blocked').length, sub: 'blocker, blocked state or label', params: { blocked: '1' }, tone: 'bad' },
    { label: 'Done', n: issues.filter((i) => i.stage === 'done').length, sub: `${issues.filter((i) => i.completedAt && Date.parse(i.completedAt) > weekAgo).length} in last 7d`, params: { status: 'done' } },
  ];
  const attention = snap.attention.filter((a) => attentionInSel(sel, a));
  const prs = snap.prs.filter((p) => p.state === 'open' && prInSel(sel, p.scope));
  const activity = snap.activity.filter((a) => eventInSel(sel, a)).slice(0, 14);
  // "Go to source": only what is configured for the teams/projects in the current selection
  const sources = snap.teams.filter((t) => t.loaded && (!sel.team || t.key === sel.team)).flatMap((t) => {
    const projs = t.projects.filter((p) => sel.project === 'all' || sel.project === p.id);
    const rows = projs.map((p) => ({ key: `${t.key}:${p.id}`, title: `${t.name} › ${p.name}`, url: p.url, repos: p.repos, knowledge: p.knowledge }));
    if (sel.project === 'all' || sel.project === 'none') rows.push({ key: `${t.key}:team`, title: `${t.name} (team level / unprojected)`, url: undefined, repos: t.teamLevel.repos, knowledge: t.teamLevel.knowledge });
    return rows;
  });
  const ticketName = (id?: string) => id && issues.find((i) => i.identifier === id);

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {tiles.map((t) => (
            <button key={t.label} onClick={() => go({ view: 'milestones', params: t.params }, true)} className="rounded-md border border-line bg-panel p-2.5 text-left hover:border-accent">
              <div className="text-[11px] uppercase tracking-wider text-muted">{t.label}</div>
              <div className={`mono text-2xl font-semibold tabular ${t.tone === 'bad' && t.n ? 'text-bad' : ''}`}>{t.n}</div>
              <div className="text-[11px] text-muted">{t.sub}</div>
            </button>
          ))}
        </div>

        <Card title={`Needs attention (${attention.length})`} right={<span className="text-[11px] text-muted">actionable = backed by source evidence · suggestion = DevFlow inference</span>}>
          {attention.length ? <AttentionList items={attention} onOpen={open} /> : <Empty>Nothing needs attention based on the data currently loaded.</Empty>}
        </Card>

        <Card title={`Open pull requests (${prs.length})`}>
          {prs.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left">
                <thead className="text-[11px] uppercase tracking-wider text-muted">
                  <tr><th className="px-3 py-1.5 font-medium">PR</th><th className="font-medium">Ticket</th><th className="font-medium">CI</th><th className="font-medium">Indep. review</th><th className="font-medium">Human review</th><th className="pr-3 font-medium">Updated</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {prs.map((p) => (
                    <tr key={p.key}>
                      <td className="max-w-[320px] truncate px-3 py-1.5"><Ext href={p.url}>#{p.number}</Ext> <span title={p.title}>{p.title}</span>{p.draft && <> <Tag>draft</Tag></>}</td>
                      <td>{p.ticket.identifier ? <button className="mono text-accent" onClick={() => open(p.ticket.identifier!)}>{p.ticket.identifier}</button>
                        : <span className="text-muted" title={p.ticket.via}>{p.ticket.link === 'ambiguous' ? 'ambiguous' : 'unlinked'}</span>}</td>
                      <td><Pill status={p.ci} /></td><td><Pill status={p.independentReview} /></td><td><Pill status={p.humanReview} /></td>
                      <td className="pr-3"><Time iso={p.updatedAt} now={now} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty>No open pull requests in the loaded data.</Empty>}
        </Card>
      </div>

      <div className="min-w-0 space-y-3">
        <Card title="Go to source">
          <div className="divide-y divide-line">
            {sources.map((p) => (
              <div key={p.key} className="space-y-0.5 px-3 py-2">
                <div className="font-medium">{p.title}</div>
                <div className="flex flex-wrap gap-x-3">
                  {p.url ? <Ext href={p.url}>Linear</Ext> : null}
                  {p.repos.length ? p.repos.map((r) => <span key={r.repo} className="text-[12px]">{r.repo.split('/')[1]}: <Ext href={r.url}>repo</Ext> · <Ext href={`${r.url}/pulls`}>PRs</Ext> · <Ext href={r.actionsUrl}>Actions</Ext></span>) : <span className="text-[12px] text-muted">no GitHub repository configured</span>}
                </div>
                {p.knowledge.length > 0 && <div className="flex flex-wrap gap-x-3 text-[12px]">{p.knowledge.slice(0, 4).map((k, i) => <Ext key={i} href={k.url}>{k.title}</Ext>)}{p.knowledge.length > 4 && sel.team && <button className="text-muted underline" onClick={() => go({ panel: 'project', ticket: undefined })}>+{p.knowledge.length - 4} more</button>}</div>}
              </div>
            ))}
            {!sources.length && <Empty>Nothing to link for this selection.</Empty>}
          </div>
        </Card>
        <Card title="Recent activity" right={<button className="text-[11px] text-accent" onClick={() => go({ view: 'activity' })}>all →</button>}>
          {activity.length ? (
            <ul className="divide-y divide-line">
              {activity.map((a) => (
                <li key={a.id} className="px-3 py-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate"><Tag>{a.source === 'github' ? 'GH' : 'LN'}</Tag> <Ext href={a.url}>{a.title}</Ext></span>
                    <Time iso={a.ts} now={now} />
                  </div>
                  <div className="flex gap-2 text-[12px] text-muted">{a.status && <Pill value={a.status} compact />}<span className="truncate">{a.detail}</span>
                    {a.ticket && ticketName(a.ticket) && <button className="mono text-accent" onClick={() => open(a.ticket!)}>{a.ticket}</button>}</div>
                </li>
              ))}
            </ul>
          ) : <Empty>No activity in the loaded data.</Empty>}
        </Card>
      </div>
    </div>
  );
}
