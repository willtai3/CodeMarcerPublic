import { $, $$, h, api, tabs, date } from './ui.js';
import { usd } from './fees.js';

const status = (t = '', err = false) => { $('#status').className = 'msg' + (err ? ' error' : ''); $('#status').textContent = t; };
const a = (href, text) => h('a', { href, textContent: text, rel: 'noopener noreferrer', target: '_blank' });
const small = (label, onclick) => h('button', { className: 'small', type: 'button', textContent: label, onclick });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const table = (heads, rows, empty) => rows.length
  ? h('div', { className: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, heads.map(t => h('th', { textContent: t })))), h('tbody', {}, rows.map(cells => h('tr', {}, cells.map(c => h('td', {}, c)))))))
  : h('p', { className: 'empty', textContent: empty });
const STATUS = { requested: 'New request', accepted: 'Accepted', paid: 'Paid', complete: 'Complete', declined: 'Declined', cancelled: 'Cancelled' };
const CHECK = { confirmed: 'Confirmed', disputed: 'Disputed' };
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
const contactCell = (p, extra) => [h('strong', { textContent: p.name }), h('br'), h('span', { className: 'select', textContent: p.email }), extra];

const render = ({ me, engineers, clients, jobs, totals, staff }) => {
  const has = p => me.perms.includes(p);
  for (const b of $$('#app [data-perm]')) b.hidden = !has(b.dataset.perm);
  if ($(`#app [data-tab="${location.hash.slice(1)}"]`)?.hidden !== false) showTab($('#app [data-tab]:not([hidden])').dataset.tab);
  $('#summary').textContent = `Signed in as ${ROLE[me.role]}. ${plural(engineers.length, 'engineer')} listed.` + (totals ? ` ${plural(totals.requested, 'job request')}, ${totals.completed} completed for ${usd(totals.billed)}. Fees owed: ${usd(totals.fees)}.${totals.disputed ? ` ${plural(totals.disputed, 'dispute')} to follow up.` : ''}` : '');

  $('#roster').replaceChildren(table(['Engineer', 'Skills', 'Pricing', 'Jobs', 'Joined', 'Listing', ...(has('accounts') ? ['Account'] : [])], engineers.map(e => [
    contactCell(e, [h('p', { className: 'meta', textContent: e.headline }), e.portfolio && a(e.portfolio, 'Portfolio')]),
    e.skills.join(', '),
    [e.rate ? `${usd(e.rate)}/hour` : 'No hourly rate', h('br'), plural(e.packages.length, 'package'), h('p', { className: 'meta', textContent: `Paid by ${e.payWith}` })],
    String(e.jobs), date(e.created),
    h('span', { className: 'inline' }, e.hidden ? 'Hidden' : e.available ? 'Live' : 'Live, not taking work', small(e.hidden ? 'Show' : 'Hide', act('/api/admin/hide', { id: e.id, hidden: !e.hidden }, `${e.name} is now ${e.hidden ? 'shown' : 'hidden'} on the site.`))),
    ...(has('accounts') ? [setPassword(e)] : []),
  ]), 'No engineers yet.'));

  if (clients) $('#clients').replaceChildren(table(['Client', 'Requests', 'Joined', 'Account'], clients.map(c => [contactCell(c), String(c.jobs), date(c.created), setPassword(c)]), 'No clients yet.'));

  if (jobs) $('#ledger').replaceChildren(table(['Requested', 'Engineer', 'Client', 'Work', 'Quote', 'Status', 'Final amount', 'Fee', 'Client check'], jobs.map(j => [
    date(j.created), j.engineer, contactCell(j.client),
    j.choice.type === 'hourly' ? `${j.choice.hours} hours at ${usd(j.choice.rate)}/hour` : j.choice.title,
    usd(j.quote), STATUS[j.status], j.amount == null ? '' : usd(j.amount), j.fee == null ? (j.pct ? `${j.pct}% when complete` : 'Free') : usd(j.fee),
    j.clientCheck ? h('span', { className: `status ${j.clientCheck === 'disputed' ? 's-requested' : 's-complete'}`, textContent: CHECK[j.clientCheck] }) : '',
  ]), 'No job requests yet.'));

  if (staff) {
    const form = h('form', { className: 'row team-add', noValidate: true },
      h('label', {}, 'Name', h('input', { name: 'name', maxLength: 80 })),
      h('label', {}, 'Email', h('input', { name: 'email', type: 'email', maxLength: 120 })),
      h('label', {}, 'Temporary password', h('input', { name: 'password', type: 'text', maxLength: 200, autocomplete: 'off', placeholder: '10+ characters' })),
      h('label', {}, 'Role', h('select', { name: 'role' }, h('option', { value: 'moderator', textContent: 'Moderator: hide and show engineers' }), h('option', { value: 'admin', textContent: 'Admin: also clients, jobs and passwords' }))),
      h('button', { className: 'primary', textContent: 'Add to team' }));
    form.onsubmit = e => { e.preventDefault(); act('/api/admin/staff', Object.fromEntries(new FormData(form)), `${form.elements.name.value} added. Give them the temporary password; they sign in here.`)({ currentTarget: form.querySelector('button') }); };
    $('#team').replaceChildren(
      h('p', { textContent: 'You are the owner: the account made with npm run admin. Team members sign in on this page with their own email and password.' }),
      table(['Member', 'Role', 'Added', ''], staff.map(s => [contactCell(s),
        h('select', { ariaLabel: `Role for ${s.name}`, onchange: e => act('/api/admin/staff/role', { id: s.id, role: e.target.value }, `${s.name} is now ${ROLE[e.target.value].toLowerCase()}.`)({ currentTarget: e.target }) },
          ['admin', 'moderator'].map(r => h('option', { value: r, textContent: ROLE[r], selected: r === s.role }))),
        date(s.created), small('Remove', act('/api/admin/staff/remove', { id: s.id }, `${s.name} removed. They are signed out everywhere.`))]), 'No team members yet.'),
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
  catch (err) { msg.className = 'msg error'; msg.textContent = err.status === 429 ? 'Too many attempts. Wait 15 minutes.' : err.status === 401 ? 'Wrong email or password.' : err.status === 503 ? 'No owner account yet. Run npm run admin on the server first.' : "Couldn't reach the server."; }
});
$('#logout').addEventListener('click', async () => { await api('/api/admin/logout', {}).catch(() => {}); signedOut(); });
const showTab = tabs($('#app .tabs'));
load().then(signedIn, () => {});
