// Pulls the facts out of an email: contract number, customer name and email, amounts, fine reference,
// card last four, location, phone and a mentioned date. Works on English and Arabic text
// (Arabic-Indic digits are converted first). Pure: pass patterns and branches in, no database access.
import { DEFAULTS } from './settings.js';
import { normalize, toAsciiDigits } from './text.js';

// [canonical name, emirate, aliases]. Aliases are matched on normalised text, longest first.
const PLACES = [
  ['Dubai International Airport', 'Dubai', ['dubai international airport', 'dubai airport', 'dxb', 'terminal 3', 'terminal 1', 'مطار دبي']],
  ['Abu Dhabi Airport', 'Abu Dhabi', ['abu dhabi airport', 'auh', 'مطار ابوظبي', 'مطار أبوظبي']],
  ['Al Quoz', 'Dubai', ['al quoz', 'alquoz', 'القوز']],
  ['Deira', 'Dubai', ['deira', 'al rigga', 'ديره', 'الرقه']],
  ['Business Bay', 'Dubai', ['business bay', 'الخليج التجاري']],
  ['Dubai Marina', 'Dubai', ['dubai marina', 'marina', 'مارينا']],
  ['JBR', 'Dubai', ['jbr', 'jumeirah beach residence']],
  ['Downtown Dubai', 'Dubai', ['downtown dubai', 'downtown', 'burj khalifa', 'وسط دبي', 'برج خليفه']],
  ['Dubai Mall', 'Dubai', ['dubai mall', 'دبي مول']],
  ['Mall of the Emirates', 'Dubai', ['mall of the emirates', 'مول الامارات']],
  ['Jumeirah', 'Dubai', ['jumeirah', 'جميرا']],
  ['Al Barsha', 'Dubai', ['al barsha', 'البرشاء']],
  ['JLT', 'Dubai', ['jlt', 'jumeirah lake towers', 'بحيرات جميرا']],
  ['Palm Jumeirah', 'Dubai', ['palm jumeirah', 'the palm', 'نخله جميرا']],
  ['Dubai Silicon Oasis', 'Dubai', ['silicon oasis', 'واحه السيليكون']],
  ['Sharjah', 'Sharjah', ['sharjah', 'al nahda', 'الشارقه', 'النهده']],
  ['Ajman', 'Ajman', ['ajman', 'عجمان']],
  ['Yas Island', 'Abu Dhabi', ['yas island', 'yas mall', 'جزيره ياس']],
  ['Musaffah', 'Abu Dhabi', ['musaffah', 'مصفح']],
  ['Al Zahiyah', 'Abu Dhabi', ['al zahiyah', 'zahiyah', 'الزاهيه']],
  ['Abu Dhabi', 'Abu Dhabi', ['abu dhabi', 'ابوظبي']],
  ['Ras Al Khaimah', 'Ras Al Khaimah', ['ras al khaimah', 'راس الخيمه']],
  ['Fujairah', 'Fujairah', ['fujairah', 'الفجيره']],
  ['Al Ain', 'Abu Dhabi', ['al ain', 'العين']],
  ['Dubai', 'Dubai', ['dubai', 'دبي']],
];

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const cleanContract = (raw) => {
  let v = String(raw || '').toUpperCase().replace(/\s+/g, '').replace(/[.,;:]+$/, '');
  if (/^AST\d+$/.test(v)) v = `AST-${v.slice(3)}`;
  if (!/\d{4}/.test(v) || /^(19|20)\d{2}$/.test(v)) return null;
  return v;
};

const plausibleName = (s) => {
  const v = String(s || '').replace(/["'<>]/g, '').trim();
  if (v.length < 2 || v.length > 60 || /@|\d|helpdesk|support|noreply|no-reply|info\b|admin|team\b|accounts?\b/i.test(v)) return null;
  if (!/^[\p{L}][\p{L} .'\-]+$/u.test(v)) return null;
  return v.replace(/\s+/g, ' ');
};

function findName(fromName, text) {
  const direct = plausibleName(fromName);
  if (direct) return direct;
  let m = /(?:my name is|i am|i'm|this is)\s+([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){0,2})/.exec(text);
  if (m && plausibleName(m[1])) return plausibleName(m[1]);
  m = /(?:اسمي|معك|انا)\s+([\u0600-\u06FF]{2,}(?:\s+[\u0600-\u06FF]{2,}){0,2})/.exec(text);
  if (m && plausibleName(m[1])) return plausibleName(m[1]);
  m = /(?:regards|best regards|kind regards|sincerely|thanks|thank you|many thanks|مع الشكر|شكرا|شكراً|تحياتي|مع تحياتي)[,.!]?\s*\n+\s*([^\n]{2,40})\s*(?:\n|$)/i.exec(text);
  if (m && plausibleName(m[1])) return plausibleName(m[1]);
  return null;
}

function findLocation(text, branches = []) {
  const labelled = /(?:location|pick[- ]?up (?:point|location)|address|الموقع|العنوان)\s*[:\-]\s*([^\n]{3,60})/i.exec(text);
  const norm = normalize(text);
  const candidates = [];
  for (const [name, , aliases] of PLACES) {
    for (const a of aliases) {
      const alias = normalize(a);
      const ar = /[\u0600-\u06FF]/.test(alias);
      const re = ar ? new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : new RegExp(`(?<![a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`);
      if (re.test(norm)) candidates.push({ name, len: alias.length });
    }
  }
  for (const b of branches) {
    const n = normalize(b.name || '');
    if (n.length > 4 && norm.includes(n)) candidates.push({ name: b.name, len: n.length + 5 });
  }
  candidates.sort((a, b) => b.len - a.len);
  if (candidates.length) return candidates[0].name;
  return labelled ? labelled[1].trim().replace(/[.,;]+$/, '') : null;
}

function findDate(text, now = new Date()) {
  let m = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(text);
  if (m) {
    const [d, mo] = [Number(m[1]), Number(m[2])];
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?\b/i.exec(text);
  if (m) {
    const y = m[3] ? Number(m[3]) : now.getUTCFullYear();
    return `${y}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
  }
  return null;
}

const AMOUNT_KEYWORDS = /(charge|charged|deduct|deposit|hold|held|block|fine|invoice|refund|paid|payment|خصم|مبلغ|تامين|تأمين|حجز|محجوز|مخالف|فاتور|استرداد|دفع)/i;
// the digits of an amount are a bounded run ({0,14} covers 10,000,000.00): an open-ended [0-9,]* restarted at every digit of "1,1,1,1,..." made this quadratic
const AMOUNT_RE = /(?:(?:AED|Dhs?\.?|Dirhams?|د\.?\s?إ|درهم|دراهم)\s*([0-9][0-9,]{0,14}(?:\.[0-9]{1,2})?))|(?:([0-9][0-9,]{0,14}(?:\.[0-9]{1,2})?)\s*(?:AED|Dhs?\.?|Dirhams?|دراهم|درهم))/gi;

/**
 * An email is untrusted input and the patterns (ours and the ones an admin saves) are regular expressions: a long run of spaces can make
 * the ones with optional words between runs of \\s* take seconds. So the text is capped and any run of four or more whitespace characters
 * is squeezed (a run with a line break becomes a blank line, the rest a single space) before anything is matched.
 */
const MAX_TEXT = 40000;
const squeeze = (t) => String(t || '').slice(0, MAX_TEXT)
  .replace(/\s{4,}/g, (run) => (/[\r\n]/.test(run) ? '\n\n' : ' '))
  .replace(/([^\p{L}\p{N}\s])\1{7,}/gu, '$1$1$1$1$1$1') // a run of one symbol (*****, -----, bullets) keeps six: card masks like **** still read
  .replace(/[0-9٠-٩۰-۹]{31,}/g, (run) => run.slice(0, 30)); // no real number or reference is longer than 30 digits

export function extractEntities({ subject = '', body = '', fromName = '', fromEmail = '' } = {}, ctx = {}, now = new Date()) {
  body = squeeze(body);
  subject = squeeze(subject).slice(0, 1000);
  const text = toAsciiDigits(`${subject}\n${body}`);
  const out = {
    contract_no: null, contract_candidates: [],
    customer_name: null, customer_email: fromEmail ? String(fromEmail).toLowerCase() : null,
    amounts: [], amount: null, currency: 'AED',
    fine_ref: null, card_last4: null, location: null, phone: null, mentioned_date: null,
  };

  // contract number
  const seen = new Set();
  for (const src of ctx.patterns || DEFAULTS.contract_patterns) {
    let re;
    try { re = new RegExp(src, 'gi'); } catch { continue; }
    let m;
    while ((m = re.exec(text))) {
      const v = cleanContract(m[1]);
      if (v && !seen.has(v)) { seen.add(v); out.contract_candidates.push(v); }
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  out.contract_no = out.contract_candidates[0] || null;

  // fine reference
  let m = /\b((?:TF|SLK)-\d{5,9})\b/i.exec(text)
    || /(?:fine|violation|ticket|salik|مخالفة|المخالفة)[\s:#.\-]{0,6}(?:(?:no|number|ref(?:erence)?|رقم)[\s:#.\-]{0,6})?([A-Z]{1,4}-?\d{5,10})/i.exec(text);
  if (m) out.fine_ref = m[1].toUpperCase();

  // amounts
  const found = [];
  AMOUNT_RE.lastIndex = 0;
  while ((m = AMOUNT_RE.exec(text))) {
    const n = Number(String(m[1] || m[2]).replace(/,/g, ''));
    if (n > 0 && n < 10000000) found.push({ n, at: m.index });
  }
  const uniq = [];
  for (const f of found) if (!uniq.some((u) => u.n === f.n)) uniq.push(f);
  out.amounts = uniq.slice(0, 4).map((u) => u.n);
  const withKeyword = uniq.find((u) => AMOUNT_KEYWORDS.test(text.slice(Math.max(0, u.at - 70), u.at + 70)));
  out.amount = (withKeyword || uniq[0] || {}).n ?? null;

  // card last four (before redaction: the raw digits are never stored)
  m = /(?:ending(?:\s+(?:in|with))?|last\s*(?:4|four)\s*digits?(?:\s+of\s+(?:my|the)\s+card)?(?:\s*(?:are|is|:))?|xxxx|x{4}|\*{3,}|•{3,}|تنتهي\s*ب|ينتهي\s*ب|اخر\s*4\s*ارقام|آخر\s*4\s*أرقام)[\s:\-ـ]*(\d{4})\b/i.exec(text);
  if (m) out.card_last4 = m[1];
  else if ((m = /\b(?:\d{4}[ -]){3}(\d{4})\b/.exec(text))) out.card_last4 = m[1];

  m = /(?:\+?971|00971|\b0)[\s-]?(?:5\d|[2-9])[\s-]?\d{3}[\s-]?\d{4}\b/.exec(text);
  if (m) out.phone = m[0].replace(/\s+/g, ' ').trim();

  out.customer_name = findName(fromName, body);
  out.location = findLocation(text, ctx.branches);
  out.mentioned_date = findDate(text, now);
  return out;
}

/** The emirate a canonical place belongs to (for picking a branch). */
export const emirateOfPlace = (name) => (PLACES.find((p) => p[0] === name) || [])[1] || null;
