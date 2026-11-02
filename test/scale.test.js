// Scale: 5,000 listed engineers. Times the real server and page against fixed limits (twice as long on CI).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { start } from './helpers.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const N = 5000, SLOW = process.env.CI ? 2 : 1, SKILLS = ['react', 'next.js', 'node', 'python', 'supabase', 'stripe', 'aws', 'swift', 'flutter', 'postgres'];
let srv, browser;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codemarcer-scale-'));
  const engineers = Array.from({ length: N }, (_, i) => ({
    id: randomUUID(), kind: 'engineer', created: new Date(Date.UTC(2026, 0, 1) + i * 6e4).toISOString(),
    name: `Engineer ${i}`, email: `e${i}@example.com`, headline: `Builds and fixes apps, number ${i}`,
    skills: [SKILLS[i % 10], SKILLS[(i * 7) % 10], ...(i % 1000 === 7 ? ['quokkajs'] : [])], rate: 50 + (i % 150),
    packages: [{ title: 'Deploy your app with HTTPS', price: 300 + (i % 500), days: 5, details: null }],
    payWith: 'Venmo @someone', terms: 'Upfront', portfolio: null, about: null, available: true, hidden: false, auth: { salt: '00', hash: '00' },
  }));
  await writeFile(join(dir, 'store.json'), JSON.stringify(engineers));
  srv = await start({}, dir);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await srv?.stop(); });

const timed = async fn => { const t = performance.now(); const r = await fn(); return [performance.now() - t, r]; };

test(`API: the public list of ${N} engineers is answered from cache`, async t => {
  await fetch(srv.base + '/api/engineers'); // first call builds the list
  const [ms, body] = await timed(async () => (await fetch(srv.base + '/api/engineers')).text());
  const list = JSON.parse(body);
  assert.equal(list.length, N);
  t.diagnostic(`cached list: ${ms.toFixed(0)} ms, ${(body.length / 1e6).toFixed(2)} MB`);
  assert.ok(ms < 150 * SLOW, `cached list took ${ms.toFixed(0)} ms for ${(body.length / 1e6).toFixed(2)} MB (limit ${150 * SLOW} ms)`);
});

test('page: first cards, search and "Show more" stay fast, and an open hire form survives paging', async t => {
  const page = await browser.newPage();
  const [loadMs] = await timed(async () => { await page.goto(srv.base + '/#find'); await page.locator('.card').first().waitFor(); });
  assert.ok(loadMs < 3000 * SLOW, `first card after ${loadMs.toFixed(0)} ms (limit ${3000 * SLOW})`);
  assert.equal(await page.locator('.card').count(), 50, 'only the first page is drawn');
  assert.equal(await page.locator('.more button').textContent(), `Show 50 more of ${N - 50}`);

  const [searchMs] = await timed(async () => { await page.locator('#q').fill('quokkajs'); await page.waitForFunction(() => document.querySelectorAll('.card').length === 5); });
  assert.ok(searchMs < 500 * SLOW, `search over ${N} took ${searchMs.toFixed(0)} ms (limit ${500 * SLOW})`);
  assert.equal(await page.locator('.more').count(), 0);

  await page.locator('#q').fill('');
  await page.locator('.card').first().getByRole('button', { name: 'Hire by the hour' }).click();
  const [moreMs] = await timed(async () => { await page.locator('.more button').click(); await page.waitForFunction(() => document.querySelectorAll('.card').length === 100); });
  assert.ok(moreMs < 500 * SLOW, `"Show more" took ${moreMs.toFixed(0)} ms (limit ${500 * SLOW})`);
  assert.equal(await page.locator('form.hire').count(), 1, 'open hire form kept when more cards are added');
  t.diagnostic(`first card ${loadMs.toFixed(0)} ms, search ${searchMs.toFixed(0)} ms, show more ${moreMs.toFixed(0)} ms`);
  await page.close();
});
