import { useEffect, useState } from 'react';
import type { RunActivityEvent, RunActivitySnapshot } from '../../../shared/types.ts';
import { Card, Tag } from './ui.tsx';

const AGENTS = ['claude', 'codex'] as const;
const ACTORS: Record<RunActivityEvent['actor'], string> = {
  claude: 'Claude', codex: 'Codex', ci: 'CI', devflow: 'DevFlow',
};
const PHASES: Record<string, string> = {
  accepted: 'Accepted',
  implementing: 'Implementing',
  'verifying-commit': 'Verifying commit',
  ci: 'Waiting for CI',
  reviewing: 'Independent review',
  publishing: 'Publishing review',
  repairing: 'Repairing',
  'awaiting-owner': 'Awaiting owner',
  escalated: 'Escalated',
  aborted: 'Aborted',
};
const timestamp = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });

export function RunActivity({ identifier }: { identifier: string }) {
  const [activity, setActivity] = useState<RunActivitySnapshot>();
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting' | 'unavailable'>('connecting');

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      setConnection('unavailable');
      return;
    }
    const stream = new EventSource(`/api/issue/${encodeURIComponent(identifier)}/run-activity`);
    stream.addEventListener('activity', (event: MessageEvent<string>) => {
      try {
        const snapshot = JSON.parse(event.data) as RunActivitySnapshot | null;
        if (!snapshot || !Array.isArray(snapshot.events)) return;
        setActivity(snapshot);
        setConnection('live');
      } catch {
        // Preserve the last complete snapshot until the server sends another one.
      }
    });
    stream.addEventListener('unavailable', () => {
      stream.close();
      setActivity(undefined);
      setConnection('unavailable');
    });
    stream.onerror = () => {
      setConnection(stream.readyState === EventSource.CLOSED ? 'unavailable' : 'reconnecting');
    };
    return () => stream.close();
  }, [identifier]);

  const connectionLabel = {
    connecting: 'Connecting…',
    live: 'Live',
    reconnecting: 'Reconnecting…',
    unavailable: 'Unavailable',
  }[connection];

  return (
    <Card title="Run Activity" right={
      <span role="status"><Tag tone={connection === 'live' ? 'ok' : 'muted'}>{connectionLabel}</Tag></span>
    }>
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Agents">
          {AGENTS.map((agent) => {
            const active = connection === 'live' && activity?.activeAgent === agent;
            return (
              <div key={agent} className={`flex min-w-0 items-center gap-2 rounded border p-2 ${active ? 'border-accent bg-accent/10' : 'border-line bg-raised'}`}>
                <span aria-hidden="true" className={`mono flex size-8 shrink-0 items-center justify-center rounded-full border font-semibold ${active ? 'border-accent text-accent' : 'border-line text-muted'}`}>
                  {agent === 'claude' ? 'C' : '>_'}
                </span>
                <div className="min-w-0">
                  <div className="font-medium">{ACTORS[agent]}</div>
                  <div className={`flex items-center gap-1 text-[11px] ${active ? 'text-accent' : 'text-muted'}`}>
                    {active && <span className="size-1.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse" aria-hidden="true" />}
                    {active ? 'Active' : connection === 'live' ? 'Idle' : 'Status unavailable'}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {activity?.runId ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-1 text-[11px]">
              <span className="mono text-muted">Run {activity.runId}</span>
              {activity.state && <Tag>{PHASES[activity.state] ?? activity.state}</Tag>}
            </div>
            <ol aria-label="Run handoffs" className="max-h-72 space-y-2 overflow-y-auto">
              {[...activity.events].reverse().map((event) => (
                <li key={event.id} className="rounded border border-line bg-raised p-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[11px] text-muted">
                    <span>{ACTORS[event.actor]}</span>
                    <time dateTime={event.at} className="tabular">{timestamp.format(Date.parse(event.at))}</time>
                  </div>
                  <div className="break-words font-medium">{event.title}</div>
                  {event.detail && <p className="whitespace-pre-wrap break-words text-[12px] text-muted">{event.detail}</p>}
                </li>
              ))}
            </ol>
          </>
        ) : connection === 'live' ? <p className="text-muted">No runs recorded for this ticket.</p>
          : connection === 'unavailable' ? <p className="text-muted">Run activity is unavailable for this ticket.</p>
            : null}
      </div>
    </Card>
  );
}
