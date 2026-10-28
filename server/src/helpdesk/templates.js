// Reply templates: choosing the approved one, filling its placeholders from the case and the contract,
// and building the draft. Only approved, active templates are used.
import { db } from '../db.js';
import { DEFAULT_TEMPLATES } from './templates.defaults.js';
import { defaultKeywordRows } from './dictionary.js';
import { addHours, nowUtc } from './routing.js';
import { getSettings } from './settings.js';
import { SUB_BY_KEY } from './taxonomy.js';
import { firstName } from './text.js';

/* ---------------------------------------------------------------- first-run data */
export function seedDefaultKeywords() {
  if (db.prepare('SELECT COUNT(*) n FROM hd_keywords').get().n) return 0;
  const ins = db.prepare('INSERT INTO hd_keywords (sub_key, language, term, weight, kind, source) VALUES (@sub_key, @language, @term, @weight, @kind, \'default\')');
  const rows = defaultKeywordRows();
  db.transaction(() => rows.forEach((r) => ins.run(r)))();
  return rows.length;
}

export function seedDefaultTemplates() {
  if (db.prepare('SELECT COUNT(*) n FROM hd_templates').get().n) return 0;
  const ins = db.prepare(`INSERT INTO hd_templates (sub_key, kind, language, name, subject, body, approved, active, note)
                          VALUES (@sub_key, @kind, @language, @name, @subject, @body, 1, 1, 'Sample wording. Replace with the approved text.')`);
  db.transaction(() => DEFAULT_TEMPLATES.forEach((t) => ins.run({ subject: null, ...t })))();
  return DEFAULT_TEMPLATES.length;
}

/* ---------------------------------------------------------------- rendering */
const truthy = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/** {{name}}, {{#name}}…{{/name}} (shown when set), {{^name}}…{{/name}} (shown when empty). */
export function renderTemplate(text, vars) {
  let out = String(text || '');
  const section = /\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
  let prev;
  do {
    prev = out;
    out = out.replace(section, (_m, type, name, inner) => ((type === '#' ? truthy(vars[name]) : !truthy(vars[name])) ? inner : ''));
  } while (out !== prev);
  const missing = [];
  out = out.replace(/\{\{(\w+)\}\}/g, (_m, name) => {
    if (truthy(vars[name])) return String(vars[name]);
    missing.push(name);
    return `[[${name}]]`;
  });
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), missing: [...new Set(missing)] };
}

/* ---------------------------------------------------------------- wording helpers */
const money = (n, lang) => {
  if (n === null || n === undefined || n === '') return '';
  const v = Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return lang === 'ar' ? `${v} درهم` : `AED ${v}`;
};
const dateText = (iso, lang) => {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB', { day: 'numeric', month: lang === 'ar' ? 'long' : 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
};
export function slaText(hours, lang) {
  if (hours < 24) {
    if (lang !== 'ar') return `${hours} hours`;
    return hours === 1 ? 'ساعة واحدة' : hours === 2 ? 'ساعتين' : `${hours} ساعات`;
  }
  const days = Math.ceil(hours / 24);
  if (lang !== 'ar') return `${days} working day${days > 1 ? 's' : ''}`;
  return days === 1 ? 'يوم عمل واحد' : days === 2 ? 'يومي عمل' : days <= 10 ? `${days} أيام عمل` : `${days} يوماً`;
}

const DEPOSIT = {
  held: { en: 'the deposit is being held until the final checks on the contract are complete', ar: 'مبلغ التأمين محتجز لحين اكتمال الفحص النهائي للعقد' },
  refund_pending: { en: 'your refund has been approved and is being processed', ar: 'تمت الموافقة على استرداد المبلغ وهو قيد المعالجة' },
  refunded: { en: 'the deposit has been refunded', ar: 'تم استرداد مبلغ التأمين' },
};
const PREAUTH = {
  active: { en: 'the hold is active and will be released after the contract is closed', ar: 'الحجز فعال وسيتم إلغاؤه بعد إغلاق العقد' },
  pending_release: { en: 'the release of the hold has been requested from the bank', ar: 'تم طلب إلغاء الحجز من البنك' },
  released: { en: 'the hold has been released', ar: 'تم إلغاء الحجز' },
};

function crmSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}

/**
 * Placeholder values for a case. `contract` is the account's contract (or null). `verified` says the sender is the customer on that
 * contract: when it is false the deposit, card hold, invoice, card, vehicle and branch details are left out of the reply (their sentences disappear, or show
 * as [[gaps]] a person must fill in), because a contract number typed in an email proves nothing about who sent it.
 */
export function templateVars(c, { contract = null, agentName = null, language = 'en', settings = getSettings(), now = nowUtc(), verified = true } = {}) {
  const fin = (verified && contract && contract.financials) || null;
  const invoice = verified && contract && contract.invoices && contract.invoices.find((i) => i.status !== 'draft');
  const sla = (settings.sla_hours && settings.sla_hours[c.priority]) || 48;
  const company = language === 'ar' ? (crmSetting('company_name_ar') || settings.company_name) : (crmSetting('company_name') || settings.company_name);
  const refundDue = fin && fin.deposit_refund_due ? dateText(fin.deposit_refund_due, language) : '';
  let depositStatus = fin && DEPOSIT[fin.deposit_status] ? DEPOSIT[fin.deposit_status][language] : '';
  if (depositStatus && refundDue && fin.deposit_status === 'refund_pending') depositStatus += language === 'ar' ? ` (المتوقع قبل ${refundDue})` : ` (expected by ${refundDue})`;
  return {
    customer_first_name: firstName(c.customer_name) || (language === 'ar' ? 'عميلنا العزيز' : 'Customer'),
    customer_name: c.customer_name || '',
    case_no: c.case_no,
    contract_no: c.contract_no && !c.contract_inferred ? c.contract_no : '',
    amount_text: money(c.amount, language),
    card_last4: c.card_last4 || (fin && fin.card_last4) || '',
    location: c.location || '',
    fine_ref: c.fine_ref || '',
    vehicle: verified && contract && contract.vehicle ? (contract.vehicle.name && contract.vehicle.plate ? `${contract.vehicle.name} (${contract.vehicle.plate})` : contract.vehicle.name || contract.vehicle.plate || '') : '',
    invoice_no: invoice ? invoice.number : '',
    invoice_total: invoice ? money(invoice.total, language) : '',
    deposit_amount: fin && fin.deposit_amount ? money(fin.deposit_amount, language) : '',
    deposit_status: depositStatus,
    preauth_status: fin && PREAUTH[fin.preauth_status] ? PREAUTH[fin.preauth_status][language] : '',
    preauth_released: fin && fin.preauth_released_at ? dateText(fin.preauth_released_at, language) : '',
    sla_text: slaText(sla, language),
    release_days: language === 'ar' ? settings.release_days_ar : settings.release_days_en,
    next_update: dateText(addHours(now, 72), language),
    close_date: dateText(addHours(now, 24 * settings.autoclose_days), language),
    branch_name: verified && contract && contract.pickup_branch ? contract.pickup_branch.name : '',
    department: language === 'ar' ? ({ 'Customer Happiness': 'إسعاد العملاء', Accounts: 'الحسابات', Branch: 'الفرع', Operations: 'العمليات', Management: 'الإدارة' }[c.department] || c.department || 'إسعاد العملاء') : (c.department || 'Customer Happiness'),
    agent_name: agentName || (language === 'ar' ? 'فريق إسعاد العملاء' : 'Customer Happiness Team'),
    support_phone: crmSetting('support_phone') || settings.support_phone,
    company_name: company,
  };
}

/* ---------------------------------------------------------------- choosing + building */
export function findTemplate(subKey, kind, language) {
  const pick = (key, lang) => db.prepare('SELECT * FROM hd_templates WHERE sub_key = ? AND kind = ? AND language = ? AND approved = 1 AND active = 1 ORDER BY id DESC LIMIT 1').get(key, kind, lang);
  return pick(subKey, language) || pick('*', language) || null;
}

const reSubject = (s) => `Re: ${String(s || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim()}`.trim();

/**
 * The draft for a case. kind: 'initial' (first reply) or 'followup' (reminder). -> null when no approved
 * template exists. The caller stores it; nothing is ever sent from here.
 */
export function buildDraft(c, { kind = 'initial', contract = null, agentName = null, settings = getSettings(), verified = true, accountNote = null } = {}) {
  const language = c.language === 'ar' ? 'ar' : 'en';
  let tpl = findTemplate(c.sub_key, kind, language);
  let note = null;
  let lang = language;
  if (!tpl && language === 'ar') {
    tpl = findTemplate(c.sub_key, kind, 'en');
    if (tpl) { lang = 'en'; note = 'No approved Arabic template for this request type: the English one was used.'; }
  }
  if (!tpl) return null;
  const vars = templateVars(c, { contract, agentName, language: lang, settings, verified });
  const { text, missing } = renderTemplate(tpl.body, vars);
  const sub = SUB_BY_KEY[c.sub_key];
  const warnings = [];
  if (note) warnings.push(note);
  if (missing.length) warnings.push(`Fill in before sending: ${missing.join(', ')}.`);
  if (c.sub_key === 'invoice_request' && vars.invoice_no) warnings.push('Attach the invoice PDF before sending (CNR Portal).');
  if (c.contract_inferred && c.contract_no) warnings.push(`Contract ${c.contract_no} was inferred from the sender. Confirm it with the customer.`);
  if (!verified && contract) warnings.push(`The sender's address is not the customer on contract ${contract.contract_no}, so deposit, card hold, invoice, vehicle and branch details were left out. Check who is writing, press "Confirm sender" if that is fine, then write the reply again.`);
  if (accountNote) warnings.push(accountNote);
  return {
    kind: kind === 'followup' ? 'followup' : 'reply',
    template_id: tpl.id, template_name: tpl.name, language: lang,
    to_email: c.customer_email, subject: reSubject(c.subject), body: text, original_body: text,
    sensitive: c.sensitive || (sub && sub.sensitive) ? 1 : 0,
    incomplete: missing.length ? 1 : 0,
    notes: warnings.join(' ') || null,
    generated_by: 'template',
  };
}
