import { useEffect, useMemo, useRef, useState } from 'react';
import { Lifecycle } from './components/Lifecycle.tsx';
import { ProjectDetail, TicketDetail } from './components/Detail.tsx';
import { Time, btn, select } from './components/ui.tsx';
import type { Snapshot } from '../../shared/types.ts';
import { VIEWS, useRoute, useSnapshot, relTime } from './lib.ts';
import { Overview } from './views/Overview.tsx';
import { Milestones } from './views/Milestones.tsx';
import { Pipeline } from './views/Pipeline.tsx';
import { Activity } from './views/Activity.tsx';

function useTheme(): [string, () => void] {
  const [t, setT] = useState(() => { try { return localStorage.getItem('devflow-theme') || 'dark'; } catch { return 'dark'; } });
  useEffect(() => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('devflow-theme', t); } catch { /* storage unavailable */ }
  }, [t]);
  return [t, () => setT(t === 'dark' ? 'light' : 'dark')];
}

export function App() {
  const live = useSnapshot();
  const { snap } = live;
  const [route, go] = useRoute();
  const [theme, toggleTheme] = useTheme();
  const [now, setNow] = useState(Date.now());
  const [showHealth, setShowHealth] = useState(false);
  const [notice, setNotice] = useState<string>();
  const onResult = (s: Snapshot, message: string) => { live.applySnapshot(s); setNotice(message); setTimeout(() => setNotice(undefined), 6000); };
  // Only re-renders relative-time labels; makes no request and stops while the tab is hidden.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') setNow(Date.now()); };
    const t = setInterval(tick, 10000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', tick); };
  }, []);

  const issues = useMemo(() => (snap ? snap.issues.filter((i) => route.project === 'all' || i.projectId === route.project) : []), [snap, route.project]);
  const openTicket = (id: string) => go({ ticket: id, panel: undefined });
  const close = () => go({ ticket: undefined, panel: undefined });
  const selected = snap && route.ticket ? snap.issues.find((i) => i.identifier === route.ticket) : undefined;
  const project = snap && route.project !== 'all' ? snap.projects.find((p) => p.id === route.project) : undefined;
  const panelOpen = !!selected || route.panel === 'project';
  // Opening an issue fetches only that issue (and its PRs' evidence) when its detail is missing or stale.
  const attempted = useRef(new Map<string, number>());
  const sel = snap && route.ticket ? snap.issues.find((i) => i.identifier === route.ticket) : undefined;
  // Freshness is evaluated only when the selection (or its fetched detail) changes — never because time passed —
  // so a panel left open does not re-read on its own.
  useEffect(() => {
    if (!sel || !snap) return;
    const fresh = !!sel.detailAt && Date.now() - Date.parse(sel.detailAt) < snap.staleAfterSeconds * 1000;
    if (fresh) return;
    const last = attempted.current.get(sel.identifier) ?? 0;
    if (Date.now() - last < 10000) return;
    attempted.current.set(sel.identifier, Date.now());
    live.openIssue(sel.identifier);
  }, [sel?.identifier, sel?.detailAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const bad = snap?.health.filter((h) => h.state === 'error' || h.state === 'stale' || h.state === 'not_configured') ?? [];
  const worst = snap?.health.some((h) => h.state === 'error') ? 'bg-bad' : bad.length ? 'bg-warn' : 'bg-ok';
  const stale = !!snap && now - Date.parse(snap.dataAt) > snap.staleAfterSeconds * 1000;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-panel px-4 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold tracking-tight">DevFlow</span>
          <span className="rounded-sm border border-line px-1 text-[10px] uppercase tracking-wider text-muted" title="No write endpoints; Linear and GitHub are only ever read">read-only</span>
        </div>
        <nav className="flex gap-1" aria-label="Views">
          {VIEWS.map((v) => (
            <button key={v.id} onClick={() => go({ view: v.id })} aria-current={route.view === v.id ? 'page' : undefined}
              className={`rounded px-2.5 py-1 ${route.view === v.id ? 'bg-raised font-semibold text-fg' : 'text-muted hover:text-fg'}`}>{v.label}</button>
          ))}
        </nav>
        <div className="flex items-center gap-1">
          <select aria-label="Project" className={select} value={route.project} onChange={(e) => go({ project: e.target.value, ticket: undefined, panel: undefined })}>
            <option value="all">All projects</option>
            {snap?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {project && <button className={btn} onClick={() => go({ panel: 'project', ticket: undefined })}>Project info</button>}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <button className="flex items-center gap-1.5 hover:underline" onClick={() => setShowHealth((s) => !s)} aria-expanded={showHealth}>
            <span className={`h-2 w-2 rounded-full ${live.error ? 'bg-bad' : stale ? 'bg-warn' : worst}`} />
            <span className="text-muted">
              {live.error ? 'Last refresh failed' : snap ? `Data read ${relTime(snap.dataAt, now)}${stale ? ' · stale' : ''}` : 'Loading…'}
              {bad.length > 0 && !live.error ? ` · ${bad.length} source issue${bad.length > 1 ? 's' : ''}` : ''}
            </span>
          </button>
          <button className={btn} onClick={live.refresh} disabled={live.loading}>{live.loading ? 'Refreshing…' : 'Refresh'}</button>
          <button className={btn} onClick={toggleTheme} aria-label="Toggle theme">{theme === 'dark' ? 'Light' : 'Dark'}</button>
        </div>
      </header>

      {notice && <div role="status" className="border-b border-ok/50 bg-ok/10 px-4 py-1 text-ok">{notice}</div>}
      {snap?.mode === 'demo' && <div className="border-b border-warn/50 bg-warn/10 px-4 py-1 text-warn">DEMO MODE — all data is synthetic test fixtures. Nothing here comes from Linear or GitHub.</div>}
      {live.error && <div className="border-b border-bad/50 bg-bad/10 px-4 py-1 text-bad">{live.error}. {snap ? `Showing data read ${relTime(snap.dataAt, now)}. Press Refresh to retry.` : 'Is the DevFlow server running? (It exits after being idle; relaunch it.)'}</div>}

      {showHealth && snap && (
        <div className="border-b border-line bg-panel px-4 py-2">
          <table className="text-left">
            <thead className="text-[11px] uppercase tracking-wider text-muted"><tr><th className="pr-4 font-medium">Source</th><th className="pr-4 font-medium">State</th><th className="pr-4 font-medium">Last success</th><th className="font-medium">Detail</th></tr></thead>
            <tbody>
              {snap.health.map((h) => (
                <tr key={h.id} className="align-top">
                  <td className="pr-4">{h.label}</td>
                  <td className={`pr-4 ${h.state === 'ok' ? 'text-ok' : h.state === 'partial' ? 'text-warn' : h.state === 'not_configured' ? 'text-muted' : 'text-bad'}`}>{h.state.replace('_', ' ')}</td>
                  <td className="pr-4"><Time iso={h.lastSuccess} now={now} /></td>
                  <td className="text-muted">{[h.error, ...h.warnings, h.rateLimit ? `rate limit remaining ${h.rateLimit.remaining}${h.rateLimit.resetAt ? `, resets ${new Date(h.rateLimit.resetAt).toLocaleTimeString()}` : ''}` : ''].filter(Boolean).join(' · ') || 'healthy'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[11px] text-muted">Stale = last refresh failed; the previous good data is still shown. DevFlow does not poll: data is read when you open the dashboard, press Refresh, or open an issue. Data older than {Math.round(snap.staleAfterSeconds / 60)} min is marked stale.</p>
        </div>
      )}

      {snap && <div className="border-b border-line px-4 py-2"><Lifecycle issues={issues} /></div>}

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto p-4">
          {!snap ? (
            <p className="text-muted">{live.error ? 'No data yet.' : 'Loading…'}</p>
          ) : route.view === 'overview' ? (
            <Overview snap={snap} issues={issues} project={route.project} go={go} now={now} />
          ) : route.view === 'milestones' ? (
            <Milestones snap={snap} issues={issues} project={route.project} route={route} go={go} onOpen={openTicket} onResult={onResult} />
          ) : route.view === 'pipeline' ? (
            <Pipeline snap={snap} issues={issues} onOpen={openTicket} now={now} route={route} go={go} project={route.project} onResult={onResult} />
          ) : (
            <Activity snap={snap} project={route.project} onOpen={openTicket} now={now} />
          )}
        </main>
        {panelOpen && snap && (
          <aside className="w-full max-w-[480px] shrink-0 overflow-auto border-l border-line bg-bg p-4 max-md:fixed max-md:inset-0 max-md:z-10 max-md:max-w-none" aria-label="Details">
            <div className="mb-2 flex justify-end"><button className={btn} onClick={close}>Close ✕</button></div>
            {selected ? <TicketDetail issue={selected} snap={snap} onOpen={openTicket} loading={live.issueLoading === selected.identifier} error={live.issueError} onResult={onResult} />
              : route.panel === 'project' && project ? <ProjectDetail project={project} snap={snap} /> : null}
          </aside>
        )}
      </div>
    </div>
  );
}
