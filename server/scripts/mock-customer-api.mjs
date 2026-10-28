// A stand-in for the real contract, customer and invoice systems (Orion Fleet, CNR Portal). Two uses:
//   1. tests build one in memory with createMockApi({ data }) and shut it down afterwards;
//   2. run it to try the live-data screens before the real APIs are available:
//
//        node scripts/mock-customer-api.mjs                # serves the CRM's own records at http://127.0.0.1:4010
//        MOCK_API_KEY=anything-you-like node scripts/mock-customer-api.mjs
//
//      then, in server/.env:   HELPDESK_ACCOUNT_SOURCE=api
//                              CUSTOMER_SYSTEMS_CONFIG=config/customer-systems.example.json
//                              MOCK_ORION_URL=http://127.0.0.1:4010/v1
//                              MOCK_ORION_KEY=<the same MOCK_API_KEY>
//
// Its field names are deliberately NOT the helpdesk's (camelCase, nested objects, upper-case statuses, dd/mm/yyyy dates, money as text),
// so config/customer-systems.example.json shows how a real API's shape is mapped. The real systems will look different again.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const json = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
};
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/** The shapes this fake API returns. `data` is { customers, contracts, invoices, fines, deposits } in the fake API's own vocabulary. */
export function createMockApi({ data, apiKey = 'dev-mock-key', prefix = '/v1' } = {}) {
  const state = { data, requests: [], down: false, delayMs: 0, rules: [] };

  const contractView = (c) => ({
    contractNumber: c.contractNumber, state: c.state, product: c.product, grandTotal: c.grandTotal, paymentState: c.paymentState,
    customerId: c.customerId, customerEmail: c.customerEmail,
    pickup: { at: c.startDate, branch: c.pickupBranch ? { name: c.pickupBranch.name, emirate: c.pickupBranch.emirate } : null },
    return: { at: c.endDate },
    vehicle: c.vehicle ? { make: c.vehicle.make, model: c.vehicle.model, plateNumber: c.vehicle.plate } : null,
    links: { portal: c.portalUrl || null },
  });
  const customerView = (c) => ({
    id: c.id, fullName: c.fullName, companyName: c.companyName || null, emailAddress: c.email, otherEmails: c.altEmails || [], mobile: c.mobile,
    loyalty: c.loyalty, accountType: c.accountType, state: c.state || 'ACTIVE',
  });
  const invoiceView = (i) => ({
    invoiceNo: i.invoiceNo, contractNumber: i.contractNumber, customerId: i.customerId,
    amount: { gross: i.gross, vat: i.vat }, state: i.state, issuedOn: i.issuedOn, dueOn: i.dueOn, outstanding: i.outstanding, pdf: i.pdf || null,
  });
  const fineView = (f) => ({ ref: f.ref, contractNumber: f.contractNumber, category: f.category, amount: f.amount, adminFee: f.adminFee, state: f.state, issuedAt: f.issuedAt });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://mock');
    const rec = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers };
    state.requests.push(rec);
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    for (const rule of state.rules) {
      if (rule.match(rec) && (rule.times === undefined || rule.times-- > 0)) return rule.reply(rec, res, json);
    }
    if (state.down) return json(res, 503, { error: { code: 'UNAVAILABLE', message: 'maintenance' } }, { 'retry-after': '1' });
    if (req.headers['x-api-key'] !== apiKey) return json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'bad key' } });
    if (req.method !== 'GET' || !url.pathname.startsWith(prefix)) return json(res, 404, { error: { code: 'NOT_FOUND' } });
    const parts = url.pathname.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent);
    const d = state.data;
    const q = url.searchParams;
    const limit = Math.min(100, Number(q.get('limit')) || 50);

    if (parts[0] === 'contracts' && parts.length === 2) {
      const c = d.contracts.find((x) => same(x.contractNumber, parts[1]));
      return c ? json(res, 200, { data: contractView(c) }) : json(res, 404, { error: { code: 'NOT_FOUND', message: 'No such contract' } });
    }
    if (parts[0] === 'contracts' && parts[2] === 'fines') return json(res, 200, { data: d.fines.filter((f) => same(f.contractNumber, parts[1])).slice(0, limit).map(fineView) });
    if (parts[0] === 'contracts' && parts[2] === 'deposit') {
      const dep = (d.deposits || {})[parts[1]] || (d.deposits || {})[String(parts[1]).toUpperCase()];
      return dep ? json(res, 200, { data: dep }) : json(res, 404, { error: { code: 'NOT_FOUND' } });
    }
    if (parts[0] === 'customers' && parts.length === 1) {
      const email = q.get('email');
      if (!email) return json(res, 400, { error: { code: 'BAD_REQUEST', message: 'email is required' } });
      const hits = d.customers.filter((c) => same(c.email, email) || (c.altEmails || []).some((e) => same(e, email)));
      return json(res, 200, { data: hits.slice(0, limit).map(customerView), total: hits.length });
    }
    if (parts[0] === 'customers' && parts.length === 2) {
      const c = d.customers.find((x) => String(x.id) === parts[1]);
      return c ? json(res, 200, { data: customerView(c) }) : json(res, 404, { error: { code: 'NOT_FOUND' } });
    }
    if (parts[0] === 'customers' && parts[2] === 'contracts') {
      const rows = d.contracts.filter((c) => String(c.customerId) === parts[1]).sort((a, b) => String(b.endDate).localeCompare(String(a.endDate))).slice(0, limit);
      return json(res, 200, { data: rows.map(contractView) });
    }
    if (parts[0] === 'invoices' && parts.length === 1) {
      const cn = q.get('contractNumber');
      const cid = q.get('customerId');
      if (!cn && !cid) return json(res, 400, { error: { code: 'BAD_REQUEST', message: 'contractNumber or customerId is required' } });
      const rows = d.invoices.filter((i) => (cn ? same(i.contractNumber, cn) : String(i.customerId) === cid)).slice(0, limit);
      return json(res, 200, { data: rows.map(invoiceView) });
    }
    return json(res, 404, { error: { code: 'NOT_FOUND' } });
  }

  const server = http.createServer((req, res) => { handle(req, res).catch((e) => json(res, 500, { error: { code: 'INTERNAL', message: e.message } })); });
  return {
    server, state,
    get requests() { return state.requests; },
    listen: (port = 0, host = '127.0.0.1') => new Promise((resolve) => server.listen(port, host, () => resolve(`http://${host}:${server.address().port}${prefix}`))),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
    /** Answer in a particular way for requests that match: { match(rec), reply(rec, res, json), times? }. */
    intercept: (rule) => { state.rules.push(rule); },
    reset: () => { state.requests.length = 0; state.rules.length = 0; state.down = false; state.delayMs = 0; },
  };
}

/* ------------------------------------------------------------------------------------------------ the CRM's own records, as this API */
const iso = (s) => (s ? `${String(s).replace(' ', 'T').slice(0, 19)}Z` : null);
const dmy = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : null; };
const STATE = { upcoming: 'BOOKED', active: 'ON_RENT', completed: 'RETURNED', cancelled: 'CANCELLED' };

export async function crmFixtures() {
  const { db } = await import('../src/db.js');
  const q = (sql, ...p) => db.prepare(sql).all(...p);
  const customers = q('SELECT id, name, email, phone, tier, segment FROM customers WHERE email IS NOT NULL').map((c) => ({
    id: `C-${c.id}`, fullName: c.name, email: c.email, altEmails: [], mobile: c.phone, loyalty: String(c.tier || 'Standard').toUpperCase(), accountType: c.segment === 'Corporate' ? 'CORPORATE' : 'INDIVIDUAL',
  }));
  const bookings = q(`SELECT b.*, c.email AS customer_email, v.plate, v.make, v.model, pb.name AS branch_name, pb.emirate AS branch_emirate
                        FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id LEFT JOIN vehicles v ON v.id = b.vehicle_id LEFT JOIN branches pb ON pb.id = b.pickup_branch_id`);
  const byId = new Map(bookings.map((b) => [b.id, b]));
  const contracts = bookings.map((b) => ({
    contractNumber: b.ref, state: STATE[b.status] || String(b.status).toUpperCase(), product: b.product_line, grandTotal: b.total_amount, paymentState: String(b.payment_status || '').toUpperCase(),
    customerId: `C-${b.customer_id}`, customerEmail: b.customer_email, startDate: iso(b.start_at), endDate: iso(b.end_at),
    pickupBranch: b.branch_name ? { name: b.branch_name, emirate: b.branch_emirate } : null, vehicle: b.plate ? { make: b.make, model: b.model, plate: b.plate } : null,
  }));
  const invoices = q('SELECT * FROM invoices').map((i) => {
    const b = byId.get(i.booking_id);
    return {
      invoiceNo: i.number, contractNumber: b ? b.ref : null, customerId: b ? `C-${b.customer_id}` : null, gross: i.total, vat: i.vat, state: String(i.status).toUpperCase(),
      issuedOn: dmy(i.issue_date), dueOn: dmy(i.due_date), outstanding: i.status === 'paid' ? '0.00' : Number(i.total).toFixed(2),
    };
  });
  const fines = q('SELECT * FROM fines').map((f) => {
    const b = byId.get(f.booking_id);
    return { ref: f.reference, contractNumber: b ? b.ref : null, category: f.type === 'Salik Toll' ? 'SALIK' : 'TRAFFIC', amount: f.amount, adminFee: f.admin_fee, state: String(f.status).toUpperCase(), issuedAt: iso(f.issued_at) };
  });
  const deposits = {};
  for (const f of q('SELECT * FROM hd_contract_financials')) {
    deposits[f.contract_no] = {
      deposit: f.deposit_amount ? { amount: f.deposit_amount, state: String(f.deposit_status || '').toUpperCase(), refundDue: f.deposit_refund_due || null } : null,
      cardHold: f.preauth_amount ? { amount: f.preauth_amount, state: String(f.preauth_status || '').toUpperCase(), releasedOn: f.preauth_released_at || null, last4: f.card_last4 || null } : null,
    };
  }
  return { customers, contracts, invoices, fines, deposits };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.MOCK_API_KEY || 'dev-mock-key';
  const port = Number(process.env.MOCK_API_PORT) || 4010;
  const data = await crmFixtures();
  const api = createMockApi({ data, apiKey: key });
  const base = await api.listen(port);
  console.log(`Mock customer systems on ${base}`);
  console.log(`  ${data.customers.length} customers, ${data.contracts.length} contracts, ${data.invoices.length} invoices, ${data.fines.length} fines (copied from the CRM database)`);
  console.log(`  sign in with the header  X-Api-Key: ${key === 'dev-mock-key' ? 'dev-mock-key' : '(your MOCK_API_KEY)'}`);
  console.log('  Ctrl+C stops it.');
}
