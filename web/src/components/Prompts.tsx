import { useState } from 'react';
import type { PromptDef } from '../../../shared/types.ts';
import { copyText, fillPrompt } from '../lib.ts';
import { btn } from './ui.tsx';

export function Prompts({ prompts, project, ticket, milestone, only }: {
  prompts: PromptDef[]; project: string; ticket?: string; milestone?: string; only?: string[];
}) {
  const [done, setDone] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const list = only ? prompts.filter((p) => only.includes(p.id)) : prompts;
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {list.map((p) => {
          const text = fillPrompt(p, { project, ticket, milestone });
          return (
            <button
              key={p.id} className={btn} title={text}
              onClick={async () => {
                const ok = await copyText(text);
                setDone(ok ? p.id : undefined); setFailed(ok ? undefined : p.id);
                setTimeout(() => { setDone(undefined); setFailed(undefined); }, 1800);
              }}
            >
              {done === p.id ? '✓ Copied' : failed === p.id ? 'Copy failed' : p.label}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-[11px] text-muted">Copies text to your clipboard only. DevFlow never runs agents. Hover a button to preview.</p>
    </div>
  );
}
