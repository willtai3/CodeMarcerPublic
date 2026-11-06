import { $, $$, h, api, tabs, usd } from './ui.js';

// ---- Shared form helpers ----
const MSG = {
  rate: 'Too many attempts from this connection. Try again later.', request: 'That request was refused. Reload the page and try again.',
  pricing: 'Add an hourly rate or at least one package.', key: 'This edit link no longer works. Get a new one with "Email me my edit link" below.', engineer: 'This engineer is no longer taking requests.', packages: 'Check each package: a title, a price of at least $25 and 1 to 90 days.', choice: 'That package is no longer offered. Reload the page.',
};
const labelOf = el => el?.closest('label')?.firstChild.textContent.split(/,| \(/)[0].trim().toLowerCase().replace(/^your /, '');
const fail = (form, err) => {
  const field = form.elements[err.field];
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
  try { m.textContent = (await send()) ?? ''; } catch (err) { fail(form, err); } finally { btn.disabled = false; }
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
  const pkg = e.packages[choice.slice(1)], hourly = choice === 'hourly';
  const quote = h('p', { className: 'meta' }), hours = hourly && h('input', { name: 'hours', inputMode: 'numeric', value: '10', required: true });
  const setQuote = () => { quote.textContent = `Estimated ${usd((+hours.value.replace(/\D/g, '') || 0) * e.rate)} at ${usd(e.rate)}/hour.`; };
  const field = (label, input) => h('label', {}, label, input);
  const form = h('form', { className: 'hire', noValidate: true },
    h('p', { textContent: hourly ? sentence(`Hourly work with ${e.name}`) : `${pkg.title} for ${usd(pkg.price)}, about ${pkg.days} day${pkg.days > 1 ? 's' : ''}.` }),
    hourly && [field('Estimated hours', hours), quote],
    field('Your name', h('input', { name: 'clientName', required: true, maxLength: 80, autocomplete: 'name' })),
    field('Your email', h('input', { name: 'clientEmail', type: 'email', required: true, maxLength: 120, autocomplete: 'email' })),
    field('Your phone', h('input', { name: 'clientPhone', type: 'tel', required: true, maxLength: 25, autocomplete: 'tel', placeholder: '(555) 123-4567' })),
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
      h('p', {}, 'Contact them to agree the details: ', h('strong', { className: 'select', textContent: r.engineer.email }), ' · ', h('strong', { className: 'select', textContent: r.engineer.phone })),
      h('p', { textContent: `They take payment by ${r.engineer.payWith}. Payment terms: ${r.engineer.terms.toLowerCase()}.` }),
      h('p', { className: 'meta', textContent: 'They also have your email and phone. Pay the engineer directly. CodeMarcer never holds the money; agree the scope in writing before paying.' })));
  });
  slot.replaceChildren(form);
  form.elements[hourly ? 'hours' : 'clientName'].focus();
};

// ---- For engineers: no account. A listing is edited with the private link emailed to the engineer. ----
const profile = $('#profile'), pkgs = $('#pkgs'), relink = $('#relink');
let key = null; // the edit key from the link, kept in memory only
const pkgRow = (p = {}) => {
  const inp = (f, label, props) => h('label', {}, label, h('input', { name: `pkg-${f}`, value: p[f] ?? '', ...props }));
  const row = h('fieldset', { className: 'pkg' },
    h('legend', { className: 'sr', textContent: 'Package' }),
    inp('title', 'Package', { maxLength: 60, placeholder: 'Deploy your app with HTTPS' }),
    inp('price', 'Price, USD', { inputMode: 'numeric', placeholder: '400' }),
    inp('days', 'Days', { inputMode: 'numeric', placeholder: '5' }),
    h('button', { className: 'icon', type: 'button', ariaLabel: 'Remove package', title: 'Remove package', innerHTML: TRASH, onclick: () => { row.remove(); syncAdd(); } }),
    inp('details', 'What is included (optional)', { maxLength: 300, className: 'wide' }));
  pkgs.append(row); syncAdd();
};
const TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
const syncAdd = () => { $('#add-pkg').hidden = pkgs.children.length >= 5; };
$('#add-pkg').onclick = () => { pkgRow(); $('input', pkgs.lastChild).focus(); };
const readPkgs = () => $$('.pkg', pkgs).map(r => Object.fromEntries($$('input', r).map(i => [i.name.slice(4), i.value.trim()]))).filter(p => Object.values(p).some(Boolean));
const fill = p => {
  for (const k of ['name', 'email', 'phone', 'headline', 'payWith', 'terms', 'portfolio', 'about']) profile.elements[k].value = p[k] ?? '';
  profile.elements.skills.value = p.skills.join(', '); profile.elements.rate.value = p.rate ?? ''; profile.elements.available.checked = p.available;
  pkgs.replaceChildren(); p.packages.forEach(pkgRow); syncAdd();
};
const clear = () => { profile.reset(); pkgs.replaceChildren(); pkgRow(); };
const say = (form, text) => { const m = $('.msg', form); m.className = 'msg'; m.textContent = text; };

// Two modes: a new listing, or editing one opened from its link (the email can't change).
const setMode = p => {
  key = p ? key : null;
  $$('[data-new]').forEach(el => (el.hidden = !!p)); $$('[data-edit]').forEach(el => (el.hidden = !p));
  $('#editing').hidden = !p; profile.elements.email.readOnly = !!p;
  $('#profile-intro').textContent = p ? 'Your listing, as clients see it on the Find an engineer tab.' : 'List yourself with your rate and packages. No account needed.';
  $('#profile-save').textContent = p ? 'Save changes' : 'List me';
  if (p) $('#who').textContent = `Editing the listing for ${p.name} (${p.email}).`, fill(p), drawRemove(); else clear();
};
const drawRemove = () => $('#remove-slot').replaceChildren(h('button', { className: 'quiet', type: 'button', textContent: 'Remove my listing', onclick: () => {
  $('#remove-slot').replaceChildren(h('span', { textContent: 'Remove your listing for good?' }), h('button', { className: 'small danger', type: 'button', textContent: 'Remove', onclick: async e => {
    e.currentTarget.disabled = true;
    try { await api('/api/listing/remove', { key }); setMode(null); say(profile, 'Your listing is removed.'); loadList(); }
    catch (err) { drawRemove(); fail(profile, err); }
  } }), h('button', { className: 'small', type: 'button', textContent: 'Cancel', onclick: drawRemove }));
  $('.danger', $('#remove-slot')).focus();
} }));
// Opening an edit link: the key leaves the address bar at once (so it isn't left on screen or in history), then the
// listing loads.
const openLink = async () => {
  const k = /^#edit=([\w-]+\.[\w-]{43})$/.exec(location.hash)?.[1];
  if (!k) return;
  history.replaceState(null, '', '#engineers');
  try { key = k; setMode(await api('/api/listing', { key })); }
  catch (err) { setMode(null); say(relink, err.status === 401 ? MSG.key : "Couldn't open your listing. Check your connection and open the link again."); }
};
addEventListener('hashchange', openLink); // before tabs(), so a link opened on this page lands on the right tab

onSubmit(profile, async () => {
  const body = { ...fields(profile), available: profile.elements.available.checked, packages: readPkgs() };
  if (key) {
    setMode(await api('/api/listing/save', { ...body, key })); await loadList();
    return 'Saved. Clients see the change now.';
  }
  const { sent } = await api('/api/engineers', body);
  clear(); await loadList();
  return sent ? `You're listed. We've emailed a private link to edit or remove your listing to ${body.email}. (If that email was already listed, nothing changed and we sent its link instead.)`
    : "Your listing is saved, but the email with your edit link couldn't be sent just now. Use \"Email me my edit link\" below in a few minutes.";
});
onSubmit(relink, async () => {
  const { email } = fields(relink);
  await api('/api/edit-link', { email }); relink.reset();
  return `If ${email} is listed, a new link is on its way and older links stop working. One email per 10 minutes.`;
});
$('#stop-edit').onclick = () => { setMode(null); say(profile, ''); };

setMode(null);
openLink();
tabs($('.tabs'), name => name === 'find' && loadList()); // fresh list each time the tab opens
