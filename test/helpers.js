import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setAdmin } from '../lib/auth.js';

export const ADMIN = { email: 'admin@example.com', password: 'correct horse battery' };

// Starts the real server on a free port with a fresh data dir; returns { base, dir, stop }.
// Pass { noAdmin: true } to start without an admin account.
export async function start(env = {}, dir, { noAdmin } = {}) {
  if (!dir) { dir = await mkdtemp(join(tmpdir(), 'codemarcer-')); noAdmin || await setAdmin(dir, ADMIN.email, ADMIN.password); }
  const proc = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '0', DATA_DIR: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', d => (err += d));
  const base = await new Promise((ok, fail) => {
    proc.stdout.on('data', d => { const m = /listening (http:\/\/\S+)/.exec(d); m && ok(m[1]); });
    proc.on('exit', c => fail(new Error(`server exited ${c}: ${err}`)));
    setTimeout(() => fail(new Error('server did not start: ' + err)), 5000);
  });
  return { base, dir, proc, stderr: () => err, stop: async (keep) => { proc.kill(); await new Promise(r => proc.once('exit', r)); keep || await rm(dir, { recursive: true, force: true }); } };
}

export const post = (base, path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
export const login = async base => (await post(base, '/api/admin/login', ADMIN)).headers.get('set-cookie').split(';')[0];

export const ENGINEER = { name: 'Maya R.', email: 'maya@example.com', password: 'maya password 1', headline: 'I take AI-built web apps to production', skills: 'Next, Supabase, Stripe, React', rate: '120', packages: [{ title: 'Deploy your app with HTTPS', price: '400', days: '5', details: 'Hosting, domain and HTTPS' }], payWith: 'Venmo @maya-r', terms: 'Half upfront, half on completion', portfolio: 'https://github.com/maya', about: '', available: true };
export const cookieOf = r => r.headers.get('set-cookie').split(';')[0];
