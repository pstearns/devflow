// LIVE agent test on a SYNTHETIC fixture only: real Claude Code + real Codex, each inside the bubblewrap sandbox with a copy of your own
// login. Everything else is local and fake: a temp bare repo as "origin", the synthetic Linear, a local CI that runs `node --test` on the
// pushed SHA, an in-memory PR service. No real Linear, no real GitHub, no production project. It spends model tokens, so it is opt-in:
//   DEVFLOW_LIVE=1 DEVFLOW_CODEX_BIN=/path/to/codex npx tsx scripts/m1-live.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeWorld } from '../test/orchestrator-harness.ts';

if (process.env.DEVFLOW_LIVE !== '1') { console.error('Refusing to run: this spends real model tokens. Set DEVFLOW_LIVE=1.'); process.exit(2); }
const which = (b: string) => { try { return execFileSync('sh', ['-c', `command -v ${b}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const claudeBin = process.env.DEVFLOW_CLAUDE_BIN || which('claude'), codexBin = process.env.DEVFLOW_CODEX_BIN || which('codex');
if (!claudeBin || !codexBin) { console.error(`Need both CLIs. claude=${claudeBin || 'missing'} codex=${codexBin || 'missing (set DEVFLOW_CODEX_BIN)'}`); process.exit(2); }

const description = 'Add a function `slugify(text)` in src/slugify.mjs (ES module, named export). It lowercases the text, collapses every run of non-alphanumeric characters into a single "-", and trims leading and trailing "-". Examples: "Hello World" -> "hello-world"; "Hello, World!" -> "hello-world"; "  --A  b--" -> "a-b"; "" -> "". Add tests in test/slugify.test.mjs using node:test, runnable with `node --test`.';
const w = makeWorld({ live: { claudeBin, codexBin, description } });
const t0 = Date.now();
try {
  console.log(`claude: ${claudeBin}\ncodex:  ${codexBin}\nfixture: synthetic ATL-22 in a temp repo; nothing real is touched.\n`);
  const pf = await w.orch.run('ATL-22').then((m) => m, (e) => { console.error(`RUN REFUSED/FAILED: ${e instanceof Error ? e.message : e}`); return undefined; });
  if (!pf) process.exitCode = 1;
  else {
    console.log(w.logs.filter((l) => /state:|ci-result|review-validated|review-invalid|infra-failure|linear-comment|escalation/.test(l)).map((l) => '  ' + l.replace(/^ATL-22 \w+ /, '')).join('\n'));
    console.log(`\nstate=${pf.state} outcome=${pf.outcome} class=${pf.reasonClass ?? '-'} attempts=${pf.attempts.length} infra=${pf.infra.length} approvedSha=${pf.approvedSha?.slice(0, 12)} elapsed=${Math.round((Date.now() - t0) / 1000)}s`);
    console.log(`Linear ticket: ${w.issue().state}; comments=${w.comments().length}; draft PRs=${JSON.stringify(w.prs.created.map((p) => ({ ...p, branch: '…' })))}`);
    w.comments().forEach((c, i) => console.log(`--- comment ${i + 1} ---\n${c}\n`));
    const dir = join(w.runsDir, `ATL-22-${pf.runId}`);
    console.log(`evidence: ${existsSync(dir) ? dir : '?'}`);
    if (pf.attempts[0]?.agent) console.log(`claude output (first 600 chars):\n${readFileSync(join(dir, 'attempt-0', 'claude-output.txt'), 'utf8').slice(0, 600)}`);
    process.exitCode = pf.outcome === 'PASS' ? 0 : 3;
  }
} finally { if (process.env.DEVFLOW_KEEP !== '1') w.dispose(); else console.log(`kept: ${w.root}`); }
