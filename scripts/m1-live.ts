// LIVE agent test on a SYNTHETIC, DISPOSABLE fixture only: real Claude Code + real Codex, each inside the bubblewrap sandbox with a copy of
// your own login. Nothing about the agents' answers is scripted. Everything else is local: a temp bare repo as "origin", the synthetic
// Linear, a local CI that runs `node --test` on each pushed SHA, an in-memory PR service. No real Linear, no real GitHub, no production project.
// It spends model tokens, so it is opt-in:
//   DEVFLOW_LIVE=1 DEVFLOW_CODEX_BIN=/abs/path/to/codex [DEVFLOW_LIVE_FIXTURE=rounding|slugify] npx tsx scripts/m1-live.ts
// The fixture "rounding" plants a latent bug in a shared helper that the ticket tells the implementer to reuse; whether the implementer or the
// reviewer notices is up to the real agents. Evidence is exported to $DEVFLOW_EVIDENCE_DIR (default ~/.local/share/devflow/m1-evidence).
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeWorld } from '../test/orchestrator-harness.ts';

if (process.env.DEVFLOW_LIVE !== '1') { console.error('Refusing to run: this spends real model tokens. Set DEVFLOW_LIVE=1.'); process.exit(2); }
const which = (b: string) => { try { return execFileSync('sh', ['-c', `command -v ${b}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const claudeBin = process.env.DEVFLOW_CLAUDE_BIN || which('claude'), codexBin = process.env.DEVFLOW_CODEX_BIN || '';
if (!claudeBin || !codexBin.startsWith('/')) { console.error(`Need both CLIs as explicit absolute paths. claude=${claudeBin || 'missing'} codex=${codexBin || 'missing (set DEVFLOW_CODEX_BIN=/abs/path)'}`); process.exit(2); }

const FIXTURES: Record<string, { description: string; seed: Record<string, string> }> = {
  slugify: {
    description: 'Add a function `slugify(text)` in src/slugify.mjs (ES module, named export). It lowercases the text, collapses every run of non-alphanumeric characters into a single "-", and trims leading and trailing "-". Examples: "Hello World" -> "hello-world"; "Hello, World!" -> "hello-world"; "  --A  b--" -> "a-b"; "" -> "". Add tests in test/slugify.test.mjs using node:test, runnable with `node --test`.',
    seed: {},
  },
  rounding: {
    description: [
      'Add `invoiceTotal(lines)` in src/invoice.mjs (ES module, named export). Each line is `{ qty, unitPrice }` in dollars. The total is the sum of qty * unitPrice over all lines, rounded to whole cents.',
      'Rounding rule (finance sign-off): half away from zero, for charges AND refunds. Refund lines have a negative unitPrice. Examples: [{qty:3,unitPrice:0.1}] -> 0.3; [{qty:1,unitPrice:19.99},{qty:2,unitPrice:5}] -> 29.99; [{qty:1,unitPrice:0.005}] -> 0.01; [{qty:1,unitPrice:-0.005}] -> -0.01; [] -> 0.',
      'Use the shared `roundCents` helper from src/money.mjs for rounding; do not duplicate rounding logic in invoice code.',
      'Add tests in test/invoice.test.mjs using node:test, runnable with `node --test`.',
    ].join('\n\n'),
    seed: {
      'src/money.mjs': '// Shared money helpers used across the codebase.\n// Round a dollar amount to whole cents.\nexport function roundCents(amount) {\n  return Math.round(amount * 100) / 100;\n}\n',
      'test/money.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { roundCents } from '../src/money.mjs';\ntest('rounds charges to cents', () => { assert.equal(roundCents(1.234), 1.23); assert.equal(roundCents(1.236), 1.24); assert.equal(roundCents(0.1 + 0.2), 0.3); });\n",
    },
  },
};
// Integer-cents variant: the defect is objectively fixable (no floating-point rabbit hole). The shared helper's DOC claims ties-away-from-zero
// but its code rounds negative ties toward +infinity; the ticket does not spell out the refund case, so whether it is noticed is up to the agents.
FIXTURES.cents = {
  description: [
    'Add `invoiceTotalCents(lines, taxBps)` in src/invoice.mjs (ES module, named export). Money is in integer cents. Each line is `{ qty, unitPriceCents }` (integers). Refunds and credits are represented by negative `qty`.',
    'subtotal = sum of qty * unitPriceCents. tax = subtotal * taxBps / 10000 rounded to a whole cent. The result is subtotal + tax (an integer number of cents).',
    'Examples: invoiceTotalCents([{qty:2,unitPriceCents:1000}], 1000) -> 2200; invoiceTotalCents([{qty:1,unitPriceCents:5}], 1000) -> 6; invoiceTotalCents([], 825) -> 0.',
    'Compute the tax with the shared `mulDivRound` helper from src/money.mjs; do not duplicate rounding logic in invoice code.',
    'Add tests in test/invoice.test.mjs using node:test, runnable with `node --test`.',
  ].join('\n\n'),
  seed: {
    'src/money.mjs': '// Shared money helpers used across the codebase.\n\n/**\n * Returns value * numerator / denominator rounded to the nearest integer.\n * Ties round AWAY FROM ZERO (2.5 -> 3, -2.5 -> -3), the same for charges and refunds.\n */\nexport function mulDivRound(value, numerator, denominator) {\n  return Math.round((value * numerator) / denominator);\n}\n',
    'test/money.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { mulDivRound } from '../src/money.mjs';\ntest('mulDivRound rounds to nearest, ties away from zero', () => { assert.equal(mulDivRound(10, 1, 4), 3); assert.equal(mulDivRound(10, 1, 3), 3); assert.equal(mulDivRound(9, 1, 3), 3); assert.equal(mulDivRound(7, 1, 4), 2); });\n",
  },
};
// Several independent subtle rules plus the same doc/code mismatch in the shared helper. Which of them the implementer misses, if any, is up to it.
FIXTURES.invoice2 = {
  description: [
    'Add `invoiceTotalCents(lines, taxBps)` in src/invoice.mjs (ES module, named export). Money is in integer cents. Each line is `{ sku, qty, unitPriceCents }`. Refunds and credits are represented by negative `qty`.',
    '1. Lines with the same `sku` are merged first: quantities are summed, and the unit price of the first line with that sku is used. Merged lines whose qty is 0 are dropped. Output order never matters.',
    '2. Tax is computed PER MERGED LINE, not on the subtotal: lineTax = lineAmount * taxBps / 10000 rounded to a whole cent, where lineAmount = qty * unitPriceCents.',
    '3. The result is the sum over merged lines of (lineAmount + lineTax), an integer number of cents.',
    '4. Throw a RangeError whose message starts with "invoice:" if taxBps is not an integer in 0..10000, or if any qty or unitPriceCents is not an integer.',
    '5. The input array and its line objects must not be mutated.',
    'Examples: invoiceTotalCents([{sku:"a",qty:2,unitPriceCents:1000}], 1000) -> 2200; invoiceTotalCents([], 825) -> 0; invoiceTotalCents([{sku:"a",qty:1,unitPriceCents:100}], 10001) throws.',
    'Use the shared `mulDivRound` helper from src/money.mjs for the tax rounding; do not duplicate rounding logic in invoice code.',
    'Add tests in test/invoice.test.mjs using node:test, runnable with `node --test`.',
  ].join('\n\n'),
  seed: FIXTURES.cents!.seed,
};
// Bounded inputs make exactness achievable (integer thousandths), so a float-based first attempt is objectively wrong yet fixable.
FIXTURES.rounding2 = {
  description: [
    'Add `invoiceTotal(lines)` in src/invoice.mjs (ES module, named export). Each line is `{ qty, unitPrice }` in dollars. `qty` is an integer; `unitPrice` is a decimal with AT MOST 3 fractional digits (e.g. 1.005); there are at most 100 lines. The total is the sum of qty * unitPrice, rounded to whole cents.',
    'Rounding rule (finance sign-off): half away from zero, for charges AND refunds (a refund line has a negative qty or unitPrice). The result must be EXACT for every input in the ranges above: for example [{qty:1,unitPrice:1.005}] -> 1.01 and [{qty:1,unitPrice:-1.005}] -> -1.01, and [{qty:3,unitPrice:0.1}] -> 0.3, [] -> 0.',
    'Use the shared `roundCents` helper from src/money.mjs for the final rounding if it is suitable; do not duplicate rounding logic in invoice code. If it is not suitable, fix it for everyone.',
    'Add tests in test/invoice.test.mjs using node:test, runnable with `node --test`.',
  ].join('\n\n'),
  seed: FIXTURES.rounding!.seed,
};
const fixtureName = process.env.DEVFLOW_LIVE_FIXTURE ?? 'rounding2';
const fx = FIXTURES[fixtureName];
if (!fx) { console.error(`unknown fixture ${fixtureName}`); process.exit(2); }

const w = makeWorld({ live: { claudeBin, codexBin, description: fx.description }, seed: fx.seed });
const t0 = Date.now();
const out: string[] = [];
const say = (s = '') => { console.log(s); out.push(s); };
try {
  say(`fixture: ${fixtureName} (synthetic ATL-22 in a temp repo; nothing real is touched)\nclaude:  ${claudeBin}\ncodex:   ${codexBin}\n`);
  const m = await w.orch.run('ATL-22').then((x) => x, (e) => { console.error(`RUN REFUSED/FAILED: ${e instanceof Error ? e.message : e}`); return undefined; });
  if (!m) process.exitCode = 1;
  else {
    const dir = join(w.runsDir, `ATL-22-${m.runId}`);
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { at: string; what: string });
    const sec = (a: string, b: string) => { const x = events.find((e) => e.what === a), y = events.filter((e) => e.what === b).pop(); return x && y ? Math.round((Date.parse(y.at) - Date.parse(x.at)) / 100) / 10 : undefined; };
    say(`state=${m.state} outcome=${m.outcome} class=${m.reasonClass ?? '-'} attempts=${m.attempts.length} (repairs used: ${m.attempts.filter((a) => a.n > 0).length}) infra-events=${m.infra.length} review-retries=${m.attempts.reduce((s, a) => s + (a.reviewRetries ?? 0), 0)}`);
    say(`ticket: ${w.issue().state}; comments on the ticket: ${w.comments().length}; draft PR: ${m.pr ? `#${m.pr.number}` : 'none'}; approvedSha: ${m.approvedSha ?? '-'}`);
    say('\n== per attempt ==');
    let claudeCost = 0, claudeTok = 0, claudeMs = 0, codexTok = 0;
    for (const a of m.attempts) {
      const cj = (() => { try { return JSON.parse(readFileSync(join(dir, `attempt-${a.n}`, 'claude-output.txt'), 'utf8').split('--- stdout ---\n')[1]!.split('\n--- stderr ---')[0]!) as Record<string, any>; } catch { return {} as Record<string, any>; } })();
      const cx = (() => { try { return readFileSync(join(dir, `attempt-${a.n}`, 'codex-output.txt'), 'utf8'); } catch { return ''; } })();
      const ctok = Number(/tokens used\s*\n\s*([\d,]+)/.exec(cx)?.[1]?.replace(/,/g, '') ?? 0);
      claudeCost += cj.total_cost_usd ?? 0; claudeMs += cj.duration_ms ?? 0;
      claudeTok += (cj.usage?.input_tokens ?? 0) + (cj.usage?.output_tokens ?? 0) + (cj.usage?.cache_creation_input_tokens ?? 0) + (cj.usage?.cache_read_input_tokens ?? 0);
      codexTok += ctok;
      say(`  attempt ${a.n}: sha ${a.headSha?.slice(0, 12)}  files=${a.files}  CI=${a.ci?.state}  review=${a.review?.verdict ?? '-'} (${a.review?.findings ?? 0} findings)${a.failure ? `  [${a.failure.slice(0, 100)}]` : ''}`);
      say(`             claude: ${cj.num_turns ?? '?'} turns, ${Math.round((cj.duration_ms ?? 0) / 100) / 10}s, $${(cj.total_cost_usd ?? 0).toFixed(3)} · codex tokens: ${ctok || '?'}`);
    }
    const kb = execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split('\t')[0];
    say(`\n== resource usage ==\n  wall clock: ${Math.round((Date.now() - t0) / 100) / 10}s total; claude (API time) ${Math.round(claudeMs / 100) / 10}s, ~${claudeTok.toLocaleString()} tokens incl. cache, $${claudeCost.toFixed(3)}; codex ~${codexTok.toLocaleString()} tokens; CI runs: ${w.ci.calls.length}; Linear comments: ${w.comments().length}; run dir: ${kb} KB`);
    say(`  phases: first implement→ci ${sec('state:implementing', 'ci-result') ?? '?'}s, last review ${sec('state:reviewing', 'review-validated') ?? '?'}s`);
    say('\n== Linear audit trail (comments on the ticket, in order) ==');
    w.comments().forEach((c, i) => say(`\n--- comment ${i + 1} ---\n${c}`));
    const dest = join(process.env.DEVFLOW_EVIDENCE_DIR ?? join(homedir(), '.local', 'share', 'devflow', 'm1-evidence'), `ATL-22-${m.runId}`);
    mkdirSync(join(dest, '..'), { recursive: true, mode: 0o700 });
    cpSync(dir, dest, { recursive: true, dereference: false, filter: (s) => !s.includes('/clone') });
    writeFileSync(join(dest, 'audit-trail.md'), w.comments().map((c, i) => `<!-- comment ${i + 1} -->\n${c}`).join('\n\n---\n\n'));
    writeFileSync(join(dest, 'transcript.txt'), out.join('\n'));
    say(`\nevidence exported to ${dest} (${readdirSync(dest).length} entries; clone omitted)`);
    process.exitCode = m.outcome === 'PASS' ? 0 : 3;
  }
} finally { if (process.env.DEVFLOW_KEEP !== '1') w.dispose(); else console.log(`kept: ${w.root}`); }
