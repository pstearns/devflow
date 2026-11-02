import { describe, expect, it } from 'vitest';
import { attentionInSel, eventInSel, inSel, parseHash, prInSel, toHash, selOf } from '../web/src/lib.ts';

const E = (teamKey: string, linearProjectId?: string) => ({ teamKey, linearProjectId });

describe('selection scoping (Team → Project)', () => {
  it('all teams shows everything; a team shows only its own issues', () => {
    const all = { team: '', project: 'all' };
    expect(inSel(all, E('ATL', 'p1'))).toBe(true);
    const atl = { team: 'ATL', project: 'all' };
    expect(inSel(atl, E('ATL', 'p1'))).toBe(true);
    expect(inSel(atl, E('ATL'))).toBe(true); // whole-team view includes unprojected issues
    expect(inSel(atl, E('ZED', 'p1'))).toBe(false);
  });
  it('a project shows only that project; "none" shows only unprojected issues', () => {
    expect(inSel({ team: 'ATL', project: 'p1' }, E('ATL', 'p1'))).toBe(true);
    expect(inSel({ team: 'ATL', project: 'p1' }, E('ATL', 'p2'))).toBe(false);
    expect(inSel({ team: 'ATL', project: 'p1' }, E('ATL'))).toBe(false);
    expect(inSel({ team: 'ATL', project: 'none' }, E('ATL'))).toBe(true);
    expect(inSel({ team: 'ATL', project: 'none' }, E('ATL', 'p1'))).toBe(false);
    expect(inSel({ team: 'ATL', project: 'p1' }, E('ZED', 'p1'))).toBe(false); // same project id string in another team never matches
  });
  it('PRs follow their repository scope', () => {
    const repoOfProject = { teamKey: 'ATL', projectIds: ['p1'], includeUnprojected: false };
    const wholeTeam = { teamKey: 'BCN', projectIds: null, includeUnprojected: false };
    expect(prInSel({ team: 'ATL', project: 'p1' }, repoOfProject)).toBe(true);
    expect(prInSel({ team: 'ATL', project: 'p2' }, repoOfProject)).toBe(false);
    expect(prInSel({ team: 'ATL', project: 'none' }, repoOfProject)).toBe(false);
    expect(prInSel({ team: 'BCN', project: 'p9' }, wholeTeam)).toBe(true);
    expect(prInSel({ team: 'ATL', project: 'all' }, wholeTeam)).toBe(false); // another team's repo
    expect(prInSel({ team: '', project: 'all' }, wholeTeam)).toBe(true);
  });
  it('events and attention items use their own scope; integration health (no team) is always shown', () => {
    const sc = { teamKey: 'ATL', projectIds: ['p1'], includeUnprojected: false };
    expect(eventInSel({ team: 'ATL', project: 'p1' }, { ...E('ATL'), scope: sc })).toBe(true);
    expect(eventInSel({ team: 'ATL', project: 'p2' }, { ...E('ATL'), scope: sc })).toBe(false);
    expect(eventInSel({ team: 'ZED', project: 'all' }, E('ATL', 'p1'))).toBe(false);
    expect(attentionInSel({ team: 'ZED', project: 'all' }, { teamKey: '' })).toBe(true);
    expect(attentionInSel({ team: 'ZED', project: 'all' }, E('ATL'))).toBe(false);
  });
});

describe('route <-> URL', () => {
  it('round-trips team, project, ticket and filters', () => {
    const r = parseHash('#/pipeline?team=atl&p=lp-1&t=ATL-3&labels=Bug');
    expect(r).toMatchObject({ view: 'pipeline', team: 'ATL', project: 'lp-1', ticket: 'ATL-3', params: { labels: 'Bug' } });
    expect(parseHash(toHash(r))).toEqual(r);
  });
  it('a project without a team, or a malformed team, never produces a scoped selection', () => {
    expect(parseHash('#/overview?p=cranklogix')).toMatchObject({ team: '', project: 'all' }); // legacy bookmark: falls back to all teams
    expect(parseHash('#/overview?team=%3Cscript%3E&p=x')).toMatchObject({ team: '', project: 'all' });
    expect(toHash({ view: 'overview', team: '', project: 'p1', params: {} })).toBe('#/overview'); // project is meaningless without a team
  });
  it('selOf drops everything except the selection (so a switch cannot carry a ticket, panel or filters)', () => {
    expect(selOf(parseHash('#/milestones?team=ZED&p=none&t=ZED-1&labels=Go&milestone=z1'))).toEqual({ team: 'ZED', project: 'none' });
  });
});
