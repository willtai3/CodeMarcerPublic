import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { start, ADMIN } from './helpers.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const SHOTS = process.env.SHOTS; // folder for screenshots, optional
let srv, browser;
before(async () => { srv = await start(); browser = await chromium.launch(); SHOTS && await mkdir(SHOTS, { recursive: true }); });
after(async () => { await browser?.close(); await srv?.stop(); });

// Every page gets: outside requests blocked and recorded, console errors (incl. CSP violations) recorded.
// A signed-out page load asks /api/me and gets the expected 401, so that one message is always allowed.
const open = async (path, opts = {}) => {
  const ctx = await browser.newContext(opts), page = await ctx.newPage(), outside = [], errors = [];
  await ctx.route('**', r => { const u = new URL(r.request().url()); return u.origin === new URL(srv.base).origin ? r.continue() : (outside.push(u.href), r.abort()); });
  page.on('console', m => m.type() === 'error' && !/status of 401/.test(m.text()) && errors.push(m.text()));
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(srv.base + path);
  return { ctx, page, done: async expected => { assert.deepEqual(outside, [], 'no outside requests'); assert.deepEqual(errors.filter(e => !expected?.test(e)), [], 'no console errors'); await ctx.close(); } };
};
const shot = (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const fillAll = async (scope, values) => { for (const [name, v] of Object.entries(values)) await scope.locator(`[name="${name}"]`).fill(v); };
const signIn = async (form, email, password) => { await fillAll(form, { email, password }); await form.getByRole('button', { name: 'Sign in' }).click(); };

test('pricing tab: promo, calculator, tab survives reload', async () => {
  const { page, done } = await open('/#pricing');
  await page.getByText('Free until February 1, 2027').waitFor();
  assert.match(await page.locator('#price-now').textContent(), /No fee on any job requested before February 1, 2027/);
  await page.locator('#amount').fill('5000');
  assert.equal(await page.locator('#calc-out').textContent(), 'Requested now: fee $0, engineer keeps $5,000. Requested from February 1, 2027: fee $500, engineer keeps $4,500.');
  await page.reload();
  assert.equal(await page.locator('#pricing').isVisible(), true);
  await done();
});

test('engineer lists themselves: wrong sign-in, pricing required, add and remove packages, live at once', async () => {
  const { page, done } = await open('/#engineers');
  const signin = page.locator('#signin');
  await signIn(signin, 'nobody@example.com', 'wrong password!');
  await signin.getByText('Wrong email or password.').waitFor();

  const f = page.locator('#profile');
  assert.equal(await f.locator('.pkg').count(), 1, 'one empty package row to start');
  await fillAll(f, { name: 'Maya R.', email: 'maya@example.com', password: 'maya password 1', headline: 'I take AI-built web apps to production', skills: 'next, supabase, stripe', payWith: 'Venmo @maya-r' });
  await f.getByRole('button', { name: 'List me' }).click();
  await f.getByText('Add an hourly rate or at least one package.').waitFor();
  await fillAll(f, { 'pkg-title': 'Deploy your app with HTTPS', 'pkg-price': '10', 'pkg-days': '5' });
  await f.getByRole('button', { name: 'List me' }).click();
  await f.getByText(/Check each package/).waitFor();
  await f.locator('[name="pkg-price"]').fill('400');

  await f.getByRole('button', { name: '+ Add package' }).click();
  assert.equal(await f.locator('.pkg').count(), 2);
  await f.locator('.pkg').nth(1).getByRole('button', { name: 'Remove package' }).click();
  assert.equal(await f.locator('.pkg').count(), 1);
  for (let i = 0; i < 4; i++) await f.getByRole('button', { name: '+ Add package' }).click();
  assert.equal(await f.getByRole('button', { name: '+ Add package' }).isHidden(), true, 'capped at 5');
  await f.locator('.pkg').nth(4).getByRole('button', { name: 'Remove package' }).click();
  assert.equal(await f.getByRole('button', { name: '+ Add package' }).isVisible(), true);
  await f.locator('[name="rate"]').fill('120');
  await shot(page, 'desktop-signup');

  await f.getByRole('button', { name: 'List me' }).click(); // empty extra rows are dropped
  await page.getByText("Signed in as Maya R. (maya@example.com). No open requests. You're listed.").waitFor();
  assert.equal(await f.getByRole('button', { name: 'Save profile' }).isVisible(), true);
  assert.equal(await f.locator('[name="email"]').isHidden(), true, 'email fixed after signup');

  await page.getByRole('tab', { name: 'Find an engineer' }).click();
  const c = page.locator('.card', { hasText: 'Maya R.' });
  await c.getByRole('button', { name: 'Hire', exact: true }).click();
  await c.getByText('Sign out of your engineer account to hire as a client.').waitFor();
  await page.getByRole('tab', { name: 'Your requests' }).click();
  await page.getByText("You're signed in as an engineer.").waitFor();
  await done(/status of 400/); // the deliberate validation failures
});

test('client hires: search, cancel, hourly quote, account made on the way, then a second hire while signed in', async () => {
  const { page, done } = await open('/#find');
  const c = page.locator('.card', { hasText: 'Maya R.' });
  await c.waitFor();
  await page.locator('#q').fill('flutter');
  await page.getByText('No engineers match that search.').waitFor();
  await page.locator('#q').fill('Stripe next');
  await c.waitFor();
  assert.match(await c.textContent(), /\$120\/hour · Paid half upfront, half on completion/);
  assert.equal(await c.textContent().then(t => t.includes('maya@example.com') || t.includes('Venmo')), false, 'contact hidden until a request');

  await c.getByRole('button', { name: 'Hire', exact: true }).click();
  await c.getByText('Deploy your app with HTTPS for $400, about 5 days.').waitFor();
  await c.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await c.locator('form.hire').count(), 0);

  await c.getByRole('button', { name: 'Hire by the hour' }).click();
  const form = c.locator('form.hire');
  await page.getByRole('tab', { name: 'Pricing' }).click(); await page.getByRole('tab', { name: 'Find an engineer' }).click();
  await page.waitForTimeout(300);
  assert.equal(await form.count(), 1, 'hire form survives reopening the tab');
  await form.locator('[name="hours"]').fill('3');
  await form.getByText('Estimated $360 at $120/hour.').waitFor();
  await fillAll(form, { clientName: 'Ann', clientEmail: 'not-an-email', password: 'ann password 1', details: 'Login loops after deploy on Vercel.' });
  await form.getByRole('button', { name: 'Send request' }).click();
  await form.getByText('Check the email.').waitFor();
  await form.locator('[name="clientEmail"]').fill('maya@example.com');
  await form.getByRole('button', { name: 'Send request' }).click();
  await form.getByText(/That email already has an account/).waitFor();
  await form.locator('[name="clientEmail"]').fill('ann@example.com');
  await form.getByRole('button', { name: 'Send request' }).click();
  await c.getByText('Request sent to Maya R.').waitFor();
  assert.equal((await c.locator('.done').textContent()).includes('R..'), false, 'no double period after a name ending in a dot');
  assert.match(await c.locator('.done').textContent(), /Quote \$360\.Email them to agree the details: maya@example\.comThey take payment by Venmo @maya-r\. Payment terms: half upfront, half on completion\./);
  await shot(page, 'desktop-hired');

  await page.locator('#q').fill('');
  await c.getByRole('button', { name: 'Hire', exact: true }).click();
  await c.getByText('Sending as Ann (ann@example.com).').waitFor();
  assert.equal(await c.locator('form.hire [name="password"]').count(), 0, 'no account fields when signed in');
  await c.locator('[name="details"]').fill('Need Stripe payments added to my app.');
  await c.getByRole('button', { name: 'Send request' }).click();
  await c.getByText('Request sent to Maya R.').waitFor();

  await c.getByRole('link', { name: 'Your requests' }).click();
  await page.locator('#requests .who', { hasText: 'Signed in as Ann (ann@example.com). 2 open requests.' }).waitFor();
  const hourly = page.locator('#requests-list .job', { hasText: '3 hours' });
  assert.match(await hourly.textContent(), /Email maya@example\.com · Pay by Venmo @maya-r · Half upfront, half on completion/);
  await hourly.getByRole('button', { name: 'Cancel request' }).click();
  await page.locator('#requests-list .job', { hasText: '3 hours' }).getByText('Cancelled').waitFor();
  await shot(page, 'desktop-requests');
  await page.getByRole('tab', { name: 'For engineers' }).click();
  await page.getByText("You're signed in as a client.").waitFor();
  assert.equal(await page.locator('#profile').isHidden(), true);
  await page.getByRole('tab', { name: 'Your requests' }).click();
  await page.locator('#requests .signout').click();
  await page.locator('#signin-client').waitFor();
  await done(/status of (400|409)/);
});

test('engineer dashboard: accept, mark paid, complete with cancel, edit profile, sign out', async () => {
  const { page, done } = await open('/#engineers');
  await signIn(page.locator('#signin'), 'maya@example.com', 'maya password 1');
  await page.locator('#who', { hasText: /Signed in as Maya R\..*1 open request\./ }).waitFor();
  const job = page.locator('#jobs .job', { hasText: 'Ann ·' }).filter({ hasText: 'Deploy your app' });
  assert.match(await job.textContent(), /Deploy your app with HTTPS · quote \$400ann@example\.com/);
  assert.match(await page.locator('#jobs .job', { hasText: '3 hours' }).textContent(), /Cancelled/);
  await shot(page, 'desktop-dashboard');

  await job.getByRole('button', { name: 'Accept' }).click();
  await job.getByRole('button', { name: 'Mark paid' }).click();
  await job.locator('.status', { hasText: 'Paid' }).waitFor();
  await job.getByRole('button', { name: 'Mark complete' }).click();
  await job.getByRole('button', { name: 'Cancel' }).click();
  await job.getByRole('button', { name: 'Mark complete' }).click();
  await job.getByLabel('Final amount in USD').fill('450');
  await job.getByRole('button', { name: 'Confirm complete' }).click();
  await job.getByText('Completed for $450. No fee: requested during the free period.').waitFor();
  assert.equal(await job.getByRole('button').count(), 0, 'no actions after complete');

  const f = page.locator('#profile');
  await f.locator('[name="headline"]').fill('Production-ready AI apps in a week');
  await f.locator('[name="available"]').uncheck();
  await f.getByRole('button', { name: 'Save profile' }).click();
  await page.getByText(/Profile saved\./).waitFor();
  await page.getByRole('tab', { name: 'Find an engineer' }).click();
  const card = page.locator('.card', { hasText: 'Maya R.' });
  await card.getByText(/Not taking new work right now/).waitFor();
  assert.equal(await card.getByRole('button').count(), 0, 'no hire buttons while unavailable');
  await page.getByRole('tab', { name: 'For engineers' }).click();
  await f.locator('[name="available"]').check();
  await f.getByRole('button', { name: 'Save profile' }).click();
  await page.getByText(/Profile saved\./).waitFor();
  await page.locator('#engineers .signout').click();
  await page.getByRole('button', { name: 'List me' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'List me' }).waitFor();
  await done();
});

test('client confirms the final amount', async () => {
  const { page, done } = await open('/#requests');
  await signIn(page.locator('#signin-client'), 'ann@example.com', 'ann password 1');
  const job = page.locator('#requests-list .job', { hasText: 'Deploy your app' });
  await job.getByText('Completed for $450. Confirm the amount if it matches what you paid.').waitFor();
  await job.getByRole('button', { name: 'Confirm $450' }).click();
  await job.getByText('Completed for $450. You confirmed this amount.').waitFor();
  assert.equal(await job.getByRole('button').count(), 0);
  await done();
});

test('staff: owner adds a moderator and an admin, moderator sees only engineers, removal signs them out', async () => {
  const { page, ctx, done } = await open('/admin');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill('wrong password here');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Wrong email or password.').waitFor();
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Signed in as Owner. 1 engineer listed. 2 job requests, 1 completed for $450. Fees owed: $0.').waitFor();
  for (const t of ['Engineers', 'Clients', 'Jobs', 'Team']) assert.equal(await page.getByRole('tab', { name: t }).isVisible(), true, t);

  await page.getByRole('tab', { name: 'Jobs' }).click();
  const completed = page.locator('#ledger tbody tr', { hasText: 'Complete' });
  assert.match(await completed.textContent(), /CompleteConfirmed\$450\$0$/, 'default columns: key columns plus check, amount and fee');
  // Columns menu: Work is opt-in; turning it on shows it and is remembered after a reload.
  assert.equal(await page.locator('#ledger th', { hasText: 'Work' }).count(), 0);
  await page.locator('#ledger summary', { hasText: 'Columns' }).click();
  await page.locator('#ledger .cols-list').getByLabel('Work').check();
  await page.locator('#ledger th', { hasText: 'Work' }).waitFor();
  assert.match(await page.locator('#ledger tbody tr', { hasText: 'Complete' }).textContent(), /Deploy your app with HTTPS/);
  await page.reload();
  await page.locator('#ledger th', { hasText: 'Work' }).waitFor();
  await page.locator('#ledger summary', { hasText: 'Columns' }).click();
  await page.locator('#ledger .cols-list').getByLabel('Work').uncheck();
  assert.equal(await page.locator('#ledger th', { hasText: 'Work' }).count(), 0);
  await page.getByRole('tab', { name: 'Clients' }).click();
  const ann = page.locator('#clients tr', { hasText: 'Ann' });
  await ann.getByRole('button', { name: 'Set password' }).click();
  await ann.getByRole('button', { name: 'Cancel' }).click();
  await ann.getByRole('button', { name: 'Set password' }).click();
  await ann.getByLabel('New password for Ann').fill('ann temporary 1');
  await ann.getByRole('button', { name: 'Save' }).click();
  await page.getByText('New password set for Ann. Give it to them directly.').waitFor();

  await page.getByRole('tab', { name: 'Team' }).click();
  const add = page.locator('#team form');
  await fillAll(add, { name: 'Mo', email: 'mo@example.com', password: 'short' });
  await add.getByRole('button', { name: 'Add to team' }).click();
  await page.getByText(/use 10 to 200 characters for the password/).waitFor();
  await fillAll(page.locator('#team form'), { name: 'Mo', email: 'mo@example.com', password: 'mo password 12' });
  await page.locator('#team form').getByRole('button', { name: 'Add to team' }).click();
  await page.getByText('Mo added. Give them the temporary password; they sign in here.').waitFor();
  await fillAll(page.locator('#team form'), { name: 'Al', email: 'al@example.com', password: 'al password 12' });
  await page.locator('#team form [name="role"]').selectOption('admin');
  await page.locator('#team form').getByRole('button', { name: 'Add to team' }).click();
  await page.getByText('Al added. Give them the temporary password; they sign in here.').waitFor();
  await page.getByLabel('Role for Al').selectOption('moderator');
  await page.getByText('Al is now moderator.').waitFor();
  await shot(page, 'desktop-team');

  // Mo signs in in another browser: only the Engineers tab, and Hide/Show work.
  const mo = await open('/admin#ledger');
  await mo.page.getByLabel('Email').fill('mo@example.com');
  await mo.page.getByLabel('Password').fill('mo password 12');
  await mo.page.getByRole('button', { name: 'Sign in' }).click();
  await mo.page.getByText('Signed in as Moderator. 1 engineer listed.').waitFor();
  for (const t of ['Clients', 'Jobs', 'Team']) assert.equal(await mo.page.getByRole('tab', { name: t }).isHidden(), true, t);
  assert.equal(await mo.page.locator('#roster').isVisible(), true, 'falls back to a tab the role may see');
  const row = mo.page.locator('#roster tr', { hasText: 'Maya R.' });
  assert.equal(await row.getByRole('button', { name: 'Set password' }).count(), 0);
  await row.getByRole('button', { name: 'Hide' }).click();
  await mo.page.getByText('Maya R. is now hidden on the site.').waitFor();
  await row.getByRole('button', { name: 'Show' }).click();
  await mo.page.getByText('Maya R. is now shown on the site.').waitFor();

  // Owner removes Mo; Mo's next action fails and returns to the sign-in form.
  const moRow = page.locator('#team tr', { hasText: 'mo@example.com' });
  await moRow.getByRole('button', { name: 'Remove Mo' }).click();
  await moRow.getByText('Remove Mo?').waitFor();
  await moRow.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await moRow.getByRole('button', { name: 'Remove Mo' }).isVisible(), true, 'cancel keeps the member');
  await moRow.getByRole('button', { name: 'Remove Mo' }).click();
  assert.equal(await moRow.locator('.danger').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(229, 37, 28)', 'confirm button is red #e5251c');
  await moRow.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByText('Mo removed. They are signed out everywhere.').waitFor();
  await row.getByRole('button', { name: 'Hide' }).click();
  await mo.page.getByText('Signed out. Sign in again.').waitFor();
  await mo.done(/status of 401/);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.locator('#login [name="password"]').waitFor();
  await done(/status of (400|401)/);
});

test('phone: no sideways scroll on every tab and the hire form; screenshots', async () => {
  const { page, done } = await open('/#find', { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  await page.locator('.card').first().waitFor();
  await page.getByRole('button', { name: 'Hire by the hour' }).first().click();
  assert.equal(await noSideScroll(page), true, 'hire form');
  await shot(page, 'phone-find');
  for (const tab of ['requests', 'engineers', 'pricing']) {
    await page.locator(`[data-tab=${tab}]`).click();
    assert.equal(await noSideScroll(page), true, tab);
    await shot(page, 'phone-' + tab);
  }
  await done();
});

test('controls line up at phone, tablet and desktop widths (34px, 28px small)', async () => {
  const { page, done } = await open('/#engineers');
  for (const width of [375, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const sel of ['#signin .row', '#profile .row', '#profile .pkg']) {
      const boxes = await page.locator(`${sel} :is(input, select, button)`).evaluateAll(els => els.filter(e => e.offsetParent).map(e => Math.round(e.getBoundingClientRect().height)));
      assert.ok(boxes.length && boxes.every(hgt => hgt === 34), `${sel} at ${width}px: heights ${boxes.join(', ')}`);
    }
    assert.equal(await noSideScroll(page), true, `no sideways scroll at ${width}px`);
  }
  await done();
});

test('buttons: hover grows 1.06, off under reduced motion; form controls line up at 34px', async () => {
  const { page, done } = await open('/#engineers');
  const btn = page.getByRole('button', { name: 'List me' }), scale = () => btn.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
  await btn.hover(); await page.waitForTimeout(250);
  assert.ok(Math.abs(await scale() - 1.06) < 0.001);
  await page.mouse.move(0, 0); await page.waitForTimeout(250);
  assert.equal(await scale(), 1);
  const heights = await page.locator('#profile :is(input:not(.trap):not([type=checkbox]), select, button)').evaluateAll(els => [...new Set(els.filter(e => e.offsetParent).map(e => e.getBoundingClientRect().height))]);
  assert.deepEqual(heights, [34]);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await btn.hover(); await page.waitForTimeout(250);
  assert.equal(await scale(), 1);
  await done();
});
