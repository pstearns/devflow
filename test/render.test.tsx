import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { SnapshotService } from '../server/service.ts';
import { demoConfig, demoFetch } from '../server/demo.ts';
import { Overview } from '../web/src/views/Overview.tsx';
import { Milestones } from '../web/src/views/Milestones.tsx';
import { Pipeline } from '../web/src/views/Pipeline.tsx';
import { Activity } from '../web/src/views/Activity.tsx';
import { ScopeDetail, TicketDetail } from '../web/src/components/Detail.tsx';
import { Lifecycle } from '../web/src/components/Lifecycle.tsx';
import { fillPrompt } from '../web/src/lib.ts';

const now = Date.parse('2026-06-01T12:00:00Z');
const snapP = new SnapshotService(demoConfig(), { linearKey: 'k', githubToken: 't', fetchImpl: demoFetch(now), mode: 'demo' }, () => now).get();
const noop = () => {};
const SEL = { team: '', project: 'all' };

describe('UI renders without throwing (SSR smoke test; not a layout check)', () => {
  it('renders every view and detail panel from the demo snapshot', async () => {
    const snap = await snapP;
    const route = { view: 'milestones' as const, team: '', project: 'all', params: {} };
    const html = [
      renderToString(<Overview snap={snap} issues={snap.issues} sel={SEL} go={noop} now={now} />),
      renderToString(<Milestones snap={snap} issues={snap.issues} sel={SEL} route={route} go={noop} onOpen={noop} onResult={noop} />),
      renderToString(<Pipeline snap={snap} issues={snap.issues} onOpen={noop} now={now} route={route} go={noop} sel={SEL} onResult={noop} />),
      renderToString(<Activity snap={snap} sel={SEL} onOpen={noop} now={now} />),
      renderToString(<Lifecycle issues={snap.issues} />),
      renderToString(<ScopeDetail snap={snap} sel={{ team: 'ATL', project: 'all' }} onSelectProject={noop} />),
      ...snap.issues.map((i) => renderToString(<TicketDetail issue={i} snap={snap} onOpen={noop} onResult={noop} />)),
    ].join('\n');
    expect(html).toContain('ATL-3');
    expect(html).toContain('Backlog'); // Backlog is its own stage column
    expect(html).toContain('Discovery');
    expect(html).toContain('#EB5757'); // real Linear label colors are used
    expect(html).toContain('Actions'); // contextual action menu
    expect(html).toContain('Labels'); // label filter
    expect(html).toContain('M1 Foundations');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toMatch(/href="(?!https:|obsidian:|#)/); // no non-https hrefs
  });
  it('fills prompt placeholders with project and ticket', async () => {
    const snap = await snapP;
    const p = snap.prompts.find((x) => x.id === 'resume')!;
    const t = fillPrompt(p, { project: 'Atlas', ticket: 'ATL-3' });
    expect(t).toContain('ATL-3');
    expect(t).toContain('Atlas');
    expect(t).not.toContain('{{');
  });
});
