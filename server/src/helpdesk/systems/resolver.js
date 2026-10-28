// From an email to an account: given the sender's address and the contract number (when the email has one) it asks the
// configured customer systems for the contract, the customer and the invoices, and merges the answers into ONE snapshot
// that looks the same whatever the API looked like:
//   { source, systems, fetched_at, status, identity, inferred, customer, contract: { ...invoices, fines, financials }, other_contracts, errors, notes }
//
// Rules that matter:
//  - A question is only asked when it has something to ask with (no address, no customer lookup). Nothing is ever asked "for everybody".
//  - Part of an answer is better than none: if the invoices are down the contract and customer still show, marked "partial".
//  - `identity` says whether the sender really is the customer on that contract. A contract number typed in an email proves
//    nothing (anyone can type one), so a reply must not quote account figures unless the address matches or staff confirmed it.
//  - A contract is only guessed when the email gave no contract number at all, and only from the sender's own recent contracts.
import { loadConfig, lookupPlaceholders, sourceRuntime } from './config.js';
import { runLookup } from './client.js';
import { mapRow } from './mapping.js';

const DAY = 86400000;
const lower = (s) => String(s ?? '').trim().toLowerCase();
const norm = (s) => lower(s).replace(/[\s-]+/g, '_');
const gulfToday = () => new Date(Date.now() + 4 * 3600000).toISOString().slice(0, 10);

/* ------------------------------------------------------------------------------------------------ vocabulary */
// What systems call a status, in the words the helpdesk screens and replies use. The configuration's own "map" runs first.
const SYNONYMS = {
  contract: { active: ['open', 'in_progress', 'on_rent', 'rented', 'running', 'ongoing', 'out'], completed: ['closed', 'returned', 'finished', 'done', 'complete', 'checked_in'], upcoming: ['booked', 'reserved', 'confirmed', 'pending', 'scheduled', 'future'], cancelled: ['canceled', 'void', 'voided', 'no_show'] },
  invoice: { paid: ['settled', 'closed', 'complete', 'completed', 'cleared'], sent: ['unpaid', 'open', 'issued', 'due', 'outstanding', 'pending', 'posted'], overdue: ['past_due', 'late'], draft: ['unposted', 'preliminary'], cancelled: ['canceled', 'void', 'voided', 'credited'], partial: ['partially_paid', 'part_paid'] },
  fine: { recovered: ['paid', 'charged', 'collected', 'settled'], unrecovered: ['open', 'unpaid', 'pending', 'outstanding', 'not_recovered'], disputed: ['under_dispute', 'objection', 'appealed'] },
  payment: { paid: ['settled', 'complete', 'completed', 'captured'], unpaid: ['pending', 'open', 'due', 'outstanding', 'unsettled'], refunded: ['reversed', 'credited'], partial: ['partially_paid', 'part_paid'] },
  deposit: { held: ['hold', 'on_hold', 'blocked', 'retained'], refund_pending: ['refund_approved', 'pending_refund', 'refund_processing', 'processing', 'approved'], refunded: ['returned', 'released', 'paid_back'] },
  preauth: { active: ['held', 'authorized', 'authorised', 'blocked', 'open'], pending_release: ['release_requested', 'release_pending', 'releasing'], released: ['cancelled', 'canceled', 'voided', 'reversed', 'closed'] },
};
function canon(kind, v) {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const key = norm(v);
  for (const [name, words] of Object.entries(SYNONYMS[kind])) if (name === key || words.includes(key)) return name;
  return key;
}
const TIERS = { standard: 'Standard', basic: 'Standard', regular: 'Standard', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };
const canonTier = (v) => (v === undefined || v === null ? undefined : TIERS[lower(v)] || String(v));
const canonSegment = (v) => {
  const s = lower(v);
  if (!s) return undefined;
  if (/(corporate|company|business|b2b|fleet|enterprise)/.test(s)) return 'Corporate';
  if (/(individual|personal|retail|private|b2c|consumer)/.test(s)) return 'Individual';
  return String(v);
};
/** Links come from another system: only plain web addresses may become clickable. */
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u.trim()) ? u.trim() : null);
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const unique = (arr) => [...new Set(arr.filter(Boolean))];
const msOf = (s) => {
  if (!s) return NaN;
  const t = String(s).replace(' ', 'T');
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t)) return Date.parse(t); // already says its zone
  return Date.parse(t.length > 10 ? `${t}Z` : `${t}T00:00:00Z`);
};

/* ------------------------------------------------------------------------------------------------ rows -> shapes */
function customerOf(row, spec, ctx) {
  const m = mapRow(row, spec, ctx);
  const name = m.name || m.company || null;
  if (!name && !m.email && m.id === undefined) return null;
  const email = m.email ? lower(m.email) : null;
  return compact({
    id: m.id !== undefined ? String(m.id) : null, name, email, emails: unique([email, ...(m.emails || []).map(lower)]), phone: m.phone || null,
    tier: canonTier(m.tier), segment: canonSegment(m.segment), status: m.status ? norm(m.status) : null, company: m.company || null, language: m.language || null, url: safeUrl(m.url),
  });
}

function contractOf(row, spec, ctx, requestedNo = null) {
  const m = mapRow(row, spec, ctx);
  const no = m.contract_no || requestedNo;
  if (!no) return null;
  return {
    booking_id: null, ext_id: m.id !== undefined ? String(m.id) : null, contract_no: String(no).trim(),
    status: canon('contract', m.status) ?? null, product_line: m.product_line ?? null, start_at: m.start_at ?? null, end_at: m.end_at ?? null,
    total_amount: m.total_amount ?? null, payment_status: canon('payment', m.payment_status) ?? null, currency: m.currency || 'AED', url: safeUrl(m.url),
    customer_ref: compact({ id: m.customer_id !== undefined ? String(m.customer_id) : undefined, email: m.customer_email ? lower(m.customer_email) : undefined, name: m.customer_name, phone: m.customer_phone, tier: canonTier(m.customer_tier), segment: canonSegment(m.customer_segment) }),
    vehicle: m.vehicle_name || m.vehicle_plate ? { name: m.vehicle_name || '', plate: m.vehicle_plate || '' } : null,
    pickup_branch: m.branch_name ? { id: null, name: m.branch_name, emirate: m.branch_emirate || null } : null,
    invoices: [], fines: [], financials: null,
  };
}

function invoiceOf(row, spec, ctx, today) {
  const m = mapRow(row, spec, ctx);
  if (m.number === undefined && m.id === undefined) return null;
  let status = canon('invoice', m.status);
  let balance = m.balance;
  if (balance === undefined && (!status || ['paid', 'cancelled', 'sent', 'overdue', 'partial', 'draft'].includes(status))) {
    balance = status === 'paid' || status === 'cancelled' ? 0 : (m.total ?? undefined);
  } // a status the helpdesk does not know says nothing about what is left to pay: the balance stays unknown
  if (!status && balance !== undefined) status = balance <= 0 ? 'paid' : 'sent';
  if ((status === 'sent' || status === 'partial') && balance > 0 && m.due_date && m.due_date < today) status = 'overdue';
  return { id: m.id !== undefined ? String(m.id) : String(m.number), number: m.number !== undefined ? String(m.number) : String(m.id), contract_no: m.contract_no ?? null, total: m.total ?? null, vat: m.vat ?? null, status: status ?? null, issue_date: m.issue_date ?? null, due_date: m.due_date ?? null, balance: balance ?? null, currency: m.currency || 'AED', url: safeUrl(m.url) };
}

function fineOf(row, spec, ctx, index) {
  const m = mapRow(row, spec, ctx);
  if (m.reference === undefined && m.amount === undefined) return null;
  return { id: m.id !== undefined ? String(m.id) : String(m.reference ?? index), contract_no: m.contract_no ?? null, reference: m.reference ?? null, type: m.type || 'Fine', amount: m.amount ?? 0, admin_fee: m.admin_fee ?? 0, status: canon('fine', m.status) ?? null, issued_at: m.issued_at ?? null };
}

function financialsOf(row, spec, ctx) {
  const m = mapRow(row, spec, ctx);
  if (!Object.keys(m).length) return null;
  return compact({
    contract_no: m.contract_no, deposit_amount: m.deposit_amount, deposit_status: canon('deposit', m.deposit_status), deposit_refund_due: m.deposit_refund_due,
    preauth_amount: m.preauth_amount, preauth_status: canon('preauth', m.preauth_status), preauth_released_at: m.preauth_released_at, card_last4: m.card_last4 ? String(m.card_last4).replace(/\D/g, '').slice(-4) || undefined : undefined,
  });
}

/* ------------------------------------------------------------------------------------------------ is the answer about what was asked */
/**
 * An API that ignores a filter answers with somebody else's records. A question is only trusted to be limited to what it asked about when
 * the identifier is part of the address path (/customers/{customer_id}/contracts) or the configuration says "scoped": true. Otherwise every
 * record has to carry its own proof (the contract number, the customer id or the address) and is dropped without it.
 */
const pathScoped = (lk) => lookupPlaceholders({ path: lk.path }).some((p) => !p.optional);
const trusted = (lk) => Boolean(lk) && (lk.scoped === true || pathScoped(lk));

/* ------------------------------------------------------------------------------------------------ who is writing */
/**
 * Is the sender the customer on this contract?
 *   'email'          the address belongs to the contract's customer (or the contract came from the sender's own records)
 *   'contract_only'  the contract was found from a number in the email, but nothing shows the address is the customer's
 *   'none'           nothing matched
 * `owner` is the customer record read through the contract (not through the sender's address).
 */
export function identityOf({ email, customerFromEmail = null, contract = null, owner = null, inferred = false }) {
  const sender = lower(email);
  if (!sender) return 'none';
  const ref = (contract && contract.customer_ref) || {};
  if (contract && inferred) { // chosen from the sender's own contracts, unless the contract itself names another customer
    return customerFromEmail && customerFromEmail.id != null && ref.id != null && String(customerFromEmail.id) !== String(ref.id) ? 'contract_only' : 'email';
  }
  if (!contract) return customerFromEmail ? 'email' : 'none';
  if (customerFromEmail && customerFromEmail.id != null && ref.id != null) return String(customerFromEmail.id) === String(ref.id) ? 'email' : 'contract_only';
  const ownerEmails = new Set([ref.email, ...(owner ? [owner.email, ...(owner.emails || [])] : [])].filter(Boolean).map(lower));
  if (ownerEmails.has(sender)) return 'email';
  if (customerFromEmail && (customerFromEmail.emails || []).some((e) => ownerEmails.has(lower(e)))) return 'email';
  return 'contract_only';
}

const alnum = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
/** "AST-100123" is "100123" is "ast100123". */
export function sameContractNo(a, b) {
  const x = alnum(a);
  const y = alnum(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length < y.length ? [x, y] : [y, x];
  return /^\d{5,}$/.test(s) && l.endsWith(s);
}

/** The sender's own most recent rental: running, or finished within 60 days. Same rule the CRM uses. */
export function pickRecent(rows, now = Date.now()) {
  const usable = rows.filter((r) => r.status !== 'cancelled' && r.status !== 'upcoming' && (r.status === 'active' || !r.end_at || msOf(r.end_at) >= now - 60 * DAY));
  usable.sort((a, b) => (Number.isFinite(msOf(b.end_at)) ? msOf(b.end_at) : now) - (Number.isFinite(msOf(a.end_at)) ? msOf(a.end_at) : now));
  return usable[0] || null;
}

/* ------------------------------------------------------------------------------------------------ the resolver */
const summarize = (r) => ({
  name: r.name, source: r.label, ok: r.ok && !r.error, found: r.ok && !r.notFound, skipped: Boolean(r.skipped), reason: r.reason || null,
  status: r.status, ms: r.ms, cached: r.cached, url: r.url, error: r.error ? r.error.message : null, code: r.error ? r.error.code : null,
});

/**
 * -> { snapshot, steps }. Never throws: problems are in snapshot.errors. keepRaw adds each answer's raw JSON to its step (setup test only).
 * `explicitContract` is true when the email (or a person) gave a contract number, which switches off guessing.
 */
export async function resolveDetailed({ email = null, contractNo = null, bypassCache = false, keepRaw = false } = {}) {
  const { config } = loadConfig();
  const lk = config.lookups;
  const deadline = Date.now() + config.deadline_ms;
  const warnings = [];
  const errors = [];
  const notes = [];
  const steps = [];
  const ctx = { offset: config.utc_offset_hours, warn: (m) => { if (warnings.length < 20 && !warnings.includes(m)) warnings.push(m); } };
  const today = gulfToday();
  const sender = email ? lower(email) : '';
  const requested = contractNo ? String(contractNo).trim() : '';

  const run = async (name, vars) => {
    const r = await runLookup(name, vars, { deadline, bypassCache, keepRaw });
    steps.push({ ...summarize(r), ...(keepRaw ? { raw: r.raw, rows: r.rows.length } : {}) });
    if (r.error) errors.push({ lookup: name, source: r.label, code: r.error.code, message: r.error.message });
    return r;
  };
  const sourcesUsed = new Set();
  const note = (r) => { if (r && r.label && !r.skipped) sourcesUsed.add(r.label); return r; };

  // 1. what the email itself points at: the contract number and the sender's address
  const base = { email: sender, contract_no: requested };
  const [cr, er] = await Promise.all([requested ? run('contract', base) : null, sender ? run('customer_by_email', base) : null]);
  note(cr); note(er);

  // An API that ignores a filter answers with somebody else's records. So an answer is only used when it provably is about what was asked.
  let contract = null;
  if (cr && cr.ok && cr.rows.length) {
    const cands = cr.rows.map((r) => ({ r, c: contractOf(r, lk.contract.map, ctx, null) }));
    const hit = cands.find((x) => x.c && sameContractNo(x.c.contract_no, requested));
    if (hit) contract = hit.c;
    else if (cands.length === 1 && !cands[0].c && trusted(lk.contract)) contract = contractOf(cands[0].r, lk.contract.map, ctx, requested); // the answer carries no number: one record, and the address named the contract
    if (!contract) warnings.push(`The contract lookup answered, but not with contract ${requested}. Check that its address or query limits the answer to one contract, and that "contract_no" is mapped.`);
  }
  let customerFromEmail = null;
  if (er && er.ok && er.rows.length) {
    const all = er.rows.map((r) => customerOf(r, lk.customer_by_email.map, ctx)).filter(Boolean);
    const named = all.filter((c) => (c.emails || []).length);
    const fits = named.length ? all.filter((c) => (c.emails || []).includes(sender)) : (all.length === 1 ? all : []);
    const named_by_contract = contract && contract.customer_ref && contract.customer_ref.id != null ? fits.find((c) => c.id != null && String(c.id) === String(contract.customer_ref.id)) : null;
    customerFromEmail = named_by_contract || fits.find((c) => c.status !== 'inactive') || fits[0] || null;
    if (!customerFromEmail && all.length) warnings.push(`The customer lookup answered with ${all.length} customer${all.length > 1 ? 's' : ''}, none with the address ${sender}. Check that its query filters by e-mail and that "email" is mapped.`);
    if (new Set(fits.map((c) => c.id)).size > 1) notes.push(`${fits.length} customers share the address ${sender}. The first match is shown: check it is the right one.`);
  }

  // 2. who the contract belongs to. The sender's own record when it is the same person, else the record the contract points at.
  const ref = contract ? contract.customer_ref : null;
  const senderIsOwner = Boolean(customerFromEmail && customerFromEmail.id != null && ref && ref.id != null && String(customerFromEmail.id) === String(ref.id));
  let owner = senderIsOwner ? customerFromEmail : null;
  if (!owner && ref && ref.id && lk.customer_by_id) {
    const r = note(await run('customer_by_id', { ...base, customer_id: ref.id }));
    if (r.ok && r.rows.length) {
      const cs = r.rows.map((x) => customerOf(x, lk.customer_by_id.map, ctx)).filter(Boolean);
      owner = cs.find((c) => c.id != null && String(c.id) === String(ref.id)) || (cs.length === 1 && cs[0].id == null && trusted(lk.customer_by_id) ? cs[0] : null);
    }
  }
  if (!owner && ref && (ref.name || ref.email || ref.id)) { // the contract carries the customer's details itself
    owner = compact({ id: ref.id || null, name: ref.name || null, email: ref.email || null, emails: ref.email ? [ref.email] : [], phone: ref.phone || null, tier: ref.tier, segment: ref.segment });
  }
  if (owner && ref) { owner.tier = owner.tier || ref.tier; owner.segment = owner.segment || ref.segment; } // facts the contract carries that the record lacked
  // the case is about the person who wrote when we know them, otherwise about the contract's customer
  const customer = customerFromEmail || owner || null;

  // 3. the customer's other contracts, and a guess only when the email named none
  let others = [];
  let inferred = false;
  const knownCustomerId = customer && customer.id ? customer.id : null;
  const listVars = { ...base, customer_id: knownCustomerId || '' };
  const wantsList = lk.contracts_by_customer && (knownCustomerId || sender);
  const listP = wantsList ? run('contracts_by_customer', listVars).then(note) : Promise.resolve(null);

  // 4. money, in parallel with the list: the invoices (by contract, else by customer), fines, deposit and card hold
  const moneyFor = (no) => ({ ...base, contract_no: no || '', customer_id: knownCustomerId || '' });
  const fetchMoney = async (c) => {
    const vars = moneyFor(c ? c.contract_no : '');
    const [ir, fr, nr] = await Promise.all([
      lk.invoices ? run('invoices', vars).then(note) : null,
      c && lk.fines ? run('fines', vars).then(note) : null,
      c && lk.financials ? run('financials', vars).then(note) : null,
    ]);
    return { ir, fr, nr };
  };
  const [listR, firstMoney] = await Promise.all([listP, contract ? fetchMoney(contract) : Promise.resolve(null)]);
  let allMine = [];
  if (listR && listR.ok && listR.rows.length) {
    const emailsOf = (c) => (c ? [c.email, ...(c.emails || [])].filter(Boolean).map(lower) : []);
    const mine = (row) => trusted(lk.contracts_by_customer) || Boolean(customer && row.customer_ref && (
      (row.customer_ref.id != null && customer.id != null && String(row.customer_ref.id) === String(customer.id)) || (row.customer_ref.email && emailsOf(customer).includes(row.customer_ref.email))));
    const listed = listR.rows.slice(0, 100).map((r) => contractOf(r, lk.contracts_by_customer.map, ctx)).filter(Boolean);
    allMine = listed.filter(mine);
    if (listed.length && allMine.length < listed.length) warnings.push(`${listed.length - allMine.length} of the ${listed.length} contracts the list returned could not be shown to belong to this customer, so they were not used. Map customer_id or customer_email in "contracts_by_customer", or put the customer in the address.`);
    const byEnd = (a, b) => String(b.end_at || b.start_at || '').localeCompare(String(a.end_at || a.start_at || ''));
    others = allMine.slice().sort(byEnd).slice(0, 10);
  }

  let money = firstMoney;
  if (!contract && !requested && allMine.length) {
    const pick = pickRecent(allMine);
    if (pick) {
      inferred = true;
      contract = pick;
      if (lk.contract && pick.contract_no) { // the list row is usually thin: read the full contract, if it really is that contract and the same customer's
        const full = note(await run('contract', { ...base, contract_no: pick.contract_no }));
        if (full.ok && full.rows.length) {
          const fc = contractOf(full.rows[0], lk.contract.map, ctx, null) || (full.rows.length === 1 && trusted(lk.contract) ? contractOf(full.rows[0], lk.contract.map, ctx, pick.contract_no) : null);
          const fref = (fc && fc.customer_ref) || {};
          if (fc && sameContractNo(fc.contract_no, pick.contract_no) && !(fref.id != null && customer && customer.id != null && String(fref.id) !== String(customer.id))) contract = fc;
          else warnings.push(`The full contract read for ${pick.contract_no} did not match it, so the list row was used.`);
        }
      }
      if (!owner) owner = customerFromEmail || customer; // a contract chosen from the sender's own list belongs to the sender
      money = await fetchMoney(contract);
    }
  }
  if (!contract && customer && lk.invoices && !money) money = await fetchMoney(null); // no contract at all: still show what the customer owes
  if (requested && !contract && cr && cr.ok && !errors.some((e) => e.lookup === 'contract')) {
    notes.push(`Contract ${requested} was not found${cr.label ? ` in ${cr.label}` : ''}.${others.length ? ` The sender has ${others.length} other contract${others.length > 1 ? 's' : ''}: see below.` : ''}`);
  }

  // 5. attach the money to the contract
  const max = config.max_invoices;
  const byDate = (key) => (a, b) => String(b[key] || '').localeCompare(String(a[key] || ''));
  let invoices = []; // everything the invoice lookup returned (it may cover all of the customer's contracts)
  let fines = [];
  let financials = null;
  const ofThisContract = (row) => !contract || !row.contract_no || sameContractNo(row.contract_no, contract.contract_no);
  // a record is used when the question was limited by its address, or when the record itself says which contract it belongs to
  const proven = (lkName, row) => trusted(lk[lkName]) || Boolean(contract && row.contract_no && sameContractNo(row.contract_no, contract.contract_no));
  const keepProven = (lkName, rows) => {
    const kept = rows.filter((r) => proven(lkName, r));
    if (kept.length < rows.length) warnings.push(`${rows.length - kept.length} record${rows.length - kept.length > 1 ? 's' : ''} from "${lkName}" could not be shown to belong to this contract, so they were not used. Map contract_no in that lookup, or put the contract in the address.`);
    return kept;
  };
  if (money) {
    if (money.ir && money.ir.ok) invoices = keepProven('invoices', money.ir.rows.map((r) => invoiceOf(r, lk.invoices.map, ctx, today)).filter(Boolean)).sort(byDate('issue_date'));
    if (money.fr && money.fr.ok) fines = keepProven('fines', money.fr.rows.map((r, i) => fineOf(r, lk.fines.map, ctx, i)).filter(Boolean)).filter(ofThisContract).sort(byDate('issued_at')).slice(0, 25);
    if (money.nr && money.nr.ok && money.nr.rows.length) { const f = financialsOf(money.nr.rows[0], lk.financials.map, ctx); financials = f && keepProven('financials', [f]).length ? f : null; }
  }
  // what is owed is counted over everything returned: it is the customer's balance, not only this contract's
  const unpaid = invoices.filter((i) => ['sent', 'overdue', 'partial'].includes(i.status) && Number(i.balance) > 0);
  const invoiceSummary = { count: invoices.length, unpaid_count: unpaid.length, outstanding: Math.round(unpaid.reduce((s, i) => s + Number(i.balance || 0), 0) * 100) / 100, overdue_count: invoices.filter((i) => i.status === 'overdue').length };

  const decidedIdentity = identityOf({ email: sender, customerFromEmail, contract, owner, inferred });
  if (contract) {
    const { customer_ref: _ref, ...plain } = contract; // identity was decided from it; the stored copy keeps the customer once
    contract = { ...plain, invoices: invoices.filter(ofThisContract).slice(0, max), fines, financials, invoice_summary: invoiceSummary, customer: owner ? compact({ id: owner.id, name: owner.name, email: owner.email, phone: owner.phone, tier: owner.tier, segment: owner.segment }) : null };
  }
  const owedWithoutContract = !contract && customer && invoices.length ? invoiceSummary : null;

  // 6. the verdict
  const identity = decidedIdentity;
  const found = Boolean(contract || customer);
  const status = errors.length ? (found ? 'partial' : 'unavailable') : found ? 'ok' : 'not_found';
  const asked = steps.filter((s) => !s.skipped);
  if (!asked.length && !errors.length) notes.push('No customer-system lookup could be made: the email has neither a contract number nor a sender address the lookups can use.');

  const snapshot = {
    v: 1, source: 'api', systems: [...sourcesUsed], fetched_at: new Date().toISOString(), status, identity, inferred,
    customer: customer || null, contract: contract || null, other_contracts: others.filter((o) => !contract || lower(o.contract_no) !== lower(contract.contract_no)).map(thin),
    open_invoices: owedWithoutContract ? { ...owedWithoutContract, items: invoices.slice(0, 10) } : null,
    errors, notes, warnings,
    lookups: steps.map(({ raw, rows, ...rest }) => rest),
  };
  return { snapshot, steps };
}

/** Other contracts are listed, not expanded: just enough to recognise them and choose one. */
function thin(c) {
  return { contract_no: c.contract_no, status: c.status, product_line: c.product_line, start_at: c.start_at, end_at: c.end_at, vehicle: c.vehicle, total_amount: c.total_amount };
}

export const resolveFromApi = async (input) => (await resolveDetailed(input)).snapshot;

/** Which systems are named in the configuration, for the status page. */
export const configuredSources = () => {
  const { config } = loadConfig();
  return Object.keys(config.sources).map((n) => sourceRuntime(n, config));
};
