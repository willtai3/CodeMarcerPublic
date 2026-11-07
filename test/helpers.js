import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// These tests drive the real Go binary from the outside. `npm test` builds it first (bin/codemarcer).
const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BIN = join(ROOT, 'bin', 'codemarcer');
if (!existsSync(BIN)) throw new Error('bin/codemarcer is missing: run `go build -o bin/codemarcer .` (npm test does this).');

export const ADMIN = { email: 'admin@example.com', password: 'correct horse battery' };

// Creates the owner account with the real `codemarcer admin` command, answering its three prompts.
export const setupOwner = (dir, email = ADMIN.email, password = ADMIN.password, again = password) =>
  spawnSync(BIN, ['admin'], { env: { ...process.env, DATA_DIR: dir }, input: `${email}\n${password}\n${again}\n`, encoding: 'utf8' });

// Starts the real server on a free port with a fresh data dir; returns { base, dir, stop }.
// Pass { noAdmin: true } to start without an owner account.
export async function start(env = {}, dir, { noAdmin } = {}) {
  if (!dir) {
    dir = await mkdtemp(join(tmpdir(), 'codemarcer-'));
    if (!noAdmin) { const r = setupOwner(dir); if (r.status !== 0) throw new Error('owner setup failed: ' + r.stderr); }
  }
  const proc = spawn(BIN, [], { cwd: ROOT, env: { ...process.env, PORT: '0', DATA_DIR: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
export const cookieOf = r => r.headers.get('set-cookie').split(';')[0];
export const login = async base => cookieOf(await post(base, '/api/admin/login', ADMIN));

// Running locally, emails are written to the server log. keyFor returns the edit key from the latest one sent to email
// (the part after #edit= in the link), or null.
// Each email in the log, as [to, text] (the log splits them at "mail to <address>:").
const mails = srv => srv.stderr().split(/^\S+ \S+ mail to /m).slice(1).map(m => [m.slice(0, m.indexOf(':')), m]);
// Both wait until the log has stopped growing, since it reaches the test a moment after the reply.
const settled = async srv => { for (let n = -1; n !== srv.stderr().length;) { n = srv.stderr().length; await new Promise(r => setTimeout(r, 40)); } };
export const keyFor = async (srv, email) => (await settled(srv), mails(srv)).filter(([to, m]) => to === email && m.includes('#edit=')).map(([, m]) => /#edit=([0-9a-f-]+\.[A-Za-z0-9_-]{43})/.exec(m)[1]).at(-1) ?? null;
export const mailsTo = async (srv, email, kind = 'edit link') => (await settled(srv), mails(srv)).filter(([to, m]) => to === email && m.includes(kind === 'edit link' ? '#edit=' : 'sent you a request')).length;

export const ENGINEER = { name: 'Maya R.', email: 'maya@example.com', phone: '(555) 010-2030', headline: 'I take AI-built web apps to production', skills: 'Next, Supabase, Stripe, React', rate: '120', packages: [{ title: 'Deploy your app with HTTPS', price: '400', days: '5', details: 'Hosting, domain and HTTPS' }], payWith: 'Venmo @maya-r', terms: 'Half upfront, half on completion', portfolio: 'https://github.com/maya', about: '', available: true };
