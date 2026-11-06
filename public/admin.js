import { $, $$, h, api, tabs, date } from './ui.js';
import { usd } from './fees.js';

const status = (t = '', err = false) => { $('#status').className = 'msg' + (err ? ' error' : ''); $('#status').textContent = t; };
const a = (href, text) => h('a', { href, textContent: text, rel: 'noopener noreferrer', target: '_blank' });
const small = (label, onclick) => h('button', { className: 'small', type: 'button', textContent: label, onclick });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const table = (heads, rows, empty) => rows.length
  ? h('div', { className: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, heads.map(t => h('th', { textContent: t })))), h('tbody', {}, rows.map(cells => h('tr', {}, cells.map(c => h('td', {}, c)))))))
  : h('p', { className: 'empty', textContent: empty });
const TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

// Column choices are a per-viewer convenience kept in this browser; the page works the same without storage.
const saved = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const ROWS = 100;
// A list table: the key columns always show; the rest are opt-in through its Columns menu (remembered).
// Rows are drawn 100 at a time; "Show more" appends, so nothing already on screen is redrawn.
const list = (name, cols, items, empty) => {
  if (!items.length) return h('p', { className: 'empty', textContent: empty });
  const key = `cols:${name}`, on = new Set(saved(key, cols.filter(c => c.always || c.on).map(c => c.label)));
  const shown = cols.filter(c => c.always || on.has(c.label)), body = h('tbody'), wrap = h('div');
  let drawn = 0;
  const more = () => { const rest = items.length - drawn; return rest > 0 ? h('button', { className: 'quiet more-rows', type: 'button', textContent: `Show ${Math.min(rest, ROWS)} more of ${rest}`, onclick: e => { e.currentTarget.remove(); page(); } }) : null; };
  const page = () => { body.append(...items.slice(drawn, drawn += ROWS).map(it => h('tr', {}, shown.map(c => h('td', {}, c.cell(it)))))); const m = more(); m && wrap.append(m); };
  const menu = h('details', { className: 'cols' }, h('summary', { className: 'small', textContent: 'Columns' }),
    h('div', { className: 'cols-list' }, cols.filter(c => !c.always).map(c => h('label', { className: 'check' },
      h('input', { type: 'checkbox', checked: on.has(c.label), onchange: e => { e.target.checked ? on.add(c.label) : on.delete(c.label); save(key, [...on]); wrap.replaceWith(list(name, cols, items, empty)); } }), c.label))));
  wrap.append(h('div', { className: 'cols-bar' }, menu), h('div', { className: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, shown.map(c => h('th', { textContent: c.label })))), body)));
  page();
  return wrap;
};
const STATUS = { requested: 'New request', accepted: 'Accepted', paid: 'Paid', complete: 'Complete', declined: 'Declined' };
const ROLE = { owner: 'Owner', admin: 'Admin', moderator: 'Moderator' };

// One code path for every admin action: send, then redraw from fresh data; failures are named.
const act = (path, body, done) => async e => {
  const btn = e.currentTarget; btn.disabled = true;
  try { await api(path, typeof body === 'function' ? body() : body); await load(); status(done); }
  catch (err) { err.status === 401 ? signedOut() : status(`Couldn't save: ${{ password: 'use 10 to 200 characters for the password', 'email-taken': 'that email is already on the team', role: 'your role does not allow this' }[err.message] ?? err.message}.`, true); btn.disabled = false; }
};
// "Set password" opens an inline field; staff hand the temporary password to the person themselves.
const setPassword = who => {
  const slot = h('span', { className: 'inline' });
  const open = () => { const pw = h('input', { type: 'text', ariaLabel: `New password for ${who.name}`, placeholder: '10+ characters', autocomplete: 'off' }); slot.replaceChildren(pw, small('Save', act('/api/admin/password', () => ({ id: who.id, password: pw.value }), `New password set for ${who.name}. Give it to them directly.`)), small('Cancel', draw)); pw.focus(); };
  const draw = () => slot.replaceChildren(small('Set password', open));
  draw(); return slot;
};
// Removing a member: a trash-can button, then a confirm step in place.
const removeMember = s => {
  const slot = h('span', { className: 'inline' });
  const draw = () => slot.replaceChildren(h('button', { className: 'icon', type: 'button', ariaLabel: `Remove ${s.name}`, title: `Remove ${s.name}`, innerHTML: TRASH, onclick: confirm }));
  const confirm = () => { slot.replaceChildren(h('span', { textContent: `Remove ${s.name}?` }), h('button', { className: 'small danger', type: 'button', textContent: 'Remove', onclick: act('/api/admin/staff/remove', { id: s.id }, `${s.name} removed. They are signed out everywhere.`) }), small('Cancel', draw)); $('.danger', slot).focus(); };
  draw(); return slot;
};
const contactCell = (p, extra) => [h('strong', { textContent: p.name }), h('br'), h('span', { className: 'select', textContent: p.email }), extra];

const render = ({ me, engineers, clients, jobs, totals, staff }) => {
  const has = p => me.perms.includes(p);
  for (const b of $$('#app [data-perm]')) b.hidden = !has(b.dataset.perm);
  if ($(`#app [data-tab="${location.hash.slice(1)}"]`)?.hidden !== false) showTab($('#app [data-tab]:not([hidden])').dataset.tab);
  $('#summary').textContent = `Signed in as ${ROLE[me.role]}. ${plural(engineers.length, 'engineer')} listed.` + (totals ? ` ${plural(totals.requested, 'job request')}, ${totals.completed} completed for ${usd(totals.billed)}. Fees owed: ${usd(totals.fees)}.` : '');

  $('#roster').replaceChildren(list('engineers', [
    { label: 'Engineer', always: true, cell: e => contactCell(e, h('p', { className: 'meta', textContent: e.headline })) },
    { label: 'Listing', always: true, cell: e => h('span', { className: 'inline' }, e.hidden ? 'Hidden' : e.available ? 'Live' : 'Live, not taking work', small(e.hidden ? 'Show' : 'Hide', act('/api/admin/hide', { id: e.id, hidden: !e.hidden }, `${e.name} is now ${e.hidden ? 'shown' : 'hidden'} on the site.`))) },
    { label: 'Skills', on: true, cell: e => e.skills.join(', ') },
    { label: 'Pricing', cell: e => [e.rate ? `${usd(e.rate)}/hour` : 'No hourly rate', h('br'), plural(e.packages.length, 'package'), e.payWith && h('p', { className: 'meta', textContent: `Paid by ${e.payWith}` })] },
    { label: 'Jobs', cell: e => String(e.jobs) },
    { label: 'Portfolio', cell: e => e.portfolio ? a(e.portfolio, 'Portfolio') : '' },
    { label: 'Joined', cell: e => date(e.created) },
    ...(has('accounts') ? [{ label: 'Account', cell: setPassword }] : []),
  ], engineers, 'No engineers yet.'));

  // Clients have no accounts: this is everyone who has sent a request, by email, with their latest name and phone.
  if (clients) $('#clients').replaceChildren(list('clients', [
    { label: 'Client', always: true, cell: c => contactCell(c, [h('br'), h('span', { className: 'select', textContent: c.phone })]) },
    { label: 'Requests', on: true, cell: c => String(c.jobs) },
    { label: 'Last request', on: true, cell: c => date(c.last) },
    { label: 'First request', cell: c => date(c.created) },
  ], clients, 'No requests yet.'));

  if (jobs) $('#ledger').replaceChildren(list('jobs', [
    { label: 'Requested', always: true, cell: j => date(j.created) },
    { label: 'Engineer', always: true, cell: j => j.engineer },
    { label: 'Client', always: true, cell: j => contactCell({ name: j.clientName, email: j.clientEmail }, [h('br'), h('span', { className: 'select', textContent: j.clientPhone })]) },
    { label: 'Status', always: true, cell: j => STATUS[j.status] },
    { label: 'What they need', cell: j => h('p', { className: 'about', textContent: j.details }) },
    { label: 'Work', cell: j => j.choice.type === 'hourly' ? `${j.choice.hours} hours at ${usd(j.choice.rate)}/hour` : j.choice.title },
    { label: 'Quote', cell: j => usd(j.quote) },
    { label: 'Final amount', on: true, cell: j => j.amount == null ? '' : usd(j.amount) },
    { label: 'Fee', on: true, cell: j => j.fee == null ? (j.pct ? `${j.pct}% when complete` : 'Free') : usd(j.fee) },
  ], jobs, 'No job requests yet.'));

  if (staff) {
    const form = h('form', { className: 'row team-add', noValidate: true },
      h('label', {}, 'Name', h('input', { name: 'name', maxLength: 80 })),
      h('label', {}, 'Email', h('input', { name: 'email', type: 'email', maxLength: 120 })),
      h('label', {}, 'Temporary password', h('input', { name: 'password', type: 'text', maxLength: 200, autocomplete: 'off', placeholder: '10+ characters' })),
      h('label', {}, 'Role', h('select', { name: 'role' }, h('option', { value: 'moderator', textContent: 'Moderator: hide and show engineers' }), h('option', { value: 'admin', textContent: 'Admin: also clients, jobs and engineer passwords' }))),
      h('button', { className: 'primary', textContent: 'Add to team' }));
    form.onsubmit = e => { e.preventDefault(); act('/api/admin/staff', Object.fromEntries(new FormData(form)), `${form.elements.name.value} added. Give them the temporary password; they sign in here.`)({ currentTarget: form.querySelector('button') }); };
    $('#team').replaceChildren(
      h('p', { textContent: 'You are the owner: the account made with npm run admin. Team members sign in on this page with their own email and password.' }),
      table(['Member', 'Role', 'Added', ''], staff.map(s => [contactCell(s),
        h('select', { ariaLabel: `Role for ${s.name}`, onchange: e => act('/api/admin/staff/role', { id: s.id, role: e.target.value }, `${s.name} is now ${ROLE[e.target.value].toLowerCase()}.`)({ currentTarget: e.target }) },
          ['admin', 'moderator'].map(r => h('option', { value: r, textContent: ROLE[r], selected: r === s.role }))),
        date(s.created), removeMember(s)]), 'No team members yet.'),
      form);
  }
};

const load = async () => render(await api('/api/admin/data'));
const signedIn = () => { $('#login').hidden = true; $('#app').hidden = $('#logout').hidden = false; };
const signedOut = () => { $('#login').hidden = false; $('#app').hidden = $('#logout').hidden = true; $('.msg', $('#login')).textContent = 'Signed out. Sign in again.'; };

$('#login').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('.msg', e.target), f = e.target.elements;
  try { await api('/api/admin/login', { email: f.email.value, password: f.password.value }); e.target.reset(); msg.textContent = ''; await load(); signedIn(); }
  catch (err) { msg.className = 'msg error'; msg.textContent = err.status === 429 ? 'Too many attempts. Wait 15 minutes.' : err.status === 401 ? 'Wrong email or password.' : err.message === 'setup' ? 'No owner account yet. Run npm run admin on the server first.' : err.status === 503 ? 'The server is busy. Try again in a moment.' : "Couldn't reach the server."; }
});
$('#logout').addEventListener('click', async () => { await api('/api/admin/logout', {}).catch(() => {}); signedOut(); });
const showTab = tabs($('#app .tabs'));
load().then(signedIn, () => {});
