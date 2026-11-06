import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { start, post, keyFor, ADMIN, ENGINEER } from './helpers.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const SHOTS = process.env.SHOTS; // folder for screenshots, optional
let srv, browser;
before(async () => { srv = await start(); browser = await chromium.launch(); SHOTS && await mkdir(SHOTS, { recursive: true }); });
after(async () => { await browser?.close(); await srv?.stop(); });

// Every page gets: outside requests blocked and recorded, console errors (incl. CSP violations) recorded.
// The admin page asks for its data on load and gets the expected 401 when signed out, so that message is allowed.
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

test('no fees: said up front, no pricing tab, tab survives reload', async () => {
  const { page, done } = await open('/#engineers');
  assert.equal(await page.locator('.badge').textContent(), 'No fees');
  assert.match(await page.locator('.lead').textContent(), /CodeMarcer takes no fee from either side\./);
  assert.equal(await page.getByRole('tab', { name: 'Pricing' }).count(), 0);
  assert.ok(!/\b\d+% fee|fees owed|free until/i.test(await page.locator('body').textContent()), 'no fee wording anywhere');
  await page.reload();
  assert.equal(await page.locator('#engineers').isVisible(), true);
  await done();
});

test('engineer lists themselves with email and phone, no password: pricing required, add and remove packages, live at once', async () => {
  const { page, done } = await open('/#engineers');
  const f = page.locator('#profile');
  assert.equal(await page.locator('#engineers [type="password"]').count(), 0, 'no password anywhere');
  assert.equal(await page.getByRole('button', { name: 'Sign in' }).count(), 0, 'no sign-in');
  assert.equal(await f.locator('.pkg').count(), 1, 'one empty package row to start');
  await fillAll(f, { name: 'Maya R.', email: 'maya@example.com', phone: '12345', headline: 'I take AI-built web apps to production', skills: 'next, supabase, stripe', payWith: 'Venmo @maya-r' });
  await f.getByRole('button', { name: 'List me' }).click();
  await f.getByText('Check the phone.').waitFor();
  await f.locator('[name="phone"]').fill('(555) 010-2030');
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
  await f.getByText(/^You're listed\. We've emailed a private link to edit or remove your listing to maya@example\.com\./).waitFor();
  assert.equal(await f.locator('[name="name"]').inputValue(), '', 'the form is cleared for the next person');
  assert.ok(keyFor(srv, 'maya@example.com'), 'the edit link was emailed');

  await page.getByRole('tab', { name: 'Find an engineer' }).click();
  await page.locator('.card', { hasText: 'Maya R.' }).waitFor();
  await done(/status of 400/); // the deliberate validation failures
});

test('client hires without an account: search, cancel, hourly quote, name/email/phone/description required', async () => {
  const { page, done } = await open('/#find');
  assert.equal(await page.getByRole('tab', { name: 'Your requests' }).count(), 0, 'no client sign-in anywhere');
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
  assert.equal(await form.locator('[type="password"]').count(), 0, 'no password field');
  await page.getByRole('tab', { name: 'For engineers' }).click(); await page.getByRole('tab', { name: 'Find an engineer' }).click();
  await page.waitForTimeout(300);
  assert.equal(await form.count(), 1, 'hire form survives reopening the tab');
  await form.locator('[name="hours"]').fill('3');
  await form.getByText('Estimated $360 at $120/hour.').waitFor();
  await fillAll(form, { clientName: 'Ann', clientEmail: 'not-an-email', clientPhone: '(555) 123-4567', details: 'Login loops after deploy on Vercel.' });
  await form.getByRole('button', { name: 'Send request' }).click();
  await form.getByText('Check the email.').waitFor();
  await form.locator('[name="clientEmail"]').fill('ann@example.com');
  await form.locator('[name="clientPhone"]').fill('12345');
  await form.getByRole('button', { name: 'Send request' }).click();
  await form.getByText('Check the phone.').waitFor();
  await form.locator('[name="clientPhone"]').fill('(555) 123-4567');
  await form.getByRole('button', { name: 'Send request' }).click();
  await c.getByText('Request sent to Maya R.').waitFor();
  assert.equal((await c.locator('.done').textContent()).includes('R..'), false, 'no double period after a name ending in a dot');
  const confirm = await c.locator('.done').textContent();
  assert.match(confirm, /Quote \$360\.Contact them to agree the details: maya@example\.com · \(555\) 010-2030They take payment by Venmo @maya-r\. Payment terms: half upfront, half on completion\.They also have your email and phone\./);
  await shot(page, 'desktop-hired');

  await page.locator('#q').fill('');
  await c.getByRole('button', { name: 'Hire', exact: true }).click();
  await fillAll(c.locator('form.hire'), { clientName: 'Ann', clientEmail: 'ann@example.com', clientPhone: '+1 555 987 6543', details: 'Need Stripe payments added to my app.' });
  await c.getByRole('button', { name: 'Send request' }).click();
  await c.getByText('Request sent to Maya R.').waitFor();
  await done(/status of 400/);
});

test('edit link: opens the listing, leaves the address bar, saves, emails a new link; a bad link says so; remove with confirm', async () => {
  const { page, done } = await open('/#edit=' + keyFor(srv, 'maya@example.com'));
  await page.getByText('Editing the listing for Maya R. (maya@example.com).').waitFor();
  assert.equal(new URL(page.url()).hash, '#engineers', 'the secret is taken out of the address bar');
  const f = page.locator('#profile');
  assert.equal(await f.locator('[name="email"]').getAttribute('readonly'), '', 'the email is fixed');
  assert.equal(await f.locator('[name="phone"]').inputValue(), '(555) 010-2030');
  assert.equal(await page.locator('#relink').isHidden(), true);
  await shot(page, 'desktop-edit');
  await f.locator('[name="headline"]').fill('Production-ready AI apps in a week');
  await f.locator('[name="available"]').uncheck();
  await f.getByRole('button', { name: 'Save changes' }).click();
  await f.getByText('Saved. Clients see the change now.').waitFor();
  await page.getByRole('tab', { name: 'Find an engineer' }).click();
  const card = page.locator('.card', { hasText: 'Maya R.' });
  await card.getByText(/Not taking new work right now/).waitFor();
  assert.equal(await card.getByRole('button').count(), 0, 'no hire buttons while unavailable');
  await page.getByRole('tab', { name: 'For engineers' }).click();
  await f.locator('[name="available"]').check();
  await f.getByRole('button', { name: 'Save changes' }).click();
  await f.getByText('Saved. Clients see the change now.').waitFor();
  await page.getByRole('button', { name: 'Done' }).click();
  await f.getByRole('button', { name: 'List me' }).waitFor();
  assert.equal(await f.locator('[name="email"]').getAttribute('readonly'), null);

  const relink = page.locator('#relink');
  await relink.locator('[name="email"]').fill('maya@example.com');
  await relink.getByRole('button', { name: 'Email me my edit link' }).click();
  await relink.getByText('If maya@example.com is listed, a new link is on its way and older links stop working. One email per 10 minutes.').waitFor();

  await page.goto(srv.base + '/#edit=' + keyFor(srv, 'maya@example.com').split('.')[0] + '.' + 'A'.repeat(43));
  await relink.getByText('This edit link no longer works. Get a new one with "Email me my edit link" below.').waitFor();
  await f.getByRole('button', { name: 'List me' }).waitFor();

  await post(srv.base, '/api/engineers', { ...ENGINEER, name: 'Dev', email: 'dev@example.com' });
  await page.goto(srv.base + '/#edit=' + keyFor(srv, 'dev@example.com')); // a link opened while the page is open
  await page.getByText('Editing the listing for Dev (dev@example.com).').waitFor();
  await page.getByRole('button', { name: 'Remove my listing' }).click();
  await page.getByText('Remove your listing for good?').waitFor();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Remove my listing' }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await f.getByText('Your listing is removed.').waitFor();
  await page.getByRole('tab', { name: 'Find an engineer' }).click();
  await page.locator('.card', { hasText: 'Maya R.' }).waitFor();
  assert.equal(await page.locator('.card', { hasText: 'Dev' }).count(), 0);
  await done(/status of 401/); // the bad link
});

test('staff: owner adds a moderator and an admin, moderator sees only engineers, removal signs them out', async () => {
  const { page, ctx, done } = await open('/admin');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill('wrong password here');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Wrong email or password.').waitFor();
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Signed in as Owner. 1 engineer listed. 2 hire requests.').waitFor();
  for (const t of ['Engineers', 'Clients', 'Hire requests', 'Team']) assert.equal(await page.getByRole('tab', { name: t }).isVisible(), true, t);
  assert.match(await page.locator('#roster tbody tr', { hasText: 'Maya R.' }).textContent(), /^Maya R\.maya@example\.com\(555\) 010-2030/, 'engineer email and phone');

  await page.getByRole('tab', { name: 'Hire requests' }).click();
  const pkgRow = page.locator('#ledger tbody tr', { hasText: 'Stripe payments' });
  assert.match(await pkgRow.textContent(), /Maya R\.Annann@example\.com\+1 555 987 6543Need Stripe payments added to my app\.\$400$/, `default columns; row was "${await pkgRow.textContent()}"`);
  // Columns menu: Work is opt-in; turning it on shows it and is remembered after a reload.
  assert.equal(await page.locator('#ledger th', { hasText: 'Work' }).count(), 0);
  await page.locator('#ledger summary', { hasText: 'Columns' }).click();
  await page.locator('#ledger .cols-list').getByLabel('Work').check();
  await page.locator('#ledger th', { hasText: 'Work' }).waitFor();
  assert.match(await pkgRow.textContent(), /Deploy your app with HTTPS/);
  await page.reload();
  await page.locator('#ledger th', { hasText: 'Work' }).waitFor();
  await page.locator('#ledger summary', { hasText: 'Columns' }).click();
  await page.locator('#ledger .cols-list').getByLabel('Work').uncheck();
  assert.equal(await page.locator('#ledger th', { hasText: 'Work' }).count(), 0);
  await page.getByRole('tab', { name: 'Clients' }).click();
  const ann = page.locator('#clients tbody tr', { hasText: 'ann@example.com' });
  assert.match(await ann.textContent(), /^AnnAnn@example\.com|^Ann.*ann@example\.com.*\+1 555 987 6543.*2/, 'client listed from requests, latest phone, request count');

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
  for (const t of ['Clients', 'Hire requests', 'Team']) assert.equal(await mo.page.getByRole('tab', { name: t }).isHidden(), true, t);
  assert.equal(await mo.page.locator('#roster').isVisible(), true, 'falls back to a tab the role may see');
  const row = mo.page.locator('#roster tr', { hasText: 'Maya R.' });
  assert.ok(!/maya@example\.com|010-2030/.test(await row.textContent()), 'moderators see no contact details');
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
  for (const tab of ['engineers']) {
    await page.locator(`[data-tab=${tab}]`).click();
    assert.equal(await noSideScroll(page), true, tab);
    await shot(page, 'phone-' + tab);
  }
  await done();
});

test('controls line up at phone, tablet and desktop widths (34px), with no sideways scroll even in a wide fallback font', async () => {
  // CI machines lack Carlito/Calibri; a wide fallback font (DejaVu Sans) must not push the page sideways either.
  for (const font of [null, '"DejaVu Sans"']) {
    const { page, done } = await open('/#engineers', { bypassCSP: !!font });
    if (font) await page.addStyleTag({ content: `body, button, input, select, textarea { font-family: ${font}, sans-serif !important; }` });
    for (const width of [375, 800, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const sel of ['#relink .row', '#profile .row', '#profile .pkg']) {
        const boxes = await page.locator(`${sel} :is(input, select, button)`).evaluateAll(els => els.filter(e => e.offsetParent).map(e => Math.round(e.getBoundingClientRect().height)));
        assert.ok(boxes.length && boxes.every(hgt => hgt === 34), `${sel} at ${width}px (${font ?? 'default font'}): heights ${boxes.join(', ')}`);
      }
      const over = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, window: innerWidth, wide: [...document.querySelectorAll('header *, main > :not(.tabs) *, footer')].filter(e => !e.closest('.tabs, .scroll') && e.getBoundingClientRect().right > innerWidth + 0.5).map(e => `${e.tagName.toLowerCase()}.${e.className} ends at ${Math.round(e.getBoundingClientRect().right)}`).slice(0, 5) }));
      assert.ok(over.page <= over.window, `sideways scroll at ${width}px (${font ?? 'default font'}): page ${over.page}px wide in a ${over.window}px window; too wide: ${over.wide.join('; ')}`);
    }
    await done();
  }
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
