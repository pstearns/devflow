// Interactive admin setup. This is the ONLY way an admin account is created or its password changed:
//   npm run auth:setup     create the single admin account
//   npm run auth:reset     change the password (invalidates every session)
//   npm run auth:unlock    clear a login lockout (password unchanged)
//   npm run auth:status    non-secret status
// The password is read from the terminal without echo, hashed with Argon2id and never stored, logged or passed on argv/env.
import './node-check.ts'; // must stay first: refuses unsupported Node versions before anything else loads
import { AuthService, MIN_PASSWORD, defaultAuthPath, passwordPolicyError, readAuthStatus } from './auth.ts';
import { fileURLToPath } from 'node:url';

/** Reads a line from a TTY with echo disabled. Refuses to run without an interactive terminal. */
export function promptHidden(question: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || !input.setRawMode) return reject(new Error('An interactive terminal is required (passwords are never read from pipes, arguments or the environment).'));
    output.write(question);
    let buf = '';
    input.setRawMode(true); input.resume(); input.setEncoding('utf8');
    const done = (fn: () => void) => { input.setRawMode!(false); input.pause(); input.removeListener('data', onData); output.write('\n'); fn(); };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(buf));
        if (ch === '\u0003') return done(() => reject(new Error('Cancelled')));
        if (ch === '\u0004') return done(() => (buf ? resolve(buf) : reject(new Error('Cancelled'))));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch === '\u001b') return; // ignore escape sequences (arrow keys); the rest of this chunk is part of the sequence
        else if (ch >= ' ') buf += ch;
      }
    };
    input.on('data', onData);
  });
}

async function newPassword(): Promise<string> {
  const a = await promptHidden(`New admin password (min ${MIN_PASSWORD} characters, input hidden): `);
  const bad = passwordPolicyError(a);
  if (bad) throw new Error(bad);
  const b = await promptHidden('Repeat password: ');
  if (a !== b) throw new Error('Passwords did not match.');
  return a;
}

export async function main(argv: string[], env = process.env): Promise<number> {
  const cmd = argv[0];
  const path = defaultAuthPath(env);
  if (cmd !== 'setup' && cmd !== 'reset' && cmd !== 'unlock' && cmd !== 'status') {
    console.error('Usage: auth-cli <setup|reset|unlock|status>\n  setup   create the single admin account (interactive)\n  reset   change the admin password and end all sessions (interactive)\n  unlock  clear the login lockout without changing the password\n  status  show non-secret status');
    return 2;
  }
  if (cmd === 'status') {
    try {
      const st = readAuthStatus(path); // read-only: creates no file or directory
      console.log(`Database:        ${path}${st.exists ? '' : ' (not created yet)'}\nAdmin set up:    ${st.hasAdmin ? 'yes' : 'no (run: npm run auth:setup)'}\nActive sessions: ${st.activeSessions}\nLogin lock:      ${st.locked ? `LOCKED, ${st.retryAfterSeconds}s remaining (run: npm run auth:unlock)` : 'not locked'} (${st.recentFailures} recent failed attempt(s))\nPermissions:     dir ${st.permissions?.dir ?? 'n/a'}, file ${st.permissions?.file ?? 'n/a'} (expected 700 / 600)`);
      return 0;
    } catch (e) { console.error(`Error: ${e instanceof Error ? e.message : 'failed'}`); return 1; }
  }
  const auth = AuthService.open({ path });
  try {
    if (cmd === 'unlock') {
      if (!auth.hasAdmin) { console.error('No admin account exists yet. Run: npm run auth:setup'); return 1; }
      auth.unlock();
      console.log('Login lockout cleared. The password and sessions were not changed.');
      return 0;
    }
    if (cmd === 'setup') {
      if (auth.hasAdmin) { console.error('An admin account already exists. To change the password run: npm run auth:reset'); return 1; }
      await auth.createAdmin(await newPassword());
      console.log(`Admin account created. Only an Argon2id hash was stored (${path}).\nStart DevFlow and sign in at http://devflow.localhost:4317/login`);
      return 0;
    }
    if (!auth.hasAdmin) { console.error('No admin account exists yet. Run: npm run auth:setup'); return 1; }
    const confirm = await promptHidden('This ends every session and replaces the password. Type RESET to continue: ');
    if (confirm.trim() !== 'RESET') { console.error('Not confirmed; nothing changed.'); return 1; }
    await auth.resetPassword(await newPassword());
    console.log('Password changed. All sessions were ended.');
    return 0;
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : 'failed'}`);
    return 1;
  } finally { auth.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
