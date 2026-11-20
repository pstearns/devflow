import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { Snapshot } from '../shared/types.ts';
import { AUTO_REFRESH_MS, createDashboardReads, startAutoRefresh, type ApiOptions } from '../web/src/lib.ts';
import { AutoRefreshToggle, RefreshControls } from '../web/src/App.tsx';

/** Minimal document stand-in: visibilityState plus visibilitychange listeners. */
function fakeDoc() {
  const listeners = new Set<() => void>();
  const doc: {
    visibilityState: DocumentVisibilityState;
    addEventListener: (t: string, l: () => void) => void;
    removeEventListener: (t: string, l: () => void) => void;
    listeners: Set<() => void>;
    set: (v: DocumentVisibilityState) => void;
  } = {
    visibilityState: 'visible',
    addEventListener: (_, l) => { listeners.add(l); },
    removeEventListener: (_, l) => { listeners.delete(l); },
    listeners,
    set: (v) => { doc.visibilityState = v; for (const l of [...listeners]) l(); },
  };
  return doc;
}
const asDoc = (d: ReturnType<typeof fakeDoc>) => d as unknown as Document;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('auto-refresh toggle', () => {
  it('is OFF by default with an accessible name and on/off state, next to Refresh', () => {
    const off = renderToString(<AutoRefreshToggle on={false} onToggle={() => {}} />);
    expect(off).toContain('role="switch"');
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain('Auto-refresh');
    expect(off).toContain('Off');
    const on = renderToString(<AutoRefreshToggle on onToggle={() => {}} />);
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('On');
  });
});

describe('startAutoRefresh scheduler', () => {
  it('refreshes every 30 seconds while visible, not before', async () => {
    expect(AUTO_REFRESH_MS).toBe(30_000);
    const doc = fakeDoc();
    const refresh = vi.fn(async () => {});
    const stop = startAutoRefresh(refresh, asDoc(doc));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it('switching OFF / unmounting stops further refreshes and removes the timer and listener', async () => {
    const doc = fakeDoc();
    const refresh = vi.fn(async () => {});
    const stop = startAutoRefresh(refresh, asDoc(doc));
    await vi.advanceTimersByTimeAsync(30_000);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(doc.listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a hidden tab suspends auto-refresh; becoming visible resumes without catching up missed ticks', async () => {
    const doc = fakeDoc();
    const refresh = vi.fn(async () => {});
    const stop = startAutoRefresh(refresh, asDoc(doc));
    await vi.advanceTimersByTimeAsync(10_000);
    doc.set('hidden');
    expect(vi.getTimerCount()).toBe(0); // no timer at all while hidden
    await vi.advanceTimersByTimeAsync(300_000);
    expect(refresh).not.toHaveBeenCalled();
    doc.set('visible');
    expect(refresh).not.toHaveBeenCalled(); // no burst of missed ticks
    await vi.advanceTimersByTimeAsync(29_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    doc.set('visible'); // repeated visible events do not add a second timer
    expect(vi.getTimerCount()).toBe(1);
    stop();
  });

  it('starting while hidden does not poll until the page is visible', async () => {
    const doc = fakeDoc();
    doc.visibilityState = 'hidden';
    const refresh = vi.fn(async () => {});
    const stop = startAutoRefresh(refresh, asDoc(doc));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(refresh).not.toHaveBeenCalled();
    doc.set('visible');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it('never overlaps: a tick while a refresh is still running is skipped, not queued', async () => {
    const doc = fakeDoc();
    let finish: () => void = () => {};
    const refresh = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    const stop = startAutoRefresh(refresh, asDoc(doc));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000); // three ticks while the request hangs
    expect(refresh).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1); // skipped ticks are not replayed
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it('a failed refresh does not disable auto-refresh', async () => {
    const doc = fakeDoc();
    const refresh = vi.fn(async () => { throw new Error('boom'); });
    const stop = startAutoRefresh(refresh, asDoc(doc));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

});

// ---- the dashboard's own wiring: the read controller useSnapshot uses and the header's Refresh/Auto-refresh controls ----

const snapA = { id: 'A' } as unknown as Snapshot;
const snapB = { id: 'B' } as unknown as Snapshot;

/** The dashboard read controller with a recording sink and an API whose responses the test releases one by one. */
function dashboard(doc = fakeDoc()) {
  const state: { snap?: Snapshot; error?: string; loading: boolean; autoOn: boolean; issueLoading?: string; teamLoading?: string } = { loading: false, autoOn: false };
  const calls: { url: string; interaction: string }[] = [];
  const replies: ((body: unknown, status?: number) => void)[] = [];
  const fakeApi = vi.fn((url: string, o: ApiOptions) => {
    calls.push({ url, interaction: o.interaction });
    return new Promise<Response>((resolve) => {
      replies.push((body, status = 200) => resolve({ ok: status < 400, status, json: async () => body } as unknown as Response));
    });
  });
  const d = createDashboardReads({
    setSnap: (s) => { state.snap = s; }, setError: (e) => { state.error = e; }, setLoading: (b) => { state.loading = b; },
    setIssueLoading: (k) => { state.issueLoading = k; }, setIssueError: () => {}, setTeamLoading: (k) => { state.teamLoading = k; }, setTeamError: () => {},
    setAutoOn: (on) => { state.autoOn = on; },
  }, { api: fakeApi, doc: asDoc(doc) });
  const reply = async (i: number, body: unknown, status?: number) => { replies[i]!(body, status); await vi.advanceTimersByTimeAsync(0); };
  /** The header controls exactly as the dashboard renders them for the current state. */
  const controls = () => {
    const el = RefreshControls({ loading: state.loading, refresh: d.refresh, autoOn: state.autoOn, setAutoRefresh: d.setAutoRefresh }) as ReactElement<{ children: Ctl[] }>;
    const [button, toggle] = el.props.children;
    return { button: button!, toggle: toggle!, html: renderToString(el) };
  };
  return { d, state, calls, reply, controls, doc };
}
type Ctl = ReactElement<{ disabled?: boolean; onClick?: () => void; onToggle?: () => void }>;
const FULL_PASSIVE = { url: '/api/snapshot?refresh=1', interaction: 'passive' };
const FULL_USER = { url: '/api/snapshot?refresh=1', interaction: 'user' };

describe('dashboard auto-refresh', () => {
  it('is OFF by default: the switch renders off beside Refresh and nothing is polled', async () => {
    const h = dashboard();
    const { html } = h.controls();
    expect(h.d.isAutoOn()).toBe(false);
    expect(html).toMatch(/>Refresh<\/button><button[^>]*role="switch"[^>]*aria-checked="false"/); // adjacent to Refresh
    expect(html).toMatch(/Auto-refresh: (<!-- -->)?Off/);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.calls).toEqual([]);
  });

  it('switching ON through the toggle refreshes the same data as Refresh at 30 s; switching OFF stops it and clears the timer', async () => {
    const h = dashboard();
    h.controls().toggle.props.onToggle!();
    expect(h.state.autoOn).toBe(true);
    expect(h.controls().html).toContain('aria-checked="true"');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toEqual([FULL_PASSIVE]);
    await h.reply(0, snapA);
    expect(h.state.snap).toBe(snapA);
    h.controls().toggle.props.onToggle!();
    expect(h.state.autoOn).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.doc.listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.calls).toHaveLength(1);
  });

  it('a hidden tab makes no automatic requests; becoming visible resumes on a fresh 30 s interval', async () => {
    const h = dashboard();
    h.d.setAutoRefresh(true);
    h.doc.set('hidden');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.calls).toEqual([]);
    h.doc.set('visible');
    expect(h.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls).toEqual([FULL_PASSIVE]);
    h.d.setAutoRefresh(false);
  });

  it('the Refresh button works while ON, and a tick during that request is skipped, not queued', async () => {
    const h = dashboard();
    h.d.setAutoRefresh(true);
    await vi.advanceTimersByTimeAsync(10_000);
    h.controls().button.props.onClick!();
    expect(h.calls).toEqual([FULL_USER]);
    expect(h.controls().html).toContain('Refreshing…');
    await vi.advanceTimersByTimeAsync(20_000); // the 30 s tick lands while Refresh is still running
    expect(h.calls).toHaveLength(1);
    await h.reply(0, snapA);
    expect(h.state.snap).toBe(snapA);
    expect(h.state.autoOn).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls).toEqual([FULL_USER, FULL_PASSIVE]);
    h.d.setAutoRefresh(false);
  });

  it('a tick while an issue or team read is running is skipped', async () => {
    const h = dashboard();
    h.d.setAutoRefresh(true);
    await vi.advanceTimersByTimeAsync(20_000);
    void h.d.openIssue('PS-1');
    void h.d.openTeam('PS');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls.map((c) => c.url)).toEqual(['/api/issue/PS-1', '/api/team/PS']);
    await h.reply(0, snapB);
    await vi.advanceTimersByTimeAsync(30_000); // the team read is still running
    expect(h.calls).toHaveLength(2);
    await h.reply(1, snapB);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls[2]).toEqual(FULL_PASSIVE);
    h.d.setAutoRefresh(false);
  });

  it('keeps manual Refresh clickable during an automatic request and runs it once after that request', async () => {
    const h = dashboard();
    h.d.setAutoRefresh(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls).toEqual([FULL_PASSIVE]);
    expect(h.controls().html).toMatch(/<button[^>]*>Refresh<\/button>/);
    expect(h.controls().button.props.disabled).toBe(false);
    h.controls().button.props.onClick!();
    h.controls().button.props.onClick!();
    expect(h.calls).toEqual([FULL_PASSIVE]);
    await h.reply(0, snapA);
    expect(h.calls).toEqual([FULL_PASSIVE, FULL_USER]);
    await h.reply(1, snapB);
    expect(h.state.snap).toBe(snapB);
    h.d.setAutoRefresh(false);
  });

  it('defers an issue or team request until the automatic refresh settles', async () => {
    const h = dashboard();
    h.d.setAutoRefresh(true);
    await vi.advanceTimersByTimeAsync(30_000);
    void h.d.openIssue('PS-1');
    void h.d.openTeam('PS');
    expect(h.state.issueLoading).toBe('PS-1');
    expect(h.state.teamLoading).toBe('PS');
    expect(h.calls).toEqual([FULL_PASSIVE]);
    await h.reply(0, snapA);
    expect(h.state.snap).toBeUndefined();
    expect(h.calls.map((call) => call.url)).toEqual(['/api/snapshot?refresh=1', '/api/issue/PS-1', '/api/team/PS']);
    await h.reply(1, snapB);
    await h.reply(2, snapB);
    expect(h.state.snap).toBe(snapB);
    h.d.setAutoRefresh(false);
  });

  it('an auto-refresh that finishes after an action result does not overwrite it', async () => {
    const h = dashboard();
    h.d.setAutoRefresh(true);
    await vi.advanceTimersByTimeAsync(30_000);
    h.d.applySnapshot(snapB);
    await h.reply(0, snapA);
    expect(h.state.snap).toBe(snapB);
    await vi.advanceTimersByTimeAsync(30_000);
    await h.reply(1, snapA);
    expect(h.state.snap).toBe(snapA);
    h.d.setAutoRefresh(false);
  });

  it('a failed auto-refresh shows the normal refresh error and stays ON', async () => {
    const h = dashboard();
    h.d.setAutoRefresh(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await h.reply(0, { error: 'Linear is unavailable' }, 502);
    expect(h.state.error).toBe('Linear is unavailable');
    expect(h.state.autoOn).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls).toHaveLength(2);
    await h.reply(1, snapA);
    expect(h.state.error).toBeUndefined();
    h.d.setAutoRefresh(false);
  });
});
