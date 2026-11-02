// Test-only helpers. Passwords are random per run: there is no fixed or default credential anywhere.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AuthService, SESSION_COOKIE } from '../server/auth.ts';

export const randomPassword = () => `${randomBytes(18).toString('base64url')}-Aa1!`; // always satisfies the 15+ char policy

export async function makeAuth(opts: { clock?: () => number; idleSeconds?: number; log?: (l: string) => void } = {}) {
  const auth = AuthService.open({ path: ':memory:', ...opts });
  const password = randomPassword();
  await auth.createAdmin(password);
  return { auth, password };
}

type Res = Awaited<ReturnType<FastifyInstance['inject']>>;
export interface Signed { cookie: string; csrf: string; token: string; headers: Record<string, string>; post: (url: string, body: unknown, extra?: Record<string, string>) => Promise<Res>; get: (url: string, extra?: Record<string, string>) => Promise<Res> }

const HOST = 'devflow.localhost:4317';
export const jsonHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({ host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...extra });

/** Signs in through the real HTTP login endpoint, like the browser does. */
export async function signIn(app: FastifyInstance, password: string): Promise<Signed> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: jsonHeaders(), payload: JSON.stringify({ password }) });
  if (r.statusCode !== 200) throw new Error(`login failed in test helper: ${r.statusCode} ${r.body}`);
  const setCookie = String(r.headers['set-cookie']);
  const token = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(setCookie)![1]!;
  const cookie = `${SESSION_COOKIE}=${token}`;
  const csrf = r.json().csrf as string;
  const headers = { cookie, host: HOST, 'x-devflow-interaction': 'user' };
  return {
    cookie, csrf, token, headers,
    get: (url, extra = {}) => app.inject({ method: 'GET', url, headers: { ...headers, ...extra } }),
    post: (url, body, extra = {}) => app.inject({ method: 'POST', url, headers: jsonHeaders({ cookie, 'x-devflow-csrf': csrf, 'x-devflow-interaction': 'user', ...extra }), payload: JSON.stringify(body) }),
  };
}
