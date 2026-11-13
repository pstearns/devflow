// "Next milestone blocker": the earliest unresolved gate on a project's configured critical path. Pure and read-only.
import type { Issue, MilestoneGate } from '../shared/types.ts';
import type { ProjectCfg } from './config.ts';

export function computeGates(projects: Pick<ProjectCfg, 'id' | 'name' | 'linear' | 'criticalPath'>[], issues: Issue[], readyLabelOf: (i: Issue) => string = () => 'Ready'): MilestoneGate[] {
  const byId = new Map(issues.map((i) => [i.identifier.toUpperCase(), i]));
  const resolved = (i: Issue) => i.state.type === 'completed' || i.state.type === 'canceled';
  const out: MilestoneGate[] = [];
  for (const p of projects) {
    if (!p.criticalPath.length) continue;
    const base = { projectId: p.id, projectName: p.name, teamKey: p.linear?.teamKey, pathTickets: p.criticalPath.map((e) => e.ticket) };
    const open = p.criticalPath.map((e) => ({ ...e, issue: byId.get(e.ticket) })).filter((e) => !e.issue || !resolved(e.issue));
    const deferred = open.filter((e) => e.deferred).map((e) => e.ticket);
    const gates = open.filter((e) => !e.deferred);
    const first = gates[0];
    if (!first) { out.push({ ...base, state: 'clear', reason: 'Every gate on the approved path is resolved.', deferred, remaining: 0 }); continue; }
    const common = { ...base, gate: first.ticket, deferred, remaining: gates.length };
    const i = first.issue;
    if (!i) { out.push({ ...common, state: 'unknown', advanceTicket: undefined, reason: `${first.ticket} is on the path but is not in the loaded data, so its state is unknown.` }); continue; }
    if (i.openBlockers.length) {
      const b = i.openBlockers[0]!;
      out.push({ ...common, state: 'blocked', advanceTicket: b.identifier, title: b.title, reason: `${i.identifier} is blocked by ${b.identifier} (${b.stateName})${i.openBlockers.length > 1 ? ` and ${i.openBlockers.length - 1} more` : ''}.` });
    } else if (i.blockedMarker) {
      out.push({ ...common, state: 'blocked', advanceTicket: i.identifier, title: i.title, reason: `${i.identifier} is marked blocked by ${i.blockedMarker} with no blocking relation to follow.` });
    } else if (i.stage === 'ready') {
      out.push({ ...common, state: 'executable', advanceTicket: i.identifier, title: i.title, reason: `${i.identifier} is unblocked and authorized (${readyLabelOf(i)}); it can be executed.` });
    } else if (i.stage === 'backlog' || i.stage === 'discovery') {
      out.push({ ...common, state: 'needs-authorization', advanceTicket: i.identifier, title: i.title, reason: `${i.identifier} is unblocked but not authorized: it needs readiness and the "${readyLabelOf(i)}" label.` });
    } else {
      const wait = i.awaitingHuman[0];
      out.push({ ...common, state: 'in-flight', advanceTicket: i.identifier, title: i.title, reason: `${i.identifier} is in ${i.stage ?? 'progress'}${wait ? `; waiting on: ${wait}` : ''}.` });
    }
  }
  return out;
}
