// Scale (admin): 5,000 engineers in the admin Engineers table, drawn 100 rows at a time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { start, ADMIN } from './helpers.js';
import { setAdmin } from '../lib/auth.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const N = 5000, SLOW = process.env.CI ? 2 : 1;
let srv, browser;
const timed = async fn => { const t = performance.now(); const r = await fn(); return [performance.now() - t, r]; };

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codemarcer-admin-scale-'));
  await writeFile(join(dir, 'store.json'), JSON.stringify(Array.from({ length: N }, (_, i) => ({
    id: randomUUID(), kind: 'engineer', created: new Date(Date.UTC(2026, 0, 1) + i * 6e4).toISOString(),
    name: `Engineer ${i}`, email: `e${i}@example.com`, headline: `Builds and fixes apps, number ${i}`, skills: ['react'], rate: 100,
    packages: [], payWith: 'Venmo @someone', terms: 'Upfront', portfolio: null, about: null, available: true, hidden: false, auth: { salt: '00', hash: '00' },
  }))));
  await setAdmin(dir, ADMIN.email, ADMIN.password);
  srv = await start({}, dir);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await srv?.stop(); });

test('admin: engineers table draws 100 rows at a time', async t => {
  const page = await browser.newPage();
  const [ms] = await timed(async () => {
    await page.goto(srv.base + '/admin');
    await page.getByLabel('Email').fill(ADMIN.email); await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('#roster tbody tr').first().waitFor();
  });
  assert.equal(await page.locator('#roster tbody tr').count(), 100, 'first 100 rows only');
  assert.equal(await page.locator('#roster .more-rows').textContent(), `Show 100 more of ${N - 100}`);
  const [moreMs] = await timed(async () => { await page.locator('#roster .more-rows').click(); await page.waitForFunction(() => document.querySelectorAll('#roster tbody tr').length === 200); });
  t.diagnostic(`admin sign-in to first rows ${ms.toFixed(0)} ms, next 100 rows ${moreMs.toFixed(0)} ms`);
  assert.ok(ms < 3000 * SLOW && moreMs < 500 * SLOW, `admin ${ms.toFixed(0)} ms, more ${moreMs.toFixed(0)} ms (limits ${3000 * SLOW}, ${500 * SLOW})`);
  await page.close();
});
