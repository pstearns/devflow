import type { Snapshot, SourceHealth } from '../shared/types.ts';
import type { Config } from './config.ts';
import { GithubClient, applyRunFallback, fetchPrDetail, fetchRepo, normalizePr, type Denied, type RepoData } from './github.ts';
import { LinearClient, fetchLinearIssue, fetchLinearProject, type LinearProjectData } from './linear.ts';
import { buildSnapshot } from './snapshot.ts';
import { SourceError, clampResume, requestScope } from './util.ts';

const REFRESH_DEADLINE_MS = 90_000;

interface Cached<T> { data: T; at: string }

/**
 * Data is only ever read because a request asked for it (dashboard open, Refresh, or opening an issue).
 * There are no timers here: with no browser connected, no Linear/GitHub request is ever made.
 */
export class SnapshotService {
  private linearCache = new Map<string, Cached<LinearProjectData>>();
  private ghCache = new Map<string, Cached<RepoData>>();
  private details = new Map<string, { updatedAt?: string; description: string; at: string }>(); // lazily-fetched descriptions
  private backoff = new Map<string, number>(); // credential ('linear' | 'github') -> epoch ms until which we make no calls
  private health: SourceHealth[] = [];
  private last?: { snap: Snapshot; at: number };
  private inflight?: Promise<Snapshot>;
  private inflightSince?: number;
  private issueInflight = new Map<string, Promise<Snapshot>>();
  private linear?: LinearClient;
  private github?: GithubClient;
  private mode: 'live' | 'demo';
  private deadlineMs: number;

  constructor(
    private cfg: Config,
    opts: { linearKey?: string; githubToken?: string; fetchImpl?: typeof fetch; mode?: 'live' | 'demo'; refreshDeadlineMs?: number },
    private clock: () => number = Date.now,
  ) {
    this.mode = opts.mode ?? 'live';
    this.deadlineMs = opts.refreshDeadlineMs ?? REFRESH_DEADLINE_MS;
    if (opts.linearKey) this.linear = new LinearClient(opts.linearKey, opts.fetchImpl);
    if (opts.githubToken) this.github = new GithubClient(opts.githubToken, opts.fetchImpl);
  }

  /** Readiness detail for /api/readyz. Never touches the network. */
  status() {
    return { refreshing: this.inflightSince !== undefined, refreshingForMs: this.inflightSince ? this.clock() - this.inflightSince : 0, haveData: !!this.last };
  }

  private noteLimit(cred: 'linear' | 'github', e: unknown) {
    if (e instanceof SourceError && e.kind === 'rate_limit')
      this.backoff.set(cred, clampResume(this.clock(), e.resetAt ? Date.parse(e.resetAt) : undefined));
  }

  /** Overridden when the write feature is attached (see actions.ts). */
  writeStatus(): { enabled: boolean; reason?: string } { return this.writeInfo; }
  private writeInfo: { enabled: boolean; reason?: string } = { enabled: false, reason: 'Linear write access is not configured' };
  setWriteInfo(i: { enabled: boolean; reason?: string }) { this.writeInfo = i; }

  private get staleMs() { return this.cfg.staleAfterMinutes * 60_000; }

  /** Dashboard open / Refresh. Cached data younger than the stale threshold is reused; `force` re-reads (min 5 s apart). */
  async get(force = false): Promise<Snapshot> {
    const age = this.last ? this.clock() - this.last.at : Infinity;
    if (this.last && age < (force ? 5000 : this.staleMs)) return this.last.snap;
    if (!this.inflight) {
      // The refresh owns an AbortController. On deadline it is cancelled (aborting every upstream request it
      // started, and blocking it from committing results), and `inflight` stays set until it has really stopped,
      // so a second refresh can never run alongside an expired one.
      const ctl = new AbortController();
      this.inflightSince = this.clock();
      const run = requestScope.run(ctl.signal, () => this.refresh(force, ctl.signal));
      const settled = run.then(() => undefined, () => undefined).finally(() => { if (this.inflight === guarded) this.inflight = undefined; this.inflightSince = undefined; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, rej) => {
        timer = setTimeout(() => { ctl.abort(); rej(new SourceError('network', 'Refresh exceeded its deadline and was cancelled; showing previous data')); }, this.deadlineMs);
      });
      const guarded: Promise<Snapshot> = Promise.race([run, deadline]).finally(() => clearTimeout(timer));
      guarded.catch(() => {});
      void settled;
      this.inflight = guarded;
    }
    return this.inflight;
  }

  /** Opening one issue: re-read only that issue (and its PRs' evidence), and only if its detail is missing or stale. */
  /** Latest assembled snapshot without any I/O. */
  peek(): Snapshot | undefined { return this.last?.snap; }

  async getIssue(identifier: string, force = false): Promise<Snapshot | undefined> {
    const base = this.last?.snap ?? (await this.get());
    const issue = base.issues.find((i) => i.identifier === identifier.toUpperCase());
    if (!issue) return undefined;
    if (!force && issue.detailAt && this.clock() - Date.parse(issue.detailAt) < this.staleMs) return this.last!.snap;
    const key = issue.identifier;
    let p = this.issueInflight.get(key);
    if (!p) {
      p = this.refreshIssue(issue.identifier, issue.projectId, issue.prKeys).finally(() => this.issueInflight.delete(key));
      this.issueInflight.set(key, p);
    }
    return p;
  }

  private async refreshIssue(identifier: string, projectId: string, prKeys: string[]): Promise<Snapshot> {
    const now = this.clock();
    for (const cred of ['linear', 'github'] as const)
      if (now < (this.backoff.get(cred) ?? 0) && (cred === 'linear' ? this.linear : this.github))
        throw new SourceError('rate_limit', `${cred === 'linear' ? 'Linear' : 'GitHub'} rate limited; waiting for reset`);
    await this.refreshIssueSources(identifier, projectId, prKeys, now);
    return this.assemble();
  }

  private async refreshIssueSources(identifier: string, projectId: string, prKeys: string[], now: number): Promise<void> {
    if (this.linear) {
      let fresh;
      try { fresh = await fetchLinearIssue(this.linear, projectId, identifier); } catch (e) { this.noteLimit('linear', e); throw e; }
      const entry = this.linearCache.get(`linear:${projectId}`);
      const idx = entry?.data.issues.findIndex((i) => i.identifier === identifier) ?? -1;
      if (entry && idx >= 0) entry.data.issues[idx] = fresh;
      this.details.set(identifier, { updatedAt: fresh.updatedAt, description: fresh.description, at: new Date(now).toISOString() });
    }
    if (this.github) {
      const denied: Denied = new Map();
      try {
      for (const key of prKeys) {
        const [repo, num] = key.split('#') as [string, string];
        const entry = this.ghCache.get(`github:${repo}`);
        const idx = entry?.data.prs.findIndex((p) => p.number === Number(num)) ?? -1;
        if (!entry || idx < 0) continue;
        // re-read the PR itself so head SHA / state are current, then its evidence
        const raw = normalizePr(await this.github.get(`/repos/${repo}/pulls/${num}`)) ?? entry.data.prs[idx]!;
        const next = await fetchPrDetail(this.github, repo, raw, denied, true);
        entry.data.prs[idx] = next;
        applyRunFallback([next], entry.data.runs);
      }
      } catch (e) { this.noteLimit('github', e); throw e; }
    }
  }

  private async source<T>(
    health: SourceHealth[], signal: AbortSignal, id: string, label: string, cred: 'linear' | 'github', cache: Map<string, Cached<T>>, fn: () => Promise<T & { warnings?: string[] }>,
  ): Promise<void> {
    const now = this.clock();
    const prev = cache.get(id);
    const h: SourceHealth = { id, label, state: 'ok', lastAttempt: new Date(now).toISOString(), lastSuccess: prev?.at, warnings: [] };
    health.push(h);
    const until = this.backoff.get(cred) ?? 0;
    try {
      if (now < until) throw new SourceError('rate_limit', 'Rate limited; waiting for reset', new Date(until).toISOString());
      const data = await fn();
      if (signal.aborted) return; // expired refresh must not commit anything
      cache.set(id, { data, at: h.lastAttempt! });
      h.lastSuccess = h.lastAttempt;
      h.warnings = (data as { warnings?: string[] }).warnings ?? [];
      if (h.warnings.length) h.state = 'partial';
    } catch (e) {
      const err = e instanceof SourceError ? e : new SourceError('http', 'Unexpected error while reading source');
      this.noteLimit(cred, err);
      h.error = err.message;
      if (err.kind === 'rate_limit') h.rateLimit = { remaining: 0, resetAt: new Date(this.backoff.get(cred) ?? now).toISOString() };
      h.state = prev ? 'stale' : 'error'; // previous good data (if any) stays in the cache
    }
  }

  private async refresh(force: boolean, signal: AbortSignal): Promise<Snapshot> {
    const health: SourceHealth[] = []; // committed to this.health only if the refresh is not cancelled
    const jobs: Promise<void>[] = [];
    const repos = new Set<string>(); // a repo shared by several projects is read once
    for (const p of this.cfg.projects) {
      if (p.linear) {
        const lc = p.linear;
        if (!this.linear) health.push({ id: `linear:${p.id}`, label: `Linear (${p.name})`, state: 'not_configured', error: 'LINEAR_API_KEY is not set (read-only personal API key required)', warnings: [] });
        else jobs.push(this.source(health, signal, `linear:${p.id}`, `Linear (${p.name})`, 'linear', this.linearCache, () => fetchLinearProject(this.linear!, p.id, lc)));
      }
      for (const repo of p.repos) {
        if (repos.has(repo)) continue;
        repos.add(repo);
        if (!this.github) health.push({ id: `github:${repo}`, label: `GitHub ${repo}`, state: 'not_configured', error: 'GITHUB_TOKEN is not set (read-only fine-grained token required)', warnings: [] });
        else jobs.push(this.source(health, signal, `github:${repo}`, `GitHub ${repo}`, 'github', this.ghCache, () => fetchRepo(this.github!, repo, force, this.clock())));
      }
    }
    await Promise.all(jobs);
    if (this.github?.rateLimit) for (const h of health) if (h.id.startsWith('github:') && !h.rateLimit) h.rateLimit = this.github.rateLimit;
    if (!this.cfg.projects.length) health.push({ id: 'config', label: 'Configuration', state: 'not_configured', error: 'No projects configured. Copy devflow.config.example.json to devflow.config.json.', warnings: [] });
    if (signal.aborted) throw new SourceError('network', 'Refresh cancelled');
    health.sort((a, b) => a.id.localeCompare(b.id));
    this.health = health;
    return this.assemble();
  }

  /** Pure local assembly from caches: makes no network request. */
  private assemble(): Snapshot {
    const linear = new Map<string, LinearProjectData>();
    const github = new Map<string, RepoData>();
    for (const p of this.cfg.projects) {
      const l = this.linearCache.get(`linear:${p.id}`);
      if (l) {
        for (const i of l.data.issues) {
          const d = this.details.get(i.identifier);
          const fresh = !!d && d.updatedAt === i.updatedAt; // an edited issue invalidates its cached description
          i.description = fresh ? d!.description : '';
          i.detailAt = fresh ? d!.at : undefined;
        }
        linear.set(p.id, l.data);
      }
      for (const repo of p.repos) { const g = this.ghCache.get(`github:${repo}`); if (g) github.set(repo, g.data); }
    }
    const times = this.health.map((h) => h.lastSuccess).filter((t): t is string => !!t).sort();
    const snap = buildSnapshot({ cfg: this.cfg, now: new Date(this.clock()), mode: this.mode, linear, github, health: this.health, dataAt: times[0], write: this.writeStatus() });
    this.last = { snap, at: this.last?.at ?? this.clock() };
    if (times.length) this.last.at = Math.max(...this.health.map((h) => Date.parse(h.lastAttempt ?? '') || 0), 0) || this.clock();
    return snap;
  }
}
