import type { ReactNode } from 'react';
import type { Evidence, Status, Tri } from '../../../shared/types.ts';
import { fullTime, relTime } from '../lib.ts';

const TRI: Record<Tri, { glyph: string; label: string; cls: string }> = {
  passed: { glyph: '✓', label: 'Passed', cls: 'text-ok' },
  failed: { glyph: '✕', label: 'Failed', cls: 'text-bad' },
  pending: { glyph: '…', label: 'Pending', cls: 'text-warn' },
  unknown: { glyph: '?', label: 'Unknown', cls: 'text-muted' },
  na: { glyph: '–', label: 'N/A', cls: 'text-muted opacity-70' },
};

export function Pill({ value, status, label, compact }: { value?: Tri; status?: Status; label?: string; compact?: boolean }) {
  const v = status?.value ?? value ?? 'unknown';
  const t = TRI[v];
  const src = status?.evidence.map((e) => e.source).filter((x, i, a) => a.indexOf(x) === i).join(', ');
  const title = status ? `${t.label}: ${status.detail}${src ? ` (source: ${src})` : ''}` : t.label;
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap ${t.cls}`}>
      <span className="mono w-3 text-center font-bold" aria-hidden>{t.glyph}</span>
      <span className={compact ? 'sr-only' : ''}>{label ?? t.label}</span>
    </span>
  );
}

export function Ext({ href, children, className = '', title }: { href?: string; children: ReactNode; className?: string; title?: string }) {
  if (!href) return <span className={`text-muted ${className}`} title={title ?? 'No source link available'}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className} title={title ?? href}>
      {children}<span className="ml-0.5 text-[10px] opacity-60" aria-hidden>↗</span>
    </a>
  );
}

export function Time({ iso, now }: { iso?: string; now?: number }) {
  return <time dateTime={iso} title={fullTime(iso)} className="tabular text-muted">{relTime(iso, now)}</time>;
}

export function Card({ title, right, children, className = '' }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-md border border-line bg-panel ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h2>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="px-3 py-6 text-center text-muted">{children}</div>;

export function EvidenceList({ items }: { items: Evidence[] }) {
  if (!items.length) return <span className="text-muted">no evidence recorded</span>;
  return (
    <ul className="space-y-0.5">
      {items.map((e, i) => (
        <li key={i} className="flex flex-wrap gap-x-1.5 text-[12px]">
          <span className="text-muted">{e.source}:</span>
          <Ext href={e.url}>{e.label}</Ext>
          {e.at && <Time iso={e.at} />}
        </li>
      ))}
    </ul>
  );
}

export const btn = 'rounded border border-line bg-raised px-2 py-1 text-[12px] hover:border-accent disabled:opacity-50';
export const select = 'rounded border border-line bg-raised px-1.5 py-1 text-[12px] text-fg';

export function Tag({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'bad' | 'warn' | 'ok' | 'accent' }) {
  const c = { muted: 'text-muted border-line', bad: 'text-bad border-bad/50', warn: 'text-warn border-warn/50', ok: 'text-ok border-ok/50', accent: 'text-accent border-accent/50' }[tone];
  return <span className={`inline-block whitespace-nowrap rounded-sm border px-1 text-[11px] leading-4 ${c}`}>{children}</span>;
}
