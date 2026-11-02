// Ticket <-> PR matching. Only explicit identifier evidence links; ambiguity yields "ambiguous", never a guess.
import type { Issue, PullRequest } from '../shared/types.ts';
import { extractIssueIds } from './util.ts';

export function matchPrs(prs: PullRequest[], issues: Issue[]): void {
  const byId = new Map(issues.map((i) => [i.identifier, i]));
  for (const i of issues) i.prKeys = [];
  for (const pr of prs) {
    const cand = new Map<string, Set<string>>(); // identifier -> evidence labels
    const add = (id: string, why: string) => {
      if (!byId.has(id)) return;
      (cand.get(id) ?? cand.set(id, new Set()).get(id)!).add(why);
    };
    extractIssueIds(pr.headRef).forEach((id) => add(id, 'branch name'));
    extractIssueIds(pr.title).forEach((id) => add(id, 'PR title'));
    for (const i of issues) {
      if (pr.url && i.attachments.some((a) => a.url === pr.url)) add(i.identifier, 'Linear attachment');
      if (i.branchName && i.branchName.toLowerCase() === pr.headRef.toLowerCase()) add(i.identifier, 'Linear branch name');
    }
    const ids = [...cand.keys()];
    const unknownIds = [...extractIssueIds(pr.headRef), ...extractIssueIds(pr.title)].filter((id) => !byId.has(id));
    if (ids.length === 1) {
      pr.ticket = { identifier: ids[0], link: 'linked', candidates: ids, via: [...cand.get(ids[0]!)!].join(' + ') };
      byId.get(ids[0]!)!.prKeys.push(pr.key);
    } else if (ids.length > 1) {
      pr.ticket = { link: 'ambiguous', candidates: ids, via: `Multiple tickets referenced: ${ids.join(', ')}` };
    } else {
      pr.ticket = { link: 'unlinked', candidates: [], via: unknownIds.length ? `References ${[...new Set(unknownIds)].join(', ')}, which is not in the loaded Linear data` : 'No ticket identifier in branch or title' };
    }
  }
}
