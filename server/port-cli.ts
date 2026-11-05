// Prints the port the server will listen on, resolved exactly as the server does (see effectivePort in config.ts), so the
// launcher probes and opens the right address. It never fails: with no usable config it prints the environment/default
// port and lets the server report the configuration problem itself. It reads only DEVFLOW_PORT and the config `port`.
import './node-check.ts';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { effectivePort, loadConfig } from './config.ts';
import { demoConfig } from './demo.ts';

/** `cwd` is the project root (where `.env` and `devflow.config.json` live). */
export function portFor(cwd: string, env: NodeJS.ProcessEnv = process.env): number {
  // Startup decides demo mode BEFORE reading .env; demo reads neither .env nor the normal config.
  if (env.DEVFLOW_DEMO === '1') return effectivePort(env, demoConfig());
  let fromFile: NodeJS.ProcessEnv = {};
  try { if (existsSync(`${cwd}/.env`)) fromFile = parseEnv(readFileSync(`${cwd}/.env`, 'utf8')); } catch { /* the server reports an unusable .env */ }
  // The environment wins over .env, as with process.loadEnvFile in the server.
  const merged = { ...fromFile, ...env };
  try { return effectivePort(merged, loadConfig(merged, cwd).config); } catch { return effectivePort(merged, { port: 4317 }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = [resolve(here, '../..'), resolve(here, '..')].find((d) => existsSync(`${d}/package.json`)) ?? process.cwd();
  console.log(String(portFor(root)));
}
