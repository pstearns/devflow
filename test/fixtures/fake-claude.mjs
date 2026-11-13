#!/usr/bin/env node
// Scripted stand-in for `claude`. Runs INSIDE the real sandbox (cwd /work). Behaviour is chosen by "SCENARIO: x" in the ticket text
// (it reaches us through the prompt), so there is no side channel between the test and the agent.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('0.0.0-fake (Claude Code)'); process.exit(0); }
if (argv[0] === 'auth') { console.log(JSON.stringify({ loggedIn: existsSync(`${process.env.HOME}/.claude/.credentials.json`) })); process.exit(0); }

const prompt = readFileSync(0, 'utf8');
const scenario = /SCENARIO: ([\w-]+)/.exec(prompt)?.[1] ?? 'defect-then-fix';
const repair = /Repair attempt (\d)/.test(prompt);
writeFileSync('claude-env.json', JSON.stringify({ keys: Object.keys(process.env), argv })); // untracked: never committed
const git = (...a) => execFileSync('git', a, { stdio: 'pipe' });

if (scenario === 'infra-claude-always') { console.error('Error: ECONNRESET talking to the API'); process.exit(1); }
if (scenario === 'infra-claude-once' && !existsSync('.infra-marker')) { writeFileSync('.infra-marker', '1'); console.error('401 unauthorized: token expired'); process.exit(1); }

const FIXED = `export const slugify = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n`;
const BUGGY = `export const slugify = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '');\n`; // forgets the trailing dash
const test = (expect) => `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { slugify } from '../src/slugify.mjs';\ntest('basic', () => assert.equal(slugify('Hello World'), '${expect}'));\n`;

mkdirSync('src', { recursive: true }); mkdirSync('test', { recursive: true });
if (!repair) {
  writeFileSync('src/slugify.mjs', scenario === 'correct-first' || scenario.startsWith('infra') || scenario.startsWith('invalid') || scenario.startsWith('pr-') ? FIXED : BUGGY);
  writeFileSync('test/slugify.test.mjs', test(scenario === 'red-ci' ? 'WRONG' : 'hello-world'));
  if (scenario === 'touch-ci') { mkdirSync('.github/workflows', { recursive: true }); writeFileSync('.github/workflows/ci.yml', 'name: ci\non: push\njobs: {}\n'); }
} else if (scenario === 'never-fixes') {
  writeFileSync('src/slugify.mjs', BUGGY + `// repair try ${Date.now()}\n`);
} else {
  writeFileSync('src/slugify.mjs', FIXED);
  writeFileSync('test/slugify.test.mjs', test('hello-world'));
  if (scenario === 'touch-ci') { /* second attempt behaves: no CI edit */ }
}
if (scenario === 'no-commit') process.exit(0);
git('add', 'src', 'test', ...(scenario === 'touch-ci' && !repair ? ['.github'] : []));
git('commit', '-q', '-m', repair ? 'ATL-22: repair slugify' : 'ATL-22: add slugify');
console.log(JSON.stringify({ result: 'done' }));
