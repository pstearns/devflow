// Defensive accessors for untrusted API payloads. Anything unexpected becomes undefined/empty.

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const str = (v: unknown, max = 2000): string | undefined =>
  typeof v === 'string' ? v.slice(0, max) : undefined;

export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

export const arr = (v: unknown, max = 500): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

export const nodes = (v: unknown, max = 500): unknown[] => (isObj(v) ? arr(v.nodes, max) : []);

export function iso(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Calendar date (Linear targetDate is YYYY-MM-DD). */
export function dateOnly(v: unknown): string | undefined {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined;
}

/** Only https URLs from the API are ever surfaced as links. */
export function safeUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 2048) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export const ISSUE_ID_RE = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,9}-\d+)(?!\d)/gi;

export function extractIssueIds(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ISSUE_ID_RE)) out.add(m[1]!.toUpperCase());
  return [...out];
}

export class SourceError extends Error {
  constructor(
    public kind: 'auth' | 'rate_limit' | 'network' | 'http' | 'invalid' | 'not_found',
    message: string,
    public resetAt?: string,
  ) {
    super(message);
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';

/** A refresh runs inside a scope; aborting its signal cancels every upstream request it started. */
export const requestScope = new AsyncLocalStorage<AbortSignal>();

/** Caps concurrent upstream requests for one client (FIFO queue). */
export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    else this.active++;
    try { return await fn(); } finally {
      const next = this.queue.shift();
      if (next) next(); else this.active--;
    }
  }
}

export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface JsonResponse { status: number; ok: boolean; headers: Headers; json: unknown }

/**
 * Fetch + parse JSON under ONE deadline that also covers the body read, with a hard cap on body size.
 * Error messages are fixed strings: they never include request headers, URLs or upstream text.
 */
export async function fetchJson(
  fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs = 15000, maxBytes = MAX_BODY_BYTES,
): Promise<JsonResponse> {
  const ctl = new AbortController();
  const outer = requestScope.getStore();
  if (outer?.aborted) throw new SourceError('network', 'Refresh cancelled');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ctl.abort(); reject(new SourceError('network', `Request timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    onAbort = () => { ctl.abort(); reject(new SourceError('network', 'Refresh cancelled')); };
    outer?.addEventListener('abort', onAbort, { once: true });
  });
  const work = (async (): Promise<JsonResponse> => {
    let res: Response;
    try { res = await fetchImpl(url, { ...init, signal: ctl.signal }); } catch { throw new SourceError('network', 'Network error contacting API'); }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) { ctl.abort(); throw new SourceError('invalid', 'API response too large'); }
    let text = '';
    try {
      if (res.body) {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) { ctl.abort(); await reader.cancel().catch(() => {}); throw new SourceError('invalid', 'API response too large'); }
          chunks.push(value);
        }
        text = new TextDecoder().decode(Buffer.concat(chunks));
      }
    } catch (e) {
      if (e instanceof SourceError) throw e;
      throw new SourceError('network', 'Network error while reading API response');
    }
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, ok: res.ok, headers: res.headers, json };
  })();
  try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer); if (onAbort) outer?.removeEventListener('abort', onAbort); work.catch(() => {}); }
}

/** Seconds -> absolute ISO time, clamped so a hostile or garbled header cannot park a source for hours. */
export function clampResume(nowMs: number, resumeMs: number | undefined, maxWaitMs = 3600_000): number {
  if (resumeMs === undefined || !Number.isFinite(resumeMs)) return nowMs + 60_000;
  return Math.min(Math.max(resumeMs, nowMs + 5_000), nowMs + maxWaitMs);
}

/**
 * TTL memo with in-flight de-duplication. `ttl` may be computed from the resolved value (pending evidence expires
 * faster than settled evidence). Nothing is treated as immutable: checks can be re-run and reviews dismissed on an
 * unchanged SHA, so `force` (the Refresh button) bypasses every finished entry. Failed promises are not cached.
 * Expired entries are dropped lazily on later writes — there is no timer.
 */
export class Memo {
  private m = new Map<string, { at: number; v: Promise<unknown>; ttl: number; done: boolean }>();
  get<T>(key: string, ttl: number | ((v: T) => number), fn: () => Promise<T>, force = false): Promise<T> {
    const hit = this.m.get(key);
    if (hit && (!hit.done || (Date.now() - hit.at < hit.ttl && !force))) return hit.v as Promise<T>;
    if (this.m.size > 500) this.sweep();
    const e = { at: Date.now(), v: undefined as unknown as Promise<unknown>, ttl: 0, done: false };
    e.v = fn().then(
      (val) => { e.ttl = typeof ttl === 'function' ? ttl(val) : ttl; e.at = Date.now(); e.done = true; return val; },
      (err) => { if (this.m.get(key) === e) this.m.delete(key); throw err; },
    );
    this.m.set(key, e);
    return e.v as Promise<T>;
  }
  private sweep() {
    const now = Date.now();
    for (const [k, e] of this.m) if (e.done && now - e.at >= e.ttl) this.m.delete(k);
    if (this.m.size > 2000) for (const k of [...this.m.keys()].slice(0, this.m.size - 1500)) this.m.delete(k);
  }
  get size() { return this.m.size; }
}
