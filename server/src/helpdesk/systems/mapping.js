// A small, safe mapping language: it turns whatever a customer-data API returns into the fields the helpdesk uses.
// There is no code and no eval in the configuration. A field is one of
//   "data.customer.full_name"                   a path (a.b[0].c, or a.0.c; "*" reads every item of a list)
//   ["data.email", "data.contact.email"]        paths tried in order, the first one with a value wins
//   { path | paths | template | value, type, map, scale, default, ... }   a path plus what to do with it
// Types: string (default), number, money, int, bool, date, datetime, email, lower, upper, list.
// Everything it returns is plain text or numbers: control characters are removed and long text is cut.

const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_TEXT = 2000;

const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** Read a.b[0].c from an object. Missing steps give undefined. "*" collects the rest of the path from every item of a list. */
export function getPath(obj, path) {
  if (obj === null || obj === undefined) return undefined;
  const p = String(path ?? '').trim().replace(/^\$\.?/, '');
  if (p === '' || p === '.') return obj;
  const parts = p.match(/[^.[\]]+/g);
  if (!parts) return undefined;
  const walk = (cur, i) => {
    if (i === parts.length) return cur;
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    const part = parts[i];
    if (part === '*') {
      if (!Array.isArray(cur)) return undefined;
      return cur.map((item) => walk(item, i + 1)).filter((v) => v !== undefined);
    }
    if (BLOCKED.has(part)) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      return Number.isInteger(idx) ? walk(cur.at(idx), i + 1) : undefined;
    }
    return Object.prototype.hasOwnProperty.call(cur, part) ? walk(cur[part], i + 1) : undefined;
  };
  return walk(obj, 0);
}

/** The rows a lookup returns: an array stays an array, one object becomes a list of one, nothing becomes an empty list. */
export function rowsAt(response, resultPath) {
  const at = resultPath ? getPath(response, resultPath) : response;
  if (at === undefined || at === null) return [];
  if (Array.isArray(at)) return at.filter((r) => r && typeof r === 'object');
  return typeof at === 'object' ? [at] : [];
}

/* ------------------------------------------------------------------------------------------------ scalars */
// control characters, and the invisible line and direction marks that can disguise text, built from code points so the file stays plain ASCII
const RANGES = [[0, 8], [11, 12], [14, 31], [127, 159], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]];
const CONTROL = new RegExp(`[${RANGES.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g');

export function cleanText(v, max = MAX_TEXT) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v !== 'string') return undefined; // an object or list is not text: say nothing rather than "[object Object]"
  const s = v.replace(CONTROL, ' ').replace(/[ \t]+/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}

const CURRENCY = '(?:AED|USD|SAR|EUR|GBP|DHS?|DH|\\$|\u20ac|\u00a3|\u062f\\.\u0625|\u062f\u0631\u0647\u0645)';
const CUR_BEFORE = new RegExp(`^${CURRENCY}\\s*`, 'i');
const CUR_AFTER = new RegExp(`\\s*${CURRENCY}$`, 'i');

/**
 * "1,234.50", "AED 1 234,50", "(12.00)", "5-", 1250 -> a number. Undefined when it is not one: only a currency word or sign may stand
 * next to the digits, so "1e3", "AST-100123" or "12abc" are not read as numbers.
 */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  let s = v.trim().replace(CUR_BEFORE, '').replace(CUR_AFTER, '').trim();
  if (!s) return undefined;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  if (/[-\u2212]$/.test(s)) { negative = !negative; s = s.slice(0, -1).trim(); } // accounting style "5-"
  if (/^[-\u2212]/.test(s)) { negative = !negative; s = s.slice(1).trim(); } else if (s.startsWith('+')) s = s.slice(1).trim();
  if (!/^\d[\d.,\s']*$/.test(s)) return undefined;
  s = s.replace(/[\s']/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // the separator that comes last is the decimal point
    s = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (lastComma >= 0) {
    // "1,234" is a thousand, "12,50" is twelve and a half, "0,500" is a half
    s = /^\d{1,3}(,\d{3})+$/.test(s) && !/^0,/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if ((s.match(/\./g) || []).length > 1) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -n : n) : undefined;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const ymdhms = (d) => `${ymd(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const HOUR = 3600000;

/**
 * Read a date or an instant. -> { ms, dateOnly } or null.
 * A text without a zone ("2026-10-01 10:00") is local time in `offset` hours from UTC (Gulf time by default).
 */
export function parseInstant(v, { offset = 4, order = 'dmy' } = {}) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    return { ms: v < 1e11 ? v * 1000 : v, dateOnly: false };
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(s);
  if (m) return { ms: Number(m[1]), dateOnly: false };
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(s);
  if (m) {
    const [, y, mo, d, h, mi, se, zone] = m;
    if (h === undefined) return validDate(Date.UTC(+y, +mo - 1, +d), +y, +mo, +d) ? { ms: Date.UTC(+y, +mo - 1, +d), dateOnly: true } : null;
    if (!validTime(h, mi, se)) return null;
    let shift = offset * HOUR;
    if (zone) {
      if (/^z$/i.test(zone)) shift = 0;
      else { const z = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone); shift = (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3] || 0)) * 60000; }
    }
    if (!validDate(Date.UTC(+y, +mo - 1, +d), +y, +mo, +d)) return null;
    return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se || 0)) - shift, dateOnly: false };
  }
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const [, a, b, y, h, mi, se] = m;
    const day = order === 'mdy' ? +b : +a;
    const mon = order === 'mdy' ? +a : +b;
    if (!validDate(Date.UTC(+y, mon - 1, day), +y, mon, day)) return null;
    if (h === undefined) return { ms: Date.UTC(+y, mon - 1, day), dateOnly: true };
    if (!validTime(h, mi, se)) return null;
    return { ms: Date.UTC(+y, mon - 1, day, +h, +mi, +(se || 0)) - offset * HOUR, dateOnly: false };
  }
  // "Tue, 01 Oct 2026 10:00:00 GMT", "1 October 2026", "01-Oct-2026": read by hand, never through Date.parse
  m = /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(GMT|UTC|Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (m) {
    const [, d, name, y, h, mi, se, zone] = m;
    const mon = MONTH_INDEX(name);
    if (mon < 0 || !validDate(Date.UTC(+y, mon, +d), +y, mon + 1, +d)) return null;
    if (h === undefined) return { ms: Date.UTC(+y, mon, +d), dateOnly: true };
    if (!validTime(h, mi, se)) return null;
    let shift = offset * HOUR;
    if (zone) { const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone); shift = z ? (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3])) * 60000 : 0; }
    return { ms: Date.UTC(+y, mon, +d, +h, +mi, +(se || 0)) - shift, dateOnly: false };
  }
  return null;
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_INDEX = (name) => { const n = String(name).toLowerCase(); return n.length >= 3 ? MONTH_NAMES.findIndex((full) => full.startsWith(n) || (n === 'sept' && full === 'september')) : -1; };
const validTime = (h, mi, se) => +h <= 23 && +mi <= 59 && (se === undefined || +se <= 59);

const validDate = (ms, y, mo, d) => { const dt = new Date(ms); return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d; };

/** type "date" -> "2026-10-06" (the business-day calendar date), type "datetime" -> "2026-10-06 06:00:00" in UTC. */
export function toDateText(v, type, opts = {}) {
  const t = parseInstant(v, opts);
  if (!t) return undefined;
  const offset = opts.offset ?? 4;
  if (type === 'date') return t.dateOnly ? ymd(new Date(t.ms)) : ymd(new Date(t.ms + offset * HOUR));
  return t.dateOnly ? `${ymd(new Date(t.ms))} 00:00:00` : ymdhms(new Date(t.ms));
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'on', 'active', 'enabled']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'off', 'inactive', 'disabled']);
export function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  return undefined;
}

/* ------------------------------------------------------------------------------------------------ field specs */
const lookup = (map, value) => {
  if (!map || value === undefined || value === null) return { hit: false };
  const key = String(value).trim().toLowerCase();
  for (const [k, to] of Object.entries(map)) if (k.trim().toLowerCase() === key) return { hit: true, to };
  return { hit: false };
};

const firstFilled = (row, paths) => {
  for (const p of paths) {
    const v = getPath(row, p);
    if (!isEmpty(v)) return v;
  }
  return undefined;
};

/** "{first_name} {last_name}" with every {path} read from the row. Nothing found at all -> undefined. */
function fillTemplate(row, template) {
  let found = false;
  const text = String(template).replace(/\{([^{}]+)\}/g, (_m, p) => {
    const v = getPath(row, p.trim());
    const s = cleanText(Array.isArray(v) ? v.join(', ') : v);
    if (s) found = true;
    return s || '';
  });
  return found ? text.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').trim() : undefined;
}

/**
 * Evaluate one field spec against a row. ctx may carry { offset, warn(message) }.
 * Returns undefined when the row has nothing for it (and no default).
 */
export function pick(row, spec, ctx = {}) {
  if (spec === undefined || spec === null) return undefined;
  if (typeof spec === 'string') return finish(row, { path: spec }, ctx);
  if (Array.isArray(spec)) return finish(row, { paths: spec }, ctx);
  if (typeof spec === 'object') return finish(row, spec, ctx);
  return undefined;
}

function finish(row, spec, ctx) {
  const paths = spec.paths || (spec.path !== undefined ? [spec.path] : []);
  // the fallback paths may themselves be full specs; a plain string is by far the usual case
  let raw;
  if (spec.template !== undefined) raw = fillTemplate(row, spec.template);
  else if (spec.value !== undefined) raw = spec.value;
  else {
    for (const p of paths) {
      const v = typeof p === 'string' ? getPath(row, p) : pick(row, p, ctx);
      if (!isEmpty(v)) { raw = v; break; }
    }
  }
  if (isEmpty(raw)) return spec.default;

  const type = spec.type || 'string';
  const shown = typeof raw === 'object' ? '(a list or object)' : String(raw).slice(0, 60);
  const warn = (what) => { if (ctx.warn) ctx.warn(`${what} "${shown}"`); };
  const mapped = lookup(spec.map, raw);
  let value = mapped.hit ? mapped.to : raw;
  if (!mapped.hit && spec.map && spec.unmapped === 'null') return spec.default;

  let out;
  switch (type) {
    case 'number':
    case 'money':
    case 'int': {
      let n = toNumber(value);
      if (n === undefined) { warn('Not a number:'); return spec.default; }
      if (spec.scale !== undefined) n *= Number(spec.scale);
      out = type === 'int' ? Math.round(n) : Math.round(n * 100) / 100;
      break;
    }
    case 'bool': out = toBool(value); if (out === undefined) { warn('Not yes or no:'); return spec.default; } break;
    case 'date':
    case 'datetime': {
      out = toDateText(value, type, { offset: spec.utc_offset_hours ?? ctx.offset ?? 4, order: spec.date_order || 'dmy' });
      if (out === undefined) { warn('Not a date:'); return spec.default; }
      break;
    }
    case 'email': out = cleanText(value, 200); out = out ? out.toLowerCase() : undefined; break;
    case 'lower': out = cleanText(value); out = out ? out.toLowerCase() : undefined; break;
    case 'upper': out = cleanText(value); out = out ? out.toUpperCase() : undefined; break;
    case 'list': {
      const list = (Array.isArray(value) ? value : String(value).split(/[;,]/)).map((x) => cleanText(x, 200)).filter(Boolean);
      out = list.length ? list : undefined;
      break;
    }
    default: {
      out = cleanText(Array.isArray(value) ? value.map((x) => cleanText(x)).filter(Boolean).join(spec.join || ', ') : value);
      if (out !== undefined && spec.prefix) out = `${spec.prefix}${out}`;
      if (out !== undefined && spec.suffix) out = `${out}${spec.suffix}`;
    }
  }
  return out === undefined ? spec.default : out;
}

/** Map one row to { field: value } using { field: spec }. Fields with no value are left out. */
export function mapRow(row, fields, ctx = {}) {
  const out = {};
  for (const [name, spec] of Object.entries(fields || {})) {
    const v = pick(row, spec, { ...ctx, field: name, warn: ctx.warn ? (m) => ctx.warn(`${name}: ${m}`) : undefined });
    if (v !== undefined && v !== null) out[name] = v;
  }
  return out;
}
