import { useCallback, useEffect, useRef, useState } from 'react';
import type { Issue, PromptDef, Snapshot } from '../../shared/types.ts';

export type View = 'overview' | 'milestones' | 'pipeline' | 'activity';
export const VIEWS: { id: View; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'milestones', label: 'Milestones & Tasks' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'activity', label: 'Activity' },
];

export interface Route { view: View; project: string; ticket?: string; panel?: 'project'; params: Record<string, string> }

export function parseHash(h: string): Route {
  const [path = '', query = ''] = h.replace(/^#\/?/, '').split('?');
  const q = Object.fromEntries(new URLSearchParams(query));
  const view = (VIEWS.find((v) => v.id === path)?.id ?? 'overview') as View;
  const { p, t, panel, ...params } = q;
  return { view, project: p || 'all', ticket: t || undefined, panel: panel === 'project' ? 'project' : undefined, params };
}
export function toHash(r: Route): string {
  const q = new URLSearchParams();
  if (r.project !== 'all') q.set('p', r.project);
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

export interface Live {
  snap?: Snapshot;
  error?: string; // last fetch error (snapshot may still be shown from an earlier success)
  loading: boolean;
  refresh: () => void; // explicit user action: re-read everything
  openIssue: (identifier: string) => void; // re-read just this issue if its detail is missing/stale
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
 * and a hidden tab becoming visible again after the data went stale. There is no timer: an idle or hidden
 * tab makes zero requests.
 */
export function useSnapshot(): Live {
  const [snap, setSnap] = useState<Snapshot>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [issueLoading, setIssueLoading] = useState<string>();
  const [issueError, setIssueError] = useState<string>();
  const snapRef = useRef<Snapshot>(undefined);
  const busy = useRef(false);
  snapRef.current = snap;

  const load = useCallback(async (force: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const r = await fetch(`/api/snapshot${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(await readError(r));
      setSnap((await r.json()) as Snapshot); setError(undefined);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Cannot reach the DevFlow server (it may have stopped after being idle)');
    } finally { busy.current = false; setLoading(false); }
  }, []);

  const openIssue = useCallback(async (identifier: string) => {
    setIssueLoading(identifier); setIssueError(undefined);
    try {
      const r = await fetch(`/api/issue/${encodeURIComponent(identifier)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(await readError(r));
      setSnap((await r.json()) as Snapshot);
    } catch (e) {
      setIssueError(e instanceof Error && e.message ? e.message : 'Cannot reach the DevFlow server');
    } finally { setIssueLoading(undefined); }
  }, []);

  useEffect(() => { load(false); }, [load]);
  useEffect(() => {
    const onVisible = () => {
      const s = snapRef.current;
      if (document.visibilityState === 'visible' && s && Date.now() - Date.parse(s.dataAt) > s.staleAfterSeconds * 1000) load(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);
  return { snap, error, loading, refresh: () => load(true), openIssue, applySnapshot: setSnap, issueLoading, issueError };
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

export type Bucket = 'backlog' | 'discovery' | 'ready' | 'progress' | 'review' | 'done' | 'canceled' | 'other';
export const BUCKETS: { id: Bucket; label: string }[] = [
  { id: 'backlog', label: 'Backlog' }, { id: 'discovery', label: 'Discovery' }, { id: 'ready', label: 'Ready' }, { id: 'progress', label: 'In progress' },
  { id: 'review', label: 'In review' }, { id: 'done', label: 'Done' }, { id: 'canceled', label: 'Canceled' },
];
export function bucketOf(i: Issue): Bucket {
  if (i.state.type === 'canceled') return 'canceled';
  switch (i.stage) {
    case 'done': return 'done';
    case 'review': case 'merge': return 'review';
    case 'implementation': case 'ci': return 'progress';
    case 'ready': return 'ready';
    case 'backlog': return 'backlog';
    case 'discovery': return 'discovery';
    default: return 'other';
  }
}

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

/** POST to a controlled Linear action. The CSRF token came from a same-origin GET; the browser adds the Origin header. */
export async function postAction(kind: string, csrf: string, body: Record<string, unknown>): Promise<{ ok: true; message: string; snapshot: Snapshot } | { ok: false; error: string; checks?: { id: string; label: string; ok: boolean; detail: string }[] }> {
  try {
    const r = await fetch(`/api/actions/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-devflow-csrf': csrf }, body: JSON.stringify(body) });
    const j = (await r.json()) as { ok?: boolean; error?: string; message?: string; snapshot?: Snapshot; checks?: never };
    if (r.ok && j.ok && j.snapshot) return { ok: true, message: j.message ?? 'Done', snapshot: j.snapshot };
    return { ok: false, error: j.error ?? `Request failed (HTTP ${r.status})`, checks: j.checks };
  } catch { return { ok: false, error: 'Cannot reach the DevFlow server' }; }
}
