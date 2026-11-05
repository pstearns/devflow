import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { effectivePort, parseConfig } from '../server/config.ts';
import { portFor } from '../server/port-cli.ts';

// The server and the launcher resolve the port through the same function. Precedence: DEVFLOW_PORT (environment, else .env),
// then config `port`, then 4317. Synthetic configuration only.
const dirs: string[] = [];
const project = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'devflow-port-')); dirs.push(d);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  return d;
};
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const cfg = (port?: number) => JSON.stringify({ projects: [], ...(port ? { port } : {}) });

describe('effectivePort (what the server listens on)', () => {
  it('DEVFLOW_PORT wins, then the config port, then 4317', () => {
    expect(effectivePort({ DEVFLOW_PORT: '5000' }, { port: 4400 })).toBe(5000);
    expect(effectivePort({}, { port: 4400 })).toBe(4400);
    expect(effectivePort({}, parseConfig({ projects: [] }))).toBe(4317);
  });
  it('a DEVFLOW_PORT that is empty, zero or not a number falls through to the config port', () => {
    for (const bad of ['', '0', 'abc']) expect(effectivePort({ DEVFLOW_PORT: bad }, { port: 4400 })).toBe(4400);
  });
});

describe('portFor (what the launcher probes) resolves exactly like the server', () => {
  it('config port only', () => { expect(portFor(project({ 'devflow.config.json': cfg(4399) }), {})).toBe(4399); });
  it('.env sets DEVFLOW_PORT and beats the config port', () => {
    expect(portFor(project({ 'devflow.config.json': cfg(4399), '.env': 'DEVFLOW_PORT=4500\n' }), {})).toBe(4500);
  });
  it('the environment beats .env, as with process.loadEnvFile in the server', () => {
    expect(portFor(project({ 'devflow.config.json': cfg(4399), '.env': 'DEVFLOW_PORT=4500\n' }), { DEVFLOW_PORT: '4600' })).toBe(4600);
  });
  it('nothing set gives 4317; a missing or invalid config never makes it fail', () => {
    expect(portFor(project({}), {})).toBe(4317);
    expect(portFor(project({ 'devflow.config.json': '{ not json' }), {})).toBe(4317);
    expect(portFor(project({ 'devflow.config.json': '{ not json', '.env': 'DEVFLOW_PORT=4700' }), {})).toBe(4700);
  });
  it('an invalid DEVFLOW_PORT in .env falls through to the config port', () => {
    expect(portFor(project({ 'devflow.config.json': cfg(4399), '.env': 'DEVFLOW_PORT=nope' }), {})).toBe(4399);
  });
});


describe('startup mode selects configuration sources before reading .env', () => {
  it('demo ignores both .env and normal config, including DEVFLOW_CONFIG', () => {
    const d = project({ 'devflow.config.json': cfg(4399), '.env': 'DEVFLOW_PORT=4500\n', 'alternate.json': cfg(4700) });
    expect(portFor(d, { DEVFLOW_DEMO: '1', DEVFLOW_CONFIG: join(d, 'alternate.json') })).toBe(4317);
    expect(portFor(d, { DEVFLOW_DEMO: '1', DEVFLOW_PORT: '4600' })).toBe(4600);
    expect(portFor(d, { DEVFLOW_DEMO: '1', DEVFLOW_PORT: '0' })).toBe(4317);
  });
  it('a demo flag inside .env does not switch normal startup to demo', () => {
    const d = project({ 'devflow.config.json': cfg(4399), '.env': 'DEVFLOW_DEMO=1\nDEVFLOW_PORT=4500\n' });
    expect(portFor(d, {})).toBe(4500);
  });
  it('normal startup honors DEVFLOW_CONFIG supplied by .env or environment', () => {
    const d = project({ 'devflow.config.json': cfg(4399), 'alternate.json': cfg(4700) });
    writeFileSync(join(d, '.env'), `DEVFLOW_CONFIG=${join(d, 'alternate.json')}\n`);
    expect(portFor(d, {})).toBe(4700);
    expect(portFor(d, { DEVFLOW_CONFIG: join(d, 'devflow.config.json') })).toBe(4399);
  });
});

describe('Linux/WSL launcher wiring (isolated fixture; no sockets or existing instance)', () => {
  it.each([['normal', '0', 4500], ['demo', '1', 4317]] as const)('%s probes and opens the resolved address', (_name, mode, port) => {
    const d = project({ 'devflow.config.json': cfg(4399), '.env': 'DEVFLOW_PORT=4500\n' });
    for (const dir of ['scripts', 'bin', 'dist-server/server']) mkdirSync(join(d, dir), { recursive: true });
    copyFileSync(resolve('scripts/devflow-start.sh'), join(d, 'scripts/devflow-start.sh'));
    // Run the real resolver through the launcher's compiled-helper contract. The curl stub never opens a socket.
    writeFileSync(join(d, 'dist-server/server/port-cli.js'), `import { portFor } from ${JSON.stringify(pathToFileURL(resolve('server/port-cli.ts')).href)}; console.log(portFor(process.cwd()));`);
    writeFileSync(join(d, 'bin/curl'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$PROBE_LOG"\nprintf DevFlow\n');
    chmodSync(join(d, 'bin/curl'), 0o700);
    const output = execFileSync('bash', [join(d, 'scripts/devflow-start.sh')], {
      encoding: 'utf8', timeout: 10000,
      env: { PATH: `${join(d, 'bin')}:${process.env.PATH}`, HOME: d, NODE_BIN: process.execPath,
        NODE_OPTIONS: `--import=${pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href}`,
        DEVFLOW_DEMO: mode, DEVFLOW_NO_BROWSER: '1', PROBE_LOG: join(d, 'probe.txt') },
    });
    expect(output).toContain(`DevFlow is already running at http://devflow.localhost:${port}`);
    expect(readFileSync(join(d, 'probe.txt'), 'utf8')).toContain(`Host: devflow.localhost:${port}`);
    expect(readFileSync(join(d, 'probe.txt'), 'utf8')).toContain(`http://127.0.0.1:${port}/login`);
    // No server build exists in the fixture: reaching the ready branch is required for success.
  });
});
