// Every API route as a plain function: (body, { session }) → [status, json, sessionChange?].
// Pure ES module so the server and the in-browser demo run the same code; storage and password hashing are passed in.
// Roles: engineer and client (site accounts), owner/admin/moderator (staff, see PERMS). A session's role is re-read
// from storage on every request, so a removed or demoted staff member loses access at once.
import { pctAt, feeFor, FEE_PCT, PROMO_END } from '../public/fees.js';
import { JOB, CLIENT, CLIENT_EDIT, STAFF, PERMS, ROLES, int, validate, profileOf, password, quoteFor, directory, NEXT, CLIENT_NEXT } from './rules.js';

const newest = (a, b) => b.created.localeCompare(a.created);
const strip = ({ auth, ...r }) => r;
const AUTH = [401, { error: 'auth' }], DENIED = [403, { error: 'role' }], GONE = [404, { error: 'not found' }];
const norm = e => String(e ?? '').trim().toLowerCase();

export const makeApi = ({ store, hash, verify, adminLogin }) => {
  // Derived views are rebuilt only when the store changes (stores without a version, like test doubles, recompute each time).
  const memo = fn => { let at, val; return () => typeof store.version !== 'number' ? fn() : at === store.version ? val : (at = store.version, val = fn()); };
  const rec = (id, kind) => (id = store.get(id))?.kind === kind ? id : null;
  const emails = memo(() => new Map([...store.all('engineer'), ...store.all('client')].map(a => [a.email, a]))); // site emails are unique across both
  const account = email => emails().get(norm(email));
  const publicList = memo(() => directory(store.all('engineer')));
  const role = s => s?.role === 'owner' ? 'owner' : s && (s.role === 'staff' ? (rec(s.id, 'staff')?.removed ? null : rec(s.id, 'staff')?.role) : rec(s.id, s.role) && s.role);
  const pricing = () => ({ pct: pctAt(), feePct: FEE_PCT, promoEnd: PROMO_END });
  const can = (perm, fn) => (b, ctx) => { const r = role(ctx.session); return PERMS[r]?.includes(perm) ? fn(b, ctx) : PERMS[r] || r ? DENIED : AUTH; };
  const contact = id => { const a = store.get(id); return a ? { name: a.name, email: a.email } : { name: '(removed)', email: '' }; };

  const site = {
    'GET /api/engineers': () => [200, publicList()],
    'GET /api/pricing': () => [200, pricing()],

    'POST /api/engineers': async b => {
      const { data, error } = profileOf(b, true);
      if (error) return [400, { error }];
      // Hash first, then check and add with no await in between, so two sign-ups with one email can't both pass.
      const { password: pw, ...profile } = data, auth = await hash(pw);
      if (account(data.email)) return [409, { error: 'email-taken' }];
      const e = await store.add('engineer', { ...profile, hidden: false, auth });
      return [201, { role: 'engineer' }, { login: { role: 'engineer', id: e.id } }];
    },
    // verify always hashes, even for an unknown email, so timing doesn't reveal who has an account.
    'POST /api/login': async b => {
      const a = account(b.email);
      return (await verify(a?.auth, b.password)) && a ? [200, { role: a.kind }, { login: { role: a.kind, id: a.id } }] : AUTH;
    },
    'POST /api/logout': () => [200, { ok: true }, { logout: true }],

    // Hiring creates the client's account on the way if they aren't signed in.
    'POST /api/jobs': async (b, { session }) => {
      const r = role(session), e = rec(b.engineerId, 'engineer');
      if (r && r !== 'client') return DENIED;
      if (!e || e.hidden || !e.available) return [404, { error: 'engineer' }];
      const choice = quoteFor(e, b.choice, b.hours);
      if (!choice) return [400, { error: b.choice === 'hourly' ? 'hours' : 'choice' }];
      const job = validate(JOB, b);
      if (job.error) return [400, { error: job.error }];
      let client = r && store.get(session.id), change;
      if (!client) {
        const acct = validate(CLIENT, b);
        if (acct.error) return [400, { error: acct.error }];
        const auth = await hash(acct.data.password);
        if (account(acct.data.clientEmail)) return [409, { error: 'email-taken' }];
        client = await store.add('client', { name: acct.data.clientName, email: acct.data.clientEmail, auth });
        change = { login: { role: 'client', id: client.id } };
      }
      await store.add('job', { ...job.data, engineerId: e.id, clientId: client.id, choice, quote: choice.quote, pct: pctAt(), status: 'requested', amount: null, fee: null, payout: null, clientCheck: null });
      return [201, { engineer: { name: e.name, email: e.email, payWith: e.payWith, terms: e.terms }, quote: choice.quote }, change];
    },

    'GET /api/me': (b, { session }) => {
      const r = role(session), me = r && store.get(session.id), jobs = me && store.all('job').filter(j => j[`${r}Id`] === me.id).sort(newest);
      if (r === 'engineer') return [200, { role: r, profile: strip(me), jobs: jobs.map(j => ({ ...j, client: contact(j.clientId) })), pricing: pricing() }];
      if (r === 'client') return [200, { role: r, profile: strip(me), jobs: jobs.map(j => { const e = store.get(j.engineerId); return { ...j, engineer: e ? { name: e.name, email: e.email, payWith: e.payWith, terms: e.terms } : contact(null) }; }) }];
      return AUTH;
    },
    'POST /api/me': async (b, { session }) => {
      const r = role(session);
      if (r !== 'engineer' && r !== 'client') return AUTH;
      const { data, error } = r === 'engineer' ? profileOf(b, false) : validate(CLIENT_EDIT, b);
      if (error) return [400, { error }];
      const pw = b.password ? password(b.password) : null;
      if (pw === undefined) return [400, { error: 'password' }];
      await store.update(session.id, { ...data, ...(pw && { auth: await hash(pw) }) });
      return [200, { ok: true }];
    },
    // Engineers move a job through its statuses (the fee rate was locked at request time). Clients can cancel
    // a request before it's accepted, and confirm or dispute the final amount once it's complete.
    'POST /api/me/jobs': async ({ id, status, amount, check }, { session }) => {
      const r = role(session), j = rec(id, 'job');
      if (r !== 'engineer' && r !== 'client') return AUTH;
      if (!j || j[`${r}Id`] !== session.id) return GONE;
      if (r === 'client' && check) return j.status === 'complete' && !j.clientCheck && ['confirmed', 'disputed'].includes(check) ? [200, await store.update(id, { clientCheck: check })] : [409, { error: 'check' }];
      if (!(r === 'engineer' ? NEXT : CLIENT_NEXT)[j.status]?.includes(status)) return [409, { error: 'status' }];
      if (status !== 'complete') return [200, await store.update(id, { status })];
      const a = int(1, 1e7)(amount ?? j.quote);
      return a === undefined ? [400, { error: 'amount' }] : [200, await store.update(id, { status, ...feeFor(a, j.pct), completed: new Date(Date.now()).toISOString() })];
    },
  };

  const admin = {
    'POST /api/admin/login': async b => {
      const owner = await adminLogin(b.email, b.password), s = store.all('staff').find(x => x.email === norm(b.email) && !x.removed);
      if (owner === true) return [200, { role: 'owner' }, { login: { role: 'owner' } }];
      if (await verify(s?.auth, b.password) && s) return [200, { role: s.role }, { login: { role: 'staff', id: s.id } }];
      return owner === 'setup' ? [503, { error: 'setup' }] : AUTH;
    },
    'POST /api/admin/logout': () => [200, { ok: true }, { logout: true }],

    // Each part of the data is included only if the signed-in role has the permission for it.
    'GET /api/admin/data': (b, { session }) => {
      const r = role(session), perms = PERMS[r];
      if (!perms) return r ? DENIED : AUTH;
      const has = p => perms.includes(p), jobs = store.all('job').sort(newest), done = jobs.filter(j => j.status === 'complete');
      const count = jobs.reduce((m, j) => m.set(j.engineerId, (m.get(j.engineerId) ?? 0) + 1).set(j.clientId, (m.get(j.clientId) ?? 0) + 1), new Map());
      const people = list => list.sort(newest).map(a => ({ ...strip(a), jobs: count.get(a.id) ?? 0 }));
      return [200, {
        me: { role: r, perms },
        engineers: people(store.all('engineer')),
        ...(has('accounts') && { clients: people(store.all('client')) }),
        ...(has('money') && {
          jobs: jobs.map(j => ({ ...j, engineer: contact(j.engineerId).name, client: contact(j.clientId) })),
          totals: { requested: jobs.length, completed: done.length, billed: done.reduce((s, j) => s + j.amount, 0), fees: Math.round(done.reduce((s, j) => s + j.fee, 0) * 100) / 100, disputed: jobs.filter(j => j.clientCheck === 'disputed').length },
        }),
        ...(has('staff') && { staff: store.all('staff').filter(s => !s.removed).sort(newest).map(strip) }),
        pricing: pricing(),
      }];
    },
    'POST /api/admin/hide': can('moderate', async ({ id, hidden }) => !rec(id, 'engineer') ? GONE : typeof hidden !== 'boolean' ? [400, { error: 'hidden' }] : [200, strip(await store.update(id, { hidden }))]),
    // No email yet, so a forgotten password is fixed by staff setting a temporary one.
    'POST /api/admin/password': can('accounts', async ({ id, password: pw }) => {
      const a = rec(id, 'engineer') ?? rec(id, 'client');
      if (!a) return GONE;
      return password(pw) ? (await store.update(id, { auth: await hash(pw) }), [200, { ok: true }]) : [400, { error: 'password' }];
    }),
    'POST /api/admin/staff': can('staff', async b => {
      const { data, error } = validate(STAFF, b);
      if (error) return [400, { error }];
      const { password: pw, ...rest } = data, auth = await hash(pw);
      if (store.all('staff').some(s => s.email === data.email && !s.removed)) return [409, { error: 'email-taken' }];
      return [201, strip(await store.add('staff', { ...rest, removed: false, auth }))];
    }),
    'POST /api/admin/staff/role': can('staff', async ({ id, role: to }) => {
      const s = rec(id, 'staff');
      return !s || s.removed ? GONE : ROLES.includes(to) ? [200, strip(await store.update(id, { role: to }))] : [400, { error: 'role' }];
    }),
    'POST /api/admin/staff/remove': can('staff', async ({ id }) => {
      const s = rec(id, 'staff');
      return !s || s.removed ? GONE : [200, strip(await store.update(id, { removed: true }))];
    }),
  };
  return { ...site, ...admin };
};
