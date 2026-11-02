import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { openStore } from './lib/store.js';
import { hash, verify, adminLogin } from './lib/auth.js';
import { makeApi } from './lib/api.js';

const env = process.env, PORT = +(env.PORT ?? 8080), HOST = env.HOST ?? '127.0.0.1', DATA = env.DATA_DIR ?? './data';
const API = makeApi({ store: await openStore(DATA), hash, verify, adminLogin: adminLogin(DATA) });

// ---- Static files: the complete public surface (also asserted in tests) ----
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };
const FILES = { '/': 'index.html', '/admin': 'admin.html', '/app.js': 'app.js', '/admin.js': 'admin.js', '/ui.js': 'ui.js', '/fees.js': 'fees.js', '/styles.css': 'styles.css', '/favicon.svg': 'favicon.svg' };
const STATIC = Object.fromEntries(await Promise.all(Object.entries(FILES).map(async ([r, f]) => [r, { body: await readFile(new URL(`./public/${f}`, import.meta.url)), type: TYPES[f.split('.').pop()] }])));
const SEC = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains', 'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// ---- Rate limits: new listings and hire requests count only when accepted; sign-ins count every attempt ----
const LIMITS = { 'POST /api/engineers': ['s', 10, 36e5, true], 'POST /api/jobs': ['s', 10, 36e5, true], 'POST /api/login': ['l', 10, 9e5], 'POST /api/admin/login': ['l', 10, 9e5] };
const hits = new Map(), sessions = new Map();
const recent = (key, ms) => { const now = Date.now(), arr = (hits.get(key) ?? []).filter(t => now - t < ms); hits.set(key, arr); return arr; };
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.length || now - a.at(-1) > 36e5) hits.delete(k); for (const [k, s] of sessions) if (s.exp < now) sessions.delete(k); }, 6e5).unref();
const ipOf = req => (env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;

// ---- Sessions: one HttpOnly cookie, 8 hours, role engineer or admin ----
const sidOf = req => /(?:^|;\s*)sid=([A-Za-z0-9_-]{43})/.exec(req.headers.cookie ?? '')?.[1];
const sessionOf = req => { const s = sessions.get(sidOf(req)); return s?.exp > Date.now() ? s : null; };
const cookie = (v, age) => `sid=${v}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
const applySession = (req, change) => {
  sessions.delete(sidOf(req)); // a sign-in always gets a fresh id
  if (change.logout) return cookie('', 0);
  const sid = randomBytes(32).toString('base64url'); sessions.set(sid, { ...change.login, exp: Date.now() + 8 * 36e5 });
  return cookie(sid, 8 * 3600);
};

// ---- HTTP ----
const send = (res, code, body, headers = {}) => { res.writeHead(code, { ...SEC, 'Cache-Control': 'no-store', 'Content-Type': 'application/json', ...headers }); res.end('Content-Type' in headers ? body : JSON.stringify(body)); };
const readJson = req => new Promise((ok, fail) => {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return fail(415);
  let size = 0; const parts = [];
  req.on('data', c => (size += c.length) <= 32768 && parts.push(c));
  req.on('end', () => { if (size > 32768) return fail(413); try { const v = JSON.parse(Buffer.concat(parts)); v && typeof v === 'object' && !Array.isArray(v) ? ok(v) : fail(400); } catch { fail(400); } });
  req.on('error', () => fail(400));
});

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname, route = `${req.method} ${path}`;
  // Behind a host's HTTPS proxy, send any plain-http visit to https.
  if (env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'http') return res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` }).end();
  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && STATIC[path]) return send(res, 200, STATIC[path].body, { 'Content-Type': STATIC[path].type, 'Cache-Control': 'no-cache' });
    const fn = API[route];
    if (!fn) return send(res, 404, { error: 'not found' });
    const body = req.method === 'POST' ? await readJson(req) : {}, [bucket, max, ms, acceptedOnly] = LIMITS[route] ?? [], seen = bucket && recent(bucket + ipOf(req), ms);
    if (seen && seen.length >= max) return send(res, 429, { error: 'rate' });
    if (seen && !acceptedOnly) seen.push(Date.now());
    if (seen && acceptedOnly && body.website) return seen.push(Date.now()), send(res, 201, { ok: true }); // honeypot: bots fill the hidden field
    const [status, json, change] = await fn(body, { session: sessionOf(req) });
    if (seen && acceptedOnly && status < 300) seen.push(Date.now());
    send(res, status, json, change ? { 'Set-Cookie': applySession(req, change) } : {});
  } catch (e) { typeof e === 'number' ? send(res, e, { error: 'request' }) : (console.error(e), send(res, 500, { error: 'server' })); }
});
server.listen(PORT, HOST, () => console.log(`listening http://${HOST}:${server.address().port}`));
