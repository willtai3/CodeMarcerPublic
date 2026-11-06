// Black-box tests of the Go server's HTTP API (bin/codemarcer), run with node --test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { start, post, login, setupOwner, ADMIN, ENGINEER, cookieOf } from './helpers.js';

let srv, base;
before(async () => { srv = await start(); base = srv.base; });
after(() => srv.stop());

const get = (path, cookie) => fetch(base + path, cookie ? { headers: { Cookie: cookie } } : {});
const json = r => r.json();
const as = cookie => ({ Cookie: cookie });
const CLIENT = { clientName: 'Ann', clientEmail: 'Ann@Example.com', clientPhone: '(555) 123-4567' };
const hire = (engineerId, extra = {}) => post(base, '/api/jobs', { engineerId, choice: 'p0', details: 'Login breaks after deploy.', link: '', ...CLIENT, ...extra });
const set = (body, c) => post(base, '/api/me/jobs', body, as(c));

// The exact public surface. Any new route that answers without signing in must be added here on purpose.
const PUBLIC = ['GET /', 'GET /admin', 'GET /app.js', 'GET /admin.js', 'GET /ui.js', 'GET /fees.js', 'GET /styles.css', 'GET /favicon.svg', 'GET /api/engineers', 'GET /api/pricing', 'POST /api/engineers', 'POST /api/login', 'POST /api/logout', 'POST /api/jobs', 'POST /api/admin/login', 'POST /api/admin/logout'];

test('public surface: every route in the Go source is either in the public list or answers 401 without a session', async () => {
  const [main, api] = await Promise.all(['../main.go', '../api.go'].map(f => readFile(new URL(f, import.meta.url), 'utf8')));
  const files = Object.keys(JSON.parse('{' + /var files = map\[string\]string\{([^}]+)\}/.exec(main)[1] + '}')).map(p => 'GET ' + p);
  const routes = [...api.matchAll(/^\s+"((?:GET|POST) \/api\/[^"]+)":/gm)].map(m => m[1]);
  assert.ok(routes.length >= 15, `found ${routes.length} routes in api.go`);
  const all = [...files, ...routes];
  assert.deepEqual(all.filter(r => PUBLIC.includes(r)).sort(), [...PUBLIC].sort());
  for (const r of all.filter(r => !PUBLIC.includes(r))) {
    const [method, path] = r.split(' ');
    assert.equal((method === 'GET' ? await get(path) : await post(base, path, {})).status, 401, r);
  }
  for (const p of ['/main.go', '/api.go', '/public/app.js', '/../data/store.json', '/admin.json']) assert.equal((await get(p)).status, 404, p);
  assert.equal((await get('/api/me', '__Host-sid=' + 'a'.repeat(43))).status, 401);
});

test('security headers on pages and API', async () => {
  for (const p of ['/', '/api/engineers']) {
    const h = (await get(p)).headers;
    assert.match(h.get('content-security-policy'), /default-src 'none'; script-src 'self'/);
    assert.equal(h.get('x-content-type-options'), 'nosniff');
    assert.equal(h.get('x-frame-options'), 'DENY');
    assert.equal(h.get('cross-origin-opener-policy'), 'same-origin');
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

test('requests: JSON only, size cap, bad JSON, other sites refused', async () => {
  assert.equal((await post(base, '/api/engineers', 'x=1', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await post(base, '/api/engineers', '{bad')).status, 400);
  assert.equal((await post(base, '/api/engineers', '[]')).status, 400);
  assert.equal((await post(base, '/api/engineers', 'null')).status, 400);
  assert.equal((await post(base, '/api/engineers', { ...ENGINEER, about: 'x'.repeat(40000) })).status, 413);
  assert.equal((await post(base, '/api/engineers', ENGINEER, { Origin: 'https://evil.example' })).status, 403, 'cross-site POST refused');
});

let maya, mayaC;
test('engineer lists themselves and is live at once; public profile hides private fields', async () => {
  const r = await post(base, '/api/engineers', ENGINEER);
  assert.equal(r.status, 201);
  assert.match(r.headers.get('set-cookie'), /^__Host-sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict/);
  mayaC = cookieOf(r);
  assert.equal((await post(base, '/api/engineers', { ...ENGINEER, email: 'MAYA@example.com' })).status, 409, 'email taken, case-insensitive');
  maya = (await json(await get('/api/engineers'))).find(e => e.name === 'Maya R.');
  assert.deepEqual(Object.keys(maya).sort(), ['about', 'available', 'created', 'headline', 'id', 'name', 'packages', 'portfolio', 'rate', 'skills', 'terms']);
  // Two sign-ups with the same new email at the same moment: exactly one wins.
  const race = await Promise.all([1, 2].map(() => post(base, '/api/engineers', { ...ENGINEER, name: 'Quokka Twin', email: 'twin@example.com' })));
  assert.deepEqual(race.map(x => x.status).sort(), [201, 409], 'concurrent sign-ups with one email');
});

test('hiring needs no account: name, email, phone and a description; contact and payment shown back', async () => {
  for (const [patch, field] of [[{ choice: 'p3' }, 'choice'], [{ choice: 'hourly', hours: '0' }, 'hours'], [{ clientName: '' }, 'clientName'], [{ clientEmail: 'nope' }, 'clientEmail'], [{ clientPhone: '' }, 'clientPhone'], [{ clientPhone: '12345' }, 'clientPhone'], [{ clientPhone: 'call me maybe' }, 'clientPhone'], [{ details: 'short' }, 'details'], [{ link: 'http://insecure.example' }, 'link'], [{ clientName: 'Ann‮evil' }, 'clientName']])
    assert.deepEqual(await json(await hire(maya.id, patch)), { error: field }, JSON.stringify(patch));
  assert.equal((await hire('missing')).status, 404);
  assert.equal((await hire(maya.id, { website: 'http://spam' })).status, 201, 'honeypot answers OK');
  const r = await hire(maya.id);
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('set-cookie'), null, 'no account or session for clients');
  assert.deepEqual(await json(r), { engineer: { name: 'Maya R.', email: 'maya@example.com', payWith: 'Venmo @maya-r', terms: 'Half upfront, half on completion' }, quote: 400 });
  assert.equal((await hire(maya.id, { choice: 'hourly', hours: '3', clientPhone: '+1 555 987 6543' })).status, 201, 'same client again, no sign-in needed');
});

test('job flow: engineer sees the client contact, accepts → paid → complete (free); no going back; nobody touches others\' jobs', async () => {
  const d = await json(await get('/api/me', mayaC));
  assert.equal(d.role, 'engineer');
  assert.ok(!('auth' in d.profile));
  assert.equal(d.jobs.length, 2, 'honeypot request not stored');
  const [hourly, pkg] = d.jobs;
  assert.deepEqual([pkg.clientName, pkg.clientEmail, pkg.clientPhone, pkg.status, pkg.pct, hourly.quote], ['Ann', 'ann@example.com', '(555) 123-4567', 'requested', 0, 360]);

  assert.equal((await set({ id: pkg.id, status: 'complete' }, mayaC)).status, 409, 'must accept first');
  assert.equal((await set({ id: pkg.id, status: 'accepted' }, mayaC)).status, 200);
  assert.equal((await set({ id: pkg.id, status: 'paid' }, mayaC)).status, 200);
  assert.equal((await set({ id: pkg.id, status: 'complete', amount: 'lots' }, mayaC)).status, 400);
  const done = await json(await set({ id: pkg.id, status: 'complete', amount: '450' }, mayaC));
  assert.deepEqual([done.status, done.amount, done.fee, done.payout], ['complete', 450, 0, 450]);
  assert.equal((await set({ id: pkg.id, status: 'accepted' }, mayaC)).status, 409, 'no going back');
  assert.equal((await set({ id: hourly.id, status: 'declined' }, mayaC)).status, 200);
  assert.equal((await set({ id: hourly.id, status: 'accepted' }, mayaC)).status, 409, 'declined is final');

  const dev = cookieOf(await post(base, '/api/engineers', { ...ENGINEER, name: 'Dev', email: 'dev@example.com' }));
  assert.equal((await set({ id: pkg.id, status: 'declined' }, dev)).status, 404, "another engineer can't touch Maya's job");
});

test('profile edits: password optional, email and hidden fixed; sign out ends the session', async () => {
  assert.equal((await post(base, '/api/me', { ...ENGINEER, password: 'short' }, as(mayaC))).status, 400);
  assert.equal((await post(base, '/api/me', { ...ENGINEER, headline: 'New headline here', password: '', email: 'hijack@example.com', hidden: true, id: 'x' }, as(mayaC))).status, 200);
  const d = await json(await get('/api/me', mayaC));
  assert.deepEqual([d.profile.headline, d.profile.email, d.profile.hidden], ['New headline here', 'maya@example.com', false]);
  assert.equal((await post(base, '/api/me', { ...ENGINEER, password: 'brand new password' }, as(mayaC))).status, 200);
  assert.equal((await post(base, '/api/login', { email: 'maya@example.com', password: ENGINEER.password })).status, 401, 'old password stops working');
  assert.deepEqual(await json(await post(base, '/api/login', { email: ' MAYA@example.com ', password: 'brand new password' })), { role: 'engineer' });
  await post(base, '/api/logout', {}, as(mayaC));
  assert.equal((await get('/api/me', mayaC)).status, 401);
  assert.equal((await post(base, '/api/login', { email: 'nobody@example.com', password: 'whatever password' })).status, 401);
});

test('staff roles: owner manages the team; admin sees money but not the team; moderator only hides; changes apply at once', async () => {
  assert.equal((await post(base, '/api/admin/login', { ...ADMIN, password: 'wrong password here' })).status, 401);
  const owner = await login(base);
  let d = await json(await get('/api/admin/data', owner));
  assert.deepEqual(d.me, { role: 'owner', perms: ['moderate', 'accounts', 'money', 'staff'] });
  assert.deepEqual(d.totals, { requested: 2, completed: 1, billed: 450, fees: 0 });
  assert.deepEqual(d.clients.map(c => [c.email, c.name, c.phone, c.jobs]), [['ann@example.com', 'Ann', '+1 555 987 6543', 2]], 'clients grouped by email, latest phone');
  assert.deepEqual([d.staff.length, d.engineers.find(e => e.name === 'Maya R.').jobs], [0, 2]);
  assert.ok(!d.engineers.some(e => 'auth' in e));

  const add = (b, c = owner) => post(base, '/api/admin/staff', { name: 'Mo', email: 'mo@example.com', password: 'mo password 12', role: 'moderator', ...b }, as(c));
  assert.equal((await add({ role: 'owner' })).status, 400);
  const mo = await json(await add());
  assert.ok(!('auth' in mo));
  const ad = await json(await add({ name: 'Al', email: 'al@example.com', role: 'admin' }));
  assert.equal((await add()).status, 409);
  const staffLogin = async (email, pw) => cookieOf(await post(base, '/api/admin/login', { email, password: pw }));
  const moC = await staffLogin('mo@example.com', 'mo password 12'), alC = await staffLogin('al@example.com', 'mo password 12');

  d = await json(await get('/api/admin/data', moC));
  assert.deepEqual([d.me.role, 'clients' in d, 'jobs' in d, 'totals' in d, 'staff' in d], ['moderator', false, false, false, false]);
  assert.equal((await post(base, '/api/admin/hide', { id: maya.id, hidden: true }, as(moC))).status, 200);
  assert.ok(!(await json(await get('/api/engineers'))).some(e => e.id === maya.id));
  assert.equal((await hire(maya.id)).status, 404, 'hidden engineers can not be hired');
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
  assert.equal((await post(base, '/api/admin/hide', { id: maya.id, hidden: true }, as(engC))).status, 403, 'an engineer session is not staff');
  assert.equal((await get('/api/admin/data', engC)).status, 403);
  await post(base, '/api/admin/logout', {}, as(owner));
  assert.equal((await get('/api/admin/data', owner)).status, 401);
});

test('data survives a restart', async () => {
  await srv.stop(true);
  srv = await start({}, srv.dir); base = srv.base;
  assert.ok((await json(await get('/api/engineers'))).some(e => e.name === 'Maya R.'));
  assert.equal((await post(base, '/api/admin/login', { email: 'mo@example.com', password: 'mo password 12' })).status, 200);
  const raw = await readFile(srv.dir + '/store.json', 'utf8');
  assert.ok(!raw.includes('maya password 1') && !raw.includes('brand new password'), 'no plain passwords on disk');
});

test('owner setup command: mismatch and weak passwords refused, nothing saved; no owner yet means setup', async () => {
  const s = await start({}, undefined, { noAdmin: true });
  try {
    let r = setupOwner(s.dir, ADMIN.email, ADMIN.password, 'different password!');
    assert.equal(r.status, 1); assert.match(r.stderr, /don't match/);
    r = setupOwner(s.dir, ADMIN.email, 'short', 'short');
    assert.equal(r.status, 1); assert.match(r.stderr, /at least 12/);
    const res = await post(s.base, '/api/admin/login', ADMIN);
    assert.equal(res.status, 503); assert.deepEqual(await res.json(), { error: 'setup' });
    r = setupOwner(s.dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal((await post(s.base, '/api/admin/login', ADMIN)).status, 200, 'works without a restart');
  } finally { await s.stop(); }
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

test('behind the proxy, rate limits use the address the proxy added, not one the client sends', async () => {
  const s = await start({ TRUST_PROXY: '1' });
  try {
    // A client can't dodge the limit by sending its own X-Forwarded-For: the proxy appends the real address last.
    for (let i = 0; i < 10; i++) await post(s.base, '/api/login', { email: 'a@x.co', password: 'wrong password!' }, { 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.7` });
    assert.equal((await post(s.base, '/api/login', { email: 'a@x.co', password: 'wrong password!' }, { 'X-Forwarded-For': '10.9.9.9, 203.0.113.7' })).status, 429);
    assert.equal((await post(s.base, '/api/login', { email: 'a@x.co', password: 'wrong password!' }, { 'X-Forwarded-For': '203.0.113.8' })).status, 401, 'a different real address has its own limit');
  } finally { await s.stop(); }
});
