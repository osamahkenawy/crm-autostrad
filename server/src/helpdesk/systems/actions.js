// What people and the scheduler do with a case's account: confirm the sender, and finish the lookups that could not be made
// when the email arrived. Kept apart from account.js because both write drafts (account.js must stay below drafts.js).
import { db } from '../../db.js';
import { audit } from '../audit.js';
import { createDraft } from '../drafts.js';
import { nowUtc } from '../routing.js';
import { readAccount, refreshAccount } from './account.js';

const lower = (s) => String(s ?? '').trim().toLowerCase();

/** A reply nobody has touched was written with older or missing account facts: write it again with the current ones. */
export async function redraftIfUntouched(caseId) {
  const d = db.prepare("SELECT id, edited, kind FROM hd_drafts WHERE case_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(caseId);
  if (!d || d.edited) return false;
  const made = await createDraft(caseId, { kind: d.kind === 'followup' ? 'followup' : 'initial' }).catch((e) => { console.warn('[helpdesk] redraft failed:', e.message); return null; });
  return Boolean(made);
}

/**
 * Ask the customer systems again for a case and, when who the sender is or which contract it is changed, write an untouched draft again:
 * it may be quoting what the old answer allowed. -> { view, changed }.
 */
export async function refreshCase(caseId, opts = {}) {
  const before = readAccount(caseId);
  const view = await refreshAccount(caseId, opts);
  const key = (a) => `${a ? a.identity : ''}|${a && a.snapshot && a.snapshot.contract ? a.snapshot.contract.contract_no : ''}`;
  const changed = key(before) !== key(view);
  if (changed) await redraftIfUntouched(caseId);
  return { view, changed };
}

/**
 * A person confirms the sender may be given the account details of this contract (the address on the email is not the
 * customer's, for example a colleague or a company mailbox). It holds for this sender and this contract only.
 */
export async function verifySender(caseId, user) {
  const c = db.prepare('SELECT * FROM hd_cases WHERE id = ?').get(caseId);
  const row = db.prepare('SELECT * FROM hd_case_accounts WHERE case_id = ?').get(caseId);
  if (!c || !row) throw new Error('This case has no account details to confirm.');
  if (row.identity === 'email' || row.identity === 'staff') return readAccount(caseId);
  const snap = JSON.parse(row.json);
  if (!snap.contract) throw new Error('This case has no contract, so there is nothing to confirm.');
  const key = `${lower(c.customer_email)}|${lower(snap.contract.contract_no)}`;
  db.prepare("UPDATE hd_case_accounts SET identity = 'staff', verified_by = ?, verified_at = ?, verified_key = ? WHERE case_id = ?").run(user.id, nowUtc(), key, caseId);
  audit({ caseId, actor: user, action: 'sender_verified', detail: `${user.name} confirmed that ${c.customer_email} may be given the details of contract ${snap.contract.contract_no}` });
  await redraftIfUntouched(caseId);
  return readAccount(caseId);
}

/**
 * Cases opened while a customer system was down are looked up again, spaced out (1, 2, 4, 8, 15, then every 30 minutes, 12 tries).
 * -> { tried, fixed }. Run from the scheduler every minute; it costs one cheap query when nothing is waiting.
 */
export async function retryPendingAccounts({ limit = 6 } = {}) {
  const due = db.prepare(`SELECT a.case_id FROM hd_case_accounts a JOIN hd_cases c ON c.id = a.case_id
                           WHERE a.next_try_at IS NOT NULL AND a.next_try_at <= ? AND c.status <> 'closed' ORDER BY a.next_try_at LIMIT ?`).all(nowUtc(), limit);
  const out = { tried: 0, fixed: 0 };
  for (const d of due) {
    out.tried++;
    const { view: after, changed } = await refreshCase(d.case_id, { auto: true, bypassCache: true });
    if (after && after.status !== 'unavailable' && !after.will_retry) {
      out.fixed++;
      if (!changed) await redraftIfUntouched(d.case_id); // the details arrived or were completed: the reply can use them
    }
  }
  return out;
}
