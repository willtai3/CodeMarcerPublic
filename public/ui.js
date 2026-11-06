// Shared DOM helpers for the site and the admin page. Text only goes in via textContent/append, never innerHTML.
export const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const h = (tag, props = {}, ...kids) => { const el = Object.assign(document.createElement(tag), props); el.append(...kids.flat(Infinity).filter(k => k != null && k !== false)); return el; };

export const api = async (path, body) => {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error ?? 'request'), { status: r.status, field: data.error });
  return data;
};

// Tabs keep their place in the URL hash; onShow(name) runs each time a tab opens.
export const tabs = (nav, onShow = () => {}) => {
  const names = $$('[data-tab]', nav).map(b => b.dataset.tab);
  const show = name => {
    name = names.includes(name) ? name : names[0];
    for (const b of $$('[data-tab]', nav)) { const on = b.dataset.tab === name; b.setAttribute('aria-selected', on); document.getElementById(b.dataset.tab).hidden = !on; }
    onShow(name);
  };
  nav.addEventListener('click', e => { const t = e.target.closest('[data-tab]')?.dataset.tab; if (t) history.replaceState(null, '', '#' + t), show(t); });
  addEventListener('hashchange', () => show(location.hash.slice(1)));
  show(location.hash.slice(1));
  return show;
};

export const date = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
