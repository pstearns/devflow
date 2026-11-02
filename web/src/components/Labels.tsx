import { useEffect, useRef } from 'react';
import type { LabelDef, LabelRef, ProjectInfo } from '../../../shared/types.ts';
import { matchesLabels, parseLabelParam } from '../lib.ts';

const hex = (c: string) => (/^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#8b97a7');

/** A Linear label with its real name and color. `lock` marks protected workflow labels (e.g. Ready). */
export function LabelChip({ l, lock }: { l: LabelRef; lock?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-line px-1 text-[11px] leading-4" title={lock ? `${l.name}: protected workflow label (set via Approve for execution)` : l.name}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: hex(l.color) }} aria-hidden />
      {l.name}{lock && <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 text-muted" aria-label="protected" role="img"><path d="M3 5.5V4a3 3 0 0 1 6 0v1.5M2.5 5.5h7v5h-7z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>}
    </span>
  );
}

/** Labels for one issue: classification labels first, then others; the workflow label is shown locked. */
export function IssueLabels({ labels, project }: { labels: LabelRef[]; project?: ProjectInfo }) {
  if (!labels.length) return null;
  const wf = project?.workflow;
  const low = (s: string) => s.toLowerCase();
  const prot = wf ? [wf.readyLabel, ...wf.protectedLabels].map(low) : [];
  const cls = wf ? wf.classificationLabels.map(low) : [];
  const sorted = [...labels].sort((a, b) => Number(cls.includes(low(b.name))) - Number(cls.includes(low(a.name))));
  return <span className="inline-flex flex-wrap gap-1">{sorted.map((l) => <LabelChip key={l.id} l={l} lock={prot.includes(low(l.name))} />)}</span>;
}

/** Any-of label filter built from the labels Linear returned (not a fixed list). */
export function LabelFilter({ labels, selected, onChange }: { labels: LabelDef[]; selected: string[]; onChange: (names: string[]) => void }) {
  const seen = new Map<string, LabelDef>();
  for (const l of labels) if (!l.isGroup && !seen.has(l.name.toLowerCase())) seen.set(l.name.toLowerCase(), l);
  const list = [...seen.values()].sort((a, b) => Number(b.classification) - Number(a.classification) || a.name.localeCompare(b.name));
  const toggle = (n: string) => onChange(selected.some((s) => s.toLowerCase() === n.toLowerCase()) ? selected.filter((s) => s.toLowerCase() !== n.toLowerCase()) : [...selected, n]);
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <details className="relative" ref={ref}>
      <summary className="cursor-pointer select-none rounded border border-line bg-raised px-1.5 py-1 text-[12px]">
        Labels{selected.length ? `: ${selected.length}` : ''}
      </summary>
      <div className="absolute z-20 mt-1 max-h-72 w-56 overflow-auto rounded border border-line bg-panel p-1.5 shadow-lg">
        {list.length === 0 && <div className="p-1 text-muted">No labels loaded from Linear.</div>}
        {list.map((l) => (
          <label key={l.name} className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-raised">
            <input type="checkbox" checked={selected.some((s) => s.toLowerCase() === l.name.toLowerCase())} onChange={() => toggle(l.name)} />
            <LabelChip l={l} lock={l.protected} />
          </label>
        ))}
        {selected.length > 0 && <button className="mt-1 w-full text-left text-accent" onClick={() => onChange([])}>Clear labels</button>}
      </div>
    </details>
  );
}

export { matchesLabels, parseLabelParam };
