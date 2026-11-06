// Black-box tests of the Go server's HTTP API (bin/codemarcer), run with node --test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { start, post, login, setupOwner, ADMIN, ENGINEER, cookieOf, keyFor, mailsTo } from './helpers.js';

let srv, base;
before(async () => { srv = await start(); base = srv.base; });
after(() => srv.stop());

const get = (path, cookie) => fetch(base + path, cookie ? { headers: { Cookie: cookie } } : {});
const json = r => r.json();
const as = cookie => ({ Cookie: cookie });
const CLIENT = { clientName: 'Ann', clientEmail: 'Ann@Example.com', clientPhone: '(555) 123-4567' };
const hire = (engineerId, extra = {}) => post(base, '/api/jobs', { engineerId, choice: 'p0', details: 'Login breaks after deploy.', link: '', ...CLIENT, ...extra });

// The exact public surface. Any new route that answers without signing in must be added here on purpose. The listing
// routes need the private edit link instead of a session.
const PUBLIC = ['GET /', 'GET /admin', 'GET /app.js', 'GET /admin.js', 'GET /ui.js', 'GET /styles.css', 'GET /favicon.svg', 'GET /api/engineers', 'POST /api/engineers', 'POST /api/edit-link', 'POST /api/listing', 'POST /api/listing/save', 'POST /api/listing/remove', 'POST /api/jobs', 'POST /api/admin/login', 'POST /api/admin/logout'];

test('public surface: every route in the Go source is either in the public list or answers 401 without a session', async () => {
  const [main, api] = await Promise.all(['../main.go', '../api.go'].map(f => readFile(new URL(f, import.meta.url), 'utf8')));
  const files = Object.keys(JSON.parse('{' + /var files = map\[string\]string\{([^}]+)\}/.exec(main)[1] + '}')).map(p => 'GET ' + p);
  const routes = [...api.matchAll(/^\s+"((?:GET|POST) \/api\/[^"]+)":/gm)].map(m => m[1]);
  assert.ok(routes.length >= 13, `found ${routes.length} routes in api.go`);
  const all = [...files, ...routes];
  assert.deepEqual(all.filter(r => PUBLIC.includes(r)).sort(), [...PUBLIC].sort());
  for (const r of all.filter(r => !PUBLIC.includes(r))) {
    const [method, path] = r.split(' ');
    assert.equal((method === 'GET' ? await get(path) : await post(base, path, {})).status, 401, r);
  }
  for (const r of ['POST /api/listing', 'POST /api/listing/save', 'POST /api/listing/remove']) assert.equal((await post(base, r.slice(5), {})).status, 401, r + ' without a link');
  for (const p of ['/main.go', '/api.go', '/public/app.js', '/../data/store.json', '/admin.json', '/api/me', '/api/login']) assert.equal((await get(p)).status, 404, p);
  assert.equal((await post(base, '/api/login', { email: 'a@b.co', password: 'x' })).status, 404, 'there is no engineer sign-in');
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

test('no fees: there is no pricing endpoint or fee script', async () => {
  for (const p of ['/api/pricing', '/fees.js']) assert.equal((await get(p)).status, 404, p);
});

test('requests: JSON only, size cap, bad JSON, other sites refused', async () => {
  assert.equal((await post(base, '/api/engineers', 'x=1', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await post(base, '/api/engineers', '{bad')).status, 400);
  assert.equal((await post(base, '/api/engineers', '[]')).status, 400);
  assert.equal((await post(base, '/api/engineers', 'null')).status, 400);
  assert.equal((await post(base, '/api/engineers', { ...ENGINEER, about: 'x'.repeat(40000) })).status, 413);
  assert.equal((await post(base, '/api/engineers', ENGINEER, { Origin: 'https://evil.example' })).status, 403, 'cross-site POST refused');
});

let maya, mayaKey;
test('engineer lists with email and phone, no password; live at once; edit link emailed; public profile hides private fields', async () => {
  const r = await post(base, '/api/engineers', ENGINEER);
  assert.deepEqual([r.status, await json(r), r.headers.get('set-cookie')], [201, { sent: true }, null], 'no account, no session');
  mayaKey = keyFor(srv, 'maya@example.com');
  assert.ok(mayaKey, 'edit link emailed');
  maya = (await json(await get('/api/engineers'))).find(e => e.name === 'Maya R.');
  assert.deepEqual(Object.keys(maya).sort(), ['about', 'available', 'created', 'headline', 'id', 'name', 'packages', 'portfolio', 'rate', 'skills', 'terms']);
  assert.ok(mayaKey.startsWith(maya.id + '.'));
  for (const [patch, field] of [[{ phone: '' }, 'phone'], [{ phone: '12345' }, 'phone'], [{ email: 'nope' }, 'email'], [{ rate: '', packages: [] }, 'pricing']])
    assert.deepEqual(await json(await post(base, '/api/engineers', { ...ENGINEER, email: 'x@example.com', ...patch })), { error: field }, JSON.stringify(patch));
  // The same email again (any case): same answer, no second listing, nothing changed; a new link goes to the owner.
  const again = await post(base, '/api/engineers', { ...ENGINEER, email: 'MAYA@example.com', name: 'Impostor' });
  assert.deepEqual([again.status, await json(again)], [201, { sent: true }]);
  assert.deepEqual((await json(await get('/api/engineers'))).map(e => e.name), ['Maya R.']);
  assert.equal(mailsTo(srv, 'maya@example.com'), 1, 'at most one link per 10 minutes');
  // Two listings with the same new email at the same moment: exactly one is made.
  await Promise.all([1, 2].map(() => post(base, '/api/engineers', { ...ENGINEER, name: 'Quokka Twin', email: 'twin@example.com' })));
  assert.equal((await json(await get('/api/engineers'))).filter(e => e.name === 'Quokka Twin').length, 1);
});

test('edit link: opens, saves and removes the listing; the email stays fixed; a new link replaces the old', async () => {
  for (const key of [undefined, '', maya.id, maya.id + '.' + 'A'.repeat(43), mayaKey.slice(0, -1) + (mayaKey.at(-1) === 'A' ? 'B' : 'A')])
    assert.equal((await post(base, '/api/listing', { key })).status, 401, String(key));
  const open = await json(await post(base, '/api/listing', { key: mayaKey }));
  assert.deepEqual([open.email, open.phone, open.payWith, 'editKey' in open, 'auth' in open], ['maya@example.com', '(555) 010-2030', 'Venmo @maya-r', false, false]);
  assert.equal((await post(base, '/api/listing/save', { key: 'nope', name: '' })).status, 401, 'a wrong link learns nothing about validation');
  assert.deepEqual(await json(await post(base, '/api/listing/save', { ...ENGINEER, key: mayaKey, phone: 'x' })), { error: 'phone' });
  const saved = await json(await post(base, '/api/listing/save', { ...ENGINEER, key: mayaKey, headline: 'New headline here', phone: '+1 555 010 9999', email: 'hijack@example.com', hidden: true, id: 'x' }));
  assert.deepEqual([saved.headline, saved.phone, saved.email, saved.hidden, saved.id], ['New headline here', '+1 555 010 9999', 'maya@example.com', false, maya.id]);
  assert.equal((await json(await get('/api/engineers'))).find(e => e.id === maya.id).headline, 'New headline here', 'clients see it at once');

  // "Email me my edit link": same answer for unknown emails; the new link replaces the old one.
  for (const email of ['nobody@example.com', 'maya@example.com']) assert.deepEqual(await json(await post(base, '/api/edit-link', { email })), { ok: true });
  assert.deepEqual(await json(await post(base, '/api/edit-link', { email: 'not an email' })), { error: 'email' });
  assert.equal(mailsTo(srv, 'nobody@example.com'), 0);
  assert.equal(keyFor(srv, 'maya@example.com'), mayaKey, 'within 10 minutes of the last link, nothing is sent and the link still works');

  const dev = { ...ENGINEER, name: 'Dev', email: 'dev@example.com' };
  await post(base, '/api/engineers', dev);
  const devKey = keyFor(srv, 'dev@example.com');
  assert.equal((await post(base, '/api/listing/remove', { key: devKey.split('.')[0] + '.' + mayaKey.split('.')[1] })).status, 401, "Maya's secret doesn't open Dev's listing");
  assert.deepEqual(await json(await post(base, '/api/listing/remove', { key: devKey })), { ok: true });
  assert.ok(!(await json(await get('/api/engineers'))).some(e => e.name === 'Dev'));
  assert.equal((await post(base, '/api/listing', { key: devKey })).status, 401, 'a removed listing is gone');
});

test('hiring needs no account: name, email, phone and a description; the engineer contact and payment details shown back', async () => {
  for (const [patch, field] of [[{ choice: 'p3' }, 'choice'], [{ choice: 'hourly', hours: '0' }, 'hours'], [{ clientName: '' }, 'clientName'], [{ clientEmail: 'nope' }, 'clientEmail'], [{ clientPhone: '' }, 'clientPhone'], [{ clientPhone: '12345' }, 'clientPhone'], [{ clientPhone: 'call me maybe' }, 'clientPhone'], [{ details: 'short' }, 'details'], [{ link: 'http://insecure.example' }, 'link'], [{ clientName: 'Ann\u202eevil' }, 'clientName']])
    assert.deepEqual(await json(await hire(maya.id, patch)), { error: field }, JSON.stringify(patch));
  assert.equal((await hire('missing')).status, 404);
  assert.equal((await hire(maya.id, { website: 'http://spam' })).status, 201, 'honeypot answers OK');
  const r = await hire(maya.id);
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('set-cookie'), null, 'no account or session for clients');
  assert.deepEqual(await json(r), { engineer: { name: 'Maya R.', email: 'maya@example.com', phone: '+1 555 010 9999', payWith: 'Venmo @maya-r', terms: 'Half upfront, half on completion' }, quote: 400 });
  assert.equal((await hire(maya.id, { choice: 'hourly', hours: '3', clientPhone: '+1 555 987 6543' })).status, 201, 'same client again, no sign-in needed');
});

test('staff roles: owner manages the team; admin sees money but not the team; moderator only hides; changes apply at once', async () => {
  assert.equal((await post(base, '/api/admin/login', { ...ADMIN, password: 'wrong password here' })).status, 401);
  const owner = await login(base);
  let d = await json(await get('/api/admin/data', owner));
  assert.deepEqual(d.me, { role: 'owner', perms: ['moderate', 'accounts', 'money', 'staff'] });
  assert.deepEqual(d.jobs.map(j => [j.engineer, j.clientEmail, j.quote]), [['Maya R.', 'ann@example.com', 360], ['Maya R.', 'ann@example.com', 400]], 'honeypot request not stored');
  assert.ok(!d.engineers.some(e => 'editKey' in e), 'edit keys never leave the server');
  assert.deepEqual(d.clients.map(c => [c.email, c.name, c.phone, c.jobs]), [['ann@example.com', 'Ann', '+1 555 987 6543', 2]], 'clients grouped by email, latest phone');
  assert.deepEqual([d.staff.length, d.engineers.find(e => e.name === 'Maya R.').jobs], [0, 2]);
  assert.ok(!d.engineers.some(e => 'auth' in e));
  assert.equal(d.engineers.find(e => e.name === 'Maya R.').phone, '+1 555 010 9999');

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
  // Hardening: moderators only hide and show listings, so they don't get engineers' emails or payment handles.
  assert.deepEqual([...new Set(d.engineers.flatMap(e => [e.email, e.phone, e.payWith]))], ['']);
  const hid = await post(base, '/api/admin/hide', { id: maya.id, hidden: true }, as(moC));
  assert.deepEqual([hid.status, await json(hid)], [200, { ok: true }]);
  assert.ok(!(await json(await get('/api/engineers'))).some(e => e.id === maya.id));
  assert.equal((await hire(maya.id)).status, 404, 'hidden engineers can not be hired');
  assert.equal((await post(base, '/api/admin/hide', { id: maya.id, hidden: false }, as(moC))).status, 200);
  assert.equal((await add({ email: 'x@example.com' }, moC)).status, 403);

  d = await json(await get('/api/admin/data', alC));
  assert.deepEqual([d.me.role, 'clients' in d, 'jobs' in d, 'staff' in d], ['admin', true, true, false]);
  assert.equal(d.engineers.find(e => e.id === maya.id).email, 'maya@example.com', 'admins see contact details');
  assert.equal((await add({ email: 'y@example.com' }, alC)).status, 403, 'admins can not manage the team');

  assert.equal((await post(base, '/api/admin/staff/role', { id: mo.id, role: 'admin' }, as(owner))).status, 200);
  assert.ok('jobs' in await json(await get('/api/admin/data', moC)), 'promotion applies to the live session');
  assert.equal((await post(base, '/api/admin/staff/remove', { id: ad.id }, as(owner))).status, 200);
  assert.equal((await get('/api/admin/data', alC)).status, 401, 'removed member is signed out at once');
  assert.equal((await post(base, '/api/admin/login', { email: 'al@example.com', password: 'mo password 12' })).status, 401);
  await post(base, '/api/admin/logout', {}, as(owner));
  assert.equal((await get('/api/admin/data', owner)).status, 401);
});

test('data survives a restart', async () => {
  await srv.stop(true);
  srv = await start({}, srv.dir); base = srv.base;
  assert.ok((await json(await get('/api/engineers'))).some(e => e.name === 'Maya R.'));
  assert.equal((await post(base, '/api/admin/login', { email: 'mo@example.com', password: 'mo password 12' })).status, 200);
  const raw = await readFile(srv.dir + '/store.json', 'utf8');
  assert.ok(!raw.includes('mo password 12') && !raw.includes(mayaKey.split('.')[1]), 'no plain passwords or edit-link secrets on disk');
  assert.equal((await post(base, '/api/listing', { key: mayaKey })).status, 200, 'the edit link still works after a restart');
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

test('rate limits: 10 accepted listings/requests per hour (rejected ones free), 10 link emails per hour, 10 sign-in attempts per 15 minutes', async () => {
  const s = await start();
  try {
    for (let i = 0; i < 15; i++) assert.equal((await post(s.base, '/api/engineers', { ...ENGINEER, email: 'bad' })).status, 400);
    for (let i = 0; i < 10; i++) assert.equal((await post(s.base, '/api/engineers', { ...ENGINEER, email: `e${i}@x.co` })).status, 201);
    assert.equal((await post(s.base, '/api/engineers', { ...ENGINEER, email: 'e11@x.co' })).status, 429);
    for (let i = 0; i < 10; i++) assert.equal((await post(s.base, '/api/edit-link', { email: `nobody${i}@x.co` })).status, 200);
    assert.equal((await post(s.base, '/api/edit-link', { email: 'e1@x.co' })).status, 429, 'link emails share a limit');
    for (let i = 0; i < 60; i++) await post(s.base, '/api/listing', { key: 'x.' + 'A'.repeat(43) });
    assert.equal((await post(s.base, '/api/listing', { key: keyFor(s, 'e1@x.co') })).status, 429, 'guessing edit links is limited');
    for (let i = 0; i < 10; i++) await post(s.base, '/api/admin/login', { email: 'a@x.co', password: 'wrong password!' });
    assert.equal((await post(s.base, '/api/admin/login', ADMIN)).status, 429);
  } finally { await s.stop(); }
});

test('behind the proxy, rate limits use the address the proxy added, not one the client sends', async () => {
  const s = await start({ TRUST_PROXY: '1' });
  try {
    // A client can't dodge the limit by sending its own X-Forwarded-For: the proxy appends the real address last.
    for (let i = 0; i < 10; i++) await post(s.base, '/api/admin/login', { email: 'a@x.co', password: 'wrong password!' }, { 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.7` });
    assert.equal((await post(s.base, '/api/admin/login', { email: 'a@x.co', password: 'wrong password!' }, { 'X-Forwarded-For': '10.9.9.9, 203.0.113.7' })).status, 429);
    assert.equal((await post(s.base, '/api/admin/login', { email: 'a@x.co', password: 'wrong password!' }, { 'X-Forwarded-For': '203.0.113.8' })).status, 401, 'a different real address has its own limit');
  } finally { await s.stop(); }
});

// Hardening: a request takes its place in the limit before it runs, so parallel requests can't all get in.
test('rate limits hold under a burst: 30 hire requests at once, 10 accepted', async () => {
  const s = await start();
  try {
    await post(s.base, '/api/engineers', ENGINEER);
    const e = (await (await fetch(s.base + '/api/engineers')).json())[0];
    const burst = await Promise.all(Array.from({ length: 30 }, () => post(s.base, '/api/jobs', { engineerId: e.id, choice: 'p0', details: 'Login breaks after deploy.', ...CLIENT })));
    const codes = burst.map(r => r.status);
    assert.deepEqual([codes.filter(c => c === 201).length + 1, codes.filter(c => c === 429).length], [10, 21], codes.join(','));
  } finally { await s.stop(); }
});

// Hardening: on Azure App Service every request comes from the platform proxy; without TRUST_PROXY=1 everyone would
// share one rate limit, so the server refuses to start.
test('refuses to start on App Service without TRUST_PROXY=1', async () => {
  await assert.rejects(start({ WEBSITE_SITE_NAME: 'codemarcer-test', TRUST_PROXY: '' }), /TRUST_PROXY=1/);
  await assert.rejects(start({ WEBSITE_SITE_NAME: 'codemarcer-test', TRUST_PROXY: '1' }), /ACS_CONNECTION_STRING/, 'a live site must really send edit links');
  const s = await start({ WEBSITE_SITE_NAME: 'codemarcer-test', TRUST_PROXY: '1', ACS_CONNECTION_STRING: 'endpoint=https://x.communication.azure.com/;accesskey=' + Buffer.from('k').toString('base64'), MAIL_FROM: 'DoNotReply@x.azurecomm.net' });
  await s.stop();
});
