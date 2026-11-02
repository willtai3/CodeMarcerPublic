// One place for the fee rules, used by the server and the page.
// Free for anything introduced before Feb 1, 2027 00:00 Pacific (PST = UTC-8); after that FEE_PCT of the agreed amount.
export const PROMO_END = Date.UTC(2027, 1, 1, 8), FEE_PCT = 10;
export const pctAt = (t = Date.now()) => (t < PROMO_END ? 0 : FEE_PCT);
export const feeFor = (amount, pct) => { const fee = Math.round(amount * pct) / 100; return { amount, pct, fee, payout: Math.round((amount - fee) * 100) / 100 }; };
export const usd = n => n == null ? 'Open to quotes' : '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
export const PROMO_LABEL = 'February 1, 2027';
