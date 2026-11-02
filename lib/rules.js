// Validation, quotes and public views. Pure ES module: shared by the server and the in-browser demo.

const ALIAS = { 'node.js': 'node', nodejs: 'node', 'react.js': 'react', reactjs: 'react', nextjs: 'next.js', next: 'next.js', postgresql: 'postgres', js: 'javascript', ts: 'typescript', 'react-native': 'react native' };
export const tags = v => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(',')).map(t => String(t).trim().toLowerCase().replace(/\s+/g, ' ')).filter(t => t && t.length <= 30).map(t => ALIAS[t] ?? t))].slice(0, 12);

export const TERMS = ['Upfront', 'Half upfront, half on completion', 'On completion', 'Discuss with client'];
const str = (min, max) => v => typeof v === 'string' && (v = v.trim()).length >= min && v.length <= max ? v : undefined;
const opt = f => v => (typeof v === 'string' ? v.trim() : v ?? '') !== '' ? f(v) : null;
export const int = (min, max) => v => (v = typeof v === 'string' ? v.trim().replace(/[$,]/g, '') : v) !== '' && v != null && Number.isInteger(+v) && +v >= min && +v <= max ? +v : undefined;
const email = v => (v = str(3, 120)(v)) && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v.toLowerCase() : undefined;
const link = v => (v = str(9, 200)(v)) && /^https:\/\/[^\s<>"]+$/i.test(v) ? v : undefined;
const bool = v => typeof v === 'boolean' ? v : undefined;
export const password = v => typeof v === 'string' && v.length >= 10 && v.length <= 200 ? v : undefined;

export const validate = (spec, body) => { const data = {}; for (const [k, f] of Object.entries(spec)) if ((data[k] = f(body?.[k])) === undefined) return { error: k }; return { data }; };

const PKG = { title: str(3, 60), price: int(25, 100000), days: int(1, 90), details: opt(str(1, 300)) };
const packages = v => { if (v == null || v === '') return []; if (!Array.isArray(v) || v.length > 5) return; const out = v.map(p => validate(PKG, p).data); return out.includes(undefined) ? undefined : out; };

const PROFILE = { name: str(1, 80), headline: str(5, 80), skills: v => (v = tags(v)).length ? v : undefined, rate: opt(int(10, 1000)), packages, payWith: str(3, 200), terms: v => TERMS.includes(v) ? v : undefined, portfolio: opt(link), about: opt(str(1, 1000)), available: bool };
const SIGNUP = { name: PROFILE.name, email, password, ...PROFILE };
export const JOB = { details: str(10, 2000), link: opt(link) };
export const CLIENT = { clientName: str(1, 80), clientEmail: email, password };
export const CLIENT_EDIT = { name: str(1, 80) };
export const ROLES = ['admin', 'moderator'];
export const STAFF = { name: str(1, 80), email, password, role: v => ROLES.includes(v) ? v : undefined };

// What each staff role may do. The owner is the account made with `npm run admin`.
export const PERMS = { owner: ['moderate', 'accounts', 'money', 'staff'], admin: ['moderate', 'accounts', 'money'], moderator: ['moderate'] };

// A profile needs an hourly rate, at least one package, or both.
export const profileOf = (body, signup) => { const r = validate(signup ? SIGNUP : PROFILE, body); return !r.error && r.data.rate == null && !r.data.packages.length ? { error: 'pricing' } : r; };

// What the client picked: "p0".."p4" for a package, or "hourly" with an hour estimate.
export const quoteFor = (e, choice, hours) => {
  if (choice === 'hourly') { const h = int(1, 500)(hours); return e.rate && h ? { type: 'hourly', hours: h, rate: e.rate, quote: h * e.rate } : undefined; }
  const p = e.packages[/^p([0-4])$/.exec(choice ?? '')?.[1]];
  return p && { type: 'package', title: p.title, days: p.days, quote: p.price };
};

// Jobs move forward only: the engineer accepts or declines, then marks paid and complete; the client can cancel before it's accepted.
export const NEXT = { requested: ['accepted', 'declined'], accepted: ['paid', 'complete', 'declined'], paid: ['complete'] };
export const CLIENT_NEXT = { requested: ['cancelled'] };

export const publicProfile = ({ id, name, headline, skills, rate, packages, terms, portfolio, about, available, created }) => ({ id, name, headline, skills, rate, packages, terms, portfolio, about, available, created });
export const directory = engineers => engineers.filter(e => !e.hidden).map(publicProfile).sort((a, b) => b.available - a.available || b.created.localeCompare(a.created));
