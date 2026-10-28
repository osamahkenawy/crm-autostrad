// The customer-systems connector configuration: which APIs hold the contract, customer and invoice data, how to
// sign in to them, which address to call for each question, and which field of the answer is which fact.
//
// It lives in a plain JSON file (server/config/customer-systems.json, or the path in CUSTOMER_SYSTEMS_CONFIG) that
// contains NO secrets: passwords, keys and tokens are only ever named here ("key_env": "ORION_API_KEY") and
// read from server/.env. The file is re-read when it changes, so a fix does not need a restart.
// Every mistake in it is reported in plain words (Helpdesk setup, Customer data) instead of failing silently.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = path.resolve(here, '../../../config/customer-systems.json');
export const configPath = () => (process.env.CUSTOMER_SYSTEMS_CONFIG ? path.resolve(process.cwd(), process.env.CUSTOMER_SYSTEMS_CONFIG) : DEFAULT_CONFIG_PATH);

/** What each question can use from the email, and what each answer can fill in. */
export const VARIABLES = ['email', 'contract_no', 'customer_id'];
const CUSTOMER_FIELDS = ['id', 'name', 'email', 'emails', 'phone', 'tier', 'segment', 'status', 'company', 'language', 'url'];
const CONTRACT_FIELDS = ['contract_no', 'id', 'status', 'product_line', 'start_at', 'end_at', 'total_amount', 'payment_status', 'currency', 'url',
  'customer_id', 'customer_email', 'customer_name', 'customer_phone', 'customer_tier', 'customer_segment', 'vehicle_name', 'vehicle_plate', 'branch_name', 'branch_emirate'];
export const LOOKUPS = {
  customer_by_email: { about: 'find the customer from the sender address', list: false, fields: CUSTOMER_FIELDS, need: [['id', 'name', 'email'], ['email', 'emails']] },
  customer_by_id: { about: 'read the customer record of a contract', list: false, fields: CUSTOMER_FIELDS, need: [['id', 'name', 'email']] },
  contract: { about: 'read one contract by its number', list: false, fields: CONTRACT_FIELDS, need: [['contract_no']] },
  contracts_by_customer: { about: "list a customer's recent contracts", list: true, fields: CONTRACT_FIELDS, need: [['contract_no']] },
  invoices: { about: 'list the invoices of a contract or customer', list: true, fields: ['number', 'id', 'total', 'vat', 'status', 'issue_date', 'due_date', 'balance', 'currency', 'contract_no', 'url'], need: [['number']] },
  fines: { about: 'list fines and Salik of a contract', list: true, fields: ['reference', 'id', 'type', 'amount', 'admin_fee', 'status', 'issued_at', 'contract_no'], need: [['reference', 'amount']] },
  financials: { about: 'read the deposit and the card hold of a contract', list: false, fields: ['deposit_amount', 'deposit_status', 'deposit_refund_due', 'preauth_amount', 'preauth_status', 'preauth_released_at', 'card_last4', 'contract_no'], need: [] },
};

/* ------------------------------------------------------------------------------------------------ schema */
const Spec = z.lazy(() => z.union([
  z.string().min(1),
  z.array(z.union([z.string().min(1), Spec])).min(1),
  z.object({
    path: z.string().min(1).optional(), paths: z.array(z.union([z.string().min(1), Spec])).min(1).optional(), template: z.string().min(1).optional(), value: z.any().optional(),
    type: z.enum(['string', 'number', 'money', 'int', 'bool', 'date', 'datetime', 'email', 'lower', 'upper', 'list']).optional(),
    map: z.record(z.string(), z.any()).optional(), unmapped: z.enum(['keep', 'null']).optional(), scale: z.number().optional(), default: z.any().optional(),
    utc_offset_hours: z.number().min(-12).max(14).optional(), date_order: z.enum(['dmy', 'mdy']).optional(), join: z.string().optional(), prefix: z.string().optional(), suffix: z.string().optional(),
  }).strict(),
]));

const Auth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('api_key'), key_env: z.string().min(1), header: z.string().min(1).optional(), query: z.string().min(1).optional(), prefix: z.string().optional() }).strict(),
  z.object({ type: z.literal('bearer'), token_env: z.string().min(1) }).strict(),
  z.object({ type: z.literal('basic'), user_env: z.string().min(1), password_env: z.string().min(1) }).strict(),
  z.object({
    type: z.literal('oauth2_client_credentials'), token_url: z.string().min(1).optional(), token_url_env: z.string().min(1).optional(), client_id_env: z.string().min(1), client_secret_env: z.string().min(1),
    scope: z.string().optional(), audience: z.string().optional(), send_credentials: z.enum(['body', 'basic']).optional(),
  }).strict(),
]);

const Source = z.object({
  label: z.string().min(1),
  base_url: z.string().min(1).optional(), base_url_env: z.string().min(1).optional(),
  auth: Auth.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().int().min(500).max(30000).optional(),
  max_concurrent: z.number().int().min(1).max(16).optional(),
  cache_seconds: z.number().int().min(0).max(3600).optional(),
  negative_cache_seconds: z.number().int().min(0).max(600).optional(),
  allow_http: z.boolean().optional(),
  max_response_kb: z.number().int().min(16).max(8192).optional(),
}).strict();

const Lookup = z.object({
  source: z.string().min(1),
  method: z.enum(['GET', 'POST']).optional(),
  path: z.string().min(1),
  query: z.record(z.string(), z.string()).optional(),
  body: z.record(z.string(), z.any()).optional(),
  result: z.string().optional(),
  not_found_status: z.array(z.number().int().min(300).max(599)).optional(),
  scoped: z.boolean().optional(),
  map: z.record(z.string(), Spec),
}).strict();

const Config = z.object({
  _comment: z.any().optional(),
  enabled: z.boolean().optional(),
  fallback_to_crm: z.boolean().optional(),
  freshness_minutes: z.number().min(0).max(1440).optional(),
  utc_offset_hours: z.number().min(-12).max(14).optional(),
  max_invoices: z.number().int().min(1).max(200).optional(),
  deadline_ms: z.number().int().min(1000).max(60000).optional(),
  sources: z.record(z.string(), Source).optional(),
  lookups: z.object({
    customer_by_email: Lookup.optional(), customer_by_id: Lookup.optional(), contract: Lookup.optional(), contracts_by_customer: Lookup.optional(),
    invoices: Lookup.optional(), fines: Lookup.optional(), financials: Lookup.optional(),
  }).strict().optional(),
}).strict();

export const DEFAULTS = { enabled: false, fallback_to_crm: false, freshness_minutes: 10, utc_offset_hours: 4, max_invoices: 25, deadline_ms: 15000 };
const SOURCE_DEFAULTS = { timeout_ms: 8000, max_concurrent: 4, cache_seconds: 300, negative_cache_seconds: 60, allow_http: false, max_response_kb: 2048 };

/* ------------------------------------------------------------------------------------------------ placeholders */
const PLACEHOLDER = /\{(\w+)(\?)?(?:\|(\w+))?\}/g;
const FILTERS = {
  digits: (s) => String(s).replace(/\D/g, ''), lower: (s) => String(s).toLowerCase(), upper: (s) => String(s).toUpperCase(),
  odata: (s) => String(s).replace(/'/g, "''"), // for 'quoted' values in a $filter
  quote: (s) => String(s).replace(/[\\"]/g, '\\$&').replace(/[\u0000-\u001f]/g, ' '), // for a value inside "quotes" in a JSON or GraphQL text
};

/** Every {name}, {name?}, {name|digits} in a text. */
export function placeholdersIn(text) {
  const out = [];
  String(text ?? '').replace(PLACEHOLDER, (_m, name, optional, filter) => { out.push({ name, optional: Boolean(optional), filter: filter || null }); return ''; });
  return out;
}
const leaves = (v, out = []) => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => leaves(x, out));
  return out;
};

/** The placeholders a lookup uses anywhere in its address, query or body. */
export function lookupPlaceholders(lk) {
  return [...placeholdersIn(lk.path), ...Object.values(lk.query || {}).flatMap(placeholdersIn), ...leaves(lk.body).flatMap(placeholdersIn)];
}

/**
 * Fill {placeholders} from vars. mode "url" percent-encodes the value (so an email cannot add a path or a query), mode "json"
 * leaves it as it is. -> { text, missing: [required names with no value] }
 */
export function fillPlaceholders(text, vars, mode = 'url') {
  const missing = [];
  const out = String(text).replace(PLACEHOLDER, (_m, name, optional, filter) => {
    const raw = vars[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') { if (!optional) missing.push(name); return ''; }
    let v = String(raw).trim();
    if (filter && FILTERS[filter]) v = FILTERS[filter](v);
    if (v === '') { if (!optional) missing.push(name); return ''; } // e.g. {contract_no|digits} of a number with no digits
    // "." and ".." would climb out of the address when used as a path segment
    if (mode === 'url' && /^\.+$/.test(v)) { if (!optional) missing.push(name); return ''; }
    return mode === 'url' ? encodeURIComponent(v) : v;
  });
  return { text: out, missing };
}

/** The values a question needs that are not known yet (required placeholders in the address, query or body). */
export function missingVars(lk, vars) {
  const out = [...fillPlaceholders(lk.path, vars, 'url').missing];
  for (const v of Object.values(lk.query || {})) out.push(...fillPlaceholders(v, vars, 'json').missing);
  for (const t of leaves(lk.body)) out.push(...fillPlaceholders(t, vars, 'json').missing);
  return [...new Set(out)];
}

/** Why a web address may not be used (no text of the address itself: it may carry a secret). null when it is fine. */
export function urlProblem(raw, label, allowHttp = false) {
  let u;
  try { u = new URL(String(raw)); } catch { return `${label} is not a valid web address`; }
  if (!/^https?:$/.test(u.protocol)) return `${label} must start with https://`;
  if (u.username || u.password) return `${label} must not contain a user name or password: put credentials in the "auth" settings`;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname);
  if (u.protocol === 'http:' && !allowHttp && (process.env.NODE_ENV === 'production' || !local)) return `${label} uses plain http: use https, or set "allow_http": true only for a trusted internal network`;
  return null;
}

/* ------------------------------------------------------------------------------------------------ checks */
function check(config) {
  const problems = [];
  const sources = config.sources || {};
  const lookups = config.lookups || {};
  const plain = (name) => `lookups.${name}`;

  for (const [name, s] of Object.entries(sources)) {
    if (!s.base_url && !s.base_url_env) problems.push(`sources.${name}: give "base_url" (or "base_url_env" to read the address from server/.env).`);
    if (s.base_url) { const bad = urlProblem(s.base_url, `sources.${name}.base_url`, s.allow_http); if (bad) problems.push(`${bad}.`); }
    if (s.auth && s.auth.type === 'oauth2_client_credentials') {
      if (!s.auth.token_url && !s.auth.token_url_env) problems.push(`sources.${name}.auth: give "token_url" (or "token_url_env").`);
      if (s.auth.token_url) { const bad = urlProblem(s.auth.token_url, `sources.${name}.auth.token_url`, s.allow_http); if (bad) problems.push(`${bad}.`); }
    }
  }

  const names = Object.keys(lookups).filter((k) => lookups[k]);
  if (config.enabled && !names.length) problems.push('No lookups are configured. Add at least "contract" or "customer_by_email".');
  if (config.enabled && !lookups.contract && !lookups.customer_by_email) problems.push('Add the "contract" lookup, the "customer_by_email" lookup, or both: without them nothing can be found from an email.');

  for (const name of names) {
    const lk = lookups[name];
    const def = LOOKUPS[name];
    if (!sources[lk.source]) problems.push(`${plain(name)}.source "${lk.source}" is not in "sources" (known: ${Object.keys(sources).join(', ') || 'none'}).`);
    const ph = lookupPlaceholders(lk);
    for (const p of ph) {
      if (!VARIABLES.includes(p.name)) problems.push(`${plain(name)}: {${p.name}} is unknown. You can use ${VARIABLES.map((v) => `{${v}}`).join(', ')}.`);
      if (p.filter && !FILTERS[p.filter]) problems.push(`${plain(name)}: filter "${p.filter}" is unknown. Use digits, lower, upper, odata or quote.`);
    }
    if (!ph.some((p) => !p.optional)) problems.push(`${plain(name)} must use at least one required placeholder such as {email} or {contract_no}. Otherwise it would ask the API for everybody's records.`);
    if (lk.method === 'POST' && !lk.body) problems.push(`${plain(name)}: a POST lookup needs a "body".`);
    if (lk.scoped !== undefined && !['contracts_by_customer', 'invoices', 'fines', 'financials', 'contract', 'customer_by_id'].includes(name)) problems.push(`${plain(name)}: "scoped" is not used here.`);
    if (lk.method !== 'POST' && lk.body) problems.push(`${plain(name)}: "body" is only used with "method": "POST".`);
    for (const field of Object.keys(lk.map || {})) {
      if (!def.fields.includes(field)) problems.push(`${plain(name)}.map: "${field}" is not a field the helpdesk uses. Choose from: ${def.fields.join(', ')}.`);
    }
    for (const group of def.need) {
      if (!group.some((f) => (lk.map || {})[f] !== undefined)) problems.push(`${plain(name)}.map must say where to read ${group.length > 1 ? `at least one of: ${group.join(', ')}` : `"${group[0]}"`} in the answer.`);
    }
    if (!Object.keys(lk.map || {}).length) problems.push(`${plain(name)}.map is empty.`);
  }
  return problems;
}

/* ------------------------------------------------------------------------------------------------ loading */
const EMPTY = { ...DEFAULTS, sources: {}, lookups: {} };
let cached = null;
let lastGood = null; // the last version of the file that passed every check

/**
 * -> { file, exists, ok, problems: [text], config, usingLastGood }.
 * A file that is edited into a broken state does not switch the helpdesk to something else: the last good version keeps working
 * (usingLastGood) and the problems are shown on the setup page. Only a file that was never good leaves an empty configuration.
 */
export function loadConfig() {
  const file = configPath();
  let st;
  try { st = fs.statSync(file); } catch { return { file, exists: false, ok: true, problems: [], config: { ...EMPTY }, usingLastGood: false }; }
  if (cached && cached.file === file && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.value;
  let value;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const res = Config.safeParse(parsed);
    if (!res.success) {
      const problems = res.error.issues.slice(0, 25).map((i) => `${i.path.join('.') || 'file'}: ${i.message}`);
      value = { file, exists: true, ok: false, problems, config: { ...EMPTY } };
    } else {
      const config = { ...DEFAULTS, ...res.data, sources: res.data.sources || {}, lookups: res.data.lookups || {} };
      const problems = check(config);
      value = { file, exists: true, ok: problems.length === 0, problems, config };
    }
  } catch (e) {
    value = { file, exists: true, ok: false, problems: [`The file is not valid JSON: ${e.message}`], config: { ...EMPTY } };
  }
  if (value.ok) lastGood = { file, config: value.config };
  else if (lastGood && lastGood.file === file) value = { ...value, config: lastGood.config, usingLastGood: true };
  value.usingLastGood = Boolean(value.usingLastGood);
  cached = { file, mtime: st.mtimeMs, size: st.size, value };
  return value;
}

/** Forget the parsed file (tests change the file under the same name within one millisecond). */
export const resetConfigCache = ({ forgetGood = false } = {}) => { cached = null; if (forgetGood) lastGood = null; };

/** 'api' when the customer systems answer, 'crm' when the CRM's own records are used. HELPDESK_ACCOUNT_SOURCE overrides the file. */
export function accountMode() {
  const forced = String(process.env.HELPDESK_ACCOUNT_SOURCE || '').trim().toLowerCase();
  if (forced === 'crm' || forced === 'api') return forced;
  const c = loadConfig();
  if (!c.exists) return 'crm';
  if (!c.ok && !c.usingLastGood) return 'api'; // a file that exists but is broken never quietly becomes the demo records: lookups say why they cannot run
  return c.config.enabled ? 'api' : 'crm';
}

/** A source with its secrets' environment names resolved: which ones are still missing on the server. */
export function sourceRuntime(name, config = loadConfig().config) {
  const s = config.sources[name];
  if (!s) return null;
  const merged = { ...SOURCE_DEFAULTS, ...s, headers: s.headers || {}, auth: s.auth || { type: 'none' } };
  const baseUrl = (merged.base_url || (merged.base_url_env && process.env[merged.base_url_env]) || '').trim().replace(/\/+$/, '');
  const missing = [];
  const problems = [];
  if (!baseUrl) missing.push(merged.base_url_env || 'base_url');
  else { const bad = urlProblem(baseUrl, 'The base address', merged.allow_http); if (bad) problems.push(bad); }
  const a = merged.auth;
  if (a.type === 'oauth2_client_credentials') {
    const tokenUrl = a.token_url || (a.token_url_env && process.env[a.token_url_env]);
    if (tokenUrl) { const bad = urlProblem(tokenUrl, 'The sign-in address', merged.allow_http); if (bad) problems.push(bad); }
  }
  const need = (k) => { if (a[k] && !process.env[a[k]]) missing.push(a[k]); };
  if (a.type === 'api_key') need('key_env');
  if (a.type === 'bearer') need('token_env');
  if (a.type === 'basic') { need('user_env'); need('password_env'); }
  if (a.type === 'oauth2_client_credentials') { need('client_id_env'); need('client_secret_env'); if (!a.token_url && a.token_url_env && !process.env[a.token_url_env]) missing.push(a.token_url_env); }
  return { name, ...merged, baseUrl, missing: [...new Set(missing)], problems };
}
