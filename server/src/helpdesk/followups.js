// Follow-up and escalation. Runs every few minutes (and on demand):
//  - customer reminders: a case waiting for the customer gets a reminder draft after 48h and again after 96h;
//  - automatic closure: still no reply 7 days after our last message and both reminders sent;
//  - escalation: a case past its due time moves up a level every 12 hours (owner, department lead, management);
//  - closure suggestions come from the latest customer message (see closingIntent in cases.js).
// Reminders are drafts: a person approves them like any other reply.
import { db } from '../db.js';
import { audit } from './audit.js';
import { closeCase, OVERDUE_SQL, SELECT_CASES } from './cases.js';
import { createDraft } from './drafts.js';
import { nowUtc } from './routing.js';
import { getSettings } from './settings.js';

const hoursBetween = (a, b) => (new Date(`${String(b).replace(' ', 'T')}Z`) - new Date(`${String(a).replace(' ', 'T')}Z`)) / 3600000;

/** Who to tell at each escalation level: the owner, then the admins (and finance when it is an Accounts case), then management and IT. */
function escalationTargets(c, level) {
  if (level <= 1) return c.owner_id ? [(db.prepare('SELECT id, name FROM users WHERE id = ?').get(c.owner_id))].filter(Boolean) : [];
  if (level === 2) return db.prepare("SELECT id, name FROM users WHERE status = 'active' AND (role = 'admin' OR (role = 'finance' AND department = ?)) ORDER BY role").all(c.department || '');
  return db.prepare("SELECT id, name FROM users WHERE status = 'active' AND (department = 'Management' OR role IN ('admin', 'it'))").all();
}

export async function runFollowups({ now = nowUtc() } = {}) {
  const settings = getSettings();
  const out = { reminders: 0, closed: 0, escalated: 0 };
  const hours = settings.followup_hours || [48, 96];

  // 1. customer reminders and automatic closure
  const waiting = db.prepare(`${SELECT_CASES} WHERE c.status = 'pending_customer'`).all();
  for (const c of waiting) {
    const lastOut = c.last_outbound_at || c.updated_at;
    const sinceReply = hoursBetween(lastOut, now);
    if (c.followup_count >= hours.length && sinceReply >= settings.autoclose_days * 24 - 1) {
      closeCase(c.id, { reason: 'no_response', note: `No reply ${settings.autoclose_days} days after our last message` }, null, { auto: true });
      out.closed++;
      continue;
    }
    const pendingReminder = db.prepare("SELECT 1 FROM hd_drafts WHERE case_id = ? AND status = 'pending'").get(c.id);
    if (c.followup_count < hours.length && !pendingReminder && c.next_followup_at && c.next_followup_at <= now) {
      const d = await createDraft(c.id, { kind: 'followup' });
      if (d) {
        db.prepare("UPDATE hd_cases SET next_followup_at = NULL, updated_at = ? WHERE id = ?").run(now, c.id);
        out.reminders++;
      }
    }
  }

  // 2. overdue cases: escalate one level per threshold
  const thresholds = settings.escalation_hours || [0, 12, 24];
  const overdue = db.prepare(`${SELECT_CASES} WHERE ${OVERDUE_SQL}`).all();
  for (const c of overdue) {
    const past = hoursBetween(c.due_at, now);
    const level = thresholds.filter((t) => past >= t).length;
    if (level > c.escalation_level) {
      db.prepare('UPDATE hd_cases SET escalation_level = ?, escalated_at = ?, updated_at = ? WHERE id = ?').run(level, now, now, c.id);
      const who = escalationTargets(c, level).map((u) => u.name);
      audit({ caseId: c.id, actor: 'system', action: 'escalated', oldValue: String(c.escalation_level), newValue: String(level), detail: `${Math.round(past)}h past the due time. Notified: ${who.join(', ') || 'no one assigned'}` });
      out.escalated++;
    }
  }
  return out;
}
