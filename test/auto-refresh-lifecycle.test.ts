import { expect, it, vi } from 'vitest';
import { useSnapshot } from '../web/src/lib.ts';

const lifecycles = vi.hoisted(() => [] as Array<() => void | (() => void)>);

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: (effect: () => void | (() => void)) => { lifecycles.push(effect); },
}));

it('registers a dashboard cleanup that stops scheduled reads on unmount', async () => {
  vi.useFakeTimers();
  const listeners = new Set<EventListener>();
  const fetch = vi.fn(async () => Response.json({}));
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: (_: string, listener: EventListener) => listeners.add(listener),
    removeEventListener: (_: string, listener: EventListener) => listeners.delete(listener),
  });
  const cleanup: Array<void | (() => void)> = [];
  try {
    const dashboard = useSnapshot();
    cleanup.push(...lifecycles.splice(0).map((effect) => effect()));
    await vi.advanceTimersByTimeAsync(0);
    expect(dashboard.autoOn).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1); // initial read
    dashboard.setAutoRefresh(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const dispose of cleanup.splice(0)) dispose?.();
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    for (const dispose of cleanup) dispose?.();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
