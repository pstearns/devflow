import { STAGES, type Issue, type Stage } from '../../../shared/types.ts';

/** Read-only lifecycle diagram. With `issue`, highlights that ticket's evidenced stage; otherwise shows counts. */
export function Lifecycle({ issues, issue }: { issues?: Issue[]; issue?: Issue }) {
  const counts = new Map<Stage, number>();
  for (const i of issues ?? []) if (i.stage) counts.set(i.stage, (counts.get(i.stage) ?? 0) + 1);
  const rework = (issues ?? []).filter((i) => i.rework.length).length;
  const cur = issue?.stage;
  const curIdx = STAGES.findIndex((s) => s.id === cur);
  return (
    <div className="min-w-0">
      <ol className="flex flex-wrap items-stretch gap-y-1" aria-label="Development lifecycle (read-only)">
        {STAGES.map((s, idx) => {
          const active = issue && s.id === cur;
          const passed = issue && curIdx > idx;
          const reworking = active && s.id === 'implementation' && (issue?.rework.length ?? 0) > 0;
          return (
            <li key={s.id} className="flex items-center">
              <div
                className={`flex items-center gap-1.5 whitespace-nowrap rounded border px-2 py-0.5 text-[12px] ${
                  active ? (reworking ? 'border-bad bg-bad/10 text-fg' : 'border-accent bg-accent/10 text-fg') : passed ? 'border-line text-muted' : 'border-line/60 text-muted'
                }`}
                aria-current={active ? 'step' : undefined}
              >
                {passed && <span className="text-ok" aria-hidden>✓</span>}
                <span className={active ? 'font-semibold' : ''}>{s.label}</span>
                {!issue && <span className="mono tabular text-fg">{counts.get(s.id) ?? 0}</span>}
              </div>
              {idx < STAGES.length - 1 && <span className="px-1 text-muted/60" aria-hidden>→</span>}
            </li>
          );
        })}
      </ol>
      <div className="mt-1 text-[11px] text-muted">
        {issue ? (
          issue.rework.length ? <span className="text-bad">↺ Loop back to Implementation: {issue.rework.join('; ')}</span>
            : issue.stage ? <span>Current stage is the furthest one with evidence; it does not control execution.</span>
            : <span>Canceled — outside the lifecycle.</span>
        ) : (
          <span>↺ CI failure or review findings loop back to Implementation{rework ? <> · <span className="text-bad">{rework} ticket{rework > 1 ? 's' : ''} in rework now</span></> : null} · read-only view</span>
        )}
      </div>
    </div>
  );
}
