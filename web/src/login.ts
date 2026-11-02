import './index.css';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('f'), pw = $<HTMLInputElement>('pw'), go = $<HTMLButtonElement>('go'), err = $('err'), banner = $('banner');
const params = new URLSearchParams(location.search);

// Only a same-app hash route may be restored after sign-in (never an arbitrary URL).
const next = /^#\/[\w\-./?=&,%:~]*$/.test(params.get('next') ?? '') ? params.get('next')! : '';
const done = () => location.replace(`/${next}`);

function show(el: HTMLElement, text: string) { el.textContent = text; el.classList.remove('hidden'); }

(async () => {
  if (params.get('expired') === '1') show(banner, 'Your session ended after 30 minutes of inactivity. Please sign in again.');
  try {
    const st = (await (await fetch('/api/auth/state', { cache: 'no-store', credentials: 'same-origin' })).json()) as { setup: boolean; authenticated: boolean };
    if (st.authenticated) return done();
    if (!st.setup) { show(banner, 'Authentication is not set up yet. In a terminal, run: npm run auth:setup'); go.disabled = true; pw.disabled = true; }
  } catch { show(banner, 'Cannot reach the DevFlow server.'); }
})();

let lockTimer: ReturnType<typeof setInterval> | undefined;
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.classList.add('hidden');
  go.disabled = true;
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw.value }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; code?: string; error?: string; retryAfterSeconds?: number };
    if (r.ok && j.ok) { pw.value = ''; return done(); }
    pw.value = ''; pw.focus();
    if (j.code === 'locked') {
      let left = j.retryAfterSeconds ?? 60;
      go.disabled = true;
      clearInterval(lockTimer);
      const tick = () => { show(err, `Too many failed attempts. Try again in ${left}s.`); if (left-- <= 0) { clearInterval(lockTimer); err.classList.add('hidden'); go.disabled = false; } };
      tick(); lockTimer = setInterval(tick, 1000);
      return;
    }
    show(err, j.code === 'invalid' ? 'Incorrect password.' : j.error ?? `Sign-in failed (HTTP ${r.status}).`);
  } catch { show(err, 'Cannot reach the DevFlow server.'); }
  go.disabled = false; // (the locked path returns earlier and keeps the button disabled until the countdown ends)
});
