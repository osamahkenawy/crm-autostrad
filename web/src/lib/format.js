// Formatting helpers. The API stores timestamps as UTC "YYYY-MM-DD HH:MM:SS" and dates as "YYYY-MM-DD".
// Autostrad operates in the UAE (UTC+4, no daylight saving), so people always see Gulf time.
export const TZ = 'Asia/Dubai';
const OFFSET_MS = 4 * 3600 * 1000;

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const aed = new Intl.NumberFormat('en-AE', { style: 'currency', currency: 'AED', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const aed0 = new Intl.NumberFormat('en-AE', { style: 'currency', currency: 'AED', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const aedCompact = new Intl.NumberFormat('en-AE', { style: 'currency', currency: 'AED', notation: 'compact', maximumFractionDigits: 1 });

export const num = (n) => nf0.format(Number(n) || 0);
export const num1 = (n) => nf1.format(Number(n) || 0);
export const money = (n) => aed.format(Number(n) || 0);
export const moneyShort = (n) => aed0.format(Math.round(Number(n) || 0));
export const moneyCompact = (n) => aedCompact.format(Number(n) || 0);

const isDateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** API string → Date (UTC instant) or null. */
export function toDate(s) {
  if (!s) return null;
  const str = String(s);
  const d = isDateOnly(str) ? new Date(`${str}T00:00:00Z`) : new Date(str.includes('T') ? str : `${str.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const dFmt = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ });
const dFmtUtc = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dtFmt = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
const tFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
const longDate = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });

export function fmtDate(s) {
  const d = toDate(s);
  if (!d) return '—';
  return (isDateOnly(String(s)) ? dFmtUtc : dFmt).format(d);
}
export function fmtDateTime(s) {
  const d = toDate(s);
  return d ? dtFmt.format(d).replace(',', '') : '—';
}
export const fmtTime = (s) => { const d = toDate(s); return d ? tFmt.format(d) : '—'; };
export const fmtLongDate = (d = new Date()) => longDate.format(d);
export const monthLabel = (ym) => monthFmt.format(new Date(`${ym}-01T00:00:00Z`));

/** Today's date in Gulf time, "YYYY-MM-DD". */
export const todayStr = () => new Date(Date.now() + OFFSET_MS).toISOString().slice(0, 10);
/** Now as the API stores it (UTC). */
export const nowUtc = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
export const hourInDubai = () => new Date(Date.now() + OFFSET_MS).getUTCHours();

/** Whole days from today to a date-only value (negative = past). */
export function daysUntil(dateStr) {
  const d = toDate(dateStr);
  if (!d) return null;
  return Math.round((d.getTime() - toDate(todayStr()).getTime()) / 86400000);
}

export function relTime(s) {
  const d = toDate(s);
  if (!d) return '';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  const abs = Math.abs(mins);
  const unit = abs < 60 ? [abs, 'min'] : abs < 1440 ? [Math.round(abs / 60), 'h'] : [Math.round(abs / 1440), 'd'];
  return mins >= 0 ? `${unit[0]}${unit[1]} ago` : `in ${unit[0]}${unit[1]}`;
}

export function duration(mins) {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** UTC API timestamp ⇄ <input type="datetime-local"> value, both in Gulf time. */
export function toInputDT(s) {
  const d = toDate(s);
  return d ? new Date(d.getTime() + OFFSET_MS).toISOString().slice(0, 16) : '';
}
export function fromInputDT(v) {
  if (!v) return null;
  const d = new Date(`${v}:00Z`);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getTime() - OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

export const initials = (name = '') => String(name).replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
export const humanize = (v) => { const s = String(v ?? '').replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };
export const pctChange = (cur, prev) => (prev ? ((cur - prev) / prev) * 100 : null);
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
