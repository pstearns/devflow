// Acceptance demonstration for M1 on a SYNTHETIC ticket. Hermetic: local bare repo as origin, fake Linear, scripted Claude/Codex stand-ins
// run through the real controller, subprocess runner, git, CI-on-SHA and review validation. Run:  npx tsx scripts/m1-demo.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorld } from '../test/orchestrator-harness.ts';

const w = makeWorld();
const say = (s = '') => console.log(s);
try {
  say('Synthetic ticket ATL-22 "Add slugify helper" — Todo + Ready (explicitly approved). SCENARIO: planted trailing-dash defect.\n');
  const m = await w.orch.run('ATL-22');
  say('== controller log =='); say(w.logs.filter((l) => /state:|ci-result|review-validated|linear-comment/.test(l)).map((l) => '  ' + l.replace(/^ATL-22 \w+ /, '')).join('\n'));
  say('\n== attempts ==');
  for (const a of m.attempts) say(`  attempt ${a.n}: sha ${a.headSha?.slice(0, 12)}  CI=${a.ci?.state}  review=${a.review?.verdict}${a.failure ? `  (${a.failure})` : ''}`);
  say('\n== Linear comments (as recorded) ==');
  w.comments().forEach((c, i) => say(`--- #${i + 1} ---\n${c}\n`));
  say('== Linear ticket state ==  ' + w.issue().state);
  say(`== run result ==  state=${m.state} outcome=${m.outcome} approvedSha=${m.approvedSha?.slice(0, 12)}  remote branch head=${w.remoteHead(m.branch).slice(0, 12)}  main unchanged=${w.mainHead() === m.baseSha}`);
  say(`== evidence dir ==  ${join(w.runsDir)}  (manifest.json, events.jsonl, attempt-*/)`);
  say(`\n== repair prompt Claude received (attempt 1, excerpt) ==\n${readFileSync(join(w.runsDir, `ATL-22-${m.runId}`, 'attempt-1', 'claude-prompt.txt'), 'utf8').split('\n').slice(0, 8).join('\n')}`);
} finally { w.dispose(); }
