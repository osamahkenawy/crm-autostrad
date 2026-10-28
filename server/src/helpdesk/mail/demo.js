// The built-in demo mailbox: sample emails are queued (by the "receive emails" button or the seed) and
// arrive through the same sync path as the real mailbox. Sending is simulated.
import { db } from '../../db.js';
import { generateEmail, pickSubKey } from '../demo.js';
import { nowUtc } from '../routing.js';
import { getSettings } from '../settings.js';

const rid = () => Math.random().toString(36).slice(2, 10);

export function queueMessage(payload) {
  db.prepare('INSERT INTO hd_demo_inbox (payload) VALUES (?)').run(JSON.stringify(payload));
}

/** Queue `n` new customer emails (mix follows the 2026 case distribution). -> the generated emails */
export function queueNewEmails(n = 3, { subKey = null, lang = null, receivedAt = null, rnd = Math.random } = {}) {
  const mailbox = getSettings().mailbox;
  const out = [];
  for (let i = 0; i < n; i++) {
    const key = subKey || pickSubKey(rnd);
    const language = lang || (rnd() < 0.25 ? 'ar' : 'en');
    const e = generateEmail({ subKey: key, lang: language, rnd, noContract: rnd() < 0.15, otherSender: rnd() < 0.1 });
    queueMessage({
      providerId: `demo-${Date.now().toString(36)}-${rid()}`, conversationId: `demo-conv-${rid()}`, direction: 'in',
      from: { name: e.fromName, email: e.fromEmail }, to: [mailbox], subject: e.subject, body: e.body, receivedAt: receivedAt || nowUtc(),
    });
    out.push(e);
  }
  return out;
}

/** A customer email typed by hand or taken from the sample library, arriving through the demo mailbox like any other. */
export function queueSampleEmail({ subject, body, customerId = null }) {
  let customer = customerId ? db.prepare('SELECT id, name, email FROM customers WHERE id = ?').get(Number(customerId)) : null;
  if (customerId && (!customer || !customer.email)) throw new Error('That customer has no email address.');
  if (!customer) {
    customer = db.prepare(`SELECT c.id, c.name, c.email FROM customers c WHERE c.email IS NOT NULL AND c.segment = 'Individual'
                             AND EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = c.id AND b.status IN ('completed', 'active')) ORDER BY RANDOM() LIMIT 1`).get();
  }
  if (!customer) throw new Error('There are no customers with an email address in the CRM to send from.');
  const booking = db.prepare("SELECT ref FROM bookings WHERE customer_id = ? AND status IN ('completed', 'active') ORDER BY end_at DESC LIMIT 1").get(customer.id);
  // the sample's contract number becomes this customer's real one, so the CRM lookup finds a contract
  const swap = (t) => (booking ? String(t || '').replace(/\bAST-\d{5,8}\b/g, booking.ref) : String(t || ''));
  const providerId = `demo-sample-${Date.now().toString(36)}-${rid()}`;
  queueMessage({ providerId, conversationId: `demo-conv-${rid()}`, direction: 'in', from: { name: customer.name, email: customer.email }, to: [getSettings().mailbox], subject: swap(subject), body: swap(body), receivedAt: nowUtc() });
  return { providerId, customer };
}

const FOLLOW_UPS = {
  en: ['Thank you for your reply. I have attached the statement you asked for. Please let me know once it is checked.', 'Any update on this please? I have not heard back yet.', 'Thanks, that is clear. Issue resolved on my side.'],
  ar: ['شكراً على ردكم. أرفقت كشف الحساب المطلوب، أرجو إفادتي بعد المراجعة.', 'هل من مستجدات بخصوص طلبي؟ لم يصلني أي رد حتى الآن.', 'شكراً لكم، تم حل المشكلة.'],
};

/** Queue a reply from the customer on an existing case's thread. */
export function queueCustomerReply(c, { text = null, receivedAt = null, subject = null } = {}) {
  const lang = c.language === 'ar' ? 'ar' : 'en';
  const list = FOLLOW_UPS[lang];
  queueMessage({
    providerId: `demo-${Date.now().toString(36)}-${rid()}`, conversationId: c.conversation_id, direction: 'in',
    from: { name: c.customer_name, email: c.customer_email }, to: [getSettings().mailbox],
    subject: subject || `Re: ${c.subject} [${c.case_no}]`, body: text || list[Math.floor(Math.random() * list.length)], receivedAt: receivedAt || nowUtc(),
  });
}

export const demoProvider = {
  name: 'demo',
  async status() {
    const pending = db.prepare('SELECT COUNT(*) n FROM hd_demo_inbox WHERE processed_at IS NULL').get().n;
    return { connected: true, label: 'Demo mailbox', mailbox: getSettings().mailbox, pending, detail: 'Built-in sample mailbox. Set HELPDESK_PROVIDER=graph and the Microsoft 365 credentials to read the real shared mailbox.' };
  },
  async fetchNew() {
    const rows = db.prepare('SELECT id, payload FROM hd_demo_inbox WHERE processed_at IS NULL ORDER BY id').all();
    return {
      messages: rows.map((r) => JSON.parse(r.payload)),
      commit: () => { if (rows.length) db.prepare(`UPDATE hd_demo_inbox SET processed_at = datetime('now') WHERE id IN (${rows.map((r) => r.id).join(',')})`).run(); },
    };
  },
  async applyTracking() { return true; },
  async createDraft({ draft }) { return { providerId: `demo-draft-${draft.id}` }; },
  async sendReply({ case: c, draft }) {
    const sentAt = nowUtc();
    return { providerId: `demo-sent-${draft.id}-${rid()}`, internetId: `<demo-${rid()}@autostrad.local>`, conversationId: c.conversation_id, sentAt, webLink: null };
  },
};
