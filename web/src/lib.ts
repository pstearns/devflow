import { useCallback, useEffect, useRef, useState } from 'react';
import type { Issue, PrScope, PromptDef, Snapshot } from '../../shared/types.ts';

export type View = 'overview' | 'milestones' | 'pipeline' | 'activity';
export const VIEWS: { id: View; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'milestones', label: 'Milestones & Tasks' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'activity', label: 'Activity' },
];

/** Team → Project selection. team '' = all loaded teams. project: 'all' | 'none' (unprojected issues) | a Linear project id. */
export interface Route { view: View; team: string; project: string; ticket?: string; panel?: 'project'; params: Record<string, string> }

export function parseHash(h: string): Route {
  const [path = '', query = ''] = h.replace(/^#\/?/, '').split('?');
  const q = Object.fromEntries(new URLSearchParams(query));
  const view = (VIEWS.find((v) => v.id === path)?.id ?? 'overview') as View;
  const { team, p, t, panel, ...params } = q;
  const tk = /^[A-Za-z][A-Za-z0-9]{0,11}$/.test(team ?? '') ? team!.toUpperCase() : '';
  return { view, team: tk, project: tk ? p || 'all' : 'all', ticket: t || undefined, panel: panel === 'project' ? 'project' : undefined, params };
}
export function toHash(r: Route): string {
  const q = new URLSearchParams();
  if (r.team) q.set('team', r.team);
  if (r.team && r.project !== 'all') q.set('p', r.project);
  if (r.ticket) q.set('t', r.ticket);
  if (r.panel) q.set('panel', r.panel);
  for (const [k, v] of Object.entries(r.params)) if (v) q.set(k, v);
  const s = q.toString();
  return `#/${r.view}${s ? `?${s}` : ''}`;
}

export function useRoute(): [Route, (patch: Partial<Route>, replaceParams?: boolean) => void] {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((patch: Partial<Route>, replaceParams = false) => {
    const cur = parseHash(location.hash);
    const next: Route = { ...cur, ...patch, params: patch.params ? (replaceParams ? patch.params : { ...cur.params, ...patch.params }) : cur.params };
    if (patch.view && patch.view !== cur.view && !patch.params) next.params = {};
    location.hash = toHash(next);
  }, []);
  return [route, go];
}

/** Everything that is scoped to a selection is filtered through these (the server stays the authority for writes). */
export interface Sel { team: string; project: string }
export const selOf = (r: Pick<Route, 'team' | 'project'>): Sel => ({ team: r.team, project: r.project });
/**
 * Which critical-path cards a selection shows. No team: every path. A whole team: that team's paths, even while their tickets are not
 * loaded yet (the card then says Unknown instead of vanishing). A project or "unprojected": only paths with a ticket inside it.
 */
export function gatesInSel<G extends { teamKey?: string; pathTickets: string[] }>(gates: G[], sel: Sel, visible: { identifier: string }[]): G[] {
  const ids = new Set(visible.map((i) => i.identifier));
  return gates.filter((g) => !sel.team || (sel.project === 'all' ? g.teamKey === sel.team : g.pathTickets.some((t) => ids.has(t))));
}
export function inSel(sel: Sel, e: { teamKey: string; linearProjectId?: string }): boolean {
  if (!sel.team) return true;
  if (e.teamKey !== sel.team) return false;
  if (sel.project === 'all') return true;
  if (sel.project === 'none') return !e.linearProjectId;
  return e.linearProjectId === sel.project;
}
/** Blocked filter: '1' = only blocked issues, '0' = only issues that are not blocked, anything else = no filter. */
export const matchesBlocked = (i: Pick<Issue, 'readiness'>, mode: string | undefined): boolean =>
  mode === '1' ? i.readiness === 'blocked' : mode === '0' ? i.readiness !== 'blocked' : true;
export function prInSel(sel: Sel, s: PrScope): boolean {
  if (!sel.team) return true;
  if (s.teamKey !== sel.team) return false;
  if (sel.project === 'all') return true;
  if (sel.project === 'none') return s.includeUnprojected;
  return s.projectIds === null || s.projectIds.includes(sel.project);
}
export const eventInSel = (sel: Sel, e: { teamKey: string; linearProjectId?: string; scope?: PrScope }) => (e.scope ? prInSel(sel, e.scope) : inSel(sel, e));
/** Integration-health attention (no team) is always relevant. */
export const attentionInSel = (sel: Sel, a: { teamKey: string; linearProjectId?: string; scope?: PrScope }) => !a.teamKey || eventInSel(sel, a);

/** Human label for the current selection, e.g. "CrankLogix › V2" (used by prompts and headings). */
export function selName(snap: Snapshot | undefined, sel: Sel): string {
  const t = snap?.teams.find((x) => x.key === sel.team);
  if (!t) return 'All teams';
  if (sel.project === 'all') return t.name;
  if (sel.project === 'none') return `${t.name} › no project`;
  return `${t.name} › ${t.projects.find((p) => p.id === sel.project)?.name ?? 'project'}`;
}

// ---- authenticated API access ------------------------------------------------------------------------------------
// The server decides when a session expires. Requests must say whether they come from a real user action ('user') or are
// automatic ('passive'); only 'user' requests move the 30-minute inactivity window.
let csrfToken: string | undefined;
let redirecting = false;

export function redirectToLogin(expired: boolean) {
  if (redirecting) return;
  redirecting = true;
  const next = /^#\/[\w\-./?=&,%:~]*$/.test(location.hash) ? location.hash : '';
  const q = [expired ? 'expired=1' : '', next ? `next=${encodeURIComponent(next)}` : ''].filter(Boolean).join('&');
  location.replace(`/login${q ? `?${q}` : ''}`);
}

export interface ApiOptions { interaction: 'user' | 'passive'; method?: 'GET' | 'POST'; body?: unknown }

export async function api(url: string, o: ApiOptions): Promise<Response> {
  const headers: Record<string, string> = { 'x-devflow-interaction': o.interaction };
  if (o.method === 'POST') {
    headers['content-type'] = 'application/json';
    headers['x-devflow-csrf'] = csrfToken ?? (await loadSession());
  }
  const r = await fetch(url, { method: o.method ?? 'GET', headers, body: o.method === 'POST' ? JSON.stringify(o.body ?? {}) : undefined, cache: 'no-store', credentials: 'same-origin' });
  if (r.status === 401) { redirectToLogin(true); throw new Error('Session expired'); }
  return r;
}

export async function loadSession(): Promise<string> {
  const r = await api('/api/auth/session', { interaction: 'user' });
  const j = (await r.json()) as { csrf: string; idleSeconds: number };
  csrfToken = j.csrf;
  idleSecondsKnown = j.idleSeconds;
  return j.csrf;
}
let idleSecondsKnown = 1800;
export const idleSeconds = () => idleSecondsKnown;

export async function logout(): Promise<void> {
  try { await api('/api/auth/logout', { interaction: 'user', method: 'POST' }); } catch { /* the session may already be gone */ }
  csrfToken = undefined;
  location.replace('/login');
}

/**
 * Keeps the server session in step with REAL user activity and notices expiry without polling:
 *  - trusted pointer/keyboard input (throttled to one request per minute) tells the server the user is active;
 *  - one idle timer, re-armed by that input, asks the (non-extending) state endpoint when it fires and redirects if the
 *    server says the session is gone. The server remains the authority on expiry.
 */
export function useSessionGuard() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastTouch = Date.now();
    const arm = () => { clearTimeout(timer); timer = setTimeout(check, idleSeconds() * 1000 + 1000); };
    const check = async () => {
      try {
        const st = (await (await fetch('/api/auth/state', { cache: 'no-store', credentials: 'same-origin' })).json()) as { authenticated: boolean };
        if (!st.authenticated) redirectToLogin(true); else arm();
      } catch { arm(); }
    };
    const onInput = (e: Event) => {
      if (!e.isTrusted) return; // scripts cannot keep a session alive by synthesizing events
      arm();
      const n = Date.now();
      if (n - lastTouch > 60_000) { lastTouch = n; api('/api/auth/touch', { interaction: 'user', method: 'POST' }).catch(() => {}); }
    };
    loadSession().then(arm).catch(() => {});
    addEventListener('pointerdown', onInput, true);
    addEventListener('keydown', onInput, true);
    return () => { clearTimeout(timer); removeEventListener('pointerdown', onInput, true); removeEventListener('keydown', onInput, true); };
  }, []);
}

export interface Live {
  snap?: Snapshot;
  error?: string; // last fetch error (snapshot may still be shown from an earlier success)
  loading: boolean;
  refresh: () => void; // explicit user action: re-read everything
  autoOn: boolean; // Auto-refresh switch; OFF on every page load, never persisted
  setAutoRefresh: (on: boolean) => void;
  openIssue: (identifier: string) => void; // re-read just this issue if its detail is missing/stale
  openTeam: (key: string) => void; // read one accessible team that has not been read yet
  teamLoading?: string;
  teamError?: string;
  applySnapshot: (s: Snapshot) => void; // a verified action result carries the updated snapshot
  issueLoading?: string;
  issueError?: string;
}

async function readError(r: Response): Promise<string> {
  try { const b = (await r.json()) as { error?: unknown }; if (typeof b.error === 'string') return b.error.slice(0, 200); } catch { /* not JSON */ }
  return `DevFlow server returned HTTP ${r.status}`;
}

/**
 * Data is fetched only on: first load, the Refresh button, opening an issue whose detail is missing/stale,
 * a hidden tab becoming visible again after the data went stale, and (only when the user switches it on for this
 * page load) the 30-second auto-refresh. A hidden tab makes zero requests.
 */
export function useSnapshot(): Live {
  const [snap, setSnap] = useState<Snapshot>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [issueLoading, setIssueLoading] = useState<string>();
  const [issueError, setIssueError] = useState<string>();
  const [teamLoading, setTeamLoading] = useState<string>();
  const [teamError, setTeamError] = useState<string>();
  const [autoOn, setAutoOn] = useState(false);
  const snapRef = useRef<Snapshot>(undefined);
  snapRef.current = snap;
  const [d] = useState(() => createDashboardReads({ setSnap, setError, setLoading, setIssueLoading, setIssueError, setTeamLoading, setTeamError, setAutoOn }));

  useEffect(() => { d.load(false); }, [d]);
  useEffect(() => {
    const onVisible = () => {
      const s = snapRef.current;
      if (document.visibilityState === 'visible' && s && Date.now() - Date.parse(s.dataAt) > s.staleAfterSeconds * 1000) d.load(false, 'passive'); // returning to a tab is not a user interaction
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [d]);
  useEffect(() => () => d.setAutoRefresh(false), [d]); // leaving the dashboard stops auto-refresh (timer and listener)
  return { snap, error, loading, refresh: d.refresh, autoOn, setAutoRefresh: d.setAutoRefresh, openIssue: d.openIssue, openTeam: d.openTeam, teamLoading, teamError, applySnapshot: d.applySnapshot, issueLoading, issueError };
}

export const AUTO_REFRESH_MS = 30_000;
type VisibilityDoc = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

/** Where the dashboard's read state goes (React state setters in the app; plain recorders in tests). */
export interface DashboardSink {
  setSnap: (s: Snapshot) => void;
  setError: (e: string | undefined) => void;
  setLoading: (b: boolean) => void;
  setIssueLoading: (id: string | undefined) => void;
  setIssueError: (e: string | undefined) => void;
  setTeamLoading: (key: string | undefined) => void;
  setTeamError: (e: string | undefined) => void;
  setAutoOn: (on: boolean) => void;
}
export interface DashboardDeps { api?: typeof api; doc?: VisibilityDoc; intervalMs?: number }

/**
 * Every dashboard read (full snapshot, one issue, one team) and the Auto-refresh switch, outside React so the exact
 * behavior the dashboard uses can be tested. Manual reads behave as before. A scheduled auto-refresh is skipped while
 * ANY read is running, and its result is dropped if a targeted read or an action result arrived after it started, so a
 * snapshot assembled earlier never overwrites newer data. A user read waits for an active automatic refresh before it starts.
 */
export function createDashboardReads(sink: DashboardSink, deps: DashboardDeps = {}) {
  const call = deps.api ?? api;
  let fullBusy = false;
  let targeted = 0; // issue/team reads in flight
  let gen = 0; // bumped by every targeted read and action result
  let autoJob: Promise<void> | undefined;
  let manualWaiting = false;
  let stopAuto: (() => void) | undefined;

  const load = async (force: boolean, interaction: 'user' | 'passive' = 'user', supersedable = false) => {
    if (fullBusy) return;
    fullBusy = true;
    if (!supersedable) sink.setLoading(true);
    const at = gen;
    try {
      const r = await call(`/api/snapshot${force ? '?refresh=1' : ''}`, { interaction });
      if (!r.ok) throw new Error(await readError(r));
      const s = (await r.json()) as Snapshot;
      if (!supersedable || at === gen) { sink.setSnap(s); sink.setError(undefined); }
    } catch (e) {
      if (!supersedable || at === gen) sink.setError(e instanceof Error && e.message ? e.message : 'Cannot reach the DevFlow server (it may have stopped)');
    } finally { fullBusy = false; if (!supersedable) sink.setLoading(false); }
  };

  const targetedRead = async (url: string, key: string, setL: (k: string | undefined) => void, setE: (e: string | undefined) => void) => {
    gen++; targeted++;
    setL(key); setE(undefined);
    try {
      if (autoJob) await autoJob;
      const r = await call(url, { interaction: 'user' });
      if (!r.ok) throw new Error(await readError(r));
      sink.setSnap((await r.json()) as Snapshot);
    } catch (e) {
      setE(e instanceof Error && e.message ? e.message : 'Cannot reach the DevFlow server');
    } finally { targeted--; setL(undefined); }
  };

  /** The same re-read as Refresh, sent as a passive request (does not extend the session). */
  const autoRefresh = async () => {
    if (fullBusy || targeted > 0 || manualWaiting) return;
    autoJob = load(true, 'passive', true);
    try { await autoJob; } finally { autoJob = undefined; }
  };

  const refresh = async () => {
    if (manualWaiting) return;
    if (autoJob) {
      manualWaiting = true;
      sink.setLoading(true);
      try { await autoJob; } finally { manualWaiting = false; }
    }
    await load(true);
  };

  const setAutoRefresh = (on: boolean) => {
    if (on === (stopAuto !== undefined)) return;
    if (on) stopAuto = startAutoRefresh(autoRefresh, deps.doc ?? document, deps.intervalMs);
    else { stopAuto?.(); stopAuto = undefined; }
    sink.setAutoOn(on);
  };

  return {
    load,
    refresh: () => { void refresh(); }, // the Refresh button
    autoRefresh,
    setAutoRefresh,
    isAutoOn: () => stopAuto !== undefined,
    openIssue: (identifier: string) => targetedRead(`/api/issue/${encodeURIComponent(identifier)}`, identifier, sink.setIssueLoading, sink.setIssueError),
    openTeam: (key: string) => targetedRead(`/api/team/${encodeURIComponent(key)}`, key, sink.setTeamLoading, sink.setTeamError),
    applySnapshot: (s: Snapshot) => { gen++; sink.setSnap(s); },
    busy: () => fullBusy || targeted > 0,
  };
}

/**
 * Optional auto-refresh (off by default, never persisted). While the page is visible, calls `refresh` every
 * `intervalMs`. A tick is skipped while the previous refresh is still running (no queue, no duplicate request).
 * A hidden page has no timer at all; becoming visible starts a fresh interval, so missed ticks never pile up.
 * A failed refresh does not stop the schedule (errors are shown by the normal refresh error path).
 * Returns a stop function that clears the timer and the visibility listener.
 */
export function startAutoRefresh(refresh: () => Promise<unknown> | unknown, doc: VisibilityDoc = document, intervalMs = AUTO_REFRESH_MS): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let stopped = false;
  const tick = () => {
    if (stopped || inFlight || doc.visibilityState !== 'visible') return;
    inFlight = true;
    Promise.resolve().then(refresh).catch(() => {}).finally(() => { inFlight = false; });
  };
  const sync = () => {
    if (!stopped && doc.visibilityState === 'visible') { if (timer === undefined) timer = setInterval(tick, intervalMs); }
    else if (timer !== undefined) { clearInterval(timer); timer = undefined; }
  };
  doc.addEventListener('visibilitychange', sync);
  sync();
  return () => { stopped = true; sync(); doc.removeEventListener('visibilitychange', sync); };
}

export function relTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export const fullTime = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '');

export type Bucket = 'backlog' | 'discovery' | 'ready' | 'progress' | 'review' | 'closeout' | 'done' | 'canceled' | 'other';
export const BUCKETS: { id: Bucket; label: string }[] = [
  { id: 'backlog', label: 'Backlog' }, { id: 'discovery', label: 'Discovery' }, { id: 'ready', label: 'Ready' }, { id: 'progress', label: 'In progress' },
  { id: 'review', label: 'In review' }, { id: 'closeout', label: 'Close in Linear' }, { id: 'done', label: 'Done' }, { id: 'canceled', label: 'Canceled' },
];
export function bucketOf(i: Issue): Bucket {
  if (i.state.type === 'canceled') return 'canceled';
  switch (i.stage) {
    case 'done': return 'done';
    case 'closeout': return 'closeout';
    case 'review': case 'merge': return 'review';
    case 'implementation': case 'ci': return 'progress';
    case 'ready': return 'ready';
    case 'backlog': return 'backlog';
    case 'discovery': return 'discovery';
    default: return 'other';
  }
}

/** The status + blocked part of the Milestones filter. The Overview tiles link with these same params, so a tile's count is the list it opens. */
export const matchesStatusFilter = (i: Issue, f: { status?: string; blocked?: string }): boolean => (!f.status || bucketOf(i) === f.status) && matchesBlocked(i, f.blocked);
export const READY_TILE_FILTER = { status: 'ready', blocked: '0' } as const;

export function fillPrompt(p: PromptDef, ctx: { project?: string; ticket?: string; milestone?: string }): string {
  return p.template
    .replaceAll('{{project}}', ctx.project ?? '<project>')
    .replaceAll('{{ticket}}', ctx.ticket ?? '<ticket>')
    .replaceAll('{{milestone}}', ctx.milestone ?? '<milestone>');
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

export const PRIORITIES = [{ v: 1, l: 'Urgent' }, { v: 2, l: 'High' }, { v: 3, l: 'Medium' }, { v: 4, l: 'Low' }, { v: 0, l: 'No priority' }];

/** Selected label names (any-of) live in the URL so filtered views are linkable. */
export const parseLabelParam = (v: string | undefined): string[] => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
export const matchesLabels = (labels: { name: string }[], selected: string[]) =>
  selected.length === 0 || labels.some((l) => selected.some((s) => s.toLowerCase() === l.name.toLowerCase()));

/** POST to a controlled Linear action (session cookie + same-origin + the session-bound CSRF token). */
export async function postAction(kind: string, body: Record<string, unknown>): Promise<{ ok: true; message: string; snapshot: Snapshot } | { ok: false; error: string; checks?: { id: string; label: string; ok: boolean; detail: string }[] }> {
  try {
    const r = await api(`/api/actions/${kind}`, { interaction: 'user', method: 'POST', body });
    const j = (await r.json()) as { ok?: boolean; error?: string; message?: string; snapshot?: Snapshot; checks?: never };
    if (r.ok && j.ok && j.snapshot) return { ok: true, message: j.message ?? 'Done', snapshot: j.snapshot };
    return { ok: false, error: j.error ?? `Request failed (HTTP ${r.status})`, checks: j.checks };
  } catch (e) { return { ok: false, error: e instanceof Error && e.message === 'Session expired' ? 'Your session expired' : 'Cannot reach the DevFlow server' }; }
}
