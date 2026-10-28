// Cases: numbering, listing (with the tab filters the dashboard links to), the full case view with its
// history, and the changes people make (assign, override the AI, close, reopen). Every change is audited.
import { db } from '../db.js';
import { audit } from './audit.js';
import { relatedCases } from './contracts.js';
import { buildInsights } from './insights.js';
import { similarCases } from './learner.js';
import { addHours, branchForLocation, dueAtFor, nowUtc, pickOwner, routeFor } from './routing.js';
import { getSettings } from './settings.js';
import { NOT_CONNECTED, accountView } from './systems/account.js';
import { accountMode } from './systems/config.js';
import { ACTIVE_STATUSES, CATEGORIES, CLOSURE_REASONS, DEPARTMENTS, PRIORITIES, SUB_BY_KEY, WORKING_STATUSES } from './taxonomy.js';
import { normalize, redact } from './text.js';

export function nextCaseNo() {
  const y = new Date().getUTCFullYear();
  const row = db.prepare('SELECT MAX(CAST(SUBSTR(case_no, 9) AS INTEGER)) AS m FROM hd_cases WHERE case_no LIKE ?').get(`CS-${y}-%`);
  return `CS-${y}-${String(((row && row.m) || 0) + 1).padStart(6, '0')}`;
}

const inList = (arr) => arr.map((s) => `'${s}'`).join(',');
const ACTIVE = `c.status IN (${inList(ACTIVE_STATUSES)})`;
const WORKING = `c.status IN (${inList(WORKING_STATUSES)})`;
export const OVERDUE_SQL = `(${WORKING} AND c.due_at IS NOT NULL AND c.due_at < datetime('now'))`;
const HAS_DRAFT = "EXISTS (SELECT 1 FROM hd_drafts d WHERE d.case_id = c.id AND d.status = 'pending')";

const TABS = {
  active: ACTIVE,
  action: WORKING,
  drafts: `${ACTIVE} AND ${HAS_DRAFT}`,
  pending_customer: "c.status = 'pending_customer'",
  overdue: OVERDUE_SQL,
  triage: `${ACTIVE} AND c.needs_review = 1`,
  closed: "c.status = 'closed'",
  all: '1=1',
};

export const SELECT_CASES = `SELECT c.*, u.name AS owner_name,
    ${OVERDUE_SQL} AS is_overdue,
    ${HAS_DRAFT} AS has_draft,
    (SELECT COUNT(*) FROM hd_messages m WHERE m.case_id = c.id) AS message_count,
    CAST((julianday('now') - julianday(c.first_received_at)) * 24 AS INTEGER) AS age_hours
  FROM hd_cases c LEFT JOIN users u ON u.id = c.owner_id`;

/** WHERE for the list filters (everything except the tab). */
function filterWhere(q, user) {
  const where = [];
  const params = [];
  const eq = (col, val) => { if (val) { where.push(`${col} = ?`); params.push(val); } };
  eq('c.priority', q.priority);
  eq('c.category', q.category);
  eq('c.sub_key', q.sub_key);
  eq('c.department', q.department);
  eq('c.language', q.language);
  if (q.owner_id === 'me' && user) { where.push('c.owner_id = ?'); params.push(user.id); } else eq('c.owner_id', q.owner_id);
  if (q.owner_id === 'none') where.push('c.owner_id IS NULL');
  if (q.q) {
    const like = `%${String(q.q).trim()}%`;
    where.push('(c.case_no LIKE ? OR c.subject LIKE ? OR c.customer_name LIKE ? OR c.customer_email LIKE ? OR c.contract_no LIKE ? OR c.details LIKE ?)');
    params.push(like, like, like, like, like, like);
  }
  const age = "(julianday('now') - julianday(c.first_received_at))";
  const aging = { '0-2': `${age} <= 2`, '3-7': `${age} > 2 AND ${age} <= 7`, '8+': `${age} > 7` }[q.aging];
  if (aging) where.push(`${ACTIVE} AND ${aging}`);
  if (q.from) { where.push('c.first_received_at >= ?'); params.push(q.from); }
  if (q.to) { where.push('c.first_received_at <= ?'); params.push(q.to); }
  return { where, params };
}

const tabSql = (tab, user) => (tab === 'mine' ? `${ACTIVE} AND c.owner_id = ${Number(user && user.id) || 0}` : TABS[tab] || null);

export function listCases(q = {}, user = null) {
  const { where, params } = filterWhere(q, user);
  const tab = tabSql(q.tab, user);
  if (tab) where.push(tab);
  if (q.status) { where.push('c.status = ?'); params.push(q.status); }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const SORTS = { due_at: 'c.due_at', first_received_at: 'c.first_received_at', last_inbound_at: 'c.last_inbound_at', priority: "CASE c.priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Average' THEN 2 ELSE 3 END", case_no: 'c.case_no', status: 'c.status' };
  const dir = String(q.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const order = SORTS[q.sort] ? `${SORTS[q.sort]} ${dir}, c.id DESC` : 'c.first_received_at DESC, c.id DESC';
  const limit = Math.min(Number(q.limit) || 25, 500);
  const offset = Number(q.offset) || 0;
  const rows = db.prepare(`${SELECT_CASES}${whereSql} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`).all(...params);
  const { n } = db.prepare(`SELECT COUNT(*) n FROM hd_cases c${whereSql}`).get(...params);
  return { data: rows, total: n };
}

/** Counts for every tab under the current filters (so the tab bar always adds up). */
export function tabCounts(q = {}, user = null) {
  const { where, params } = filterWhere(q, user);
  const base = where.length ? ` AND ${where.join(' AND ')}` : '';
  const out = {};
  for (const tab of [...Object.keys(TABS), 'mine']) {
    out[tab] = db.prepare(`SELECT COUNT(*) n FROM hd_cases c WHERE ${tabSql(tab, user)}${base}`).get(...params).n;
  }
  return out;
}

export const getCaseRow = (id) => db.prepare(`${SELECT_CASES} WHERE c.id = ?`).get(id);

const CLOSING = /(thank you|thanks|thx|much appreciated|resolved|solved|all good|no longer|problem (?:is )?fixed|received (?:it|the)|شكرا|شكراً|تم الحل|تم حل|تم استلام|تم الاسترداد|وصلني|حُلت|لا حاجه)/i;

/** Does the customer's last message look like "thanks, it's resolved"? (offered as a closure suggestion) */
export function closingIntent(text) {
  const t = String(text || '').trim();
  return t.length > 0 && t.length < 400 && CLOSING.test(normalize(t)) && !/[?؟]/.test(t);
}

export function getCaseDetail(id, user = null) {
  const c = getCaseRow(id);
  if (!c) return null;
  const messages = db.prepare('SELECT * FROM hd_messages WHERE case_id = ? ORDER BY received_at ASC, id ASC').all(id)
    .map((m) => ({ ...m, attachments: m.attachments ? safeJson(m.attachments, []) : [] }));
  const drafts = db.prepare(`SELECT d.*, u.name AS reviewer_name FROM hd_drafts d LEFT JOIN users u ON u.id = d.reviewed_by WHERE d.case_id = ? ORDER BY d.id DESC`).all(id);
  const trail = db.prepare('SELECT * FROM hd_audit WHERE case_id = ? ORDER BY at DESC, id DESC LIMIT 200').all(id);
  const acct = accountView(c);
  const contract = acct && acct.snapshot ? acct.snapshot.contract : null;
  const related = relatedCases({ caseId: id, contractNo: c.contract_no, email: c.customer_email });
  const lastIn = [...messages].reverse().find((m) => m.direction === 'in');
  const priority_reasons = safeJson(c.priority_reasons, []);
  const firstIn = messages.find((m) => m.direction === 'in');
  const similar = similarCases(`${c.subject || ''}\n${firstIn ? firstIn.body : ''}`, { excludeCaseId: id, limit: 3 }).map((s) => {
    const other = getCaseRow(s.case_id);
    if (!other) return null;
    const reply = db.prepare("SELECT subject, body, received_at FROM hd_messages WHERE case_id = ? AND direction = 'out' ORDER BY received_at DESC, id DESC LIMIT 1").get(other.id);
    return { id: other.id, case_no: other.case_no, subject: other.subject, sub_category: other.sub_category, status: other.status, closure_reason: other.closure_reason, closed_at: other.closed_at, first_received_at: other.first_received_at, similarity: s.sim, reply: reply || null };
  }).filter(Boolean);
  const notes = db.prepare('SELECT * FROM hd_notes WHERE case_id = ? ORDER BY id ASC').all(id);
  return {
    ...c,
    matched_terms: safeJson(c.matched_terms, []),
    priority_reasons,
    messages, drafts, audit: trail, contract, account: accountForScreen(acct), related, notes, similar,
    insights: buildInsights({ ...c, priority_reasons }, contract, related, acct),
    suggest_close: ACTIVE_STATUSES.includes(c.status) && lastIn ? closingIntent(lastIn.body) : false,
    mailbox_link: [...messages].reverse().find((m) => m.web_link)?.web_link || null,
    can_see_sensitive: Boolean(user),
  };
}

/** What the case screen needs to know about where the contract, customer and invoices came from (the contract itself is sent as `contract`). */
function accountForScreen(acct) {
  if (!acct) return { source: accountMode(), status: 'not_checked', identity: 'none', systems: [], customer: null, other_contracts: [], errors: [], notes: accountMode() === 'none' ? [NOT_CONNECTED] : [], will_retry: false, stale: false };
  const s = acct.snapshot;
  const by = acct.verified_by ? db.prepare('SELECT name FROM users WHERE id = ?').get(acct.verified_by) : null;
  return {
    source: acct.source, status: acct.status, identity: acct.identity, systems: s.systems || [], fetched_at: acct.fetched_at, inferred: Boolean(s.inferred),
    customer: s.customer || null, other_contracts: s.other_contracts || [], open_invoices: s.open_invoices || null,
    errors: (s.errors || []).map((e) => ({ lookup: e.lookup, source: e.source, message: e.message })), notes: s.notes || [],
    stale: acct.stale, will_retry: acct.will_retry, attempts: acct.attempts, last_error: acct.last_error, verified_by: by ? by.name : null, verified_at: acct.verified_at,
  };
}

export const safeJson = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

/* ---------------------------------------------------------------- changes by people */
const OVERRIDABLE = {
  sub_key: 'request type', priority: 'priority', department: 'department', owner_id: 'owner', contract_no: 'contract number',
  customer_name: 'customer name', customer_email: 'customer email', amount: 'amount', location: 'location', fine_ref: 'fine reference',
  card_last4: 'card last four', details: 'details', language: 'language',
};

/**
 * Apply a person's edits. Changing the request type, priority, department or owner on a case the AI
 * classified is recorded as an override (the override rate on the dashboard counts these).
 */
export function updateCase(id, patch, user) {
  const before = getCaseRow(id);
  if (!before) return null;
  const settings = getSettings();
  const set = {};
  const changes = [];
  const reason = patch.reason ? String(patch.reason).slice(0, 300) : null;

  for (const key of Object.keys(OVERRIDABLE)) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (value === '') value = null;
    if (key === 'priority' && !PRIORITIES.includes(value)) throw new Error('Unknown priority.');
    if (key === 'department' && value && !DEPARTMENTS.includes(value)) throw new Error('Unknown department.');
    if (key === 'sub_key' && !SUB_BY_KEY[value]) throw new Error('Unknown request type.');
    if (key === 'owner_id' && value !== null) value = Number(value);
    if (String(before[key] ?? '') === String(value ?? '')) continue;
    set[key] = value;
    changes.push(key);
  }

  if ('contract_no' in set) set.contract_inferred = 0; // a number a person entered is no longer a guess
  if (set.sub_key) {
    const sub = SUB_BY_KEY[set.sub_key];
    Object.assign(set, { sub_category: sub.name, category: sub.category, impact: sub.impact, sensitive: sub.sensitive ? 1 : before.sensitive });
    if (!('department' in set) && !('owner_id' in set)) {
      // a new type may belong to another team: then the case moves to it. Same team: the owner keeps it.
      const route = routeFor(sub.key);
      if (route.department !== before.department) {
        set.department = route.department;
        set.owner_id = pickOwner(route.department, { branchId: branchForLocation(before.location), ruleOwnerId: route.ownerId });
        changes.push('department', 'owner_id');
      }
    }
  }
  if (set.department && !('owner_id' in set) && set.department !== before.department) {
    set.owner_id = pickOwner(set.department, { branchId: branchForLocation(before.location) });
    changes.push('owner_id');
  }
  if (set.priority) set.due_at = dueAtFor(set.priority, before.last_inbound_at || before.first_received_at, settings);
  if (!Object.keys(set).length && !('confirm' in patch)) return before;

  if (patch.confirm || set.sub_key || set.priority) set.needs_review = 0;
  set.updated_at = nowUtc();
  if (changes.length && before.classified_by && before.classified_by !== 'manual') set.classified_by = before.classified_by; // keep the original engine for the override statistics

  const cols = Object.keys(set);
  db.prepare(`UPDATE hd_cases SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...set, id });

  const isOverride = (k) => ['sub_key', 'priority', 'department'].includes(k) && before.classified_by && before.classified_by !== 'manual'; // reassigning to a colleague is not an AI mistake
  const names = (k, v) => (k === 'owner_id' ? (v ? (db.prepare('SELECT name FROM users WHERE id = ?').get(v) || {}).name : null) : v);
  for (const k of new Set(changes)) {
    audit({ caseId: id, actor: user, action: isOverride(k) ? 'override' : (k === 'owner_id' ? 'reassigned' : 'field_changed'), field: k, oldValue: names(k, before[k]), newValue: names(k, set[k]), detail: reason });
  }
  if (patch.confirm) audit({ caseId: id, actor: user, action: 'classification_confirmed', detail: `${before.sub_category} (${Math.round((before.confidence || 0) * 100)}%)` });
  return getCaseRow(id);
}

export function closeCase(id, { reason, note }, user, { auto = false } = {}) {
  const c = getCaseRow(id);
  if (!c) return null;
  if (!CLOSURE_REASONS.some((r) => r.value === reason)) throw new Error('Choose a closure reason.');
  if (c.status === 'closed') return c;
  const now = nowUtc();
  db.prepare("UPDATE hd_cases SET status = 'closed', closed_at = ?, closure_reason = ?, closure_note = ?, closed_by = ?, next_followup_at = NULL, needs_review = 0, updated_at = ? WHERE id = ?")
    .run(now, reason, note ? String(note).slice(0, 500) : null, auto ? null : (user && user.id) || null, now, id);
  db.prepare("UPDATE hd_drafts SET status = 'discarded', discard_reason = 'case_closed' WHERE case_id = ? AND status = 'pending'").run(id);
  audit({ caseId: id, actor: auto ? 'system' : user, action: 'closed', oldValue: c.status, newValue: 'closed', detail: `${reason}${note ? `: ${note}` : ''}${auto ? ' (automatic)' : ''}` });
  return getCaseRow(id);
}

export function reopenCase(id, user, why = 'Reopened by staff') {
  const c = getCaseRow(id);
  if (!c || c.status !== 'closed') return c;
  const settings = getSettings();
  const now = nowUtc();
  db.prepare("UPDATE hd_cases SET status = 'open', closed_at = NULL, closure_reason = NULL, closure_note = NULL, closed_by = NULL, reopened_count = reopened_count + 1, due_at = ?, escalation_level = 0, updated_at = ? WHERE id = ?")
    .run(dueAtFor(c.priority, now, settings), now, id);
  audit({ caseId: id, actor: user || 'system', action: 'reopened', oldValue: 'closed', newValue: 'open', detail: why });
  return getCaseRow(id);
}

/** Status moves people can make by hand (closing and reopening have their own rules). */
export function setStatus(id, status, user) {
  const c = getCaseRow(id);
  if (!c) return null;
  if (!['open', 'pending_customer', 'pending_internal'].includes(status)) throw new Error('Use Close for closing a case.');
  if (c.status === 'closed') throw new Error('Reopen the case first.');
  if (c.status === status) return c;
  const settings = getSettings();
  const now = nowUtc();
  const sets = { status, updated_at: now };
  if (status === 'pending_customer') sets.next_followup_at = null;
  if (status !== 'pending_customer' && c.status === 'pending_customer') sets.due_at = dueAtFor(c.priority, now, settings);
  db.prepare(`UPDATE hd_cases SET ${Object.keys(sets).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...sets, id });
  audit({ caseId: id, actor: user, action: 'status_changed', field: 'status', oldValue: c.status, newValue: status });
  return getCaseRow(id);
}

export const CATEGORY_LIST = CATEGORIES;

/* ---------------------------------------------------------------- outgoing mail */
/**
 * Records a reply that went to the customer (sent from the CRM, or seen in the mailbox's Sent Items).
 * A reply does not resolve a case: it moves to "pending customer", pauses the SLA clock and schedules
 * the first reminder.
 */
export function attachOutbound(c, m, { user = null, viaDraft = false, kind = 'reply' } = {}) {
  const settings = getSettings();
  const at = m.receivedAt || nowUtc();
  db.prepare(`INSERT OR IGNORE INTO hd_messages (case_id, provider_id, internet_id, conversation_id, direction, from_name, from_email, to_email, cc, subject, body, attachments, web_link, received_at)
              VALUES (?, ?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    c.id, m.providerId || `local-${c.id}-${Date.now()}`, m.internetId || null, m.conversationId || c.conversation_id,
    m.fromName || null, m.fromEmail || settings.mailbox, Array.isArray(m.to) ? m.to.join(', ') : (m.to || c.customer_email), m.cc || null,
    redact(m.subject || '').text || null, redact(m.body || '').text, m.attachments ? JSON.stringify(m.attachments) : null, m.webLink || null, at,
  );
  const sets = { last_outbound_at: at, updated_at: nowUtc() };
  if (c.status === 'open' || c.status === 'pending_internal') {
    sets.status = 'pending_customer';
    const hours = settings.followup_hours || [48, 96];
    const done = kind === 'followup' ? c.followup_count : c.followup_count;
    sets.next_followup_at = done < hours.length ? addHours(at, hours[Math.min(done, hours.length - 1)] - (done > 0 ? hours[done - 1] : 0)) : null;
  } else if (c.status === 'pending_customer' && kind === 'followup') {
    const hours = settings.followup_hours || [48, 96];
    sets.next_followup_at = c.followup_count < hours.length ? addHours(at, hours[c.followup_count] - hours[c.followup_count - 1]) : null;
  }
  db.prepare(`UPDATE hd_cases SET ${Object.keys(sets).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...sets, id: c.id });
  audit({ caseId: c.id, actor: user || 'system', action: 'reply_sent', detail: viaDraft ? 'Sent from the CRM after approval' : 'Reply seen in the mailbox' });
}

/** Internal note for colleagues (never sent to the customer). */
export function addNote(id, body, user) {
  const c = getCaseRow(id);
  if (!c) return null;
  const text = String(body || '').trim().slice(0, 2000);
  if (!text) throw new Error('Write the note first.');
  db.prepare('INSERT INTO hd_notes (case_id, user_id, user_name, body) VALUES (?, ?, ?, ?)').run(id, user.id, user.name, text);
  db.prepare('UPDATE hd_cases SET updated_at = ? WHERE id = ?').run(nowUtc(), id);
  audit({ caseId: id, actor: user, action: 'note_added', detail: text.length > 140 ? `${text.slice(0, 140)}...` : text });
  return getCaseRow(id);
}
