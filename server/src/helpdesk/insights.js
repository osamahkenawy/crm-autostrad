// "What to look at": facts from the CRM and the case history that explain the request or point to the next step.
// Everything here is read-only and comes with the evidence, so a person can check it before acting on it.
import { getSettings } from './settings.js';
import { NOT_CONNECTED } from './systems/account.js';
import { accountMode } from './systems/config.js';

const money = (n) => `AED ${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const ms = (s) => (s ? new Date(String(s).length === 10 ? `${s}T00:00:00Z` : `${String(s).replace(' ', 'T')}Z`).getTime() : NaN);
const daysAgo = (s) => Math.floor((Date.now() - ms(s)) / 86400000);
const day = (s) => String(s || '').slice(0, 10);
const RANK = { danger: 0, warn: 1, info: 2, ok: 3 };

const when = (iso) => String(iso || '').replace('T', ' ').slice(0, 16);

/**
 * -> [{ tone: 'danger'|'warn'|'info'|'ok', title, detail }] most important first.
 * `acct` is the stored account (readAccount()): where the contract, customer and invoices came from and whether the sender is the customer.
 */
export function buildInsights(c, contract, related = [], acct = null) {
  const out = [];
  const add = (tone, title, detail = '') => out.push({ tone, title, detail });
  const settings = getSettings();
  const fin = contract && contract.financials;
  const ended = contract && contract.end_at && ms(contract.end_at) < Date.now();
  const snap = acct && acct.snapshot;
  const place = snap && snap.systems && snap.systems.length ? snap.systems.join(' and ') : snap && snap.source === 'api' ? 'the customer systems' : 'the CRM';
  const others = (snap && snap.other_contracts) || [];

  /* can the details be trusted, and are they here at all */
  if (acct && acct.status === 'unavailable') {
    add('warn', 'Customer details are not available yet', `${acct.last_error || 'The customer systems did not answer.'} ${acct.will_retry ? 'The helpdesk keeps trying and fills them in by itself. Press Refresh to try now.' : 'Press Refresh to try again.'}`);
  } else if (acct && acct.status === 'partial') {
    add('warn', 'Some details are missing', `${(snap.errors[0] && snap.errors[0].message) || 'One of the customer systems did not answer.'} ${acct.will_retry ? 'It will be tried again automatically.' : ''}`.trim());
  } else if (acct && acct.stale) {
    add('info', `Showing details from ${when(acct.fetched_at)} (UTC)`, `${acct.last_error || 'The customer system did not answer the last refresh.'} Check figures before quoting them.`);
  }
  if (contract && acct && acct.identity === 'contract_only') {
    const owner = contract.customer && (contract.customer.name || contract.customer.email);
    add('danger', 'The sender is not the customer on this contract', `${c.customer_email || 'The sender'} wrote about contract ${contract.contract_no}${owner ? `, which belongs to ${owner}` : ''}. Anyone can type a contract number, so check who is writing before sharing account details. The drafted reply leaves them out; use "Confirm sender" once you are sure.`);
  } else if (contract && acct && acct.identity === 'staff') {
    add('info', 'Sender confirmed by staff', 'Someone on the team checked that this sender may receive the details of this contract.');
  }

  if (!contract) {
    const hint = others.length ? ` The sender has ${others.length} other contract${others.length > 1 ? 's' : ''}: if one of them is the right one, choose it under "Other contracts".` : '';
    // when the systems did not answer at all that is already said above: "not found" would be untrue
    if (accountMode() === 'none') {
      // nothing is connected: nothing was looked up, so "no contract found" and "no recent rental" would be untrue
      add('info', 'Contract details are not available', `${NOT_CONNECTED} ${c.contract_no ? `The email names ${c.contract_no}: check it by hand.` : 'The email names no contract: ask the customer for it if the answer depends on it.'}`);
    } else if (!acct || acct.status !== 'unavailable') {
      add('warn', 'No contract found', `${c.contract_no ? `${c.contract_no} is not in ${place}. Ask the customer to check the number.` : 'The email has no contract number and the sender has no recent rental. Ask the customer for it.'}${hint}`);
    }
  } else if (c.contract_inferred) {
    add('warn', `Contract ${contract.contract_no} was guessed`, 'It is the sender\'s latest rental, not something the customer wrote. Confirm it in the reply.');
  }

  /* what the customer owes */
  const sum = contract && contract.invoice_summary;
  if (sum && sum.unpaid_count > 0 && ['billing_complaint', 'unrecognized_charge', 'invoice_request', 'refund_request', 'damage_dispute'].includes(c.sub_key)) {
    add(sum.overdue_count ? 'warn' : 'info', `${sum.unpaid_count} unpaid invoice${sum.unpaid_count > 1 ? 's' : ''} on this account (${money(sum.outstanding)})`, sum.overdue_count ? `${sum.overdue_count} past the due date. Mention it only if it helps the customer.` : 'Not yet due.');
  } else if (!contract && snap && snap.open_invoices && snap.open_invoices.unpaid_count > 0) {
    add('info', `${snap.open_invoices.unpaid_count} unpaid invoice${snap.open_invoices.unpaid_count > 1 ? 's' : ''} for this customer (${money(snap.open_invoices.outstanding)})`, 'No contract is attached to the case.');
  }

  /* an amount in the email against what the CRM knows about this contract */
  if (c.amount && contract) {
    const amt = Number(c.amount);
    const near = (x) => x !== null && x !== undefined && Math.abs(Number(x) - amt) < 0.51;
    const hits = [];
    for (const f of contract.fines) {
      const total = Number(f.amount) + Number(f.admin_fee || 0);
      if (near(f.amount) || near(total)) hits.push(`${f.type} ${f.reference || ''} (${money(total)}, ${f.status})${f.issued_at ? `, issued ${day(f.issued_at)}` : ''}`);
    }
    for (const i of contract.invoices) if (near(i.total) || near(i.vat)) hits.push(`invoice ${i.number} (${money(i.total)}, ${i.status})`);
    if (fin && near(fin.deposit_amount)) hits.push('the security deposit');
    if (fin && near(fin.preauth_amount)) hits.push('the card hold (pre-authorization)');
    if (near(contract.total_amount)) hits.push('the contract total');
    if (hits.length) add('info', `${money(amt)} matches ${hits[0]}`, `${hits.length > 1 ? `Also close to: ${hits.slice(1).join('; ')}. ` : ''}Likely the explanation: check it before replying.`);
    else if (c.sub_key === 'unrecognized_charge') add('warn', `Nothing on this contract is ${money(amt)}`, 'No fine, invoice, deposit or card hold has that amount. It may belong to another contract or be a duplicate: ask Accounts.');
  }

  /* the same amount invoiced twice */
  if (contract) {
    const seen = {};
    for (const i of contract.invoices.filter((x) => x.status !== 'draft')) (seen[Number(i.total).toFixed(2)] ||= []).push(i.number);
    for (const [total, list] of Object.entries(seen)) if (list.length > 1) add('warn', `${list.length} invoices for ${money(total)}`, `${list.join(', ')}. Could be a duplicate charge.`);
  }

  /* the customer's amount against the deposit or card hold on record */
  if (fin && c.amount) {
    const amt = Number(c.amount);
    if (c.sub_key === 'preauth_followup' && fin.preauth_amount && Math.abs(amt - fin.preauth_amount) > 0.5) add('warn', `The customer says ${money(amt)}, the CRM shows ${money(fin.preauth_amount)} on hold`, 'Check which is right before replying.');
    if (c.sub_key === 'deposit_refund' && fin.deposit_amount && Math.abs(amt - fin.deposit_amount) > 0.5) add('warn', `The customer says ${money(amt)}, the CRM shows a deposit of ${money(fin.deposit_amount)}`, 'Check which is right before replying.');
  }

  /* deposit */
  if (fin && fin.deposit_amount && (c.sub_key === 'deposit_refund' || c.sub_key === 'unrecognized_charge')) {
    const dep = money(fin.deposit_amount);
    if (fin.deposit_status === 'refunded') add('ok', `Deposit of ${dep} shows as refunded`, 'Confirm with the customer that it reached their card. Banks can take a few days.');
    else if (fin.deposit_status === 'refund_pending') {
      const late = fin.deposit_refund_due && ms(fin.deposit_refund_due) < Date.now();
      add(late ? 'danger' : 'info', late ? `Deposit refund of ${dep} is ${daysAgo(fin.deposit_refund_due)} days overdue` : `Deposit refund of ${dep} is approved`, late ? `It was due by ${fin.deposit_refund_due}. Ask Accounts to release it and tell the customer the date.` : `Expected by ${fin.deposit_refund_due || 'the usual release time'}.`);
    } else if (fin.deposit_status === 'held') {
      const since = contract.end_at ? daysAgo(contract.end_at) : null;
      add(ended && since > 14 ? 'warn' : 'info', `Deposit of ${dep} is still held`, ended ? `The rental ended ${since} days ago. The usual release time is ${settings.release_days_en}.` : 'The rental has not ended yet.');
    }
  }

  /* card hold */
  if (fin && fin.preauth_amount && (c.sub_key === 'preauth_followup' || c.sub_key === 'unrecognized_charge')) {
    const hold = money(fin.preauth_amount);
    if (fin.preauth_status === 'released') add('ok', `The ${hold} card hold was released${fin.preauth_released_at ? ` on ${day(fin.preauth_released_at)}` : ''}`, 'If the customer still sees it, the bank is slow to show the release. Explain that it can take a few days.');
    else if (fin.preauth_status === 'pending_release') add('info', `Release of the ${hold} card hold was requested`, 'Waiting for the bank.');
    else add(ended ? 'warn' : 'info', `The ${hold} card hold is still active`, ended ? `The rental ended ${contract.end_at ? daysAgo(contract.end_at) : '?'} days ago: ask Accounts to request the release.` : 'It is released after the contract is closed.');
  }

  if (c.sub_key === 'invoice_request' && contract) {
    const inv = contract.invoices.find((i) => i.status !== 'draft');
    if (inv) add('ok', `Invoice ${inv.number} is available`, `${money(inv.total)}, ${inv.status}. Attach the PDF from the CNR Portal before sending.`);
    else add('warn', 'No invoice exists for this contract yet', 'Ask Accounts to issue it before replying.');
  }

  if (c.sub_key === 'fine_dispute' && contract) {
    const fine = contract.fines.find((f) => c.fine_ref && f.reference === c.fine_ref) || contract.fines[0];
    if (fine) {
      const inside = fine.issued_at && contract.start_at && contract.end_at ? ms(fine.issued_at) >= ms(contract.start_at) - 3600000 && ms(fine.issued_at) <= ms(contract.end_at) + 3600000 : null;
      add(inside === false ? 'warn' : 'info', `${fine.type} ${fine.reference || ''}: ${money(Number(fine.amount) + Number(fine.admin_fee || 0))}`, inside === false ? 'The fine date is outside the rental period: it may not be the customer\'s. Check with the authority record.' : 'The fine date falls inside the rental period.');
    }
  }

  if (c.sub_key === 'vehicle_collection' && contract && contract.pickup_branch) add('info', `Collection from ${c.location || 'the customer'}`, `The contract started at ${contract.pickup_branch.name}. Arrange the pick-up with that branch.`);

  /* who is asking and how often */
  const tier = contract && contract.customer && contract.customer.tier;
  if (tier && tier !== 'Standard') add('info', `${tier} customer`, 'Worth a faster, more personal reply.');
  if (contract && contract.customer && contract.customer.segment === 'Corporate') add('info', 'Corporate account', 'Copy the account manager if the reply is about money.');
  const open = related.filter((r) => r.status !== 'closed');
  const recent = related.filter((r) => r.first_received_at && daysAgo(r.first_received_at) <= 60);
  if (open.length) add('warn', `${open.length} other open case${open.length > 1 ? 's' : ''} for this contract or sender`, `${open.slice(0, 3).map((r) => `${r.case_no} (${r.sub_category})`).join(', ')}. Answer them together.`);
  else if (recent.length >= 2) add('info', `Contacted us ${recent.length + 1} times in 60 days`, `Earlier: ${recent.slice(0, 3).map((r) => `${r.case_no} (${r.sub_category})`).join(', ')}.`);

  /* tone and timing */
  if ((c.priority_reasons || []).some((r) => /legal|escalation/i.test(r))) add('danger', 'The customer mentions legal or escalation action', 'Hand it to a manager and keep the reply factual.');
  if ((c.priority_reasons || []).some((r) => /chasing/i.test(r))) add('warn', 'The customer is chasing', 'They wrote before without an answer. Apologise and give a date.');
  if (c.sensitive) add('info', 'Sensitive financial request', 'A finance, admin or IT user has to approve the reply.');
  if (c.language === 'ar') add('info', 'The customer wrote in Arabic', 'The reply is drafted in Arabic.');

  return out.sort((a, b) => RANK[a.tone] - RANK[b.tone]);
}
