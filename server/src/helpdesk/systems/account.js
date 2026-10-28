// The account of a case: what the customer systems (or, in demo mode, the CRM) said about the customer, the contract and the
// invoices. resolveAccount() asks; saveSnapshot() keeps the answer with the case so every screen and every draft reads the same
// facts without waiting on a network call; refreshAccount() asks again.
//
// A lookup that fails never loses an email: the case is created without the extra facts, marked "will retry", and filled in
// by the scheduler when the system answers. A failed refresh never overwrites good data that was already there.
import { db } from '../../db.js';
import { audit } from '../audit.js';
import { crmAccount, relatedCases } from '../contracts.js';
import { priorityRank, scorePriority } from '../priority.js';
import { dueAtFor, nowUtc } from '../routing.js';
import { getSettings } from '../settings.js';
import { stripQuoted } from '../text.js';
import { accountMode, loadConfig } from './config.js';
import { resolveFromApi, sameContractNo } from './resolver.js';

export const MAX_ATTEMPTS = 12;
const BACKOFF_MINUTES = [1, 2, 4, 8, 15, 30]; // after the 1st, 2nd, ... failed attempt; the last value repeats
const lower = (s) => String(s ?? '').trim().toLowerCase();
const inMinutes = (min) => new Date(Date.now() + min * 60000).toISOString().slice(0, 19).replace('T', ' ');

/* ------------------------------------------------------------------------------------------------ asking */
function failed(source, code, message) {
  return {
    v: 1, source, systems: [], fetched_at: new Date().toISOString(), status: 'unavailable', identity: 'none', inferred: false, customer: null, contract: null, other_contracts: [], open_invoices: null,
    errors: [{ lookup: null, source: null, code, message }], notes: [], warnings: [], lookups: [],
  };
}

/** For mail that is not looked up at all (spam, automatic replies): nothing was asked, nothing is stored. */
export const notChecked = () => ({
  v: 1, source: accountMode(), systems: [], fetched_at: new Date().toISOString(), status: 'not_checked', identity: 'none', inferred: false, customer: null, contract: null,
  other_contracts: [], open_invoices: null, errors: [], notes: [], warnings: [], lookups: [],
});

/** What a real mailbox gets while no customer system is connected: nothing is looked up and the case says so. The CRM's demo records are never used for it. */
export const NOT_CONNECTED = 'The customer systems (Orion Fleet and the CNR Portal) are not connected yet, so no customer, contract or invoice details were looked up for this email.';
export const notConnected = () => ({ ...notChecked(), source: 'none', notes: [NOT_CONNECTED] });

/** The account for an email. Never throws: a problem comes back as status 'unavailable' with the reason. */
export async function resolveAccount({ email = null, contractNo = null, bypassCache = false } = {}) {
  try {
    if (accountMode() === 'none') return notConnected();
    if (accountMode() === 'crm') return crmAccount({ email, contractNo });
    const cfg = loadConfig();
    if (!cfg.exists) return failed('api', 'config', 'The customer systems are switched on but the configuration file is missing. See Helpdesk setup, Customer data.');
    if (!cfg.ok && !cfg.usingLastGood) return failed('api', 'config', `The customer systems configuration has problems: ${cfg.problems[0]}`);
    const snap = await resolveFromApi({ email, contractNo, bypassCache });
    if (cfg.config.fallback_to_crm && (snap.status === 'not_found' || snap.status === 'unavailable')) {
      const crm = crmAccount({ email, contractNo });
      if (crm.status === 'ok') return { ...crm, notes: [...crm.notes, 'Not found in the customer systems: this is the CRM record.'], errors: snap.errors, fallback: true };
    }
    return snap;
  } catch (e) {
    console.error('[helpdesk] account lookup failed:', e);
    return failed(accountMode(), 'internal', `The lookup failed: ${e.message}`);
  }
}

/* ------------------------------------------------------------------------------------------------ keeping it */
const rowOf = (caseId) => db.prepare('SELECT * FROM hd_case_accounts WHERE case_id = ?').get(caseId);

/** Is what is stored about the same contract (or, with no contract named, still about the sender's own)? Old details about another contract must not stay. */
function sameSubject(prevJson, contractNo) {
  let prevSnap;
  try { prevSnap = JSON.parse(prevJson); } catch { return false; }
  const prevNo = prevSnap && prevSnap.contract && prevSnap.contract.contract_no;
  if (contractNo) return Boolean(prevNo) && sameContractNo(prevNo, contractNo);
  return !prevNo || Boolean(prevSnap.inferred);
}

/**
 * Store a snapshot for a case. -> true when it replaced what was there, false when a lookup with errors left the last good details in place
 * (they are only kept while they are about the same contract: details of another contract would be worse than none).
 * `email` is the sender, used to remember that staff vouched for this sender on this contract. `contractNo` is the number the lookup was made with.
 */
export function saveSnapshot(caseId, snap, { email = null, contractNo = null } = {}) {
  const prev = rowOf(caseId);
  const hadErrors = Boolean(snap.errors && snap.errors.length);
  const attempts = hadErrors ? (prev ? prev.attempts : 0) + 1 : 0;
  const nextTry = hadErrors && attempts < MAX_ATTEMPTS ? inMinutes(BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1]) : null;
  const lastError = hadErrors ? snap.errors[0].message : null;

  if (hadErrors && prev && ['ok', 'partial'].includes(prev.status) && sameSubject(prev.json, contractNo)) {
    db.prepare('UPDATE hd_case_accounts SET attempts = ?, next_try_at = ?, last_error = ? WHERE case_id = ?').run(attempts, nextTry, lastError, caseId);
    return false;
  }
  const key = `${lower(email)}|${lower(snap.contract && snap.contract.contract_no)}`;
  let { identity } = snap;
  let verified = { by: null, at: null, key: null };
  if (prev && prev.identity === 'staff' && prev.verified_key === key && identity !== 'email') {
    identity = 'staff';
    verified = { by: prev.verified_by, at: prev.verified_at, key: prev.verified_key };
  }
  db.prepare(`INSERT INTO hd_case_accounts (case_id, source, status, identity, verified_by, verified_at, verified_key, fetched_at, attempts, next_try_at, last_error, json)
              VALUES (@case_id, @source, @status, @identity, @vby, @vat, @vkey, @fetched_at, @attempts, @next_try_at, @last_error, @json)
              ON CONFLICT(case_id) DO UPDATE SET source = excluded.source, status = excluded.status, identity = excluded.identity, verified_by = excluded.verified_by,
                verified_at = excluded.verified_at, verified_key = excluded.verified_key, fetched_at = excluded.fetched_at, attempts = excluded.attempts,
                next_try_at = excluded.next_try_at, last_error = excluded.last_error, json = excluded.json`).run({
    case_id: caseId, source: snap.source, status: snap.status, identity, vby: verified.by, vat: verified.at, vkey: verified.key,
    fetched_at: snap.fetched_at, attempts, next_try_at: nextTry, last_error: lastError, json: JSON.stringify({ ...snap, identity }),
  });
  return true;
}

/** -> { snapshot, status, source, identity, fetched_at, attempts, next_try_at, last_error, stale } or null when nothing was stored. */
export function readAccount(caseId) {
  const row = rowOf(caseId);
  if (!row) return null;
  let snapshot;
  try { snapshot = JSON.parse(row.json); } catch { return null; }
  return {
    snapshot: { ...snapshot, identity: row.identity }, status: row.status, source: row.source, identity: row.identity, fetched_at: row.fetched_at,
    verified_by: row.verified_by, verified_at: row.verified_at, attempts: row.attempts, next_try_at: row.next_try_at, last_error: row.last_error,
    stale: Boolean(row.last_error && ['ok', 'partial'].includes(row.status)), will_retry: Boolean(row.next_try_at),
  };
}

/** What a screen shows for a case. Demo (CRM) mode reads the CRM live, like before; with the customer systems on, it is the stored snapshot. */
export function accountView(c) {
  if (accountMode() === 'none') {
    const stored = readAccount(c.id);
    return stored && stored.source === 'crm' ? null : stored; // a lookup that was made in the demo records is not shown for a real mailbox
  }
  if (accountMode() === 'crm') {
    // details that came from the real systems are never replaced by the demo records just because somebody opened the case
    const prev = rowOf(c.id);
    if (!(prev && prev.source === 'api' && ['ok', 'partial'].includes(prev.status))) {
      const snap = crmAccount({ email: c.customer_email, contractNo: c.contract_no, assumeInferred: Boolean(c.contract_inferred) });
      saveSnapshot(c.id, snap, { email: c.customer_email });
    }
  }
  return readAccount(c.id);
}

/** Fill in what the case lacked from a snapshot. A contract number a person typed is never replaced. */
function applyToCase(c, snap) {
  const sets = {};
  if (snap.contract) {
    if (!c.contract_no || c.contract_inferred) {
      if (lower(snap.contract.contract_no) !== lower(c.contract_no)) sets.contract_no = snap.contract.contract_no;
      sets.contract_inferred = snap.inferred ? 1 : 0;
    }
    if (snap.source === 'crm' && snap.contract.booking_id) sets.booking_id = snap.contract.booking_id;
  }
  if (snap.customer && !c.customer_name) sets.customer_name = snap.customer.name || null;
  if (snap.source === 'crm' && snap.customer && snap.customer.id) sets.customer_id = snap.customer.id;
  const cols = Object.keys(sets).filter((k) => String(sets[k] ?? '') !== String(c[k] ?? ''));
  if (!cols.length) return;
  db.prepare(`UPDATE hd_cases SET ${cols.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`).run({ ...sets, id: c.id, now: nowUtc() });
}

/**
 * The case was opened without the customer's details (a system was down) and they have now arrived. A Gold, Platinum or corporate customer
 * raises the priority, as it would have at the start. It only ever raises, and never undoes a priority a person chose.
 */
function raiseForCustomer(c, customer) {
  if (db.prepare("SELECT 1 FROM hd_audit WHERE case_id = ? AND actor_type = 'user' AND field = 'priority'").get(c.id)) return false;
  const first = db.prepare("SELECT subject, body FROM hd_messages WHERE case_id = ? AND direction = 'in' ORDER BY received_at ASC, id ASC LIMIT 1").get(c.id);
  const open = relatedCases({ caseId: c.id, contractNo: c.contract_no, email: c.customer_email }).filter((r) => r.status !== 'closed').length;
  const scored = scorePriority({ subKey: c.sub_key, subject: first ? first.subject : '', body: first ? stripQuoted(first.body) : '', amount: c.amount, tier: customer.tier, segment: customer.segment, openRelated: open });
  if (priorityRank(scored.priority) >= priorityRank(c.priority)) return false;
  const why = scored.reasons.find((r) => /(customer|account) \(\+1\)$/.test(r));
  let reasons = [];
  try { reasons = JSON.parse(c.priority_reasons || '[]'); } catch { /* start again */ }
  reasons.push(`${why ? `${why.replace(/ \(\+1\)$/, '')}, known once the customer details arrived` : 'Customer details arrived'} (+1)`);
  const dueAt = dueAtFor(scored.priority, c.last_inbound_at || c.first_received_at, getSettings());
  db.prepare('UPDATE hd_cases SET priority = ?, priority_reasons = ?, due_at = ?, updated_at = ? WHERE id = ?').run(scored.priority, JSON.stringify(reasons), dueAt, nowUtc(), c.id);
  audit({ caseId: c.id, actor: 'system', action: 'priority_set', oldValue: c.priority, newValue: scored.priority, detail: `The customer details arrived after the case was opened: ${why ? why.replace(/ \(\+1\)$/, '') : 'priority re-checked'}` });
  return true;
}

const describeSnapshot = (s) => {
  const bits = [];
  if (s.customer) bits.push(`customer ${s.customer.name || s.customer.email || s.customer.id}`);
  if (s.contract) bits.push(`contract ${s.contract.contract_no}${s.inferred ? ' (from the sender)' : ''}`);
  if (s.contract && s.contract.invoices.length) bits.push(`${s.contract.invoices.length} invoice${s.contract.invoices.length > 1 ? 's' : ''}`);
  return bits.join(', ') || 'nothing found';
};

/** Ask again for a case. -> the stored view. `auto` marks the scheduler's retries in the audit log. */
export async function refreshAccount(caseId, { user = null, bypassCache = true, auto = false } = {}) {
  const c = db.prepare('SELECT * FROM hd_cases WHERE id = ?').get(caseId);
  if (!c) return null;
  if (accountMode() === 'none') return null; // nothing is connected, so there is nothing to ask again
  const explicit = c.contract_no && !c.contract_inferred ? c.contract_no : null;
  const before = readAccount(caseId);
  const hadCustomer = Boolean(before && before.snapshot && before.snapshot.customer);
  const snap = await resolveAccount({ email: c.customer_email, contractNo: explicit, bypassCache });
  const replaced = saveSnapshot(caseId, snap, { email: c.customer_email, contractNo: explicit });
  if (replaced) applyToCase(c, snap);
  if (replaced && !hadCustomer && snap.customer && ['email', 'staff'].includes(snap.identity) && c.status !== 'closed') raiseForCustomer(db.prepare('SELECT * FROM hd_cases WHERE id = ?').get(caseId), snap.customer);
  const systems = snap.systems.length ? snap.systems.join(' and ') : snap.source === 'crm' ? 'the CRM' : 'the customer systems';
  if (snap.status === 'unavailable' || (snap.errors && snap.errors.length)) {
    audit({ caseId, actor: user || 'system', action: 'account_lookup_failed', detail: `${snap.errors[0].message}${replaced ? '' : ' The earlier details were kept.'}${auto ? ' Will try again.' : ''}` });
  } else {
    audit({ caseId, actor: user || 'system', action: 'account_refreshed', detail: `${systems}: ${describeSnapshot(snap)}${auto ? ' (retry)' : ''}` });
  }
  return readAccount(caseId);
}

/** For a draft: the account no older than the configured freshness, asking again when it is. Never throws. */
export async function ensureFreshAccount(c) {
  try {
    if (accountMode() !== 'api') return accountView(c);
    const acct = readAccount(c.id);
    const max = loadConfig().config.freshness_minutes;
    const age = acct && acct.fetched_at ? (Date.now() - Date.parse(acct.fetched_at)) / 60000 : Infinity;
    if (acct && acct.status !== 'unavailable' && age <= max) return acct;
    if (acct && acct.status === 'unavailable' && age < 1) return acct; // it failed a moment ago: asking again now would only fail again
    return (await refreshAccount(c.id, { bypassCache: true })) || acct;
  } catch (e) {
    console.error('[helpdesk] could not refresh the account before drafting:', e.message);
    return readAccount(c.id);
  }
}

/** Replies may quote account figures only when the sender is the customer on the contract (or staff confirmed it). */
export const senderVerified = (acct) => !acct || !acct.snapshot || !acct.snapshot.contract || ['email', 'staff'].includes(acct.identity);
