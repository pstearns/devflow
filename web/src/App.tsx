import { useEffect, useMemo, useRef, useState } from 'react';
import { Lifecycle } from './components/Lifecycle.tsx';
import { ScopeDetail, TicketDetail } from './components/Detail.tsx';
import { Time, btn, select } from './components/ui.tsx';
import type { Snapshot } from '../../shared/types.ts';
import { VIEWS, inSel, logout, selOf, useRoute, useSessionGuard, useSnapshot, relTime } from './lib.ts';
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
  useSessionGuard();
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

  const scope = selOf(route);
  const issues = useMemo(() => (snap ? snap.issues.filter((i) => inSel(scope, i)) : []), [snap, route.team, route.project]); // eslint-disable-line react-hooks/exhaustive-deps
  const team = snap?.teams.find((t) => t.key === route.team);

  // Switching team or project discards everything that depended on the old selection: the open ticket/panel, per-view
  // filters (labels and milestones are team/project specific) and, via `key` below, each view's local state.
  const selectTeam = (key: string) => go({ team: key, project: 'all', ticket: undefined, panel: undefined, params: {} }, true);
  const selectProject = (id: string) => go({ project: id, ticket: undefined, panel: undefined, params: { ...route.params, milestone: '', labels: '' } }, true);

  // A team that has not been read yet is read when it is first selected (only that team).
  const teamAttempt = useRef(new Map<string, number>());
  useEffect(() => {
    if (!team || team.loaded) return;
    const last = teamAttempt.current.get(team.key) ?? 0;
    if (Date.now() - last < 10000) return;
    teamAttempt.current.set(team.key, Date.now());
    live.openTeam(team.key);
  }, [team?.key, team?.loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  // A bookmarked project that no longer exists in the team falls back to the whole team.
  useEffect(() => {
    if (team && route.project !== 'all' && route.project !== 'none' && !team.projects.some((p) => p.id === route.project)) go({ project: 'all' }, false);
  }, [team?.key, route.project]); // eslint-disable-line react-hooks/exhaustive-deps
  const openTicket = (id: string) => go({ ticket: id, panel: undefined });
  const close = () => go({ ticket: undefined, panel: undefined });
  const selected = snap && route.ticket ? snap.issues.find((i) => i.identifier === route.ticket) : undefined;
  const panelOpen = !!selected || (route.panel === 'project' && !!route.team);
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
          <span className="rounded-sm border border-line px-1 text-[10px] uppercase tracking-wider text-muted" title={snap?.write.enabled ? 'GitHub is read-only. Linear changes only through the controlled actions menu, validated and verified against live Linear.' : 'No write access is configured: Linear and GitHub are only read'}>{snap?.write.enabled ? 'controlled writes' : 'read-only'}</span>
        </div>
        <nav className="flex gap-1" aria-label="Views">
          {VIEWS.map((v) => (
            <button key={v.id} onClick={() => go({ view: v.id })} aria-current={route.view === v.id ? 'page' : undefined}
              className={`rounded px-2.5 py-1 ${route.view === v.id ? 'bg-raised font-semibold text-fg' : 'text-muted hover:text-fg'}`}>{v.label}</button>
          ))}
        </nav>
        <div className="flex items-center gap-1" role="group" aria-label="Team and project">
          <select aria-label="Team" className={select} value={route.team} onChange={(e) => selectTeam(e.target.value)}>
            <option value="">All teams</option>
            {snap?.teams.map((t) => <option key={t.key} value={t.key}>{t.name} ({t.key}){t.loaded ? '' : ' · not read yet'}</option>)}
          </select>
          <span className="text-muted" aria-hidden>›</span>
          <select aria-label="Project" className={select} value={route.project} disabled={!team} onChange={(e) => selectProject(e.target.value)}>
            <option value="all">Whole team (all issues)</option>
            {team?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="none">No project (unprojected)</option>
          </select>
          {team && <button className={btn} onClick={() => go({ panel: 'project', ticket: undefined })}>Info</button>}
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
          <button className={btn} onClick={logout} title="End this session on the server and return to the sign-in page">Log out</button>
        </div>
      </header>

      {notice && <div role="status" className="border-b border-ok/50 bg-ok/10 px-4 py-1 text-ok">{notice}</div>}
      {snap?.mode === 'demo' && <div className="border-b border-warn/50 bg-warn/10 px-4 py-1 text-warn">DEMO MODE — all data is synthetic test fixtures. Nothing here comes from Linear or GitHub.</div>}
      {live.error && <div className="border-b border-bad/50 bg-bad/10 px-4 py-1 text-bad">{live.error}. {snap ? `Showing data read ${relTime(snap.dataAt, now)}. Press Refresh to retry.` : 'Is the DevFlow server running? (Start it again if it has stopped.)'}</div>}

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
          ) : route.team && !team ? (
            <div className="rounded-md border border-line bg-panel p-4"><p>Team <span className="mono">{route.team}</span> is not visible to DevFlow's Linear key.</p><button className={`${btn} mt-2`} onClick={() => selectTeam('')}>Show all teams</button></div>
          ) : team && !team.loaded ? (
            <div className="rounded-md border border-line bg-panel p-4" role="status">
              {live.teamLoading === team.key ? <p className="text-muted">Reading team {team.name} from Linear…</p>
                : <><p className={live.teamError || team.error ? 'text-bad' : 'text-muted'}>{live.teamError ?? team.error ?? `Team ${team.name} has not been read yet.`}</p><button className={`${btn} mt-2`} onClick={() => live.openTeam(team.key)}>Read team now</button></>}
            </div>
          ) : (
            // key = selection: every view starts clean (filters, expanded rows, dialogs) when the team or project changes
            <div key={`${route.team}|${route.project}|${route.view}`}>
              {route.view === 'overview' ? <Overview snap={snap} issues={issues} sel={scope} go={go} now={now} />
                : route.view === 'milestones' ? <Milestones snap={snap} issues={issues} sel={scope} route={route} go={go} onOpen={openTicket} onResult={onResult} />
                : route.view === 'pipeline' ? <Pipeline snap={snap} issues={issues} onOpen={openTicket} now={now} route={route} go={go} sel={scope} onResult={onResult} />
                : <Activity snap={snap} sel={scope} onOpen={openTicket} now={now} />}
            </div>
          )}
        </main>
        {panelOpen && snap && (
          <aside className="w-full max-w-[480px] shrink-0 overflow-auto border-l border-line bg-bg p-4 max-md:fixed max-md:inset-0 max-md:z-10 max-md:max-w-none" aria-label="Details">
            <div className="mb-2 flex justify-end"><button className={btn} onClick={close}>Close ✕</button></div>
            {selected ? <TicketDetail issue={selected} snap={snap} onOpen={openTicket} loading={live.issueLoading === selected.identifier} error={live.issueError} onResult={onResult} />
              : route.panel === 'project' && route.team ? <ScopeDetail snap={snap} sel={scope} onSelectProject={selectProject} /> : null}
          </aside>
        )}
      </div>
    </div>
  );
}
