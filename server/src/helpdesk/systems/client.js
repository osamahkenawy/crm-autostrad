// Calls the customer-data APIs on behalf of the helpdesk. It is the only place that talks to them, and it is built so a slow,
// broken or hostile API can never stall or corrupt the mailbox:
//  - every call has a timeout, and the whole lookup for one email has a deadline;
//  - throttling and temporary failures are retried once with a pause; a source that keeps failing is paused for a minute
//    (circuit breaker) instead of making every email wait;
//  - answers are cached for a few minutes (and "not found" for a minute), so a customer who writes three times costs one call;
//  - redirects are not followed, answers are size-limited, and everything put into an address is percent-encoded;
//  - keys, tokens and passwords are read from server/.env only when a request is made and are never logged or returned.
// runLookup() never throws: it returns { ok:false, error } so one failing question does not hide the others.
import { fillPlaceholders, loadConfig, lookupPlaceholders, missingVars, sourceRuntime } from './config.js';
import { rowsAt } from './mapping.js';

export class SystemError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/** Timings the tests shorten. */
export const tuning = { breakerThreshold: 5, breakerOpenMs: 60_000, retryPauseMs: 400, retryMaxPauseMs: 5000, cacheEntries: 300, cacheMaxBytes: 64 * 1024, cacheBudget: 24 * 1024 * 1024 };

const health = new Map(); // source -> counters shown on the Customer data page
const cache = new Map(); // key -> { at, ttl, value, cost }
let cacheBytes = 0; // estimated memory of everything in the cache
const gates = new Map(); // source -> { active, queue }
const tokens = new Map(); // source -> { token, exp }

const stateOf = (name) => {
  if (!health.has(name)) health.set(name, { calls: 0, failures: 0, consecutive: 0, openUntil: 0, probing: false, lastOkAt: null, lastErrorAt: null, lastError: null, avgMs: null });
  return health.get(name);
};
/** How much the answer cache holds (an estimate of its memory). */
export const cacheStats = () => ({ entries: cache.size, bytes: cacheBytes });
export const sourceHealth = (name) => {
  const h = stateOf(name);
  return { calls: h.calls, failures: h.failures, last_ok_at: h.lastOkAt, last_error_at: h.lastErrorAt, last_error: h.lastError, avg_ms: h.avgMs === null ? null : Math.round(h.avgMs), paused_until: h.openUntil > Date.now() ? new Date(h.openUntil).toISOString() : null };
};
/** Clear counters, caches and tokens (tests; also "reset" after the connection settings were fixed). */
export function resetClient() { health.clear(); cache.clear(); cacheBytes = 0; gates.clear(); tokens.clear(); }

/* ------------------------------------------------------------------------------------------------ breaker and slots */
function beforeCall(rt) {
  const h = stateOf(rt.name);
  const now = Date.now();
  if (h.openUntil) {
    if (now < h.openUntil || h.probing) throw new SystemError('breaker', `${rt.label} is not answering. Calls are paused for a short while (${Math.max(1, Math.ceil((h.openUntil - now) / 1000))}s) and the case will be completed automatically.`);
    h.probing = true; // let one request through to see whether it is back
  }
}
function afterCall(rt, ok, ms, error) {
  const h = stateOf(rt.name);
  h.calls++;
  h.probing = false;
  if (ok) {
    h.consecutive = 0; h.openUntil = 0; h.lastOkAt = new Date().toISOString();
    h.avgMs = h.avgMs === null ? ms : h.avgMs * 0.8 + ms * 0.2;
  } else if (error && ['timeout', 'network', 'http5', 'auth'].includes(error.kind)) {
    h.failures++; h.consecutive++; h.lastErrorAt = new Date().toISOString(); h.lastError = error.message;
    if (h.consecutive >= tuning.breakerThreshold) h.openUntil = Date.now() + tuning.breakerOpenMs;
  } else if (error) { h.failures++; h.lastErrorAt = new Date().toISOString(); h.lastError = error.message; }
}

async function withSlot(rt, fn) {
  const g = gates.get(rt.name) || { active: 0, queue: [] };
  gates.set(rt.name, g);
  if (g.active < rt.max_concurrent) g.active++;
  else await new Promise((resolve) => g.queue.push(resolve)); // the slot is handed over, not released and re-taken
  try { return await fn(); } finally {
    const next = g.queue.shift();
    if (next) next(); else g.active--;
  }
}

/* ------------------------------------------------------------------------------------------------ signing in */
async function oauthToken(rt, { fresh = false } = {}) {
  const cached = tokens.get(rt.name);
  if (!fresh && cached && cached.exp > Date.now() + 60_000) return cached.token;
  const a = rt.auth;
  const url = a.token_url || process.env[a.token_url_env];
  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (a.scope) form.set('scope', a.scope);
  if (a.audience) form.set('audience', a.audience);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (a.send_credentials === 'basic') headers.Authorization = `Basic ${Buffer.from(`${process.env[a.client_id_env]}:${process.env[a.client_secret_env]}`).toString('base64')}`;
  else { form.set('client_id', process.env[a.client_id_env]); form.set('client_secret', process.env[a.client_secret_env]); }
  let res;
  try { res = await fetch(url, { method: 'POST', headers, body: form, redirect: 'manual', signal: AbortSignal.timeout(Math.min(rt.timeout_ms, 10_000)) }); } catch (e) {
    throw new SystemError('auth', `${rt.label}: could not reach the sign-in address (${timedOut(e) ? 'timed out' : (e.cause && e.cause.code) || scrub(e.message)}).`, { kind: 'auth' });
  }
  let j = {};
  try { j = JSON.parse(await readCapped(res, 64 * 1024)); } catch { j = {}; } // a sign-in answer is tiny: anything bigger is not one
  if (!res.ok || !j.access_token) throw new SystemError('auth', `${rt.label}: the sign-in was refused (${res.status}${j.error_description ? `: ${String(j.error_description).slice(0, 120)}` : j.error ? `: ${String(j.error).slice(0, 60)}` : ''}). Check the client ID and secret in server/.env.`, { kind: 'auth' });
  tokens.set(rt.name, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3000) * 1000 });
  return j.access_token;
}

async function authFor(rt, opts) {
  const a = rt.auth;
  const headers = {};
  const query = {};
  if (a.type === 'api_key') {
    if (a.query) query[a.query] = process.env[a.key_env];
    else headers[a.header || 'X-Api-Key'] = `${a.prefix || ''}${process.env[a.key_env]}`;
  } else if (a.type === 'bearer') headers.Authorization = `Bearer ${process.env[a.token_env]}`;
  else if (a.type === 'basic') headers.Authorization = `Basic ${Buffer.from(`${process.env[a.user_env]}:${process.env[a.password_env]}`).toString('base64')}`;
  else if (a.type === 'oauth2_client_credentials') headers.Authorization = `Bearer ${await oauthToken(rt, opts)}`;
  // a key pasted with a curly quote or a dash from a document cannot be sent; say so instead of failing in the network layer
  if (Object.values({ ...headers, ...query }).some((v) => /[^\x00-\xff]/.test(String(v)))) {
    throw new SystemError('config', `${rt.label}: a key or password in server/.env contains a character that cannot be sent in a request (often a curly quote or dash from copy and paste). Type it in again.`, { kind: 'other' });
  }
  return { headers, query };
}

/* ------------------------------------------------------------------------------------------------ one request */
const fillDeep = (v, vars) => {
  if (typeof v === 'string') { const f = fillPlaceholders(v, vars, 'json'); return f.text; }
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, vars));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) { const y = fillDeep(x, vars); if (!(typeof y === 'string' && y === '' && typeof x === 'string' && /\{\w+\?/.test(x))) out[k] = y; }
    return out;
  }
  return v;
};

function buildUrl(rt, lk, vars, authQuery) {
  const p = fillPlaceholders(lk.path, vars, 'url');
  if (p.missing.length) throw new SystemError('config', `${rt.label}: the address needs ${p.missing.join(' and ')}, which is not known.`);
  const url = new URL(`${rt.baseUrl}/${p.text.replace(/^\/+/, '')}`);
  const base = new URL(rt.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  // whatever was put into the address, it must still point inside the configured API
  if (url.origin !== base.origin || (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))) throw new SystemError('config', `${rt.label}: the address built for this lookup leaves the configured API. Check the path.`);
  for (const [k, v] of Object.entries(lk.query || {})) {
    const f = fillPlaceholders(v, vars, 'json');
    if (f.text !== '') url.searchParams.set(k, f.text);
  }
  for (const [k, v] of Object.entries(authQuery)) url.searchParams.set(k, v);
  return url;
}

const maskUrl = (url, authQuery) => {
  const u = new URL(url.href);
  for (const k of Object.keys(authQuery)) if (u.searchParams.has(k)) u.searchParams.set(k, '***');
  return u.toString();
};

async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) throw new SystemError('too_large', `The answer is larger than ${Math.round(maxBytes / 1024)} KB, which is more than expected for one record.`, { kind: 'other' });
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    let chunk;
    try { chunk = await reader.read(); } catch (e) {
      throw timedOut(e) ? new SystemError('timeout', 'The system stopped sending its answer.', { kind: 'timeout' }) : new SystemError('network', 'The connection broke while the answer was being sent.', { kind: 'network' });
    }
    const { done, value } = chunk;
    if (done) break;
    total += value.length;
    if (total > maxBytes) { reader.cancel().catch(() => {}); throw new SystemError('too_large', `The answer is larger than ${Math.round(maxBytes / 1024)} KB, which is more than expected for one record.`, { kind: 'other' }); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/** Error text with every address taken out: an address can carry a key or a password. */
const scrub = (text) => String(text || '').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[address]').slice(0, 160);
const timedOut = (e) => Boolean(e) && (e.name === 'TimeoutError' || e.name === 'AbortError');

/** One HTTP exchange, with at most one retry. -> { status, json, ms } or throws SystemError. */
async function exchange(rt, lk, vars, { deadline, trace }) {
  let attempt = 0;
  let freshToken = false;
  for (;;) {
    attempt++;
    const left = deadline - Date.now();
    if (left < 400) throw new SystemError('timeout', `${rt.label}: ran out of time for this email.`, { kind: 'timeout' });
    const auth = await authFor(rt, { fresh: freshToken });
    const url = buildUrl(rt, lk, vars, auth.query);
    const method = lk.method || 'GET';
    const headers = { Accept: 'application/json', 'User-Agent': 'Autostrad-Helpdesk/1', ...rt.headers, ...auth.headers };
    let body;
    if (method === 'POST') { body = JSON.stringify(fillDeep(lk.body, vars)); headers['Content-Type'] = 'application/json'; }
    const started = Date.now();
    if (trace) trace.url = maskUrl(url, auth.query);
    let res;
    try {
      res = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(Math.min(rt.timeout_ms, left)) });
    } catch (e) {
      const slow = timedOut(e);
      const err = new SystemError(slow ? 'timeout' : 'network', slow ? `${rt.label} did not answer in time.` : `Could not reach ${rt.label} (${(e.cause && e.cause.code) || scrub(e.message)}).`, { kind: slow ? 'timeout' : 'network' });
      if (attempt < 2 && !slow && deadline - Date.now() > 1500) { await pause(tuning.retryPauseMs); continue; }
      throw err;
    }
    const ms = Date.now() - started;
    if (trace) trace.status = res.status;

    if (res.status >= 300 && res.status < 400) {
      res.body && res.body.cancel().catch(() => {});
      throw new SystemError('redirect', `${rt.label} answered with a redirect (${res.status}). Redirects are not followed: put the final address in base_url.`, { kind: 'other', status: res.status });
    }
    if ((lk.not_found_status || [404]).includes(res.status)) { res.body && res.body.cancel().catch(() => {}); return { status: res.status, json: null, ms, notFound: true }; }
    if (res.status === 401 || res.status === 403) {
      res.body && res.body.cancel().catch(() => {});
      if (res.status === 401 && rt.auth.type === 'oauth2_client_credentials' && !freshToken) { freshToken = true; tokens.delete(rt.name); continue; }
      throw new SystemError('auth', `${rt.label} refused our credentials (${res.status}). Check the key or token in server/.env, and that it may read these records.`, { kind: res.status === 401 ? 'auth' : 'other', status: res.status }); // a 403 can be one record: it does not pause the whole system
    }
    if ([429, 502, 503, 504].includes(res.status)) {
      const wait = Math.min(tuning.retryMaxPauseMs, (Number(res.headers.get('retry-after')) || 0) * 1000 || tuning.retryPauseMs * attempt);
      res.body && res.body.cancel().catch(() => {});
      if (attempt < 2 && deadline - Date.now() > wait + 1500) { await pause(wait); continue; }
      throw new SystemError('http', `${rt.label} is busy or down (${res.status}).`, { kind: 'http5', status: res.status });
    }
    if (res.status >= 500) { res.body && res.body.cancel().catch(() => {}); throw new SystemError('http', `${rt.label} had an internal error (${res.status}).`, { kind: 'http5', status: res.status }); }

    const text = await readCapped(res, rt.max_response_kb * 1024);
    if (res.status >= 400) {
      let detail = '';
      try { const j = JSON.parse(text); detail = String((j.error && (j.error.message || j.error.code)) || j.message || j.error || '').slice(0, 120); } catch { /* not JSON */ }
      throw new SystemError('http', `${rt.label} answered ${res.status}${detail ? `: ${detail}` : ''}.`, { kind: 'other', status: res.status });
    }
    if (res.status === 204 || text.trim() === '') return { status: res.status, json: null, ms, notFound: true };
    let json;
    try { json = JSON.parse(text.replace(/^﻿/, '')); } catch {
      throw new SystemError('parse', `${rt.label} did not answer with JSON${res.headers.get('content-type') ? ` (it sent ${String(res.headers.get('content-type')).split(';')[0]})` : ''}. Check the address.`, { kind: 'other', status: res.status });
    }
    return { status: res.status, json, ms, notFound: false, size: text.length };
  }
}

/* ------------------------------------------------------------------------------------------------ public */
const cacheDrop = (key) => { const hit = cache.get(key); if (hit) { cacheBytes -= hit.cost; cache.delete(key); } };
const cacheGet = (key) => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl * 1000) { cacheDrop(key); return null; }
  cache.delete(key); cache.set(key, hit); // most recently used last
  return hit.value;
};
const cacheSet = (key, value, ttl, size) => {
  if (!ttl || size > tuning.cacheMaxBytes) return;
  cacheDrop(key);
  const cost = Math.max(512, size * 6); // a parsed answer takes several times the memory of its text
  cache.set(key, { at: Date.now(), ttl, value, cost });
  cacheBytes += cost;
  while (cache.size && (cache.size > tuning.cacheEntries || cacheBytes > tuning.cacheBudget)) cacheDrop(cache.keys().next().value);
};

/**
 * Ask one of the configured questions. vars: { email, contract_no, customer_id }.
 * -> { name, source, label, skipped?, ok, notFound, rows, raw, url, status, ms, cached, error: { code, message } }
 * `skipped` means a value the question needs was not known, so nothing was asked.
 */
export async function runLookup(name, vars, { deadline = Date.now() + 15_000, bypassCache = false, keepRaw = false } = {}) {
  const cfg = loadConfig();
  const { config } = cfg;
  const lk = config.lookups[name];
  const base = { name, source: lk ? lk.source : null, label: null, ok: false, notFound: false, rows: [], raw: null, url: null, status: null, ms: 0, cached: false };
  if (!cfg.ok && !cfg.usingLastGood) return { ...base, error: { code: 'config', message: `The customer systems configuration has problems: ${cfg.problems[0]}` } };
  if (!lk) return { ...base, skipped: true, reason: 'not configured' };
  const rt = sourceRuntime(lk.source, config);
  if (!rt) return { ...base, error: { code: 'config', message: `Source "${lk.source}" is not defined.` } };
  base.label = rt.label;

  const lacking = missingVars(lk, vars);
  if (lacking.length) return { ...base, skipped: true, reason: `needs ${lacking.join(' and ')}` };
  if (rt.missing.length) return { ...base, error: { code: 'config', message: `${rt.label} is not fully set up: add ${rt.missing.join(', ')} to server/.env and restart the server.` } };
  if (rt.problems.length) return { ...base, error: { code: 'config', message: `${rt.label}: ${rt.problems[0]}.` } };

  const trace = {};
  // the cache is keyed on the values this question actually uses, so a second email about the same contract is a hit
  const used = [...new Set(lookupPlaceholders(lk).map((p) => p.name))].sort();
  const key = `${name}|${lk.source}|${lk.method || 'GET'}|${lk.path}|${JSON.stringify(lk.query || {})}|${JSON.stringify(lk.body || {})}|${used.map((n) => `${n}=${String(vars[n] ?? '').trim().toLowerCase()}`).join('&')}`;
  if (!bypassCache) {
    const hit = cacheGet(key);
    if (hit) return { ...base, ...hit, cached: true, raw: null };
  }

  try {
    beforeCall(rt);
  } catch (e) {
    return { ...base, error: { code: e.code, message: e.message } };
  }
  try {
    const r = await withSlot(rt, () => exchange(rt, lk, vars, { deadline, trace }));
    afterCall(rt, true, r.ms);
    const rows = r.notFound ? [] : rowsAt(r.json, lk.result);
    const out = { ...base, ok: true, notFound: r.notFound || rows.length === 0, rows, raw: r.json, url: trace.url || null, status: r.status, ms: r.ms };
    cacheSet(key, { ok: true, notFound: out.notFound, rows, url: out.url, status: r.status, ms: r.ms }, out.notFound ? rt.negative_cache_seconds : rt.cache_seconds, r.size || 0);
    return keepRaw ? out : { ...out, raw: null };
  } catch (e) {
    if (!(e instanceof SystemError)) {
      const slow = timedOut(e);
      const message = slow ? `${rt.label} did not answer in time.` : `${rt.label}: ${scrub(e.message)}`;
      afterCall(rt, false, 0, { kind: slow ? 'timeout' : 'other', message });
      return { ...base, url: trace.url || null, status: trace.status || null, error: { code: slow ? 'timeout' : 'internal', message } };
    }
    afterCall(rt, false, 0, { kind: e.kind || 'other', message: e.message });
    return { ...base, url: trace.url || null, status: trace.status || null, error: { code: e.code, message: e.message } };
  }
}
