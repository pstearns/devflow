// Ticket <-> PR matching. Only explicit identifier evidence links; ambiguity yields "ambiguous", never a guess.
// A PR may only link to an issue whose own scope (project/team configuration) lists the PR's repository.
import type { Issue, PullRequest } from '../shared/types.ts';
import { extractIssueIds } from './util.ts';

export function matchPrs(prs: PullRequest[], issues: Issue[], canLink: (issue: Issue, pr: PullRequest) => boolean = () => true): void {
  const all = new Map(issues.map((i) => [i.identifier, i]));
  for (const i of issues) i.prKeys = [];
  for (const pr of prs) {
    const linkable = issues.filter((i) => canLink(i, pr));
    const byId = new Map(linkable.map((i) => [i.identifier, i]));
    const cand = new Map<string, Set<string>>(); // identifier -> evidence labels
    const add = (id: string, why: string) => {
      if (!byId.has(id)) return;
      (cand.get(id) ?? cand.set(id, new Set()).get(id)!).add(why);
    };
    extractIssueIds(pr.headRef).forEach((id) => add(id, 'branch name'));
    extractIssueIds(pr.title).forEach((id) => add(id, 'PR title'));
    for (const i of linkable) {
      if (pr.url && i.attachments.some((a) => a.url === pr.url)) add(i.identifier, 'Linear attachment');
      if (i.branchName && i.branchName.toLowerCase() === pr.headRef.toLowerCase()) add(i.identifier, 'Linear branch name');
    }
    const ids = [...cand.keys()];
    const mentioned = [...new Set([...extractIssueIds(pr.headRef), ...extractIssueIds(pr.title)])];
    if (ids.length === 1) {
      pr.ticket = { identifier: ids[0], link: 'linked', candidates: ids, via: [...cand.get(ids[0]!)!].join(' + ') };
      byId.get(ids[0]!)!.prKeys.push(pr.key);
    } else if (ids.length > 1) {
      pr.ticket = { link: 'ambiguous', candidates: ids, via: `Multiple tickets referenced: ${ids.join(', ')}` };
    } else {
      const wrongRepo = mentioned.filter((id) => all.has(id));
      const unknown = mentioned.filter((id) => !all.has(id));
      const via = wrongRepo.length
        ? `References ${wrongRepo.join(', ')}, but ${pr.repo} is not a configured repository for ${wrongRepo.length > 1 ? 'their' : 'its'} project/team, so DevFlow does not link it`
        : unknown.length ? `References ${unknown.join(', ')}, which is not in the loaded Linear data` : 'No ticket identifier in branch or title';
      pr.ticket = { link: 'unlinked', candidates: [], via };
    }
  }
}
