// `npm run orchestrate -- run ABC-12`  /  `npm run orchestrate -- release ABC-12`
// Runs one ticket to a terminal state (awaiting owner approval, or escalated) and prints the manifest summary. No daemon, no polling.
import '../node-check.ts';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadEnvFile, type Config, type OrchestrationCfg } from '../config.ts';
import { LinearClient } from '../linear.ts';
import { LinearWriteClient } from '../linear-write.ts';
import { GithubClient } from '../github.ts';
import { CliAgents } from './agents.ts';
import { GithubCi } from './ci.ts';
import { GithubPrs } from './pr.ts';
import { Orchestrator, Rejected } from './controller.ts';
import { PolicyGuard } from './policy.ts';
import { DuplicateRun, RunStore } from './manifest.ts';
import { TERMINAL } from './types.ts';

const die = (msg: string, code = 1): never => { console.error(`DevFlow orchestrate: ${msg}`); process.exit(code); };

const [cmd, ticketRaw] = process.argv.slice(2);
if ((cmd !== 'run' && cmd !== 'release') || !ticketRaw) die('usage: orchestrate run <ISSUE> | orchestrate release <ISSUE>', 2);
const ticket = ticketRaw!.toUpperCase();

// Trusted inputs (.env, devflow.config.json) come from DevFlow's OWN directory, never from the current directory: running this command from
// inside a target repository must not let that repository supply credentials or policy. Works from source (server/orchestrator/) and from dist-server.
const here = dirname(fileURLToPath(import.meta.url));
const root = [resolve(here, '../..'), resolve(here, '../../..')].find((d) => existsSync(resolve(d, 'package.json')) && existsSync(resolve(d, 'server'))) ?? die('cannot locate the DevFlow directory');
process.chdir(root);
const warn = loadEnvFile(resolve(root, '.env'));
if (warn) console.warn(`DevFlow warning: ${warn}`);
const loaded = loadConfig(process.env, root);
if (!loaded.found) die(`no configuration at ${loaded.path}`);
const cfg: Config = loaded.config;

if (cmd === 'release') {
  // Manual recovery for an interrupted run: marks it aborted and frees the ticket's lock. Never touches Linear.
  const team = ticket.split('-')[0]!;
  const oc = cfg.projects.find((p) => p.linear?.teamKey === team && p.orchestration)?.orchestration;
  if (!oc) die(`no orchestration configured for team ${team}`);
  const store = new RunStore(oc!.runsDir);
  const run = store.activeRun(ticket);
  if (run) { run.state = 'aborted'; run.outcome = 'ABORTED'; run.reason = 'released manually after interruption'; store.save(run, new Date().toISOString()); }
  store.release(ticket);
  console.log(run ? `Released ${ticket}; run ${run.runId} marked aborted. Check the ticket and branch in Linear/GitHub before re-approving.` : `Released the lock for ${ticket} (no active run was recorded).`);
  process.exit(0);
}

const readKey = process.env.LINEAR_API_KEY?.trim(), writeKey = process.env.LINEAR_WRITE_API_KEY?.trim(), ghToken = process.env.GITHUB_TOKEN?.trim(), ghWrite = process.env.GITHUB_WRITE_TOKEN?.trim();
if (!readKey || !writeKey || !ghToken || !ghWrite) die('LINEAR_API_KEY, LINEAR_WRITE_API_KEY, GITHUB_TOKEN and GITHUB_WRITE_TOKEN must all be set');
if (writeKey === readKey) die('LINEAR_WRITE_API_KEY must differ from LINEAR_API_KEY');
if (ghWrite === ghToken) die('GITHUB_WRITE_TOKEN must differ from GITHUB_TOKEN (the read token never creates pull requests)');

const gh = new GithubClient(ghToken!);
const policyFor = (): PolicyGuard => {
  const oc = firstOrchestration(cfg);
  if (!oc) return die(`no orchestration configured for ${ticket}'s team`);
  return new PolicyGuard(() => firstOrchestration(loadConfigFresh())!, loaded.path);
};
const orch = new Orchestrator({
  cfg,
  read: new LinearClient(readKey!),
  write: new LinearWriteClient(writeKey!),
  ci: new GithubCi(gh),
  prs: new GithubPrs(gh, ghWrite!),
  policy: policyFor(),
  agents: new CliAgents(firstOrchestration(cfg) ?? { claude: { bin: 'claude', allowedTools: [] }, codex: { bin: 'codex' } }), // credentials are staged per role by the sandbox, never inherited
  log: (l) => console.log(`DevFlow ${l}`),
});
try {
  const m = await orch.run(ticket);
  console.log(JSON.stringify({ ticket: m.ticket, run: m.runId, state: m.state, outcome: m.outcome, reason: m.reason, branch: m.branch, approvedSha: m.approvedSha, attempts: m.attempts.length }, null, 2));
  process.exit(TERMINAL.includes(m.state) && m.outcome === 'PASS' ? 0 : 3);
} catch (e) {
  if (e instanceof Rejected || e instanceof DuplicateRun) die(`refused: ${e.message}`, 4);
  die(`failed: ${e instanceof Error ? e.message : 'unknown error'}`);
}

/** Binary names/tools come from the ticket's project, resolved per run in the controller; the CLI only needs one set for the runner. */
/** Re-read from disk each time so a changed config changes the policy digest (and stops the run) instead of being silently ignored. */
function loadConfigFresh(): Config { return loadConfig(process.env, root).config; }
function firstOrchestration(c: Config): OrchestrationCfg | undefined {
  const team = ticket.split('-')[0]!;
  return c.projects.find((p) => p.linear?.teamKey === team && p.orchestration)?.orchestration;
}
