#!/usr/bin/env node
// Scripted stand-in for `claude`. Runs INSIDE the real sandbox (cwd /work). Behaviour is chosen by "SCENARIO: x" in the ticket text
// (it reaches us through the prompt), so there is no side channel between the test and the agent.
import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
if (argv[0] === '--help') { console.log('Usage: claude [options]\n  -p, --print\n  --output-format <f>\n  --permission-mode <m>\n  --no-session-persistence\n  --allowedTools <t>'); process.exit(0); }
if (argv[0] === '--version') { console.log('0.0.0-fake (Claude Code)'); process.exit(0); }
if (argv[0] === 'auth') { console.log(JSON.stringify({ loggedIn: existsSync(`${process.env.HOME}/.claude/.credentials.json`) })); process.exit(0); }

const prompt = readFileSync(0, 'utf8');
const scenario = /SCENARIO: ([\w-]+)/.exec(prompt)?.[1] ?? 'defect-then-fix';
const repair = /Repair attempt (\d)/.test(prompt);
writeFileSync('claude-env.json', JSON.stringify({ keys: Object.keys(process.env), argv, script: process.argv[1] })); // untracked: never committed
const git = (...a) => execFileSync('git', a, { stdio: 'pipe' });

if (scenario === 'infra-claude-always') { console.error('Error: ECONNRESET talking to the API'); process.exit(1); }
if (scenario === 'infra-claude-once' && !existsSync('.infra-marker')) { writeFileSync('.infra-marker', '1'); console.error('401 unauthorized: token expired'); process.exit(1); }

const FIXED = `export const slugify = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n`;
const BUGGY = `export const slugify = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '');\n`; // forgets the trailing dash
const test = (expect) => `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { slugify } from '../src/slugify.mjs';\ntest('basic', () => assert.equal(slugify('Hello World'), '${expect}'));\n`;

mkdirSync('src', { recursive: true }); mkdirSync('test', { recursive: true });
if (!repair) {
  writeFileSync('src/slugify.mjs', scenario === 'correct-first' || scenario === 'symlink-clone' || scenario === 'symlink-out' || scenario.startsWith('infra') || scenario.startsWith('invalid') || scenario.startsWith('pr-') ? FIXED : BUGGY);
  writeFileSync('test/slugify.test.mjs', test(scenario === 'red-ci' ? 'WRONG' : 'hello-world'));
  if (scenario === 'touch-ci' || scenario === 'touch-ci-always') { mkdirSync('.github/workflows', { recursive: true }); writeFileSync('.github/workflows/ci.yml', 'name: ci\non: push\njobs: {}\n'); }
} else if (scenario === 'never-fixes' || scenario === 'touch-ci-always') {
  writeFileSync('src/slugify.mjs', BUGGY + `// repair try ${Date.now()}\n`);
} else if (scenario === 'review-then-touch' && /Repair attempt 1 /.test(prompt)) {
  // attempt 1: a protected file lands on top of the already-pushed commit A
  writeFileSync('src/slugify.mjs', BUGGY + '// still wrong\n'); mkdirSync('.github/workflows', { recursive: true }); writeFileSync('.github/workflows/ci.yml', 'name: ci\n'); git('add', 'src', '.github');
} else if (scenario === 'review-then-touch') {
  // attempt 2: follow the controller's instruction literally: rebuild the unaccepted suffix on top of the LAST ACCEPTED commit it names
  const accepted = /git reset --soft ([0-9a-f]{40})/.exec(prompt)[1];
  git('reset', '-q', '--soft', accepted); git('rm', '-rq', '--cached', '--ignore-unmatch', '.github'); execFileSync('rm', ['-rf', '.github']);
  mkdirSync('src', { recursive: true }); writeFileSync('src/slugify.mjs', FIXED); writeFileSync('test/slugify.test.mjs', test('hello-world'));
} else {
  if (scenario === 'touch-ci') execFileSync('git', ['reset', '-q', '--hard', 'HEAD~1']); // rebuild the unpushed branch WITHOUT the forbidden file in any commit
  mkdirSync('src', { recursive: true }); mkdirSync('test', { recursive: true });
  writeFileSync('src/slugify.mjs', FIXED);
  writeFileSync('test/slugify.test.mjs', test('hello-world'));
}
if (scenario === 'symlink-clone') { symlinkSync('..', 'escape-link'); symlinkSync('/etc', 'abs-link'); } // untracked links out of the clone
if (scenario === 'no-commit') process.exit(0);
git('add', 'src', 'test', ...((scenario === 'touch-ci' || scenario === 'touch-ci-always') && !repair ? ['.github'] : []));
git('commit', '-q', '-m', repair ? 'ATL-22: repair slugify' : 'ATL-22: add slugify');
console.log(JSON.stringify({ result: 'done' }));
