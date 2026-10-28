// Text helpers shared by extraction and classification: Arabic and English normalisation, language
// detection, removal of quoted history and signatures, and redaction of sensitive data.

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** Arabic-Indic and Persian digits to ASCII. */
export const toAsciiDigits = (s) => String(s || '')
  .replace(/[٠-٩]/g, (d) => ARABIC_INDIC.indexOf(d))
  .replace(/[۰-۹]/g, (d) => EASTERN_INDIC.indexOf(d));

/**
 * Normal form used for keyword matching on both the email and the dictionary: lower case, no Arabic
 * diacritics or tatweel, alef / ya / ta-marbuta variants merged, ASCII digits, single spaces.
 */
export function normalize(s) {
  return toAsciiDigits(s)
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[’‘`´]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const AR = /[؀-ۿݐ-ݿ]/g;

/** 'ar' | 'en' | 'mixed', by the share of Arabic letters. */
export function detectLanguage(text) {
  const letters = String(text || '').replace(/[^A-Za-z؀-ۿݐ-ݿ]/g, '');
  if (!letters.length) return 'en';
  const ratio = (String(text).match(AR) || []).length / letters.length;
  return ratio > 0.55 ? 'ar' : ratio > 0.15 ? 'mixed' : 'en';
}
/** Which language to reply in. */
export const replyLanguage = (text) => (detectLanguage(text) === 'en' ? 'en' : (detectLanguage(text) === 'ar' ? 'ar' : ((String(text).match(AR) || []).length > 25 ? 'ar' : 'en')));

const QUOTE_START = [
  /^\s*On .{5,160}wrote:\s*$/im,
  /^\s*-{2,}\s*Original Message\s*-{2,}/im,
  /^\s*From:\s.+\r?\n\s*(?:Sent|Date):\s/im,
  /^\s*_{5,}\s*$/m,
  /^\s*Sent from my (?:iPhone|iPad|Android|Samsung|mobile)/im,
  /^\s*Get Outlook for /im,
  /^\s*(?:في|بتاريخ).{5,120}كتب.{0,60}:\s*$/m,
  /^\s*-{2,}\s*(?:الرسالة الأصلية|رسالة أصلية)\s*-{2,}/m,
  /^\s*(?:This|The) (?:e-?mail|message) (?:and any attachments )?(?:is|are) confidential/im,
  /^\s*DISCLAIMER\b/m,
];

/** The part of an email the customer actually wrote in this message (no quoted history or boilerplate). */
export function stripQuoted(text) {
  let t = String(text || '').replace(/\r\n/g, '\n');
  let cut = t.length;
  for (const re of QUOTE_START) {
    const m = re.exec(t);
    if (m && m.index < cut) cut = m.index;
  }
  t = t.slice(0, cut).split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
  return t.replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);
}

const luhn = (digits) => {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
};

/**
 * Masks what must never sit in the case history or go to an AI service: card numbers (Luhn-valid,
 * keeping the last four), Emirates ID, IBAN and CVV. -> { text, redactions }
 */
export function redact(text) {
  let count = 0;
  let t = toAsciiDigits(text || '');
  t = t.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return m;
    count++;
    return `**** **** **** ${digits.slice(-4)}`;
  });
  t = t.replace(/\b784[- ]?\d{4}[- ]?\d{7}[- ]?\d\b/g, (m) => { count++; return `784-****-*******-${m.slice(-1)}`; });
  t = t.replace(/\bAE\d{2}(?:[ ]?\d){19}\b/gi, // a UAE IBAN is AE + 21 digits (23 characters), with or without spaces
     (m) => { count++; return `AE** **** **** **** ${m.replace(/\s/g, '').slice(-4)}`; });
  t = t.replace(/\b(cvv2?|cvc)\b(\D{0,6})\d{3,4}\b/gi, (_m, label, gap) => { count++; return `${label}${gap}***`; });
  return { text: t, redactions: count };
}

export const excerpt = (text, n = 160) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const firstName = (name) => {
  const clean = String(name || '').replace(/\(.*?\)/g, '').replace(/[,;].*$/, '').trim();
  const first = clean.split(/\s+/)[0] || '';
  return /^(mr|mrs|ms|dr|eng|sheikh|mohammed|muhammad)\.?$/i.test(first) && clean.split(/\s+/)[1] ? `${first} ${clean.split(/\s+/)[1]}` : first;
};
