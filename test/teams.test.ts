import { describe, expect, it } from 'vitest';
import { SnapshotService } from '../server/service.ts';
import { demoConfig, demoFetch, DEMO_READ_KEY, DEMO_WRITE_KEY } from '../server/demo.ts';
import type { FakeLinearOpts } from '../server/demo-linear.ts';
import { LinearClient } from '../server/linear.ts';
import { LinearWriteClient } from '../server/linear-write.ts';
import { ActionError, LinearActions } from '../server/actions.ts';
import { buildApp } from '../server/app.ts';
import { parseConfig } from '../server/config.ts';
import { makeAuth, signIn } from './helpers.ts';
import { resolveScope } from '../server/scope.ts';

const now = Date.parse('2026-06-01T12:00:00Z');

async function setup(opts: FakeLinearOpts = {}) {
  const calls: string[] = [];
  const f0 = demoFetch(now, opts);
  const f = Object.assign((async (u: string | URL | Request, i?: RequestInit) => {
    const url = String(u);
    calls.push(url.includes('linear') ? `linear:${/(?:query|mutation) (\w+)/.exec(String(i?.body))?.[1]}:${/"(?:key|id)":"([^"]+)"/.exec(String(i?.body))?.[1] ?? ''}` : `gh:${new URL(url).pathname.split('/')[3]}`);
    return f0(u, i);
  }) as typeof fetch, { store: f0.store });
  const cfg = demoConfig();
  const service = new SnapshotService(cfg, { linearKey: DEMO_READ_KEY, githubToken: 't', fetchImpl: f, mode: 'demo' }, () => now);
  service.setWriteInfo({ enabled: true });
  const snap = await service.get();
  const actions = new LinearActions({ cfg, read: new LinearClient(DEMO_READ_KEY, f), write: new LinearWriteClient(DEMO_WRITE_KEY, f), service, clock: () => now });
  const spec = (id: string) => { const [t, n] = id.split('-') as [string, string]; return f.store.issues[t!]!.find((x) => x.n === Number(n))!; };
  return { f, service, snap, actions, cfg, calls, spec, ops: () => f.store.mutations.map((m) => m.op) };
}
const fail = async (p: Promise<unknown>) => (await p.then(() => { throw new Error('expected rejection'); }, (e) => e)) as ActionError;
const issue = (snap: Awaited<ReturnType<typeof setup>>['snap'], id: string) => snap.issues.find((i) => i.identifier === id)!;

describe('team discovery', () => {
  it('discovers every accessible team dynamically; only configured ones are read at open', async () => {
    const { snap } = await setup();
    expect(snap.teams.map((t) => t.key)).toEqual(['ATL', 'BCN', 'QAT', 'ZED']); // nothing hard-coded: this is what the (fake) Linear returned
    const by = (k: string) => snap.teams.find((t) => t.key === k)!;
    expect([by('ATL').loaded, by('BCN').loaded, by('ZED').loaded]).toEqual([true, true, true]);
    expect(by('QAT')).toMatchObject({ loaded: false, configured: false });
    expect(by('QAT').projects.map((p) => p.name)).toEqual(['QA Board']); // projects are known from discovery even before issues are read
    expect(snap.issues.some((i) => i.teamKey === 'QAT')).toBe(false);
  });
  it('a team the key cannot see is not offered, and a configured-but-hidden team is reported', async () => {
    const { snap, service } = await setup({ hideTeams: ['QAT', 'BCN'] });
    expect(snap.teams.map((t) => t.key)).toContain('BCN'); // still listed because config names it...
    expect(snap.teams.find((t) => t.key === 'BCN')).toMatchObject({ loaded: false, error: expect.stringMatching(/not visible/) }); // ...but flagged
    expect(snap.teams.some((t) => t.key === 'QAT')).toBe(false);
    expect(await service.getTeam('QAT')).toBeUndefined();
  });
});

describe('on-demand team loading', () => {
  it('reading one team touches only that team: no other team, project or GitHub repository', async () => {
    const { service, calls } = await setup();
    calls.length = 0;
    const snap = (await service.getTeam('QAT'))!;
    expect(snap.teams.find((t) => t.key === 'QAT')!.loaded).toBe(true);
    expect(snap.issues.filter((i) => i.teamKey === 'QAT').map((i) => i.identifier).sort()).toEqual(['QAT-1', 'QAT-2']);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.startsWith('linear:') && !/ATL|BCN|ZED/.test(c))).toBe(true);
    expect(calls.some((c) => c.startsWith('gh:'))).toBe(false);
    calls.length = 0;
    await service.getTeam('QAT'); // fresh: nothing to read
    expect(calls).toEqual([]);
  });
  it('a team opened once stays loaded across later refreshes; unknown or malformed keys read nothing', async () => {
    const { service, calls } = await setup();
    await service.getTeam('QAT');
    const snap = await service.get(true);
    expect(snap.teams.find((t) => t.key === 'QAT')!.loaded).toBe(true);
    calls.length = 0;
    expect(await service.getTeam('NOPE')).toBeUndefined();
    expect(await service.getTeam('bad key!')).toBeUndefined();
    expect(calls).toEqual([]);
  });
  it('the HTTP endpoint validates the key server-side', async () => {
    const { service } = await setup();
    const { auth, password } = await makeAuth();
    const app = await buildApp(service, { distDir: '/none', auth });
    const sess = await signIn(app, password);
    const get = (url: string) => app.inject({ url, headers: { host: 'devflow.localhost:4317', cookie: sess.cookie } });
    expect((await get('/api/team/QAT')).json().teams.find((t: { key: string }) => t.key === 'QAT').loaded).toBe(true);
    expect((await get('/api/team/NOPE')).statusCode).toBe(404);
    expect((await get('/api/team/a%20b')).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/team/QAT', headers: { host: 'devflow.localhost:4317', cookie: sess.cookie } })).statusCode).toBe(405);
  });
});

describe('labels per team keep their own names and colors', () => {
  it('team labels plus workspace labels; different teams have different sets', async () => {
    const { snap } = await setup();
    const names = (k: string) => snap.labels.filter((l) => l.teamKey === k).map((l) => l.name).sort();
    expect(names('ZED')).toEqual(['Bug', 'Chore', 'Feature', 'Go', 'Spike']);
    expect(names('BCN')).toEqual(['Bug', 'Feature', 'Idea', 'Ready']);
    expect(names('ATL')).toContain('Needs Design');
    expect(names('ZED')).not.toContain('Ready'); // no label leaks between teams
    const color = (k: string, n: string) => snap.labels.find((l) => l.teamKey === k && l.name === n)!;
    expect(color('ATL', 'Ready').color).toBe('#4EA7FC');
    expect(color('BCN', 'Ready').color).toBe('#2D9CDB'); // same name, the team's own color
    expect(color('ZED', 'Bug')).toMatchObject({ color: '#EB5757', scope: 'workspace' }); // workspace label shared across teams
    expect(color('ZED', 'Go').protected).toBe(true); // ZED's team policy names Go as its ready label
    expect(color('ATL', 'Ready').protected).toBe(true);
  });
});

describe('issues are scoped to their own team and project, including unprojected ones', () => {
  it('team-wide data includes unprojected issues and issues of projects config does not mention', async () => {
    const { snap } = await setup();
    expect(snap.issues.filter((i) => i.teamKey === 'ATL')).toHaveLength(21);
    expect(issue(snap, 'ATL-20').linearProjectId).toBeUndefined(); // unprojected
    expect(issue(snap, 'ATL-21').linearProjectId).toBe('lp-ATL2'); // another project in the team
    expect(issue(snap, 'ATL-3').linearProjectId).toBe('lp-ATL');
    expect(snap.issues.filter((i) => i.teamKey === 'ZED').map((i) => i.identifier).sort()).toEqual(['ZED-1', 'ZED-2', 'ZED-3', 'ZED-4']);
  });
  it('policy is never inherited across projects or from a project to unprojected issues', async () => {
    const { snap } = await setup();
    const p = (id: string) => { const i = issue(snap, id); return [i.policy, i.configProjectId ?? null, i.write.allowed]; };
    expect(p('ATL-3')).toEqual(['project', 'atlas', true]); // covered by the Atlas config project
    expect(p('ATL-21')).toEqual(['default', null, false]); // Atlas Labs: config names only "Atlas"
    expect(p('ATL-20')).toEqual(['default', null, false]); // unprojected: not covered by the project entry
    expect(p('BCN-2')).toEqual(['project', 'beacon', true]); // whole-team style entry covers PROJECTS of BCN...
    expect(p('BCN-5')).toEqual(['default', null, false]); // ...but not its unprojected issues
    expect(p('ZED-2')).toEqual(['team', null, true]); // explicit team-level policy and write
    expect(p('ZED-3')).toEqual(['team', null, true]);
  });
  it('stage rules use each issue\'s own vocabulary (Go/Spike for ZED, Ready/Discovery for ATL)', async () => {
    const { snap } = await setup();
    expect(issue(snap, 'ZED-3').stage).toBe('ready'); // Todo + "Go"
    expect(issue(snap, 'ZED-1').stage).toBe('discovery'); // "Spike"
    expect(issue(snap, 'ZED-2').stage).toBe('backlog'); // Chore is a classification label, not a stage
    expect(issue(snap, 'ATL-8').stage).toBe('discovery');
  });
  it('milestones stay per project; issues without one and unprojected issues are separate groups', async () => {
    const { snap } = await setup();
    const atl = snap.milestones.filter((m) => m.teamKey === 'ATL');
    expect(atl.find((m) => m.id === 'm2')).toMatchObject({ linearProjectId: 'lp-ATL', kind: 'milestone' });
    expect(atl.find((m) => m.id === 'none:lp-ATL2')!.issueIdentifiers).toEqual(['ATL-21']);
    expect(atl.find((m) => m.kind === 'no-project')!.issueIdentifiers).toEqual(['ATL-20']);
    expect(atl.find((m) => m.id === 'none:lp-ATL')!.issueIdentifiers).toContain('ATL-15');
    expect(snap.milestones.find((m) => m.id === 'z1')).toMatchObject({ teamKey: 'ZED', linearProjectId: 'lp-ZED' });
  });
});

describe('GitHub evidence is tied to the right repository', () => {
  it('a PR links only to issues whose own project/team lists that repository', async () => {
    const { snap } = await setup();
    const pr = (k: string) => snap.prs.find((p) => p.key === k)!;
    expect(pr('demo-org/atlas#3').ticket).toMatchObject({ link: 'linked', identifier: 'ATL-3' });
    for (const k of ['demo-org/beacon#7', 'demo-org/atlas#20', 'demo-org/atlas#21']) {
      expect(pr(k).ticket.link, k).toBe('unlinked');
      expect(pr(k).ticket.via, k).toMatch(/not a configured repository/);
    }
    expect(issue(snap, 'ATL-3').prKeys).toEqual(['demo-org/atlas#3']); // not hijacked by the beacon-repo PR
    expect(issue(snap, 'ATL-20').prKeys).toEqual([]);
    expect(issue(snap, 'ATL-21').prKeys).toEqual([]);
  });
  it('PR scopes follow the repository owner (or the linked issue)', async () => {
    const { snap } = await setup();
    const pr = (k: string) => snap.prs.find((p) => p.key === k)!;
    expect(pr('demo-org/atlas#15').scope).toEqual({ teamKey: 'ATL', projectIds: ['lp-ATL'], includeUnprojected: false }); // unlinked: the repo's project only
    expect(pr('demo-org/beacon#7').scope).toEqual({ teamKey: 'BCN', projectIds: null, includeUnprojected: false });
    expect(pr('demo-org/atlas#3').scope).toEqual({ teamKey: 'ATL', projectIds: ['lp-ATL'], includeUnprojected: false }); // linked: the issue's project
  });
  it('projects and teams without a GitHub repository work', async () => {
    const { snap } = await setup();
    const zed = snap.teams.find((t) => t.key === 'ZED')!;
    expect(zed.projects[0]!.repos).toEqual([]);
    expect(zed.teamLevel.repos).toEqual([]);
    expect(snap.health.some((h) => h.id.includes('ZED') && h.id.startsWith('github:'))).toBe(false);
    const qat = (await (await setup()).service.getTeam('QAT'))!.teams.find((t) => t.key === 'QAT')!;
    expect(qat.projects[0]!.repos).toEqual([]);
    const atl = snap.teams.find((t) => t.key === 'ATL')!;
    expect(atl.projects.find((p) => p.name === 'Atlas')!.repos.map((r) => r.repo)).toEqual(['demo-org/atlas']);
    expect(atl.projects.find((p) => p.name === 'Atlas Labs')!.repos).toEqual([]); // a repo is not shared with sibling projects
  });
  it('activity and attention carry scope so views can filter them', async () => {
    const { snap } = await setup();
    expect(snap.activity.every((e) => e.teamKey)).toBe(true);
    expect(snap.activity.find((e) => e.ticket === 'ATL-3')).toMatchObject({ teamKey: 'ATL' });
    expect(snap.attention.filter((a) => a.teamKey === '' ).every((a) => a.kind === 'integration')).toBe(true);
    expect(snap.attention.find((a) => a.id === 'ci:demo-org/atlas#3')).toMatchObject({ teamKey: 'ATL' });
  });
});

describe('server-side write authorization (never the browser selection)', () => {
  it('refuses writes to unprojected issues, uncovered projects, unconfigured teams and un-inherited whole-team entries', async () => {
    const { actions, ops, service } = await setup();
    await service.getTeam('QAT');
    for (const id of ['ATL-20', 'ATL-21', 'BCN-5', 'QAT-1', 'QAT-2']) {
      for (const call of [() => actions.labels(id, ['lbl-bug'], []), () => actions.milestone(id, null), () => actions.approve(id, id), () => actions.revoke(id, id, ''), () => actions.status(id, 'st-x')]) {
        const e = await fail(call());
        expect([e.status, e.code], id).toEqual([403, 'not-authorized']);
      }
    }
    expect(ops()).toEqual([]);
  });
  it('options for a read-only scope explain why, and approval lists the policy check as failed', async () => {
    const { actions, service } = await setup();
    await service.getTeam('QAT');
    const o = await actions.options('ATL-20');
    expect(o).toMatchObject({ writeEnabled: false, scope: { teamKey: 'ATL', policy: 'default', explicitPolicy: false } });
    expect(o.reason).toMatch(/not covered by any configured project/);
    expect(o.approve.checks.find((c) => c.id === 'policy')).toMatchObject({ ok: false });
    expect(o.approve.checks.find((c) => c.id === 'policy')!.detail).toMatch(/never inherited/);
    expect((await actions.options('QAT-1')).reason).toMatch(/not covered/);
  });
  it('the authorization comes from the issue\'s live team/project; extra "team" fields in a request change nothing', async () => {
    const { service, actions, ops } = await setup();
    const { auth, password } = await makeAuth();
    const app = await buildApp(service, { distDir: '/none', actions, auth });
    const sess = await signIn(app, password);
    const r = await sess.post('/api/actions/labels', { identifier: 'ATL-20', team: 'ZED', teamKey: 'ZED', project: 'lp-ZED', add: ['lbl-bug'], remove: [] });
    expect([r.statusCode, r.json().code]).toEqual([403, 'not-authorized']);
    expect(ops()).toEqual([]);
  });
  it('writes work where config authorizes them, with that scope\'s own vocabulary', async () => {
    const { actions, spec } = await setup();
    expect((await actions.labels('ZED-2', ['lbl-zed-spike'], [])).ok).toBe(true); // unprojected, but team ZED is write-enabled
    expect(spec('ZED-2').labels).toEqual(['Chore', 'Spike']);
    expect((await actions.labels('ATL-3', ['lbl-security'], [])).ok).toBe(true); // project-covered
    expect((await actions.milestone('ZED-3', 'z1')).ok).toBe(true);
  });
  it('labels of another team are rejected even though they exist in Linear', async () => {
    const { actions, ops } = await setup();
    expect((await fail(actions.labels('ATL-3', ['lbl-zed-spike'], []))).code).toBe('unknown-label');
    expect(ops()).toEqual([]);
  });
  it('the team\'s ready label is protected for that team (Go for ZED), not the other teams\' (Ready)', async () => {
    const { actions } = await setup();
    expect((await fail(actions.labels('ZED-3', ['lbl-zed-go'], []))).code).toBe('protected-label');
    expect((await fail(actions.labels('ZED-1', ['lbl-zed-go'], []))).code).toBe('protected-label');
  });
  it('approval under an explicit TEAM policy uses that team\'s vocabulary and thresholds', async () => {
    const { actions, spec, f } = await setup();
    const o = await actions.options('ZED-2');
    expect(o.scope).toMatchObject({ policy: 'team', explicitPolicy: true });
    expect(o.approve.eligible).toBe(true);
    expect((await actions.approve('ZED-2', 'ZED-2')).ok).toBe(true);
    expect(spec('ZED-2').state).toBe('Todo');
    expect(spec('ZED-2').labels).toContain('Go'); // ZED's ready label, not "Ready"
    expect(f.store.comments.get('ZED-2')![0]!.body).toMatch(/label "Go" added/);
    const short = await actions.options('ZED-4'); // 'tbd' is shorter than ZED's minimum of 10
    expect(short.approve.eligible).toBe(false);
    expect(short.approve.checks.find((c) => c.id === 'description')).toMatchObject({ ok: false });
  });
  it('a project policy applies only to its own project', async () => {
    const { actions } = await setup();
    expect((await actions.options('ATL-3')).scope).toMatchObject({ policy: 'project' });
    expect((await actions.options('BCN-2')).scope).toMatchObject({ policy: 'project' });
    expect((await actions.options('ATL-21')).scope).toMatchObject({ policy: 'default', explicitPolicy: false });
  });
});

describe('scope resolver and configuration migration', () => {
  const legacy = parseConfig({ projects: [{ id: 'old', name: 'Old', linear: { teamKey: 'CRA', projects: [] }, github: { repos: ['o/r'] } }] }); // a pre-teams config
  it('a legacy config keeps working: projected issues stay writable with their project\'s rules', () => {
    const s = resolveScope(legacy, 'CRA', { id: 'p1', name: 'Any project' });
    expect([s.policy, s.writeAllowed, s.repos]).toEqual(['project', true, ['o/r']]);
  });
  it('...but unprojected issues of that team no longer inherit it and become read-only until a teams[] entry exists', () => {
    const s = resolveScope(legacy, 'CRA', undefined);
    expect([s.policy, s.writeAllowed, s.explicitPolicy, s.repos]).toEqual(['default', false, false, []]);
    const withTeam = parseConfig({ ...{ projects: legacy.projects.map((p) => ({ id: p.id, name: p.name, linear: p.linear, github: { repos: p.repos } })) }, teams: [{ key: 'cra', write: true, workflow: { readyLabel: 'Ready' } }] });
    expect(resolveScope(withTeam, 'CRA', undefined)).toMatchObject({ policy: 'team', writeAllowed: true, explicitPolicy: true });
  });
  it('a write-enabled teams[] entry without a workflow fails closed: rejected by the parser, and read-only if built by hand', () => {
    expect(() => parseConfig({ projects: [], teams: [{ key: 'A', write: true }] })).toThrow(/requires an explicit "workflow"/);
    const c = parseConfig({ projects: [], teams: [{ key: 'B' }, { key: 'D', write: true, workflow: { readyLabel: 'Go' } }] });
    expect(resolveScope(c, 'B')).toMatchObject({ writeAllowed: false });
    expect(resolveScope(c, 'C')).toMatchObject({ writeAllowed: false, explicitPolicy: false });
    expect(resolveScope(c, 'D')).toMatchObject({ writeAllowed: true, explicitPolicy: true });
    const bypass = { ...c, teams: [{ key: 'A', write: true, repos: [], knowledge: [] }] }; // a Config that never went through parseConfig
    expect(resolveScope(bypass, 'A')).toMatchObject({ writeAllowed: false, explicitPolicy: false });
    expect(resolveScope(bypass, 'A').writeReason).toMatch(/no explicit workflow/);
  });
  it('validates teams[] entries', () => {
    expect(() => parseConfig({ projects: [], teams: [{ key: 'A' }, { key: 'a' }] })).toThrow(/Duplicate teams/);
    expect(() => parseConfig({ projects: [], teams: [{ key: '1x' }] })).toThrow(/invalid/);
    expect(() => parseConfig({ projects: [], teams: [{ key: 'A', github: { repos: ['bad repo'] } }] })).toThrow(/owner\/repo/);
  });
  it('a config with no projects at all is valid: teams are still discovered', async () => {
    const f = demoFetch(now);
    const snap = await new SnapshotService(parseConfig({ projects: [] }), { linearKey: DEMO_READ_KEY, fetchImpl: f, mode: 'demo' }, () => now).get();
    expect(snap.teams.map((t) => t.key)).toEqual(['ATL', 'BCN', 'QAT', 'ZED']);
    expect(snap.teams.every((t) => !t.loaded && !t.configured)).toBe(true);
    expect(snap.issues).toEqual([]); // nothing is read until a team is selected
  });
});

describe('custom readiness labels cannot be edited as ordinary labels', () => {
  it('a team whose ready label is custom (Go) cannot add or remove it through label edits', async () => {
    const { actions, ops } = await setup();
    const zed = (await setup()).snap.issues.find((i) => i.identifier.startsWith('ZED-'))!;
    expect((await fail(actions.labels(zed.identifier, ['lbl-zed-go'], []))).code).toBe('protected-label');
    expect(ops()).toEqual([]);
  });
  it('a write-enabled team with no workflow (config built by hand) refuses every label edit and mutates nothing', async () => {
    const base = await setup();
    const cfg = { ...base.cfg, teams: [{ key: 'ZED', write: true, repos: [], knowledge: [] }] };
    const actions = new LinearActions({ cfg, read: new LinearClient(DEMO_READ_KEY, base.f), write: new LinearWriteClient(DEMO_WRITE_KEY, base.f), service: base.service, clock: () => now });
    const zed = base.snap.issues.find((i) => i.identifier.startsWith('ZED-'))!;
    for (const id of ['lbl-zed-go', 'lbl-zed-spike']) expect((await fail(actions.labels(zed.identifier, [id], []))).code).toBe('not-authorized');
    expect(base.ops()).toEqual([]);
  });
});
