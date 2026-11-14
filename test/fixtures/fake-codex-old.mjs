#!/usr/bin/env node
// Scripted stand-in for `codex exec`. Runs INSIDE the real sandbox (cwd /review, read-only). It really inspects the snapshot: it imports
// the implementation and checks it against the ticket's examples, so "finding the defect" is a computed result, not a canned answer.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
if (argv[0] === 'exec' && argv[1] === '--help') { console.log('Usage: codex exec [--sandbox]'); process.exit(0); }
if (argv[0] === '--version') { console.log('codex-cli 0.0.0-fake'); process.exit(0); }
if (argv[0] === 'login') { console.log(existsSync(`${process.env.CODEX_HOME}/auth.json`) ? 'Logged in using ChatGPT' : 'Not logged in'); process.exit(0); }

const prompt = readFileSync(0, 'utf8');
const sha = /commit ([0-9a-f]{40})/.exec(prompt)[1];
const nonce = /"nonce":"([0-9a-f]+)"/.exec(prompt)[1];
const ticket = readFileSync('context/ticket.md', 'utf8');
const scenario = /SCENARIO: ([\w-]+)/.exec(ticket)?.[1] ?? 'defect-then-fix';
const files = readFileSync('context/files.txt', 'utf8').split('\n').filter(Boolean);
const o = argv.indexOf('-o');
const emit = (s) => (o >= 0 ? writeFileSync(argv[o + 1], s) : console.log(s));
const out = (obj) => emit(JSON.stringify(obj));

// what this process could see and do (reported through the summary so tests can assert on the boundary)
const probe = {};
for (const [k, f] of [['write_src', 'src/src/slugify.mjs'], ['write_root', 'x.txt'], ['write_etc', '/etc/x']]) { try { writeFileSync(f, 'x'); probe[k] = 'WROTE'; } catch (e) { probe[k] = e.code; } }
const envKeys = Object.keys(process.env).sort().join(',');

const { slugify } = await import(pathToFileURL(`${process.cwd()}/src/src/slugify.mjs`).href).catch(() => ({}));
const cases = [['Hello World', 'hello-world'], ['Hello, World!', 'hello-world'], ['  --A  b--', 'a-b']];
const bad = slugify ? cases.filter(([i, x]) => slugify(i) !== x).map(([i, x]) => ({ i, x, got: slugify(i) })) : [{ i: '-', x: '-', got: 'module missing' }];
const finding = bad.length ? [{ id: 'F1', severity: 'blocker', file: 'src/slugify.mjs', line: 1, title: 'slugify leaves a trailing dash', detail: `The ticket requires leading and trailing separators to be trimmed. ${bad.length} example(s) fail.`, evidence: bad.map((b) => `slugify(${JSON.stringify(b.i)}) returned ${JSON.stringify(b.got)}, expected ${JSON.stringify(b.x)}`).join('; ') }] : [];
const summary = (s) => `${s} [probe ${JSON.stringify(probe)}] [env ${envKeys}]`;
const honest = { verdict: finding.length ? 'FAIL' : 'PASS', commit: sha, nonce, summary: summary(finding.length ? 'Defect found by executing the examples from the ticket.' : 'All ticket examples hold.'), reviewed_files: files, findings: finding };

if (scenario === 'fabricated-pass-nonce') out({ verdict: 'PASS', commit: sha, nonce: '0'.repeat(32), summary: 'looks good', reviewed_files: files, findings: [] });
else if (scenario === 'fabricated-pass-partial') out({ verdict: 'PASS', commit: sha, nonce, summary: 'looks good', reviewed_files: [], findings: [] });
else if (scenario === 'fabricated-pass-bare') out({ verdict: 'PASS' });
else if (scenario === 'wrong-commit') out({ ...honest, commit: 'f'.repeat(40) });
else if (scenario === 'prose') emit('PASS - I reviewed it and it is fine.');
else if (scenario === 'tamper') { const { chmodSync } = await import('node:fs'); chmodSync('src', 0o755); chmodSync('src/src', 0o755); chmodSync('src/src/slugify.mjs', 0o644); writeFileSync('src/src/slugify.mjs', 'export const slugify = (t) => t;\n'); out({ ...honest, verdict: 'PASS', findings: [] }); }
else out(honest);
