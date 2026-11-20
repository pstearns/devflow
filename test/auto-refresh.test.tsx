import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { AUTO_REFRESH_MS, startAutoRefresh } from '../web/src/lib.ts';
import { AutoRefreshToggle } from '../web/src/App.tsx';

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

  it('manual refresh keeps working while auto-refresh is ON and does not disturb the schedule', async () => {
    const doc = fakeDoc();
    const calls: string[] = [];
    const auto = vi.fn(async () => { calls.push('auto'); });
    const manual = async () => { calls.push('manual'); };
    const stop = startAutoRefresh(auto, asDoc(doc));
    await vi.advanceTimersByTimeAsync(10_000);
    await manual();
    await vi.advanceTimersByTimeAsync(20_000);
    await manual();
    expect(calls).toEqual(['manual', 'auto', 'manual']);
    stop();
  });
});
