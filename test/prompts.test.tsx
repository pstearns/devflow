import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { DEFAULT_PROMPTS, parseConfig } from '../server/config.ts';
import { fillPrompt } from '../web/src/lib.ts';
import { Prompts } from '../web/src/components/Prompts.tsx';

const byId = (id: string) => DEFAULT_PROMPTS.find((p) => p.id === id)!;
const A = { project: 'Alpha Team › Atlas', milestone: 'M1 Foundations', ticket: 'ATL-3' };
const B = { project: 'Beta Team › Beacon', milestone: 'M2 Launch', ticket: 'BCN-7' };
const decode = (h: string) => h.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&#x27;', "'").replaceAll('&amp;', '&');

describe('default prompt templates (PS-3)', () => {
  it('keeps the six IDs, button labels and order', () => {
    expect(DEFAULT_PROMPTS.map((p) => [p.id, p.label])).toEqual([
      ['discover', 'Discover ticket'], ['execute', 'Execute approved ticket'], ['review', 'Independent review'],
      ['resolve', 'Resolve review findings'], ['resume', 'Resume ticket'], ['milestone', 'Review milestone'],
    ]);
  });
  it('states each workflow contract and stays short', () => {
    const need: Record<string, RegExp[]> = {
      discover: [/Read-only/, /knowledge/, /dependencies/, /repo contracts/, /Ready, Waiting on prerequisite or Blocked/],
      execute: [/Claude Code only/, /explicitly approved Ready/, /branch\/PR state/, /dedicated branch/, /tests and scans/, /PR with acceptance evidence/, /Do not merge or change protected settings/, /three failed approaches/],
      review: [/Codex only/, /Read-only/, /full diff/, /raw CI\/security outputs/, /exact latest head SHA/, /severity, location, evidence and remedy/, /PASS, FAIL or INCOMPLETE for the reviewed SHA/],
      resolve: [/with Claude/, /each finding as fixed or disputed/, /current head SHA/, /rerun checks/i, /re-review on the new SHA/, /Do not bypass checks or merge/, /three failed approaches/],
      resume: [/with Claude/, /issue, branch, PR, CI and review state/, /last verified action without duplicating/, /verify Ready approval before editing/, /owner decision/, /three failed approaches/],
      milestone: [/Read-only/, /Done, Ready, Waiting on prerequisite, Blocked and unapproved Backlog/, /critical path and next executable task/],
    };
    for (const p of DEFAULT_PROMPTS) {
      for (const re of need[p.id]!) expect(p.template, p.id).toMatch(re);
      expect(p.template.length, p.id).toBeLessThan(450);
    }
    expect(byId('review').template).not.toMatch(/Claude/);
    expect(byId('execute').template).not.toMatch(/Codex/);
  });
  it('ticket prompts reference ticket, project and milestone; the milestone prompt needs no ticket', () => {
    for (const p of DEFAULT_PROMPTS.filter((x) => x.id !== 'milestone')) for (const t of ['{{ticket}}', '{{project}}', '{{milestone}}']) expect(p.template, p.id).toContain(t);
    expect(byId('milestone').template).not.toContain('{{ticket}}');
  });
});

describe('fillPrompt', () => {
  it('renders the selected issue, project and milestone for two distinct projects without leaking between them', () => {
    for (const p of DEFAULT_PROMPTS) {
      const a = fillPrompt(p, A);
      const b = fillPrompt(p, B);
      expect(a).not.toBe(b);
      for (const [mine, other] of [[a, B], [b, A]] as const) {
        expect(mine).not.toMatch(/\{\{|not selected/);
        for (const v of Object.values(other)) expect(mine).not.toContain(v);
      }
      expect(a).toContain(A.project); expect(a).toContain(A.milestone);
      expect(b).toContain(B.project); expect(b).toContain(B.milestone);
      if (p.id !== 'milestone') { expect(a).toContain(A.ticket); expect(b).toContain(B.ticket); }
    }
  });
  it('never guesses a missing selection', () => {
    const t = fillPrompt(byId('execute'), {});
    expect(t).toContain('<ticket not selected>');
    expect(t).toContain('<project not selected>');
    expect(t).toContain('<milestone not selected>');
    expect(t).toMatch(/Not selected: ticket, project, milestone\. Do not guess/);
    expect(t).not.toContain('{{');
  });
  it('names only the missing parts of a partial selection; blank counts as missing', () => {
    const t = fillPrompt(byId('resume'), { project: B.project, ticket: B.ticket, milestone: '  ' });
    expect(t).toContain('Resume BCN-7 (project Beta Team › Beacon, milestone <milestone not selected>)');
    expect(t).toMatch(/Not selected: milestone\./);
    const m = fillPrompt(byId('milestone'), { milestone: A.milestone });
    expect(m).toContain('"M1 Foundations" in <project not selected>');
    expect(m).toMatch(/Not selected: project\./); // ticket is not used by this template, so not reported
  });
  it('inserts selected names verbatim (no re-expansion of placeholder-like text)', () => {
    const t = fillPrompt(byId('discover'), { ticket: 'X-1', project: 'P {{milestone}}', milestone: 'M' });
    expect(t).toContain('project P {{milestone}}, milestone M');
  });
  it('fills config overrides the same way and keeps the defaults for the rest', () => {
    const c = parseConfig({ projects: [], prompts: { review: 'Custom review of {{ticket}} in {{project}}' } });
    expect(c.prompts.map((p) => p.id)).toEqual(DEFAULT_PROMPTS.map((p) => p.id));
    expect(fillPrompt(c.prompts.find((p) => p.id === 'review')!, A)).toBe('Custom review of ATL-3 in Alpha Team › Atlas');
    expect(fillPrompt(c.prompts.find((p) => p.id === 'review')!, {})).toMatch(/Not selected: ticket, project\./);
    expect(c.prompts.find((p) => p.id === 'execute')).toEqual(byId('execute'));
  });
});

describe('Prompts component', () => {
  it('renders one copy button per prompt with the filled text as preview, per selection', () => {
    const a = decode(renderToString(<Prompts prompts={DEFAULT_PROMPTS} {...A} />));
    const b = decode(renderToString(<Prompts prompts={DEFAULT_PROMPTS} {...B} />));
    for (const p of DEFAULT_PROMPTS) { expect(a).toContain(`>${p.label}</button>`); expect(a).toContain(fillPrompt(p, A)); expect(b).toContain(fillPrompt(p, B)); }
    expect(a).not.toContain('BCN-7'); expect(b).not.toContain('ATL-3');
    expect(a).toContain('Copies text to your clipboard only');
  });
  it('honors `only` and shows missing selection explicitly', () => {
    const h = decode(renderToString(<Prompts prompts={DEFAULT_PROMPTS} only={['milestone']} project={A.project} />));
    expect(h).toContain('Review milestone');
    expect(h).not.toContain('Discover ticket');
    expect(h).toContain('<milestone not selected>');
  });
});
