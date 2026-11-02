import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { start, post, login, ADMIN, ENGINEER, cookieOf } from './helpers.js';

let srv, base;
before(async () => { srv = await start(); base = srv.base; });
after(() => srv.stop());

const get = (path, cookie) => fetch(base + path, cookie ? { headers: { Cookie: cookie } } : {});
const json = r => r.json();
const as = cookie => ({ Cookie: cookie });
const CLIENT = { clientName: 'Ann', clientEmail: 'Ann@Example.com', password: 'ann password 1' };
// Hire as a new client (account fields) or, with a cookie, as a signed-in client.
const hire = (engineerId, extra = {}, cookie) => post(base, '/api/jobs', { engineerId, choice: 'p0', details: 'Login breaks after deploy.', link: '', ...(cookie ? {} : CLIENT), ...extra }, cookie ? as(cookie) : {});
const set = (body, c) => post(base, '/api/me/jobs', body, as(c));

// The exact public surface. Any new route that answers without signing in must be added here on purpose.
const PUBLIC = ['GET /', 'GET /admin', 'GET /app.js', 'GET /admin.js', 'GET /ui.js', 'GET /fees.js', 'GET /styles.css', 'GET /favicon.svg', 'GET /api/engineers', 'GET /api/pricing', 'POST /api/engineers', 'POST /api/login', 'POST /api/logout', 'POST /api/jobs', 'POST /api/admin/login', 'POST /api/admin/logout'];

test('public surface: every route is either in the public list or answers 401 without a session', async () => {
  const [server, api] = await Promise.all(['../server.js', '../lib/api.js'].map(f => readFile(new URL(f, import.meta.url), 'utf8')));
  const files = Object.keys(JSON.parse('{' + /const FILES = \{([^}]+)\}/.exec(server)[1].replaceAll("'", '"') + '}')).map(p => 'GET ' + p);
  const all = [...files, ...[...api.matchAll(/^\s+'((?:GET|POST) \/api\/[^']+)':/gm)].map(m => m[1])];
  assert.deepEqual(all.filter(r => PUBLIC.includes(r)).sort(), [...PUBLIC].sort());
  for (const r of all.filter(r => !PUBLIC.includes(r))) {
    const [method, path] = r.split(' ');
    assert.equal((method === 'GET' ? await get(path) : await post(base, path, {})).status, 401, r);
  }
  assert.equal((await get('/server.js')).status, 404);
  assert.equal((await get('/lib/api.js')).status, 404);
  assert.equal((await get('/api/me', 'sid=' + 'a'.repeat(43))).status, 401);
});

test('security headers on pages and API', async () => {
  for (const p of ['/', '/api/engineers']) {
    const h = (await get(p)).headers;
    assert.match(h.get('content-security-policy'), /default-src 'none'; script-src 'self'/);
    assert.equal(h.get('x-content-type-options'), 'nosniff');
    assert.equal(h.get('x-frame-options'), 'DENY');
    assert.match(h.get('strict-transport-security'), /max-age=31536000/);
  }
});

test('behind the host proxy, plain http redirects to https', async () => {
  const s = await start({ TRUST_PROXY: '1' });
  try {
    const r = await fetch(s.base + '/admin?x=1', { redirect: 'manual', headers: { 'X-Forwarded-Proto': 'http' } });
    assert.equal(r.status, 301); assert.equal(r.headers.get('location'), `https://${new URL(s.base).host}/admin?x=1`);
  } finally { await s.stop(); }
});

test('pricing reports free now and the later rate', async () => {
  assert.deepEqual(await json(await get('/api/pricing')), { pct: 0, feePct: 10, promoEnd: Date.parse('2027-02-01T08:00:00Z') });
});

test('requests: JSON only, size cap, bad JSON', async () => {
  assert.equal((await post(base, '/api/engineers', 'x=1', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await post(base, '/api/engineers', '{bad')).status, 400);
  assert.equal((await post(base, '/api/engineers', '[]')).status, 400);
  assert.equal((await post(base, '/api/engineers', { ...ENGINEER, about: 'x'.repeat(40000) })).status, 413);
});

let maya, mayaC, annC;
test('engineer lists themselves and is live at once; public profile hides private fields', async () => {
  const r = await post(base, '/api/engineers', ENGINEER);
  assert.equal(r.status, 201);
  assert.match(r.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
  mayaC = cookieOf(r);
  assert.equal((await post(base, '/api/engineers', { ...ENGINEER, email: 'MAYA@example.com' })).status, 409, 'email taken, case-insensitive');
  maya = (await json(await get('/api/engineers'))).find(e => e.name === 'Maya R.');
  // Two sign-ups with the same new email at the same moment: exactly one wins.
  const race = await Promise.all([1, 2].map(() => post(base, '/api/engineers', { ...ENGINEER, name: 'Quokka Twin', email: 'twin@example.com' })));
  assert.deepEqual(race.map(r => r.status).sort(), [201, 409], 'concurrent sign-ups with one email');
  assert.deepEqual(Object.keys(maya).sort(), ['about', 'available', 'created', 'headline', 'id', 'name', 'packages', 'portfolio', 'rate', 'skills', 'terms']);
});

test('hiring: validation, account created on the way, contact and payment shown, signed-in client hires without account fields', async () => {
  assert.equal((await hire(maya.id, { choice: 'p3' })).status, 400);
  assert.deepEqual(await json(await hire(maya.id, { choice: 'hourly', hours: '0' })), { error: 'hours' });
  assert.deepEqual(await json(await hire(maya.id, { clientEmail: 'nope' })), { error: 'clientEmail' });
  assert.deepEqual(await json(await hire(maya.id, { password: 'short' })), { error: 'password' });
  assert.deepEqual(await json(await hire(maya.id, { clientEmail: 'maya@example.com' })), { error: 'email-taken' }, 'site emails are unique across engineers and clients');
  assert.equal((await hire('missing')).status, 404);
  assert.equal((await hire(maya.id, { website: 'http://spam' })).status, 201, 'honeypot answers OK');
  assert.equal((await hire(maya.id, {}, mayaC)).status, 403, 'engineers can not hire');
  const r = await hire(maya.id);
  assert.equal(r.status, 201);
  annC = cookieOf(r);
  assert.deepEqual(await json(r), { engineer: { name: 'Maya R.', email: 'maya@example.com', payWith: 'Venmo @maya-r', terms: 'Half upfront, half on completion' }, quote: 400 });
  assert.equal((await hire(maya.id)).status, 409, 'same email again needs sign-in');
  assert.equal((await hire(maya.id, { choice: 'hourly', hours: '3', clientName: 'ignored', password: '' }, annC)).status, 201);
  const me = await json(await get('/api/me', annC));
  assert.equal(me.role, 'client');
  assert.deepEqual([me.profile.name, me.profile.email, 'auth' in me.profile], ['Ann', 'ann@example.com', false]);
  assert.deepEqual(me.jobs.map(j => [j.quote, j.engineer.payWith]), [[360, 'Venmo @maya-r'], [400, 'Venmo @maya-r']]);
});

test('job flow: engineer accepts → paid → complete (free); client confirms; client cancels another; nobody touches others\' jobs', async () => {
  let d = await json(await get('/api/me', mayaC));
  assert.equal(d.role, 'engineer');
  assert.equal(d.jobs.length, 2, 'honeypot request not stored');
  const [hourly, pkg] = d.jobs;
  assert.deepEqual([pkg.client, pkg.status, pkg.pct], [{ name: 'Ann', email: 'ann@example.com' }, 'requested', 0]);

  assert.equal((await set({ id: pkg.id, status: 'complete' }, mayaC)).status, 409, 'must accept first');
  assert.equal((await set({ id: pkg.id, status: 'accepted' }, annC)).status, 409, 'clients can not accept');
  assert.equal((await set({ id: pkg.id, status: 'accepted' }, mayaC)).status, 200);
  assert.equal((await set({ id: pkg.id, status: 'cancelled' }, annC)).status, 409, 'too late to cancel once accepted');
  assert.equal((await set({ id: pkg.id, check: 'confirmed' }, annC)).status, 409, 'nothing to confirm yet');
  assert.equal((await set({ id: pkg.id, status: 'paid' }, mayaC)).status, 200);
  assert.equal((await set({ id: pkg.id, status: 'complete', amount: 'lots' }, mayaC)).status, 400);
  const done = await json(await set({ id: pkg.id, status: 'complete', amount: '450' }, mayaC));
  assert.deepEqual([done.status, done.amount, done.fee, done.payout], ['complete', 450, 0, 450]);
  assert.equal((await set({ id: pkg.id, status: 'accepted' }, mayaC)).status, 409, 'no going back');
  assert.equal((await set({ id: pkg.id, check: 'maybe' }, annC)).status, 409);
  assert.equal((await set({ id: pkg.id, check: 'confirmed' }, annC)).status, 200);
  assert.equal((await set({ id: pkg.id, check: 'disputed' }, annC)).status, 409, 'answer once');
  assert.equal((await set({ id: hourly.id, status: 'cancelled' }, annC)).status, 200);
  assert.equal((await set({ id: hourly.id, status: 'accepted' }, mayaC)).status, 409, 'cancelled is final');

  const dev = cookieOf(await post(base, '/api/engineers', { ...ENGINEER, name: 'Dev', email: 'dev@example.com' }));
  const bob = cookieOf(await hire(maya.id, { clientName: 'Bob', clientEmail: 'bob@example.com' }));
  assert.equal((await set({ id: pkg.id, check: 'disputed' }, bob)).status, 404, "another client can't touch Ann's job");
  assert.equal((await set({ id: pkg.id, status: 'declined' }, dev)).status, 404, "another engineer can't touch Maya's job");
  d = await json(await get('/api/me', mayaC));
  assert.equal(d.jobs.find(j => j.id === pkg.id).clientCheck, 'confirmed');
});

test('profile edits: engineer password optional and email fixed; client can rename; sign out ends the session', async () => {
  assert.equal((await post(base, '/api/me', { ...ENGINEER, password: 'short' }, as(mayaC))).status, 400);
  assert.equal((await post(base, '/api/me', { ...ENGINEER, headline: 'New headline here', password: '', email: 'hijack@example.com', hidden: true }, as(mayaC))).status, 200);
  const d = await json(await get('/api/me', mayaC));
  assert.deepEqual([d.profile.headline, d.profile.email, d.profile.hidden], ['New headline here', 'maya@example.com', false]);
  assert.equal((await post(base, '/api/me', { ...ENGINEER, password: 'brand new password' }, as(mayaC))).status, 200);
  assert.equal((await post(base, '/api/login', { email: 'maya@example.com', password: ENGINEER.password })).status, 401, 'old password stops working');
  assert.deepEqual(await json(await post(base, '/api/login', { email: ' MAYA@example.com ', password: 'brand new password' })), { role: 'engineer' });
  assert.equal((await post(base, '/api/me', { name: 'Ann B.', email: 'x@y.z' }, as(annC))).status, 200);
  assert.equal((await json(await get('/api/me', annC))).profile.name, 'Ann B.');
  assert.deepEqual(await json(await post(base, '/api/login', { email: 'ann@example.com', password: CLIENT.password })), { role: 'client' });
  await post(base, '/api/logout', {}, as(mayaC));
  assert.equal((await get('/api/me', mayaC)).status, 401);
  assert.equal((await post(base, '/api/login', { email: 'nobody@example.com', password: 'whatever password' })).status, 401);
});

test('staff roles: owner manages the team; admin sees money but not the team; moderator only hides; changes apply at once', async () => {
  assert.equal((await post(base, '/api/admin/login', { ...ADMIN, password: 'wrong password here' })).status, 401);
  const owner = await login(base);
  let d = await json(await get('/api/admin/data', owner));
  assert.deepEqual(d.me, { role: 'owner', perms: ['moderate', 'accounts', 'money', 'staff'] });
  assert.deepEqual(d.totals, { requested: 3, completed: 1, billed: 450, fees: 0, disputed: 0 });
  assert.deepEqual([d.clients.length, d.staff.length, d.engineers.find(e => e.name === 'Maya R.').jobs], [2, 0, 3]);
  assert.ok(!d.engineers.some(e => 'auth' in e) && !d.clients.some(c => 'auth' in c));

  const add = (b, c = owner) => post(base, '/api/admin/staff', { name: 'Mo', email: 'mo@example.com', password: 'mo password 12', role: 'moderator', ...b }, as(c));
  assert.equal((await add({ role: 'owner' })).status, 400);
  const mo = await json(await add());
  const ad = await json(await add({ name: 'Al', email: 'al@example.com', role: 'admin' }));
  assert.equal((await add()).status, 409);
  const staffLogin = async (email, pw) => cookieOf(await post(base, '/api/admin/login', { email, password: pw }));
  const moC = await staffLogin('mo@example.com', 'mo password 12'), alC = await staffLogin('al@example.com', 'mo password 12');

  d = await json(await get('/api/admin/data', moC));
  assert.deepEqual([d.me.role, 'clients' in d, 'jobs' in d, 'totals' in d, 'staff' in d], ['moderator', false, false, false, false]);
  assert.equal((await post(base, '/api/admin/hide', { id: maya.id, hidden: true }, as(moC))).status, 200);
  assert.ok(!(await json(await get('/api/engineers'))).some(e => e.id === maya.id));
  assert.equal((await hire(maya.id, { clientEmail: 'new@example.com' })).status, 404, 'hidden engineers can not be hired');
  assert.equal((await post(base, '/api/admin/hide', { id: maya.id, hidden: false }, as(moC))).status, 200);
  assert.equal((await post(base, '/api/admin/password', { id: maya.id, password: 'whatever pass' }, as(moC))).status, 403);
  assert.equal((await add({ email: 'x@example.com' }, moC)).status, 403);

  d = await json(await get('/api/admin/data', alC));
  assert.deepEqual([d.me.role, 'clients' in d, 'jobs' in d, 'staff' in d], ['admin', true, true, false]);
  assert.equal((await add({ email: 'y@example.com' }, alC)).status, 403, 'admins can not manage the team');
  assert.equal((await post(base, '/api/admin/password', { id: maya.id, password: 'short' }, as(alC))).status, 400);
  assert.equal((await post(base, '/api/admin/password', { id: maya.id, password: 'temporary pass 1' }, as(alC))).status, 200);
  const tempLogin = await post(base, '/api/login', { email: 'maya@example.com', password: 'temporary pass 1' }), engC = cookieOf(tempLogin);
  assert.equal(tempLogin.status, 200, 'temporary password works');

  assert.equal((await post(base, '/api/admin/staff/role', { id: mo.id, role: 'admin' }, as(owner))).status, 200);
  assert.ok('jobs' in await json(await get('/api/admin/data', moC)), 'promotion applies to the live session');
  assert.equal((await post(base, '/api/admin/staff/remove', { id: ad.id }, as(owner))).status, 200);
  assert.equal((await get('/api/admin/data', alC)).status, 401, 'removed member is signed out at once');
  assert.equal((await post(base, '/api/admin/login', { email: 'al@example.com', password: 'mo password 12' })).status, 401);
  assert.equal((await get('/api/admin/data', annC)).status, 403, 'a client session is not staff');
  assert.equal((await post(base, '/api/admin/hide', { id: maya.id, hidden: true }, as(engC))).status, 403, 'an engineer session is not staff');
  await post(base, '/api/admin/logout', {}, as(owner));
  assert.equal((await get('/api/admin/data', owner)).status, 401);
});

test('data survives a restart', async () => {
  await srv.stop(true);
  srv = await start({}, srv.dir); base = srv.base;
  assert.ok((await json(await get('/api/engineers'))).some(e => e.name === 'Maya R.'));
  assert.equal((await post(base, '/api/login', { email: 'ann@example.com', password: CLIENT.password })).status, 200);
  assert.equal((await post(base, '/api/admin/login', { email: 'mo@example.com', password: 'mo password 12' })).status, 200);
});

test('no owner account yet: login says setup is needed', async () => {
  const s = await start({}, undefined, { noAdmin: true });
  try { const r = await post(s.base, '/api/admin/login', ADMIN); assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'setup' }); }
  finally { await s.stop(); }
});

test('rate limits: 10 accepted listings/requests per hour (rejected ones free), 10 sign-in attempts per 15 minutes', async () => {
  const s = await start();
  try {
    for (let i = 0; i < 15; i++) assert.equal((await post(s.base, '/api/engineers', { ...ENGINEER, email: 'bad' })).status, 400);
    for (let i = 0; i < 10; i++) assert.equal((await post(s.base, '/api/engineers', { ...ENGINEER, email: `e${i}@x.co` })).status, 201);
    assert.equal((await post(s.base, '/api/engineers', { ...ENGINEER, email: 'e11@x.co' })).status, 429);
    for (let i = 0; i < 10; i++) await post(s.base, '/api/login', { email: 'e1@x.co', password: 'wrong password!' });
    assert.equal((await post(s.base, '/api/login', { email: 'e1@x.co', password: ENGINEER.password })).status, 429);
    assert.equal((await post(s.base, '/api/admin/login', ADMIN)).status, 429, 'shared sign-in bucket');
  } finally { await s.stop(); }
});

test('after Feb 1 2027 the fee is locked at request time and charged on completion', async () => {
  const { makeApi } = await import('../lib/api.js');
  const recs = new Map(), store = { all: k => [...recs.values()].filter(r => r.kind === k), get: id => recs.get(id), add: async (kind, d) => { const r = { id: String(recs.size), kind, created: new Date().toISOString(), ...d }; recs.set(r.id, r); return r; }, update: async (id, p) => { recs.set(id, { ...recs.get(id), ...p }); return recs.get(id); } };
  const api = makeApi({ store, hash: async () => ({}), verify: async () => true, adminLogin: async () => false });
  const real = Date.now;
  try {
    const [, , s] = await api['POST /api/engineers'](ENGINEER), eng = { session: s.login };
    const [, , c] = await api['POST /api/jobs']({ engineerId: '0', choice: 'p0', ...CLIENT, details: 'requested in the free period' }, {});
    Date.now = () => Date.parse('2027-02-02T00:00:00Z');
    await api['POST /api/jobs']({ engineerId: '0', choice: 'p0', details: 'requested after the free period' }, { session: c.login });
    const jobs = store.all('job');
    for (const j of jobs) await api['POST /api/me/jobs']({ id: j.id, status: 'accepted' }, eng), await api['POST /api/me/jobs']({ id: j.id, status: 'complete', amount: '1000' }, eng);
    assert.deepEqual(store.all('job').map(j => [j.fee, j.payout]), [[0, 1000], [100, 900]]);
  } finally { Date.now = real; }
});
