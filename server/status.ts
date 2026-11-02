// Interpretation of raw evidence into Passed / Failed / Pending / Unknown / Not applicable.
import type { CheckItem, Evidence, ReviewItem, Status, Tri } from '../shared/types.ts';
import type { Config } from './config.ts';

export const status = (value: Tri, detail: string, evidence: Evidence[] = []): Status => ({ value, detail, evidence });

const checkEv = (c: CheckItem): Evidence => ({
  source: c.source === 'check_run' ? 'GitHub check run' : c.source === 'workflow_run' ? 'GitHub Actions workflow run' : 'GitHub commit status',
  label: `${c.name}: ${c.rawConclusion ?? c.rawStatus}`,
  url: c.url,
  at: c.at,
});

export function ciStatus(checks: CheckItem[], detailOk: boolean, partial?: string, checkRunsUnavailable = false): Status {
  if (!detailOk) return status('unknown', checkRunsUnavailable ? 'Unavailable: check-run details cannot be read and no GitHub Actions workflow run exists for this commit' : 'Checks could not be read from GitHub');
  const via = checks.length > 0 && checks.every((c) => c.source === 'workflow_run') ? ' workflow run(s)' : ' check(s)';
  const note = checkRunsUnavailable ? ' (check-run details unavailable; CI taken from GitHub Actions workflow runs)' : '';
  if (!checks.length) return status('unknown', 'No checks reported for the PR head commit');
  const failed = checks.filter((c) => c.state === 'failed');
  if (failed.length) return status('failed', `${failed.length} of ${checks.length}${via} failed${note}`, failed.map(checkEv));
  const pending = checks.filter((c) => c.state === 'pending');
  if (pending.length) return status('pending', `${pending.length} of ${checks.length}${via} still running${partial ? ` (incomplete: ${partial})` : ''}${note}`, pending.map(checkEv));
  const unknown = checks.filter((c) => c.state === 'unknown');
  if (unknown.length) return status('unknown', `${unknown.length}${via} ended cancelled/stale — not a pass${note}`, unknown.map(checkEv));
  if (partial) return status('unknown', `${checks.length}${via} succeeded, but evidence is incomplete (${partial}) — not reported as passed${note}`, checks.slice(0, 8).map(checkEv));
  return status('passed', `All ${checks.length}${via} succeeded${note}`, checks.slice(0, 8).map(checkEv));
}

export function humanReviewStatus(reviews: ReviewItem[], detailOk: boolean, prState: 'open' | 'closed' | 'merged', partial?: string): Status {
  if (!detailOk) return status('unknown', 'Reviews could not be read from GitHub');
  // latest decisive review per reviewer; COMMENTED/PENDING never override a decision
  const latest = new Map<string, ReviewItem>();
  for (const r of [...reviews].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))) {
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED') latest.set(r.user, r);
  }
  const ev = (r: ReviewItem): Evidence => ({ source: 'GitHub review', label: `${r.user}: ${r.state}`, url: r.url, at: r.at });
  const decisions = [...latest.values()].filter((r) => r.state !== 'DISMISSED');
  const changes = decisions.filter((r) => r.state === 'CHANGES_REQUESTED');
  if (changes.length) return status('failed', `Changes requested by ${changes.map((r) => r.user).join(', ')}`, changes.map(ev));
  if (partial) return status('unknown', `Review evidence is incomplete (${partial}); later decisions may be missing`);
  const approved = decisions.filter((r) => r.state === 'APPROVED');
  if (approved.length) return status('passed', `Approved by ${approved.map((r) => r.user).join(', ')}`, approved.map(ev));
  return prState === 'open' ? status('pending', 'No approving review yet') : status('unknown', 'No review decision recorded');
}

/** Independent (e.g. Codex) review is only ever "passed" from explicitly configured evidence. */
export function independentReviewStatus(
  pr: { labels: string[]; checks: CheckItem[]; state: 'open' | 'closed' | 'merged'; detailOk: boolean },
  review: Config['review'],
): Status {
  const { checkName, passedLabel, findingsLabel } = review;
  if (!checkName && !passedLabel && !findingsLabel)
    return status('unknown', 'No independent-review evidence source is configured (see review.* in devflow.config.json)');
  const hasLabel = (l?: string) => !!l && pr.labels.some((x) => x.toLowerCase() === l.toLowerCase());
  if (hasLabel(findingsLabel)) return status('failed', `Label "${findingsLabel}" records review findings`, [{ source: 'GitHub PR label', label: findingsLabel! }]);
  if (checkName) {
    const c = pr.checks.find((x) => x.name.toLowerCase() === checkName.toLowerCase());
    if (c) return status(c.state, `Check "${c.name}" is ${c.rawConclusion ?? c.rawStatus}`, [checkEv(c)]);
  }
  if (hasLabel(passedLabel)) return status('passed', `Label "${passedLabel}" records a passed review`, [{ source: 'GitHub PR label', label: passedLabel! }]);
  if (!pr.detailOk && checkName) return status('unknown', 'Checks could not be read, so review evidence is unavailable');
  return pr.state === 'open' ? status('pending', 'No independent-review record found yet') : status('unknown', 'No independent-review record found');
}
