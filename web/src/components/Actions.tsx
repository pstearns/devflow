import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ActionOptions, Issue, Snapshot } from '../../../shared/types.ts';
import { api, postAction } from '../lib.ts';
import { LabelChip } from './Labels.tsx';
import { btn, select } from './ui.tsx';

type Kind = 'labels' | 'status' | 'milestone' | 'approve' | 'revoke';

const ITEMS: { kind: Kind; label: string; hint: string }[] = [
  { kind: 'labels', label: 'Edit labels…', hint: 'Add or remove ordinary labels' },
  { kind: 'status', label: 'Change status…', hint: 'Linear decides what is allowed' },
  { kind: 'milestone', label: 'Set milestone…', hint: 'Assign or remove a project milestone' },
  { kind: 'approve', label: 'Approve for execution…', hint: 'Set the execution state and add the ready label' },
  { kind: 'revoke', label: 'Revoke readiness…', hint: 'Remove the ready label and return to backlog' },
];

/** Contextual menu for one issue. Every change is validated and verified server-side against live Linear. */
export function IssueActions({ issue, snap, onResult, compact }: { issue: Issue; snap: Snapshot; onResult: (s: Snapshot, message: string) => void; compact?: boolean }) {
  const [menu, setMenu] = useState(false);
  const [kind, setKind] = useState<Kind>();
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>();
  const MENU_W = 256, EDGE = 8;
  // The menu lives in a portal with fixed positioning so a scrolling/clipping column (Pipeline) can never cut it off.
  // It opens below the button, right-aligned, and flips upward or slides in when it would leave the viewport.
  useLayoutEffect(() => {
    if (!menu) { setPos(undefined); return; }
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    const h = menuRef.current?.offsetHeight ?? 320;
    const left = Math.max(EDGE, Math.min(b.right - MENU_W, window.innerWidth - MENU_W - EDGE));
    const below = b.bottom + 4;
    const top = below + h > window.innerHeight - EDGE ? b.top - 4 - h : below;
    setPos({ left, top: Math.max(EDGE, Math.min(top, window.innerHeight - h - EDGE)) }); // always fully inside the window
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { const t = e.target as Node; if (!ref.current?.contains(t) && !menuRef.current?.contains(t)) setMenu(false); };
    const dismiss = () => setMenu(false); // a fixed menu would drift away from its button if the page or a column scrolls
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    window.addEventListener('scroll', dismiss, true); window.addEventListener('resize', dismiss);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); window.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss); };
  }, [menu]);
  const w = snap.write;
  return (
    <div className="relative inline-block" ref={ref}>
      <button ref={btnRef} className={`${btn} ${compact ? 'px-1.5 py-0.5' : ''}`} aria-haspopup="menu" aria-expanded={menu} onClick={(e) => { e.stopPropagation(); setMenu(!menu); }} title="Actions in Linear">
        {compact ? '⋯' : 'Actions ▾'}<span className="sr-only"> for {issue.identifier}</span>
      </button>
      {menu && createPortal(
        <div role="menu" ref={menuRef} style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, width: MENU_W, visibility: pos ? 'visible' : 'hidden' }}
          className="z-50 max-h-[calc(100vh-16px)] overflow-y-auto rounded border border-line bg-panel p-1 shadow-lg">
          {!w.enabled && <div className="px-2 py-1 text-[11px] text-warn">{w.reason ?? 'Linear write access is not configured.'} Options below show what is available once it is.</div>}
          {w.enabled && !issue.write.allowed && <div className="px-2 py-1 text-[11px] text-warn">Read-only here: {issue.write.reason ?? 'this team/project is not enabled for writes'}. The server re-checks this for every action.</div>}
          {ITEMS.map((it) => (
            <button key={it.kind} role="menuitem" className="block w-full rounded px-2 py-1 text-left hover:bg-raised" title={it.hint}
              onClick={() => { setMenu(false); setKind(it.kind); }}>
              {it.label}<span className="block text-[11px] text-muted">{it.hint}</span>
            </button>
          ))}
          <div className="border-t border-line px-2 py-1 text-[11px] text-muted">Changes are made in Linear and verified by re-reading it.</div>
        </div>,
        document.body,
      )}
      {kind && <ActionDialog kind={kind} issue={issue} onClose={() => setKind(undefined)} onResult={(s, m) => { setKind(undefined); onResult(s, m); }} />}
    </div>
  );
}

function ActionDialog({ kind, issue, onClose, onResult }: { kind: Kind; issue: Issue; onClose: () => void; onResult: (s: Snapshot, m: string) => void }) {
  const [opts, setOpts] = useState<ActionOptions>();
  const [loadErr, setLoadErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [checks, setChecks] = useState<ActionOptions['approve']['checks']>();
  const [typed, setTyped] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [stateId, setStateId] = useState('');
  const [ms, setMs] = useState('');
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await api(`/api/issue-actions/${encodeURIComponent(issue.identifier)}`, { interaction: 'user' });
        const j = await r.json();
        if (!live) return;
        if (!r.ok) throw new Error(typeof j.error === 'string' ? j.error : `HTTP ${r.status}`);
        const o = j as ActionOptions;
        setOpts(o);
        setPicked(new Set(o.labels.filter((l) => l.applied).map((l) => l.id)));
        setStateId(o.state.id); setMs(o.milestones.current ?? '');
      } catch (e) { if (live) setLoadErr(e instanceof Error ? e.message : 'Could not load live options from Linear'); }
    })();
    return () => { live = false; };
  }, [issue.identifier]);
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', esc); return () => document.removeEventListener('keydown', esc); }, [onClose]);
  useEffect(() => { first.current?.focus(); }, [opts]);

  const submit = async (k: string, body: Record<string, unknown>) => {
    if (!opts) return;
    setBusy(true); setErr(undefined);
    const r = await postAction(k, { identifier: issue.identifier, ...body });
    setBusy(false);
    if (r.ok) onResult(r.snapshot, r.message); else { setErr(r.error); setChecks(r.checks); }
  };

  const title = ITEMS.find((i) => i.kind === kind)!.label.replace('…', '');
  const confirmOk = typed.trim().toLowerCase() === issue.identifier.toLowerCase();
  const disabled = !opts?.writeEnabled;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 p-4 pt-16" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={`${title} for ${issue.identifier}`} className="max-h-[80vh] w-full max-w-lg overflow-auto rounded-md border border-line bg-panel p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-start justify-between gap-2">
          <div><h2 className="text-[14px] font-semibold">{title}</h2><div className="text-[12px] text-muted"><span className="mono">{issue.identifier}</span> {issue.title}</div></div>
          <button className={btn} onClick={onClose} aria-label="Close dialog">✕</button>
        </div>
        {!opts && !loadErr && <p className="text-muted">Reading live options from Linear…</p>}
        {loadErr && <p className="text-bad">Could not read Linear: {loadErr}</p>}
        {opts && disabled && <p className="mb-2 rounded border border-warn/50 bg-warn/10 p-2 text-warn">{opts.reason}. Set <span className="mono">LINEAR_WRITE_API_KEY</span> (a separate Linear key with Write permission) and restart DevFlow. Read-only features are unaffected.</p>}

        {opts && kind === 'labels' && (
          <div className="space-y-2">
            <p className="text-[12px] text-muted">Current state: {opts.state.name}. Only the labels you change are touched; others are preserved. Protected workflow labels are locked: <b>{opts.names.ready}</b> changes only through Approve and Revoke, any other protected label is edited in Linear.</p>
            <ul className="max-h-72 space-y-0.5 overflow-auto">
              {opts.labels.map((l) => (
                <li key={l.id}>
                  <label className={`flex items-center gap-2 rounded px-1 py-0.5 ${l.editable ? 'cursor-pointer hover:bg-raised' : 'opacity-60'}`} title={l.reason}>
                    <input type="checkbox" disabled={!l.editable} checked={picked.has(l.id)} onChange={() => setPicked((s) => { const n = new Set(s); n.has(l.id) ? n.delete(l.id) : n.add(l.id); return n; })} />
                    <LabelChip l={l} lock={!!l.reason && /Protected/.test(l.reason)} />
                    {l.classification && <span className="text-[11px] text-muted">classification</span>}
                    {l.reason && !disabled && <span className="text-[11px] text-muted">{l.reason}</span>}
                  </label>
                </li>
              ))}
            </ul>
            <button ref={first} className={btn} disabled={busy || disabled} onClick={() => {
              const add = opts.labels.filter((l) => l.editable && picked.has(l.id) && !l.applied).map((l) => l.id);
              const remove = opts.labels.filter((l) => l.editable && !picked.has(l.id) && l.applied).map((l) => l.id);
              if (!add.length && !remove.length) { setErr('No changes to apply'); return; }
              submit('labels', { add, remove });
            }}>{busy ? 'Applying…' : 'Apply label changes'}</button>
          </div>
        )}

        {opts && kind === 'status' && (
          <div className="space-y-2">
            <p className="text-[12px] text-muted">The change is sent to Linear as chosen. Linear decides what is allowed, and DevFlow reads the issue back to show the result.</p>
            <ul className="space-y-0.5">
              {opts.states.map((s) => (
                <li key={s.id}>
                  <label className={`flex items-baseline gap-2 rounded px-1 py-0.5 ${s.allowed || s.current ? 'cursor-pointer hover:bg-raised' : 'opacity-60'}`}>
                    <input type="radio" name="state" disabled={!s.allowed && !s.current} checked={stateId === s.id} onChange={() => setStateId(s.id)} />
                    <span>{s.name}</span><span className="text-[11px] text-muted">{s.type}{s.reason ? ` — ${s.reason}` : ''}</span>
                  </label>
                </li>
              ))}
            </ul>
            <button ref={first} className={btn} disabled={busy || disabled || stateId === opts.state.id} onClick={() => submit('status', { stateId })}>{busy ? 'Applying…' : 'Change status'}</button>
          </div>
        )}

        {opts && kind === 'milestone' && (
          <div className="space-y-2">
            {opts.milestones.reason && <p className="text-[12px] text-muted">{opts.milestones.reason}</p>}
            <select className={`${select} w-full`} value={ms} disabled={!opts.milestones.canChange} onChange={(e) => setMs(e.target.value)} aria-label="Milestone">
              <option value="">No milestone</option>
              {opts.milestones.options.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <p className="text-[11px] text-muted">Only milestones of this issue's own Linear project are offered.</p>
            <button ref={first} className={btn} disabled={busy || !opts.milestones.canChange || ms === (opts.milestones.current ?? '')} onClick={() => submit('milestone', { milestoneId: ms || null })}>{busy ? 'Applying…' : ms ? 'Assign milestone' : 'Remove milestone'}</button>
          </div>
        )}

        {opts && kind === 'approve' && (
          <div className="space-y-2">
            <p className="text-[12px]">Approving authorizes execution: DevFlow will move <b>{issue.identifier}</b> to <b>{opts.approve.todoState ?? 'Todo'}</b>, add the protected <b>{opts.names.ready}</b> label (the same two changes you would make in Linear), then re-read Linear and show what it reports. It does not start any agent.</p>
            <ul className="space-y-0.5" aria-label="Prerequisites">
              {(checks ?? opts.approve.checks).map((c) => (
                <li key={c.id} className="flex gap-2"><span className={c.ok ? 'text-ok' : 'text-bad'} aria-hidden>{c.ok ? '✓' : '✕'}</span><span><span className={c.ok ? '' : 'font-medium'}>{c.label}</span><span className="block text-[11px] text-muted">{c.detail}</span></span></li>
              ))}
            </ul>
            {!opts.approve.eligible && <p className="text-bad">Approval is not available yet. Fix the failed prerequisites, then reopen this dialog.</p>}
            {opts.approve.eligible && !disabled && (
              <label className="block text-[12px]">Type <span className="mono">{issue.identifier}</span> to confirm
                <input className={`${select} mt-1 block w-full`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" aria-label="Confirmation" />
              </label>
            )}
            <button ref={first} className={btn} disabled={busy || disabled || !opts.approve.eligible || !confirmOk} onClick={() => submit('approve', { confirm: typed })}>{busy ? 'Approving…' : 'Approve for execution'}</button>
          </div>
        )}

        {opts && kind === 'revoke' && (
          <div className="space-y-2">
            <p className="text-[12px]">{opts.names.backlog ? <>Revoking removes the protected <b>{opts.names.ready}</b> label, returns <b>{issue.identifier}</b> to <b>{opts.names.backlog}</b>, then re-reads Linear and shows what it reports.</> : <>Revocation is unavailable because this team has no backlog state. Nothing will be changed.</>}</p>
            {!opts.revoke.possible && opts.revoke.reason && <p className="text-warn">{opts.revoke.reason}</p>}
            {opts.revoke.possible && !disabled && (
              <>
                <label className="block text-[12px]">Type <span className="mono">{issue.identifier}</span> to confirm
                  <input className={`${select} mt-1 block w-full`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" aria-label="Confirmation" />
                </label>
              </>
            )}
            <button ref={first} className={btn} disabled={busy || disabled || !opts.revoke.possible || !confirmOk} onClick={() => submit('revoke', { confirm: typed })}>{busy ? 'Revoking…' : 'Revoke readiness'}</button>
          </div>
        )}

        {err && <p role="alert" className="mt-2 rounded border border-bad/50 bg-bad/10 p-2 text-bad">{err}</p>}
      </div>
    </div>
  );
}
