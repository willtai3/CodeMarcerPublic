import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pctAt, feeFor, PROMO_END, FEE_PCT, usd } from '../public/fees.js';
import { tags, profileOf, quoteFor, directory, validate, JOB, CLIENT, STAFF, PERMS, NEXT, CLIENT_NEXT } from '../lib/rules.js';
import { openStore } from '../lib/store.js';
import { hash, verify, setAdmin, adminLogin } from '../lib/auth.js';
import { ENGINEER } from './helpers.js';

const tmp = () => mkdtemp(join(tmpdir(), 'hu-'));

test('fees: free through Jan 31 2027 Pacific, FEE_PCT from Feb 1 2027 00:00 PST', () => {
  assert.equal(pctAt(Date.parse('2026-11-01T12:00:00Z')), 0);
  assert.equal(pctAt(Date.parse('2027-01-31T23:59:59-08:00')), 0);
  assert.equal(pctAt(Date.parse('2027-02-01T00:00:00-08:00')), FEE_PCT);
  assert.equal(PROMO_END, Date.parse('2027-02-01T08:00:00Z'));
  assert.deepEqual(feeFor(5000, 10), { amount: 5000, pct: 10, fee: 500, payout: 4500 });
  assert.deepEqual(feeFor(1234, 10), { amount: 1234, pct: 10, fee: 123.4, payout: 1110.6 });
  assert.equal(usd(4500), '$4,500');
});

test('tags normalise aliases, dedupe and cap', () => {
  assert.deepEqual(tags('React.js, NodeJS ,node,  Next , '), ['react', 'node', 'next.js']);
  assert.equal(tags(Array.from({ length: 20 }, (_, i) => 't' + i).join(',')).length, 12);
});

test('profile: valid signup; rate or packages required; package rules; field errors named', () => {
  const ok = profileOf(ENGINEER, true);
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.data.packages, [{ title: 'Deploy your app with HTTPS', price: 400, days: 5, details: 'Hosting, domain and HTTPS' }]);
  assert.equal(ok.data.rate, 120);
  assert.equal(ok.data.about, null);
  assert.equal(profileOf({ ...ENGINEER, rate: '', packages: [] }, true).error, 'pricing');
  assert.equal(profileOf({ ...ENGINEER, rate: '' }, true).error, undefined, 'packages alone are enough');
  assert.equal(profileOf({ ...ENGINEER, packages: [] }, true).error, undefined, 'a rate alone is enough');
  for (const [patch, field] of [[{ email: 'x' }, 'email'], [{ password: 'short' }, 'password'], [{ headline: 'hi' }, 'headline'], [{ skills: ' , ' }, 'skills'], [{ rate: '5' }, 'rate'], [{ rate: '12.5' }, 'rate'], [{ packages: [{ title: 'ok title', price: '10', days: '2' }] }, 'packages'], [{ packages: Array(6).fill(ENGINEER.packages[0]) }, 'packages'], [{ payWith: '' }, 'payWith'], [{ terms: 'Never' }, 'terms'], [{ portfolio: 'http://x.example' }, 'portfolio'], [{ available: 'yes' }, 'available']])
    assert.equal(profileOf({ ...ENGINEER, ...patch }, true).error, field, JSON.stringify(patch));
  assert.equal(profileOf({ ...ENGINEER, email: undefined, password: undefined }, false).error, undefined, 'edits need no email or password');
  assert.equal(validate(JOB, { details: 'short' }).error, 'details');
  assert.equal(validate(CLIENT, { clientName: 'C', clientEmail: 'c@x.co', password: 'short' }).error, 'password');
  assert.equal(validate(STAFF, { name: 'S', email: 's@x.co', password: 'long password', role: 'owner' }).error, 'role', 'nobody can be made owner');
});

test('quotes: package by index, hourly needs a rate and 1-500 hours, anything else refused', () => {
  const e = { rate: 120, packages: [{ title: 'Deploy', price: 400, days: 5 }] };
  assert.deepEqual(quoteFor(e, 'p0'), { type: 'package', title: 'Deploy', days: 5, quote: 400 });
  assert.deepEqual(quoteFor(e, 'hourly', '3'), { type: 'hourly', hours: 3, rate: 120, quote: 360 });
  for (const [c, hrs] of [['p1'], ['p9'], ['x'], [undefined], ['hourly', '0'], ['hourly', '501'], ['hourly', '2.5'], ['__proto__']]) assert.equal(quoteFor(e, c, hrs), undefined, `${c} ${hrs}`);
  assert.equal(quoteFor({ ...e, rate: null }, 'hourly', '3'), undefined);
});

test('directory hides hidden engineers, puts available first, and never exposes email, auth or payment details', () => {
  const base = { skills: [], packages: [], rate: 1, terms: 'Upfront', email: 'x@y.z', auth: {}, payWith: 'Venmo', hidden: false };
  const d = directory([{ ...base, id: 'a', available: false, created: '2026-10-03' }, { ...base, id: 'b', available: true, created: '2026-10-01' }, { ...base, id: 'c', available: true, created: '2026-10-02', hidden: true }]);
  assert.deepEqual(d.map(e => e.id), ['b', 'a']);
  for (const e of d) for (const k of ['email', 'auth', 'payWith', 'hidden']) assert.ok(!(k in e), k);
});

test('job status only moves forward; clients can only cancel a new request', () => {
  assert.deepEqual(NEXT, { requested: ['accepted', 'declined'], accepted: ['paid', 'complete', 'declined'], paid: ['complete'] });
  assert.deepEqual(CLIENT_NEXT, { requested: ['cancelled'] });
});

test('permissions: owner > admin > moderator', () => {
  assert.deepEqual(PERMS, { owner: ['moderate', 'accounts', 'money', 'staff'], admin: ['moderate', 'accounts', 'money'], moderator: ['moderate'] });
});

test('passwords: scrypt hash only, right one passes, wrong or missing fail', async () => {
  const a = await hash('long enough password');
  assert.ok(!JSON.stringify(a).includes('long enough'));
  assert.equal(await verify(a, 'long enough password'), true);
  assert.equal(await verify(a, 'long enough passworD'), false);
  assert.equal(await verify(undefined, 'long enough password'), false);
  assert.equal(await verify(a, 42), false);
});

test('admin account file: setup state, right login, wrong email or password, weak input refused, owner-only file', async () => {
  const dir = await tmp();
  try {
    const login = adminLogin(dir);
    assert.equal(await login('a@b.co', 'whatever password'), 'setup');
    await assert.rejects(setAdmin(dir, 'a@b.co', 'short'), /12 characters/);
    await assert.rejects(setAdmin(dir, 'nope', 'long enough password'), /email/);
    await setAdmin(dir, 'Me@Example.com', 'long enough password');
    assert.equal((await stat(join(dir, 'admin.json'))).mode & 0o777, 0o600);
    assert.ok(!(await readFile(join(dir, 'admin.json'), 'utf8')).includes('long enough password'));
    assert.equal(await login(' me@example.com ', 'long enough password'), true);
    assert.equal(await login('me@example.com', 'wrong password!!'), false);
    assert.equal(await login('other@example.com', 'long enough password'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('store: survives reopen, owner-only file, failed write rolls back and later writes work', async () => {
  const dir = await tmp();
  try {
    const s = await openStore(dir), a = await s.add('engineer', { n: 1 });
    assert.equal((await stat(join(dir, 'store.json'))).mode & 0o777, 0o600);
    assert.equal((await openStore(dir)).get(a.id).n, 1);
    await rm(dir, { recursive: true, force: true });
    await assert.rejects(s.update(a.id, { n: 2 }));
    await assert.rejects(s.add('job', { n: 3 }));
    assert.equal(s.get(a.id).n, 1);
    assert.equal(s.all('job').length, 0);
    await mkdir(dir);
    await s.update(a.id, { n: 4 });
    assert.equal((await openStore(dir)).get(a.id).n, 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
