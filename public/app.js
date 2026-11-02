import { $, $$, h, api, tabs, date } from './ui.js';
import { pctAt, feeFor, usd, FEE_PCT, PROMO_LABEL } from './fees.js';

// ---- Pricing ----
const free = pctAt() === 0;
$('#promo').textContent = free ? `Free until ${PROMO_LABEL}` : `${FEE_PCT}% fee`;
$('#price-now').textContent = free ? `No fee on any job requested before ${PROMO_LABEL}.` : `${FEE_PCT}% of each completed job.`;
$('#price-rule').textContent = `From ${PROMO_LABEL}, engineers pay ${FEE_PCT}% of each completed job's amount, billed monthly. Clients pay nothing extra.`;
const calc = () => {
  const a = +$('#amount').value.replace(/\D/g, '') || 0, now = feeFor(a, pctAt()), later = feeFor(a, FEE_PCT);
  $('#calc-out').textContent = free
    ? `Requested now: fee ${usd(now.fee)}, engineer keeps ${usd(now.payout)}. Requested from ${PROMO_LABEL}: fee ${usd(later.fee)}, engineer keeps ${usd(later.payout)}.`
    : `Fee ${usd(now.fee)}, engineer keeps ${usd(now.payout)}.`;
};
$('#amount').addEventListener('input', calc); calc();

// ---- Shared form helpers ----
const MSG = {
  rate: 'Too many attempts from this connection. Try again later.', request: 'That request was refused. Reload the page and try again.',
  pricing: 'Add an hourly rate or at least one package.', 'email-taken': 'That email already has an account. Sign in on Your requests or For engineers first.',
  password: 'Use a password of 10 to 200 characters.', auth: 'Wrong email or password.', role: 'Sign out of your engineer account to hire as a client.', engineer: 'This engineer is no longer taking requests.', packages: 'Check each package: a title, a price of at least $25 and 1 to 90 days.', choice: 'That package is no longer offered. Reload the page.',
};
const labelOf = el => el?.closest('label')?.firstChild.textContent.split(/,| \(/)[0].trim().toLowerCase().replace(/^your /, '');
const fail = (form, err) => {
  const field = form.elements[err.field] ?? (err.field === 'password' && form.elements.newPassword);
  if (field?.focus) field.setAttribute('aria-invalid', 'true'), field.focus();
  const m = $('.msg', form); m.className = 'msg error';
  m.textContent = MSG[err.field] ?? (field?.focus ? `Check the ${labelOf(field)}.` : "Couldn't send. Check your connection and try again; nothing was lost.");
};
// Runs a form's submit: clears old errors, disables the button while sending, reports failures in the form.
const onSubmit = (form, send) => form.addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('button.primary', form), m = $('.msg', form);
  $$('[aria-invalid]', form).forEach(el => el.removeAttribute('aria-invalid'));
  btn.disabled = true; m.className = 'msg'; m.textContent = 'Sending';
  try { await send(); m.textContent = ''; } catch (err) { fail(form, err); } finally { btn.disabled = false; }
});
const sentence = s => s.replace(/\.$/, '') + '.'; // "Maya R." doesn't end up with two dots
const fields = form => Object.fromEntries([...new FormData(form)].filter(([k]) => !k.startsWith('pkg-')));

// ---- Find an engineer ----
// Search runs over one prepared text per engineer; only the first PAGE matches are drawn, more on request.
const PAGE = 50;
let engineers = [], index = [], lastList, matches = [], limit = PAGE;
const words = () => $('#q').value.toLowerCase().split(/[,\s]+/).filter(Boolean);
// "Show more" appends the next page under the cards already drawn, so an open hire form stays open.
const moreRow = () => { const rest = matches.length - limit; return rest > 0 ? [h('li', { className: 'more' }, h('button', { className: 'quiet', type: 'button', textContent: `Show ${Math.min(rest, PAGE)} more of ${rest}`, onclick: e => { e.currentTarget.closest('li').remove(); $('#list').append(...matches.slice(limit, limit += PAGE).map(card), ...moreRow()); } }))] : []; };
const renderList = () => {
  const q = words();
  matches = q.length ? engineers.filter((e, i) => q.every(w => index[i].includes(w))) : engineers; limit = PAGE;
  $('#list').replaceChildren(...matches.slice(0, limit).map(card), ...moreRow(),
    ...(matches.length ? [] : [h('li', { className: 'empty', textContent: engineers.length ? 'No engineers match that search.' : 'No engineers listed yet.' })]));
};
const loadList = async () => {
  try {
    const next = await api('/api/engineers'), key = JSON.stringify(next);
    if (key === lastList) return; // unchanged: keep the cards (and any open hire form) as they are
    lastList = key; engineers = next; index = engineers.map(e => [e.name, e.headline, ...e.skills].join(' ').toLowerCase()); renderList();
  }
  catch { $('#list').replaceChildren(h('li', { className: 'empty', textContent: "Couldn't load engineers. Check your connection and open this tab again." })); }
};
$('#q').addEventListener('input', renderList);

const card = e => {
  const slot = h('div', { className: 'hire-slot' });
  const hire = (choice, label) => e.available && h('button', { className: 'small', type: 'button', textContent: label, onclick: () => openHire(e, choice, slot) });
  return h('li', { className: 'card' },
    h('div', {}, h('strong', { textContent: e.name }), h('p', { className: 'meta', textContent: e.headline })),
    h('div', { className: 'chips' }, e.skills.map(t => h('span', { className: 'chip', textContent: t }))),
    h('p', { className: 'meta', textContent: [e.rate && `${usd(e.rate)}/hour`, `Paid ${e.terms.toLowerCase()}`, !e.available && 'Not taking new work right now'].filter(Boolean).join(' · ') }),
    e.packages.length > 0 && h('ul', { className: 'pkgs' }, e.packages.map((p, i) => h('li', {},
      h('div', {}, h('span', { textContent: `${p.title} · ${usd(p.price)} · ${p.days} day${p.days > 1 ? 's' : ''}` }), p.details && h('p', { className: 'meta', textContent: p.details })),
      hire('p' + i, 'Hire')))),
    e.rate && hire('hourly', 'Hire by the hour'),
    e.about && h('p', { className: 'about', textContent: e.about }),
    e.portfolio && h('a', { href: e.portfolio, textContent: 'Portfolio', rel: 'noopener noreferrer', target: '_blank' }),
    slot);
};

// One hire form open at a time, inside the engineer's card.
const openHire = (e, choice, slot) => {
  $$('.hire-slot').forEach(s => s.replaceChildren());
  if (role === 'engineer') return slot.replaceChildren(h('p', { className: 'msg error', textContent: MSG.role }));
  const pkg = e.packages[choice.slice(1)], hourly = choice === 'hourly';
  const quote = h('p', { className: 'meta' }), hours = hourly && h('input', { name: 'hours', inputMode: 'numeric', value: '10', required: true });
  const setQuote = () => { quote.textContent = `Estimated ${usd((+hours.value.replace(/\D/g, '') || 0) * e.rate)} at ${usd(e.rate)}/hour.`; };
  const field = (label, input) => h('label', {}, label, input);
  const form = h('form', { className: 'hire', noValidate: true },
    h('p', { textContent: hourly ? sentence(`Hourly work with ${e.name}`) : `${pkg.title} for ${usd(pkg.price)}, about ${pkg.days} day${pkg.days > 1 ? 's' : ''}.` }),
    hourly && [field('Estimated hours', hours), quote],
    role === 'client' ? h('p', { className: 'meta', textContent: `Sending as ${me.name} (${me.email}).` }) : [
      field('Your name', h('input', { name: 'clientName', required: true, maxLength: 80, autocomplete: 'name' })),
      field('Your email', h('input', { name: 'clientEmail', type: 'email', required: true, maxLength: 120, autocomplete: 'email' })),
      field('Create a password to follow this request, 10+ characters', h('input', { name: 'password', type: 'password', required: true, maxLength: 200, autocomplete: 'new-password' })),
      h('p', { className: 'meta' }, 'Already have an account? ', h('a', { href: '#requests', textContent: 'Sign in on Your requests' }), ' first.')],
    field('What you need', h('textarea', { name: 'details', required: true, rows: 4, maxLength: 2000, placeholder: 'What the app does, what is broken or missing, and any deadline.' })),
    field('Link to the app or repo (optional)', h('input', { name: 'link', type: 'url', maxLength: 200, placeholder: 'https://' })),
    h('input', { className: 'trap', name: 'website', tabIndex: -1, autocomplete: 'off', ariaHidden: 'true' }),
    h('div', { className: 'inline' }, h('button', { className: 'primary', textContent: 'Send request' }), h('button', { className: 'quiet', type: 'button', textContent: 'Cancel', onclick: () => slot.replaceChildren() })),
    h('p', { className: 'msg', role: 'status' }));
  if (hourly) hours.addEventListener('input', setQuote), setQuote();
  onSubmit(form, async () => {
    const r = await api('/api/jobs', { ...fields(form), engineerId: e.id, choice });
    slot.replaceChildren(h('div', { className: 'done', role: 'status' },
      h('p', {}, h('strong', { textContent: sentence(`Request sent to ${r.engineer.name}`) }), ` Quote ${usd(r.quote)}.`),
      h('p', {}, 'Email them to agree the details: ', h('strong', { className: 'select', textContent: r.engineer.email })),
      h('p', { textContent: `They take payment by ${r.engineer.payWith}. Payment terms: ${r.engineer.terms.toLowerCase()}.` }),
      h('p', { className: 'meta', textContent: 'Pay the engineer directly. CodeMarcer never holds the money; agree the scope in writing before paying.' }),
      h('p', {}, 'Follow it on ', h('a', { href: '#requests', textContent: 'Your requests' }), '.')));
    await loadMe();
  });
  slot.replaceChildren(form);
  form.elements[hourly ? 'hours' : role === 'client' ? 'details' : 'clientName'].focus();
};

// ---- Accounts: engineers and clients sign in on the site; each tab shows what fits the signed-in role ----
const profile = $('#profile'), pkgs = $('#pkgs');
let role = null, me = null;
const pkgRow = (p = {}) => {
  const inp = (f, label, props) => h('label', {}, label, h('input', { name: `pkg-${f}`, value: p[f] ?? '', ...props }));
  const row = h('fieldset', { className: 'pkg' },
    h('legend', { className: 'sr', textContent: 'Package' }),
    inp('title', 'Package', { maxLength: 60, placeholder: 'Deploy your app with HTTPS' }),
    inp('price', 'Price, USD', { inputMode: 'numeric', placeholder: '400' }),
    inp('days', 'Days', { inputMode: 'numeric', placeholder: '5' }),
    h('button', { className: 'icon', type: 'button', ariaLabel: 'Remove package', title: 'Remove package', innerHTML: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>', onclick: () => { row.remove(); syncAdd(); } }),
    inp('details', 'What is included (optional)', { maxLength: 300, className: 'wide' }));
  pkgs.append(row); syncAdd();
};
const syncAdd = () => { $('#add-pkg').hidden = pkgs.children.length >= 5; };
$('#add-pkg').onclick = () => { pkgRow(); $('input', pkgs.lastChild).focus(); };
const readPkgs = () => $$('.pkg', pkgs).map(r => Object.fromEntries($$('input', r).map(i => [i.name.slice(4), i.value.trim()]))).filter(p => Object.values(p).some(Boolean));

const fill = p => {
  for (const k of ['name', 'headline', 'payWith', 'terms', 'portfolio', 'about']) profile.elements[k].value = p[k] ?? '';
  profile.elements.skills.value = p.skills.join(', '); profile.elements.rate.value = p.rate ?? ''; profile.elements.available.checked = p.available;
  pkgs.replaceChildren(); p.packages.forEach(pkgRow); syncAdd();
};
const setMode = (r, p = null) => {
  role = r; me = p;
  const on = r === 'engineer';
  $$('[data-show]').forEach(el => (el.hidden = !el.dataset.show.split(' ').includes(r ?? 'out')));
  $$('[data-signup]', profile).forEach(el => (el.hidden = on)); $$('[data-edit]', profile).forEach(el => (el.hidden = !on));
  $('#profile-intro').textContent = on ? 'Your profile, as clients see it on the Find an engineer tab.' : 'New here? List yourself with your rate and packages.';
  $('#profile-save').textContent = on ? 'Save profile' : 'List me';
};

const STATUS = { requested: 'New request', accepted: 'Accepted', paid: 'Paid', complete: 'Complete', declined: 'Declined', cancelled: 'Cancelled' };
const ACTIONS = { requested: [['accepted', 'Accept'], ['declined', 'Decline']], accepted: [['paid', 'Mark paid'], ['complete', 'Mark complete'], ['declined', 'Decline']], paid: [['complete', 'Mark complete']] };
const what = c => c.type === 'hourly' ? `${c.hours} hours at ${usd(c.rate)}/hour` : c.title;
const setJob = async (btn, body) => { btn.disabled = true; try { await api('/api/me/jobs', body); await loadMe(); } catch (err) { err.status === 401 ? setMode(null) : (btn.disabled = false, btn.closest('li').querySelector('.msg').textContent = `Couldn't update: ${err.message}.`); } };
const small = (label, onclick) => h('button', { className: 'small', type: 'button', textContent: label, onclick });
const CHECK = { confirmed: 'The client confirmed this amount.', disputed: 'The client reported a problem with this job; the site owner will follow up.' };
const job = j => {
  const actions = h('div', { className: 'inline wrap' });
  const complete = () => {
    const amt = h('input', { inputMode: 'numeric', value: j.quote, ariaLabel: 'Final amount in USD' });
    actions.replaceChildren(h('label', { className: 'inline' }, 'Final amount, USD', amt), h('button', { className: 'small', type: 'button', textContent: 'Confirm complete', onclick: e => setJob(e.currentTarget, { id: j.id, status: 'complete', amount: amt.value.replace(/\D/g, '') }) }), h('button', { className: 'small', type: 'button', textContent: 'Cancel', onclick: draw }));
    amt.focus();
  };
  const draw = () => actions.replaceChildren(...(ACTIONS[j.status] ?? []).map(([s, label]) => h('button', { className: 'small', type: 'button', textContent: label, onclick: e => s === 'complete' ? complete() : setJob(e.currentTarget, { id: j.id, status: s }) })));
  draw();
  return h('li', { className: 'job' },
    h('div', { className: 'row-between' }, h('strong', { textContent: `${j.client.name} · ${date(j.created)}` }), h('span', { className: `status s-${j.status}`, textContent: STATUS[j.status] })),
    h('p', { textContent: `${what(j.choice)} · quote ${usd(j.quote)}` }),
    h('p', { className: 'select', textContent: j.client.email }),
    h('p', { className: 'about', textContent: j.details }),
    j.link && h('a', { href: j.link, textContent: j.link, rel: 'noopener noreferrer', target: '_blank' }),
    j.status === 'complete' && h('p', { className: 'meta', textContent: `Completed for ${usd(j.amount)}. ${j.pct ? `Fee ${usd(j.fee)} (${j.pct}%) owed to CodeMarcer.` : 'No fee: requested during the free period.'} ${CHECK[j.clientCheck] ?? ''}`.trim() }),
    actions, h('p', { className: 'msg', role: 'status' }));
};
// A client's view of a request: the engineer's contact and payment details, cancel before acceptance, confirm or dispute at the end.
const request = j => {
  const actions = h('div', { className: 'inline wrap' }), body = b => e => setJob(e.currentTarget, { id: j.id, ...b });
  if (j.status === 'requested') actions.append(small('Cancel request', body({ status: 'cancelled' })));
  if (j.status === 'complete' && !j.clientCheck) actions.append(small(`Confirm ${usd(j.amount)}`, body({ check: 'confirmed' })), small('Report a problem', body({ check: 'disputed' })));
  return h('li', { className: 'job' },
    h('div', { className: 'row-between' }, h('strong', { textContent: `${j.engineer.name} · ${date(j.created)}` }), h('span', { className: `status s-${j.status}`, textContent: STATUS[j.status] })),
    h('p', { textContent: `${what(j.choice)} · quote ${usd(j.quote)}` }),
    j.engineer.payWith && h('p', {}, 'Email ', h('span', { className: 'select', textContent: j.engineer.email }), ` · Pay by ${j.engineer.payWith} · ${j.engineer.terms}`),
    h('p', { className: 'about', textContent: j.details }),
    j.status === 'complete' && h('p', { className: 'meta', textContent: `Completed for ${usd(j.amount)}. ${{ confirmed: 'You confirmed this amount.', disputed: "You reported a problem. The site owner will follow up by email." }[j.clientCheck] ?? 'Confirm the amount if it matches what you paid.'}` }),
    actions, h('p', { className: 'msg', role: 'status' }));
};
const empty = text => h('li', { className: 'empty', textContent: text });
const loadMe = async () => {
  const { role: r, profile: p, jobs } = await api('/api/me');
  setMode(r, p);
  const open = jobs.filter(j => ACTIONS[j.status]).length;
  $$('.who').forEach(el => (el.textContent = `Signed in as ${p.name} (${p.email}). ${open ? `${open} open request${open > 1 ? 's' : ''}.` : 'No open requests.'}`));
  if (r === 'engineer') fill(p), $('#jobs').replaceChildren(...jobs.map(job), ...(jobs.length ? [] : [empty('No requests yet. They appear here when a client hires you.')]));
  else $('#requests-list').replaceChildren(...jobs.map(request), ...(jobs.length ? [] : [empty('No requests yet. Send one from Find an engineer.')]));
  return r;
};

for (const form of $$('.signin')) onSubmit(form, async () => {
  await api('/api/login', fields(form)); form.reset();
  location.hash = (await loadMe()) === 'engineer' ? 'engineers' : 'requests';
});
onSubmit(profile, async () => {
  const isNew = role !== 'engineer', { newPassword, ...b } = fields(profile), body = { ...b, available: profile.elements.available.checked, packages: readPkgs(), ...(!isNew && { password: newPassword }) };
  await api(isNew ? '/api/engineers' : '/api/me', body);
  profile.elements.newPassword.value = ''; profile.elements.password.value = '';
  await loadMe(); await loadList();
  $('.msg', profile).textContent = ''; $('#who').textContent += isNew ? " You're listed." : ' Profile saved.';
  $('#who').scrollIntoView({ block: 'nearest' });
});
for (const b of $$('.signout')) b.onclick = async () => { await api('/api/logout', {}).catch(() => {}); setMode(null); profile.reset(); pkgs.replaceChildren(); pkgRow(); $$('.hire-slot').forEach(s => s.replaceChildren()); };

setMode(null); pkgRow();
tabs($('.tabs'), name => name === 'find' && loadList()); // fresh list each time the tab opens
loadMe().catch(() => {});
