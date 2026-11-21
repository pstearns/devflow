import { useEffect, useState } from 'react';
import type { RunActivityEvent, RunActivityFeedEntry, RunActivitySnapshot } from '../../../shared/types.ts';
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

function useActivityStream<T>(path: string, valid: (data: unknown) => boolean) {
  const [activity, setActivity] = useState<T>();
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting' | 'unavailable'>('connecting');

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      setConnection('unavailable');
      return;
    }
    const stream = new EventSource(path);
    stream.addEventListener('activity', (event: MessageEvent<string>) => {
      try {
        const snapshot: unknown = JSON.parse(event.data);
        if (!valid(snapshot)) return;
        setActivity(snapshot as T);
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
  }, [path, valid]);

  const connectionLabel = {
    connecting: 'Connecting…',
    live: 'Live',
    reconnecting: 'Reconnecting…',
    unavailable: 'Unavailable',
  }[connection];

  return { activity, connection, connectionLabel };
}

const isRun = (data: unknown) => typeof data === 'object' && data !== null && 'events' in data && Array.isArray(data.events);

function EventLine({ event }: { event: RunActivityEvent }) {
  const time = Date.parse(event.at);
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[11px] text-muted">
        <span>{ACTORS[event.actor]}</span>
        {Number.isFinite(time) && <time dateTime={event.at} className="tabular">{timestamp.format(time)}</time>}
      </div>
      <div className="break-words font-medium">{event.title}</div>
      {event.detail && <p className="whitespace-pre-wrap break-words text-[12px] text-muted">{event.detail}</p>}
    </>
  );
}

export function RunActivityFeed({ onOpen }: { onOpen: (id: string) => void }) {
  const [activity, setActivity] = useState<RunActivityFeedEntry[]>();
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting' | 'unavailable'>('connecting');
  useEffect(() => {
    let pending: AbortController | undefined;
    const update = async () => {
      if (document.visibilityState !== 'visible' || pending) return;
      const request = new AbortController();
      pending = request;
      try {
        const response = await fetch('/api/run-activity', { cache: 'no-store', signal: request.signal, credentials: 'same-origin' });
        if (request.signal.aborted) return;
        if (response.status === 401 || response.status === 403) {
          setActivity(undefined);
          setConnection('unavailable');
          return;
        }
        if (!response.ok) throw new Error('Run activity unavailable');
        const entries: unknown = await response.json();
        if (request.signal.aborted) return;
        if (!Array.isArray(entries)) throw new Error('Invalid run activity');
        setActivity(entries);
        setConnection('live');
      } catch {
        if (!request.signal.aborted) setConnection('reconnecting');
      } finally {
        if (pending === request) pending = undefined;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void update();
      else { pending?.abort(); pending = undefined; }
    };
    const timer = setInterval(update, 2_000);
    document.addEventListener('visibilitychange', onVisibility);
    void update();
    return () => {
      pending?.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  const connectionLabel = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…', unavailable: 'Unavailable' }[connection];
  const runs = [...(activity ?? [])].sort((a, b) => Number(!!b.activeAgent) - Number(!!a.activeAgent));
  return (
    <Card title="Run Activity" right={<span role="status"><Tag tone={connection === 'live' ? 'ok' : 'muted'}>{connectionLabel}</Tag></span>}>
      <div className="space-y-3 p-2">
        {runs.map((run) => (
          <section key={run.identifier} className="rounded border border-line bg-raised p-2" aria-label={run.identifier}>
            <div className="flex flex-wrap items-center justify-between gap-1">
              <button type="button" onClick={() => onOpen(run.identifier)} className="mono font-semibold text-accent hover:underline">{run.identifier}</button>
              {run.state && <Tag>{PHASES[run.state] ?? run.state}</Tag>}
            </div>
            {connection === 'live' && run.activeAgent && <p className="text-[11px] text-accent">Last recorded agent: {ACTORS[run.activeAgent]}</p>}
            <ol aria-label={`${run.identifier} handoffs`} className="mt-1 space-y-1">
              {[...run.events].reverse().map((event) => (
                <li key={event.id} className="border-t border-line pt-1"><EventLine event={event} /></li>
              ))}
            </ol>
          </section>
        ))}
        {connection === 'live' && !runs.length && <p className="text-muted">No unfinished runs.</p>}
      </div>
    </Card>
  );
}

export function RunActivity({ identifier }: { identifier: string }) {
  const { activity, connection, connectionLabel } = useActivityStream<RunActivitySnapshot>(`/api/issue/${encodeURIComponent(identifier)}/run-activity`, isRun);
  return (
    <Card title="Run Activity" right={
      <span role="status"><Tag tone={connection === 'live' ? 'ok' : 'muted'}>{connectionLabel}</Tag></span>
    }>
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Agents">
          {AGENTS.map((agent) => {
            const latest = connection === 'live' && activity?.activeAgent === agent;
            return (
              <div key={agent} className={`flex min-w-0 items-center gap-2 rounded border p-2 ${latest ? 'border-accent bg-accent/10' : 'border-line bg-raised'}`}>
                <span aria-hidden="true" className={`mono flex size-8 shrink-0 items-center justify-center rounded-full border font-semibold ${latest ? 'border-accent text-accent' : 'border-line text-muted'}`}>
                  {agent === 'claude' ? 'C' : '>_'}
                </span>
                <div className="min-w-0">
                  <div className="font-medium">{ACTORS[agent]}</div>
                  <div className={`flex items-center gap-1 text-[11px] ${latest ? 'text-accent' : 'text-muted'}`}>
                    {latest && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />}
                    {latest ? 'Last recorded' : connection === 'live' ? '—' : 'Status unavailable'}
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
                  <EventLine event={event} />
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
