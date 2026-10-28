// Contract and customer lookup in the CRM's own tables (bookings, invoices, fines, customers, plus the deposit and
// pre-authorization table). This is the demo data source. With the customer systems connected (systems/), the live
// contract, customer and invoice data comes from their APIs instead; crmAccount() gives the same answer shape as the connector,
// so the rest of the helpdesk does not care which one it asked.
import { db } from '../db.js';
import { identityOf } from './systems/resolver.js';

const BOOKING_SQL = `SELECT b.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone, c.tier, c.segment,
    v.plate, (v.make || ' ' || v.model) AS vehicle_name, pb.name AS pickup_branch, pb.emirate AS pickup_emirate
  FROM bookings b
  LEFT JOIN customers c ON c.id = b.customer_id
  LEFT JOIN vehicles v ON v.id = b.vehicle_id
  LEFT JOIN branches pb ON pb.id = b.pickup_branch_id`;

function shape(b) {
  const invoices = db.prepare('SELECT id, number, total, vat, status, issue_date, due_date FROM invoices WHERE booking_id = ? ORDER BY issue_date DESC').all(b.id);
  const fines = db.prepare('SELECT id, reference, type, amount, admin_fee, status, issued_at FROM fines WHERE booking_id = ? ORDER BY issued_at DESC').all(b.id);
  const financials = db.prepare('SELECT * FROM hd_contract_financials WHERE contract_no = ?').get(b.ref) || null;
  return {
    booking_id: b.id, contract_no: b.ref, status: b.status, product_line: b.product_line, start_at: b.start_at, end_at: b.end_at,
    total_amount: b.total_amount, payment_status: b.payment_status,
    customer: b.customer_id ? { id: b.customer_id, name: b.customer_name, email: b.customer_email, phone: b.customer_phone, tier: b.tier, segment: b.segment } : null,
    vehicle: b.plate ? { name: b.vehicle_name, plate: b.plate } : null,
    pickup_branch: b.pickup_branch_id ? { id: b.pickup_branch_id, name: b.pickup_branch, emirate: b.pickup_emirate } : null,
    invoices, fines, financials,
  };
}

/** Find a booking by its reference, tolerating a bare number ("100123" for "AST-100123"). */
export function lookupContract(contractNo) {
  if (!contractNo) return null;
  const ref = String(contractNo).toUpperCase().trim();
  let b = db.prepare(`${BOOKING_SQL} WHERE b.ref = ?`).get(ref);
  const digits = ref.replace(/\D/g, '');
  if (!b && digits.length >= 5) b = db.prepare(`${BOOKING_SQL} WHERE b.ref LIKE ? ORDER BY b.id DESC`).get(`%${digits}`);
  return b ? shape(b) : null;
}

export function findCustomerByEmail(email) {
  if (!email) return null;
  return db.prepare('SELECT id, name, email, phone, tier, segment FROM customers WHERE lower(email) = lower(?) LIMIT 1').get(String(email).trim()) || null;
}

/** When an email carries no contract number: the customer's most recent live or recently finished booking. */
export function guessContractForCustomer(customerId) {
  if (!customerId) return null;
  const b = db.prepare(`${BOOKING_SQL} WHERE b.customer_id = ? AND b.status IN ('active', 'completed')
                         AND b.end_at >= datetime('now', '-60 days') ORDER BY b.end_at DESC LIMIT 1`).get(customerId);
  return b ? shape(b) : null;
}

/** Other cases for the same contract or sender (email history matching). */
export function relatedCases({ caseId = null, contractNo = null, email = null, limit = 8 }) {
  if (!contractNo && !email) return [];
  const where = [];
  const params = [];
  if (contractNo) { where.push('contract_no = ?'); params.push(contractNo); }
  if (email) { where.push('lower(customer_email) = lower(?)'); params.push(email); }
  return db.prepare(`SELECT id, case_no, status, sub_category, priority, subject, contract_no, customer_email, first_received_at, closed_at
                       FROM hd_cases WHERE (${where.join(' OR ')}) ${caseId ? 'AND id <> ?' : ''}
                       ORDER BY first_received_at DESC LIMIT ?`).all(...params, ...(caseId ? [caseId] : []), limit);
}

const lowerEmail = (e) => String(e || '').trim().toLowerCase();

/**
 * The account for an email, from the CRM tables, in the same shape the customer-systems connector returns.
 * A contract is only guessed (from the sender's latest rental) when the email named no contract at all.
 * `assumeInferred` re-reads a case whose contract was guessed earlier.
 */
export function crmAccount({ email = null, contractNo = null, assumeInferred = false } = {}) {
  const sender = lowerEmail(email);
  const customerFromEmail = sender ? findCustomerByEmail(sender) : null;
  let contract = contractNo ? lookupContract(contractNo) : null;
  let inferred = false;
  if (!contract && (!contractNo || assumeInferred) && customerFromEmail) {
    const guess = guessContractForCustomer(customerFromEmail.id);
    if (guess) { contract = guess; inferred = true; }
  }
  const owner = contract && contract.customer ? contract.customer : null;
  const customer = customerFromEmail || owner || null;
  const identity = identityOf({
    email: sender, customerFromEmail: customerFromEmail && { ...customerFromEmail, emails: [lowerEmail(customerFromEmail.email)] },
    contract: contract && { ...contract, customer_ref: owner ? { id: owner.id, email: lowerEmail(owner.email) } : {} },
    owner: owner && { ...owner, emails: [lowerEmail(owner.email)] }, inferred,
  });
  if (contract) {
    const open = contract.invoices.filter((i) => ['sent', 'overdue'].includes(i.status));
    contract = {
      ...contract,
      invoices: contract.invoices.map((i) => ({ ...i, balance: i.status === 'paid' || i.status === 'cancelled' ? 0 : i.total, currency: 'AED' })),
      invoice_summary: { count: contract.invoices.length, unpaid_count: open.length, outstanding: Math.round(open.reduce((n, i) => n + Number(i.total || 0), 0) * 100) / 100, overdue_count: contract.invoices.filter((i) => i.status === 'overdue').length },
    };
  }
  const others = customer
    ? db.prepare(`${BOOKING_SQL} WHERE b.customer_id = ? ${contract ? 'AND b.id <> ?' : ''} ORDER BY b.start_at DESC LIMIT 10`).all(...(contract ? [customer.id, contract.booking_id] : [customer.id]))
      .map((b) => ({ contract_no: b.ref, status: b.status, product_line: b.product_line, start_at: b.start_at, end_at: b.end_at, vehicle: b.plate ? { name: b.vehicle_name, plate: b.plate } : null, total_amount: b.total_amount }))
    : [];
  const notes = [];
  if (contractNo && !contract) notes.push(`Contract ${contractNo} was not found in the CRM.${others.length ? ` The sender has ${others.length} other contract${others.length > 1 ? 's' : ''}: see below.` : ''}`);
  return {
    v: 1, source: 'crm', systems: ['Autostrad CRM'], fetched_at: new Date().toISOString(), status: contract || customer ? 'ok' : 'not_found', identity, inferred,
    customer: customer || null, contract, other_contracts: others, open_invoices: null, errors: [], notes, warnings: [], lookups: [],
  };
}
