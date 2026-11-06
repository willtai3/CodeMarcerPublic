// The page's own fee rules (public/fees.js). The server's copy is tested in logic_test.go, which also checks the two match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pctAt, feeFor, PROMO_END, FEE_PCT, usd } from '../public/fees.js';

test('fees on the page: free through Jan 31 2027 Pacific, FEE_PCT from Feb 1 2027 00:00 PST', () => {
  assert.equal(pctAt(Date.parse('2026-11-01T12:00:00Z')), 0);
  assert.equal(pctAt(Date.parse('2027-01-31T23:59:59-08:00')), 0);
  assert.equal(pctAt(Date.parse('2027-02-01T00:00:00-08:00')), FEE_PCT);
  assert.equal(PROMO_END, Date.parse('2027-02-01T08:00:00Z'));
  assert.deepEqual(feeFor(5000, 10), { amount: 5000, pct: 10, fee: 500, payout: 4500 });
  assert.deepEqual(feeFor(1234, 10), { amount: 1234, pct: 10, fee: 123.4, payout: 1110.6 });
  assert.equal(usd(4500), '$4,500');
  assert.equal(usd(null), 'Open to quotes');
});
