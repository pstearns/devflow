import { useMemo, useState } from 'react';
import type { ActivityEvent, Snapshot } from '../../../shared/types.ts';
import { Card, Empty, Ext, Pill, Tag, Time, select } from '../components/ui.tsx';
import { eventInSel, type Sel } from '../lib.ts';

const KIND: Record<ActivityEvent['kind'], string> = {
  pr_opened: 'PR opened', pr_merged: 'PR merged', pr_closed: 'PR closed', pr_updated: 'PR updated', ci_run: 'CI run', issue_changed: 'State change', issue_updated: 'Issue updated',
};

export function Activity({ snap, sel, onOpen, now }: { snap: Snapshot; sel: Sel; onOpen: (id: string) => void; now: number }) {
  const [source, setSource] = useState('all');
  const [status, setStatus] = useState('all');
  const [kind, setKind] = useState('all');
  const list = useMemo(() => snap.activity.filter((a) =>
    eventInSel(sel, a) && (source === 'all' || a.source === source) && (kind === 'all' || a.kind === kind) &&
    (status === 'all' || (status === 'none' ? !a.status : a.status === status))), [snap, sel.team, sel.project, source, status, kind]);
  const tname = (key: string) => snap.teams.find((t) => t.key === key)?.name ?? key;
  return (
    <Card
      title={`Activity (${list.length})`}
      right={
        <div className="flex flex-wrap gap-2">
          <select aria-label="Source" className={select} value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">All sources</option><option value="github">GitHub</option><option value="linear">Linear</option>
          </select>
          <select aria-label="Event type" className={select} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">All events</option>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select aria-label="Status" className={select} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">Any status</option><option value="passed">Passed</option><option value="failed">Failed</option><option value="pending">Pending</option><option value="unknown">Unknown</option><option value="none">No status</option>
          </select>
        </div>
      }
    >
      {list.length ? (
        <ul className="divide-y divide-line">
          {list.map((a) => (
            <li key={a.id} className="grid grid-cols-[80px_92px_1fr] items-baseline gap-x-3 px-3 py-1.5 md:grid-cols-[80px_110px_minmax(0,1fr)_160px]">
              <Time iso={a.ts} now={now} />
              <span><Tag tone={a.source === 'github' ? 'muted' : 'accent'}>{a.source === 'github' ? 'GitHub' : 'Linear'}</Tag> <span className="text-muted">{KIND[a.kind]}</span></span>
              <span className="min-w-0">
                <Ext href={a.url} className="break-words">{a.title}</Ext>
                <span className="ml-2 text-[12px] text-muted">{a.detail}</span>
                {a.ticket && <button className="mono ml-2 text-accent" onClick={() => onOpen(a.ticket!)}>{a.ticket}</button>}
              </span>
              <span className="hidden justify-self-end md:flex md:items-center md:gap-2">{a.status && <Pill value={a.status} />}<span className="text-[11px] text-muted">{!sel.team ? tname(a.teamKey) : ''}</span></span>
            </li>
          ))}
        </ul>
      ) : <Empty>No activity matches these filters.</Empty>}
    </Card>
  );
}
