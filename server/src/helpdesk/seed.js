// Demo data for the helpdesk: reply wording, routing rules, deposit and card-hold records for the contracts,
// and about 150 customer emails spread over the last 45 days that go through the same pipeline as live mail
// (classification, priority, routing, drafts), then get answered, chased, closed or left open the way a real
// week looks. Everything is backdated afterwards so the dashboard, trends and reports have a history.
// It never calls the Anthropic API or Microsoft Graph, whatever the environment says.
import { db } from '../db.js';
import { audit } from './audit.js';
import { closeCase, getCaseRow, setStatus, updateCase } from './cases.js';
import { approveDraft, SENSITIVE_APPROVER_ROLES, updateDraft } from './drafts.js';
import { generateEmail, pickSubKey } from './demo.js';
import { runFollowups } from './followups.js';
import { invalidateDictionary } from './knowledge.js';
import { seedTestSet } from './lab.js';
import { demoProvider } from './mail/demo.js';
import { gulfToday } from './metrics.js';
import { ingestMessage } from './pipeline.js';
import { generateReport } from './reports.js';
import { addHours } from './routing.js';
import { getSettings, setState } from './settings.js';
import { SUBCATEGORIES } from './taxonomy.js';
import { seedDefaultKeywords, seedDefaultTemplates } from './templates.js';

const T = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const HOUR = 3600000;

/** Empties every helpdesk table (the main seed calls this before it deletes the users they point at). */
export function resetHelpdesk() {
  db.exec(`DELETE FROM hd_audit; DELETE FROM hd_notes; DELETE FROM hd_drafts; DELETE FROM hd_messages; DELETE FROM hd_cases; DELETE FROM hd_routing_rules;
           DELETE FROM hd_contract_financials; DELETE FROM hd_channel_stats; DELETE FROM hd_reports; DELETE FROM hd_demo_inbox;
           DELETE FROM hd_state; DELETE FROM hd_settings; DELETE FROM hd_test_runs; DELETE FROM hd_test_cases;
           DELETE FROM hd_templates; DELETE FROM hd_keywords;`);
  invalidateDictionary();
}

const THANKS = {
  en: ['Thank you, that is clear. The issue is resolved on my side.', 'Thanks for the quick reply, I have received it. All good now.', 'Many thanks, problem solved.'],
  ar: ['شكراً جزيلاً، تم حل المشكلة.', 'شكراً على الرد السريع، وصلني المبلغ.', 'شكراً لكم، كل شيء واضح الآن.'],
};
const REMINDER = {
  en: 'Dear customer, we are following up on your request. If you have any further details or documents, please reply to this email and we will continue right away.',
  ar: 'عميلنا العزيز، نتابع معكم بخصوص طلبكم. في حال توفر أي تفاصيل أو مستندات إضافية يرجى الرد على هذا البريد لنتابع فوراً.',
};
const EXTRA_LINE = {
  en: 'Please let us know if there is anything else we can help with.',
  ar: 'يسعدنا خدمتكم في أي وقت إذا احتجتم أي مساعدة إضافية.',
};
// short, vague emails the engine cannot be sure about: they land in the "To check" queue, as real ones do
const VAGUE_AT = [118, 126, 134, 141, 146, 149]; // which of the 150 emails are the vague ones (late, so the flagged ones are recent)
const VAGUE = [
  ['Booking', 'Hi, I need help with my booking, please call me.'],
  ['Re: Your booking confirmation', 'I have a question about the above, can someone get back to me?'],
  ['مساعدة', 'السلام عليكم، ابغى مساعدة بخصوص الحجز، ممكن أحد يتواصل معي؟'],
  ['question', 'Can someone explain what happened with my last rental? I am not happy about how it ended.'],
  ['Help', 'pls help asap'],
  ['Re: reminder', 'Hello, following the previous message. Thanks.'],
];
// request types staff most often re-file into each other (used for the demo override history)
const CONFUSED = { unrecognized_charge: 'billing_complaint', deposit_refund: 'refund_request', fine_dispute: 'damage_dispute', service_complaint: 'staff_complaint', preauth_followup: 'unrecognized_charge', billing_complaint: 'unrecognized_charge' };

/** Small seeded generator (mulberry32): the demo data is the same on every run. */
const mulberry32 = (a) => () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export async function seedHelpdesk({ seed = 20261027, cases = 150, days = 45 } = {}) {
  const rnd = mulberry32(seed);
  const keep = { p: process.env.HELPDESK_PROVIDER, l: process.env.HELPDESK_LLM_MODE, s: process.env.HELPDESK_SEND_MODE };
  process.env.HELPDESK_PROVIDER = 'demo';
  process.env.HELPDESK_LLM_MODE = 'off';
  process.env.HELPDESK_SEND_MODE = 'send_after_approval';
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const stats = { cases: 0, closed: 0, errors: 0, unanswered: 0, waiting_for_details: 0 };

  try {
    seedDefaultKeywords();
    seedDefaultTemplates();
    seedTestSet();
    invalidateDictionary();

    // routing: one editable rule per request type, starting from the standard department
    const insRule = db.prepare('INSERT INTO hd_routing_rules (sub_key, department, note) VALUES (?, ?, ?)');
    for (const s of SUBCATEGORIES) insRule.run(s.key, s.department, 'Standard routing');

    // deposit and card-hold records for contracts that have ended or are running
    const insFin = db.prepare(`INSERT INTO hd_contract_financials (contract_no, deposit_amount, deposit_status, deposit_refund_due, preauth_amount, preauth_status, preauth_released_at, card_last4)
                               VALUES (@contract_no, @deposit_amount, @deposit_status, @deposit_refund_due, @preauth_amount, @preauth_status, @preauth_released_at, @card_last4)`);
    const done = db.prepare("SELECT ref, status, end_at, product_line FROM bookings WHERE status IN ('completed', 'active')").all();
    db.transaction(() => {
      for (const b of done) {
        const end = new Date(`${String(b.end_at).replace(' ', 'T')}Z`);
        const deposit = pick([500, 1000, 1500, 2000]);
        const ended = b.status === 'completed';
        const dueAt = new Date(end.getTime() + (14 + Math.floor(rnd() * 8)) * 24 * HOUR);
        const r = rnd();
        insFin.run({
          contract_no: b.ref, deposit_amount: deposit,
          deposit_status: !ended ? 'held' : r < 0.6 ? 'refunded' : r < 0.9 ? 'refund_pending' : 'held',
          deposit_refund_due: ended ? T(dueAt).slice(0, 10) : null,
          preauth_amount: pick([1000, 1500, 2000, 3000]),
          preauth_status: !ended ? 'active' : r < 0.65 ? 'released' : r < 0.85 ? 'pending_release' : 'active',
          preauth_released_at: ended && r < 0.65 ? T(end.getTime() + 2 * 24 * HOUR).slice(0, 10) : null,
          card_last4: String(1000 + Math.floor(rnd() * 8999)),
        });
      }
    })();

    // WhatsApp and phone are not connected to this module: staff enter the daily counts by hand (demo figures here)
    const insCh = db.prepare('INSERT OR REPLACE INTO hd_channel_stats (day, channel, count, note) VALUES (?, ?, ?, ?)');
    for (let d = 0; d < 30; d++) {
      const day = T(Date.now() - d * 24 * HOUR).slice(0, 10);
      insCh.run(day, 'whatsapp', 1 + Math.floor(rnd() * 4), 'Demo figure, replace with the real count');
      insCh.run(day, 'calls', 2 + Math.floor(rnd() * 5), 'Demo figure, replace with the real count');
    }

    /* ----------------------------------------------------------- the cases */
    const settings = getSettings();
    const nowMs = Date.now();
    const staff = db.prepare("SELECT id, name, role, department FROM users WHERE status = 'active'").all();
    const byId = Object.fromEntries(staff.map((u) => [u.id, u]));
    const approvers = staff.filter((u) => SENSITIVE_APPROVER_ROLES.includes(u.role));
    const bookingIds = db.prepare("SELECT b.id FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.status IN ('completed', 'active') AND c.segment = 'Individual'").all().map((r) => r.id);
    const approverFor = (c, draft) => {
      const owner = byId[c.owner_id];
      if (owner && (!draft.sensitive || SENSITIVE_APPROVER_ROLES.includes(owner.role))) return owner;
      const same = approvers.filter((u) => u.department === c.department);
      return pick(same.length ? same : approvers);
    };

    // arrival times: busier recently, inside office hours, oldest first so case numbers rise with time
    const times = [];
    for (let i = 0; i < cases; i++) {
      const d = Math.floor(days * rnd() ** 1.3);
      const dt = new Date(nowMs - d * 24 * HOUR - rnd() * 24 * HOUR);
      dt.setUTCHours(3 + Math.floor(rnd() * 14), Math.floor(rnd() * 60), Math.floor(rnd() * 60));
      let t = dt.getTime();
      if (t > nowMs - 5 * 60000) t = nowMs - (5 + Math.floor(rnd() * 120)) * 60000;
      times.push(t);
    }
    times.sort((a, b) => a - b);

    const lastAudit = () => db.prepare('SELECT COALESCE(MAX(id), 0) m FROM hd_audit').get().m;
    /** Runs `fn`, then dates every audit row it wrote at `ms` (one row every few seconds, in order). */
    const atTime = async (ms, fn) => {
      const mark = lastAudit();
      const out = await fn();
      const rows = db.prepare('SELECT id FROM hd_audit WHERE id > ? ORDER BY id').all(mark);
      const upd = db.prepare('UPDATE hd_audit SET at = ? WHERE id = ?');
      rows.forEach((r, i) => upd.run(T(ms + i * 4000), r.id));
      return out;
    };
    const setCase = (id, fields) => db.prepare(`UPDATE hd_cases SET ${Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });

    let n = 0;
    for (const receivedMs of times) {
      n++;
      try {
        const lang = rnd() < 0.22 ? 'ar' : 'en';
        const e = generateEmail({ subKey: pickSubKey(rnd), lang, rnd, bookingId: pick(bookingIds), noContract: rnd() < 0.12, otherSender: rnd() < 0.08 });
        const vagueNo = VAGUE_AT.indexOf(n); // the last three stay flagged for a person to check
        if (vagueNo >= 0 && VAGUE[vagueNo]) { e.subject = VAGUE[vagueNo][0]; e.body = `${VAGUE[vagueNo][1]}\n\n${e.fromName}`; }
        const received = T(receivedMs);
        const convo = `seed-conv-${n}`;
        const r = await ingestMessage({
          providerId: `seed-in-${n}`, conversationId: convo, direction: 'in', from: { name: e.fromName, email: e.fromEmail },
          to: [settings.mailbox], subject: e.subject, body: e.body, receivedAt: received,
        }, { provider: demoProvider });
        if (!r.caseId) continue;
        stats.cases++;

        // date what ingestion wrote at the time the email arrived
        db.prepare('SELECT id FROM hd_audit WHERE case_id = ? ORDER BY id').all(r.caseId).forEach((row, i) => db.prepare('UPDATE hd_audit SET at = ? WHERE id = ?').run(T(receivedMs + i * 20000), row.id));
        setCase(r.caseId, { created_at: received, updated_at: received });
        db.prepare('UPDATE hd_drafts SET created_at = ? WHERE case_id = ?').run(T(receivedMs + 90000), r.caseId);

        let c = getCaseRow(r.caseId);
        if (c.status === 'closed') { // spam or an automatic reply
          setCase(c.id, { closed_at: T(receivedMs + 60000), updated_at: T(receivedMs + 60000) });
          stats.closed++;
          continue;
        }

        const owner = byId[c.owner_id] || pick(staff);
        if (vagueNo >= 3) continue; // waiting in "To check": nobody has looked at it yet
        const ageH = (nowMs - receivedMs) / HOUR;
        const sla = settings.sla_hours[c.priority] || 48;

        // a person looks at a case the AI was unsure about
        if (c.needs_review && ageH > 10 && (vagueNo >= 0 ? vagueNo < 3 : rnd() < 0.7)) await atTime(receivedMs + 2 * HOUR, () => updateCase(c.id, { confirm: true }, owner));

        // some cases wait on another team
        const answered = rnd() < (ageH < 3 ? 0.12 : ageH < 24 ? 0.55 : ageH < 72 ? 0.9 : ageH < 240 ? 0.93 : 0.99);
        if (!answered) {
          stats.unanswered++;
          if (ageH > 6 && rnd() < 0.3) await atTime(receivedMs + 4 * HOUR, () => setStatus(c.id, 'pending_internal', owner));
          continue;
        }

        const delayH = Math.max(0.4, rnd() < 0.8 ? rnd() * sla * 0.9 : sla * (1 + rnd() * 1.5));
        const replyMs = receivedMs + delayH * HOUR;
        if (replyMs > nowMs - 90000) continue;

        const draft = db.prepare("SELECT * FROM hd_drafts WHERE case_id = ? AND status = 'pending' ORDER BY id DESC").get(c.id);
        if (!draft) continue;
        const approver = approverFor(c, draft);

        // staff correct the AI now and then, and edit the odd draft
        if (rnd() < 0.05) {
          const order = ['Low', 'Average', 'High', 'Critical'];
          const up = Math.min(3, order.indexOf(c.priority) + 1);
          if (up !== order.indexOf(c.priority)) await atTime(replyMs - 40 * 60000, () => updateCase(c.id, { priority: order[up], reason: 'Customer has contacted us before about this' }, owner));
        } else if (CONFUSED[c.sub_key] && rnd() < 0.035) {
          await atTime(replyMs - 40 * 60000, () => updateCase(c.id, { sub_key: CONFUSED[c.sub_key], reason: 'Re-filed after reading the full email' }, owner));
        }
        if (rnd() < 0.26) await atTime(replyMs - 15 * 60000, () => updateDraft(draft.id, { body: `${draft.body}\n\n${EXTRA_LINE[draft.language === 'ar' ? 'ar' : 'en']}` }, approver));

        try {
          await atTime(replyMs, () => approveDraft(draft.id, approver, demoProvider));
        } catch { stats.waiting_for_details++; continue; } // placeholders left in the draft: it stays pending, as it would for a person
        db.prepare("UPDATE hd_messages SET received_at = ? WHERE case_id = ? AND direction = 'out'").run(T(replyMs), c.id);
        db.prepare('UPDATE hd_drafts SET reviewed_at = ?, sent_at = ? WHERE id = ?').run(T(replyMs), T(replyMs), draft.id);
        setCase(c.id, { last_outbound_at: T(replyMs), next_followup_at: addHours(T(replyMs), settings.followup_hours[0]), updated_at: T(replyMs) });

        const sinceReplyH = (nowMs - replyMs) / HOUR;
        const custLang = c.language === 'ar' ? 'ar' : 'en';
        if (rnd() < 0.66 && sinceReplyH > 4) {
          // the customer answers; most of the time with thanks, then staff close the case
          const custMs = replyMs + (2 + rnd() * 26) * HOUR;
          if (custMs < nowMs - 90000) {
            await atTime(custMs, () => ingestMessage({
              providerId: `seed-re-${n}`, conversationId: convo, direction: 'in', from: { name: e.fromName, email: e.fromEmail }, to: [settings.mailbox],
              subject: `Re: ${e.subject} [${c.case_no}]`, body: pick(THANKS[custLang]), receivedAt: T(custMs),
            }, { provider: demoProvider }));
            setCase(c.id, { updated_at: T(custMs) });
            const closeMs = custMs + (0.5 + rnd() * 20) * HOUR;
            if (closeMs < nowMs - 90000) {
              const reason = rnd() < 0.45 ? 'customer_confirmed' : rnd() < 0.65 ? 'action_completed' : 'resolved';
              await atTime(closeMs, () => closeCase(c.id, { reason }, owner));
              setCase(c.id, { closed_at: T(closeMs), updated_at: T(closeMs) });
              stats.closed++;
            }
          }
        } else if (sinceReplyH >= 48) {
          // no answer: reminders went out after 48 and 96 hours, then the case closed itself 7 days later
          const reminders = sinceReplyH >= 96 ? 2 : 1;
          const insMsg = db.prepare(`INSERT INTO hd_messages (case_id, provider_id, conversation_id, direction, from_name, from_email, to_email, subject, body, received_at)
                                     VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, ?)`);
          for (let k = 0; k < reminders; k++) {
            const at = replyMs + settings.followup_hours[k] * HOUR;
            insMsg.run(c.id, `seed-fu-${n}-${k}`, convo, 'Customer Happiness Team', settings.mailbox, c.customer_email, `Re: ${c.subject} [${c.case_no}]`, REMINDER[custLang], T(at));
            audit({ caseId: c.id, actor: 'ai', action: 'followup_drafted', detail: `Reminder ${k + 1}`, at: T(at - 60000) });
            audit({ caseId: c.id, actor: owner, action: 'reply_sent', detail: `Reminder ${k + 1} sent after approval`, at: T(at) });
          }
          const lastMs = replyMs + settings.followup_hours[reminders - 1] * HOUR;
          setCase(c.id, { followup_count: reminders, last_outbound_at: T(lastMs), next_followup_at: reminders < settings.followup_hours.length ? addHours(T(replyMs), settings.followup_hours[reminders]) : null, updated_at: T(lastMs) });
          const closeMs = lastMs + settings.autoclose_days * 24 * HOUR;
          if (reminders === 2 && closeMs < nowMs - 90000) {
            await atTime(closeMs, () => closeCase(c.id, { reason: 'no_response', note: `No reply ${settings.autoclose_days} days after our last message` }, null, { auto: true }));
            setCase(c.id, { closed_at: T(closeMs), updated_at: T(closeMs) });
            stats.closed++;
          }
        }
      } catch (err) {
        stats.errors++;
        console.warn(`  helpdesk seed: case ${n} skipped (${err.message})`);
      }
    }

    // reminders and escalations that are due right now
    await runFollowups();

    // a week of daily summaries and a few weekly ones
    for (let d = 1; d <= 7; d++) generateReport('daily', { day: T(nowMs - d * 24 * HOUR - 4 * HOUR).slice(0, 10) });
    for (let w = 1; w <= 3; w++) generateReport('weekly', { day: T(nowMs - w * 7 * 24 * HOUR).slice(0, 10) });
    setState('last_sync_at', new Date().toISOString());
    setState('last_daily_report', gulfToday());
    setState('last_followup_at', new Date().toISOString());
  } finally {
    for (const [k, v] of [['HELPDESK_PROVIDER', keep.p], ['HELPDESK_LLM_MODE', keep.l], ['HELPDESK_SEND_MODE', keep.s]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return stats;
}
