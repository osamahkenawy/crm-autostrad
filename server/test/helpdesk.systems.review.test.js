// Regression tests for what an independent review of the customer-systems connector found. Each test reproduces one finding
// (the scenario is in the test name) and checks the fix. Same setup as helpdesk.systems.test.js: throw-away database, fake
// systems on 127.0.0.1, fake keys.   Run: node --test test/helpdesk.systems.review.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-hd-review-'));
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|GRAPH_|HELPDESK_|ORION_|CNR_|CUSTOMER_)/.test(k)) delete process.env[k];
process.env.ARC_DB_PATH = path.join(dir, 'review.test.db');
process.env.HELPDESK_SCHEDULER = 'off';
process.env.HELPDESK_ACCOUNT_SOURCE = 'api';
process.env.ORION_API_KEY = 'orion-test-key';
process.env.CNR_API_KEY = 'orion-test-key';
const EXAMPLE = path.join(root, 'config', 'customer-systems.example.json');
process.env.CUSTOMER_SYSTEMS_CONFIG = EXAMPLE;

const { db, migrate } = await import('../src/db.js');
migrate();
const { seedDefaultKeywords, seedDefaultTemplates } = await import('../src/helpdesk/templates.js');
seedDefaultKeywords();
seedDefaultTemplates();

const mapping = await import('../src/helpdesk/systems/mapping.js');
const cfgMod = await import('../src/helpdesk/systems/config.js');
const client = await import('../src/helpdesk/systems/client.js');
const { resolveDetailed } = await import('../src/helpdesk/systems/resolver.js');
const account = await import('../src/helpdesk/systems/account.js');
const actions = await import('../src/helpdesk/systems/actions.js');
const { createMockApi } = await import('../scripts/mock-customer-api.mjs');
const { ingestMessage } = await import('../src/helpdesk/pipeline.js');
const { getCaseDetail, getCaseRow, updateCase } = await import('../src/helpdesk/cases.js');
const { approveDraft } = await import('../src/helpdesk/drafts.js');
const { extractEntities } = await import('../src/helpdesk/extract.js');
const { nowUtc } = await import('../src/helpdesk/routing.js');

client.tuning.retryPauseMs = 5;
client.tuning.breakerOpenMs = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');
const iso = (days) => new Date(Date.now() + days * DAY).toISOString().replace(/\.\d+Z$/, 'Z');
const dmy = (days) => { const d = new Date(Date.now() + days * DAY); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; };
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function serve(handler) {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push({ method: req.method, url: req.url, headers: req.headers }); Promise.resolve(handler(req, res)).catch((e) => { res.writeHead(500); res.end(e.message); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

let cfgCount = 0;
function useConfig(config, { forgetGood = true } = {}) {
  let file = config;
  if (typeof config === 'object') { file = path.join(dir, `cfg-${++cfgCount}.json`); fs.writeFileSync(file, JSON.stringify(config)); }
  process.env.CUSTOMER_SYSTEMS_CONFIG = file;
  cfgMod.resetConfigCache({ forgetGood });
  client.resetClient();
  return file;
}
const example = () => JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
/** The example configuration with one change. */
const variant = (change) => { const c = example(); change(c); return useConfig(c); };
const oneSource = (url, over = {}, lookup = {}) => ({
  enabled: true,
  sources: { s: { label: 'Test system', base_url: url, allow_http: true, timeout_ms: 800, ...over } },
  lookups: { contract: { source: 's', path: '/contracts/{contract_no}', result: 'data', map: { contract_no: 'no' }, ...lookup } },
});

/* ================================================================================================ 1. email-triggered slowdown */
describe('a hostile email cannot stall the helpdesk', () => {
  it('a long run of spaces in a mail does not make contract-number extraction slow, and real numbers are still found', () => {
    const cases = [['contract', 'contract' + ' '.repeat(6000) + 'x'], ['fine', 'fine' + ' '.repeat(6000) + 'x'], ['alternating', 'contract' + ' \n'.repeat(4000) + 'x'], ['arabic', 'رقم العقد' + ' '.repeat(6000) + 'x'], ['huge', ' '.repeat(2_000_000)]];
    for (const [label, body] of cases) {
      const t0 = Date.now();
      extractEntities({ subject: '', body });
      assert.ok(Date.now() - t0 < 250, `${label} took ${Date.now() - t0} ms`);
    }
    const found = (body) => extractEntities({ body }).contract_candidates;
    assert.deepEqual(found('Hello, contract no: AST-100123 please'), ['AST-100123']);
    assert.deepEqual(found('The Contract number 654321 is wrong'), ['654321']);
    assert.deepEqual(found('my booking #123456'), ['123456']);
    assert.deepEqual(found('reservation:   987654'), ['987654']);
    assert.deepEqual(found('رقم العقد 123456 من فضلكم'), ['123456']);
    assert.equal(extractEntities({ body: 'fine no. TF-12345678 was charged' }).fine_ref, 'TF-12345678');
  });
});

/* ================================================================================================ 2. parsing */
describe('numbers and dates are read strictly', () => {
  const { toNumber, toDateText } = mapping;
  it('only a currency word or a sign may stand next to the digits', () => {
    assert.equal(toNumber('5-'), -5, 'accounting minus');
    assert.equal(toNumber('0,500'), 0.5);
    assert.equal(toNumber('1,500'), 1500);
    assert.equal(toNumber('1e3'), undefined);
    assert.equal(toNumber('AST-100123'), undefined, 'a contract number is not an amount');
    assert.equal(toNumber('12abc'), undefined);
    assert.equal(toNumber('Dhs 1,500.25'), 1500.25);
    assert.equal(toNumber('AED -5'), -5);
    assert.equal(toNumber('(12.00)'), -12);
  });
  it('reads month names by hand, whatever time zone the server runs in, and refuses nonsense', () => {
    assert.equal(toDateText('1 October 2026', 'date'), '2026-10-01');
    assert.equal(toDateText('Tue, 01 Oct 2026 10:00:00 GMT', 'datetime'), '2026-10-01 10:00:00');
    assert.equal(toDateText('01-Oct-2026', 'date'), '2026-10-01');
    assert.equal(toDateText('TBD 5', 'date'), undefined);
    assert.equal(toDateText('25:61:61', 'datetime'), undefined);
    assert.equal(toDateText('2026-10-06 25:00', 'datetime'), undefined);
    assert.equal(toDateText('01/10/2026 24:30', 'datetime'), undefined);
    assert.equal(toDateText('31 Feb 2026', 'date'), undefined);
  });
});

/* ================================================================================================ 3. configuration */
describe('the configuration cannot silently change what the helpdesk does', () => {
  afterEach(() => { process.env.HELPDESK_ACCOUNT_SOURCE = 'api'; });

  it('a file edited into a broken state keeps working as it was, and never becomes the demo records', () => {
    delete process.env.HELPDESK_ACCOUNT_SOURCE; // as in production: the file decides
    const file = useConfig(EXAMPLE);
    const good = fs.readFileSync(EXAMPLE, 'utf8');
    const own = path.join(dir, 'edited.json');
    fs.writeFileSync(own, good);
    useConfig(own);
    assert.equal(cfgMod.loadConfig().ok, true);
    assert.equal(cfgMod.accountMode(), 'api');
    fs.writeFileSync(own, '{ "enabled": true, oops');
    cfgMod.resetConfigCache(); // the parse is read again, the last good version is remembered
    const broken = cfgMod.loadConfig();
    assert.equal(broken.ok, false);
    assert.equal(broken.usingLastGood, true);
    assert.equal(Object.keys(broken.config.lookups).length, 7, 'the last good lookups are still there');
    assert.equal(cfgMod.accountMode(), 'api', 'not crm');
    fs.writeFileSync(own, good);
    cfgMod.resetConfigCache();
    assert.equal(cfgMod.loadConfig().ok, true);
    assert.equal(file.length > 0, true);
  });

  it('a file that was never good fails closed: lookups say why they cannot run, they do not fall back to the CRM', async () => {
    delete process.env.HELPDESK_ACCOUNT_SOURCE;
    const own = path.join(dir, 'never-good.json');
    fs.writeFileSync(own, '{ not json');
    useConfig(own);
    assert.equal(cfgMod.accountMode(), 'api');
    const snap = await account.resolveAccount({ email: 'sara@example.test', contractNo: 'AST-100001' });
    assert.equal(snap.source, 'api');
    assert.equal(snap.status, 'unavailable');
    assert.match(snap.errors[0].message, /configuration has problems/);
    // while the shipped default stays what it is: valid and switched off
    useConfig(path.join(root, 'config', 'customer-systems.json'));
    assert.equal(cfgMod.accountMode(), 'crm');
  });

  it('an address with a user name and password in it is refused, and the password is never shown', async () => {
    const problems = (c) => { useConfig(c); return cfgMod.loadConfig().problems.join(' '); };
    assert.match(problems(oneSource('http://svc:TopSecretPw9@127.0.0.1:9')), /must not contain a user name or password/);
    assert.ok(!problems(oneSource('http://svc:TopSecretPw9@127.0.0.1:9')).includes('TopSecretPw9'));
    // an address from the environment is judged when it is used
    const srv = await serve((req, res) => send(res, 200, { data: { no: 'X' } }));
    try {
      process.env.TEST_BASE = `http://svc:TopSecretPw9@${srv.url.replace('http://', '')}`;
      const c = oneSource(srv.url); delete c.sources.s.base_url; c.sources.s.base_url_env = 'TEST_BASE';
      useConfig(c);
      const r = await client.runLookup('contract', { contract_no: 'AST-1' });
      assert.equal(r.error.code, 'config');
      assert.ok(!JSON.stringify(r).includes('TopSecretPw9'));
      assert.equal(srv.hits.length, 0, 'nothing was sent');
    } finally { delete process.env.TEST_BASE; await srv.close(); }
  });

  it('plain http is refused for an address from the environment and for the sign-in address, in production', () => {
    process.env.NODE_ENV = 'production';
    try {
      process.env.TEST_BASE = 'http://orion.internal.test/api';
      process.env.TEST_TOKEN_URL = 'http://login.internal.test/token';
      process.env.TEST_ID = 'x'; process.env.TEST_SECRET = 'y';
      const c = oneSource('https://x.test');
      delete c.sources.s.base_url; c.sources.s.base_url_env = 'TEST_BASE'; c.sources.s.allow_http = false;
      c.sources.s.auth = { type: 'oauth2_client_credentials', token_url_env: 'TEST_TOKEN_URL', client_id_env: 'TEST_ID', client_secret_env: 'TEST_SECRET' };
      useConfig(c);
      const rt = cfgMod.sourceRuntime('s');
      assert.equal(rt.problems.length, 2);
      assert.match(rt.problems.join(' '), /base address uses plain http/i);
      assert.match(rt.problems.join(' '), /sign-in address uses plain http/i);
    } finally { delete process.env.NODE_ENV; for (const k of ['TEST_BASE', 'TEST_TOKEN_URL', 'TEST_ID', 'TEST_SECRET']) delete process.env[k]; }
  });

  it('quoted values can be escaped for OData and for JSON or GraphQL texts, and a value that filters to nothing is missing', () => {
    const { fillPlaceholders } = cfgMod;
    assert.equal(fillPlaceholders("$filter=Email eq '{email|odata}'", { email: "o'brien@x.test" }, 'json').text, "$filter=Email eq 'o''brien@x.test'");
    assert.equal(fillPlaceholders('query { c(email: "{email|quote}") }', { email: 'a"b\\c) { id } x: y(z: "@x.test' }, 'json').text, 'query { c(email: "a\\"b\\\\c) { id } x: y(z: \\"@x.test") }');
    assert.deepEqual(fillPlaceholders('/c/{contract_no|digits}', { contract_no: 'ABC' }), { text: '/c/', missing: ['contract_no'] });
  });

  it('the customer lookup must say where the address is, so its answer can be checked', () => {
    useConfig(example());
    const c = example();
    delete c.lookups.customer_by_email.map.email;
    delete c.lookups.customer_by_email.map.emails;
    useConfig(c);
    assert.match(cfgMod.loadConfig().problems.join(' '), /customer_by_email\.map must say where to read at least one of: email, emails/);
    const d = example(); d.lookups.customer_by_email.scoped = true;
    useConfig(d);
    assert.match(cfgMod.loadConfig().problems.join(' '), /"scoped" is not used here/);
  });
});

/* ================================================================================================ 4. the HTTP client */
describe('the client under stress', () => {
  let srv;
  afterEach(async () => { if (srv) { await srv.close(); srv = null; } });

  it('an answer that stalls half way counts as the system being down, and pauses it', async () => {
    srv = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"data":'); /* never finished */ });
    useConfig(oneSource(srv.url, { timeout_ms: 500 }));
    const keep = client.tuning.breakerThreshold;
    client.tuning.breakerThreshold = 2;
    try {
      const a = await client.runLookup('contract', { contract_no: 'S1' });
      assert.equal(a.error.code, 'timeout', JSON.stringify(a.error));
      await client.runLookup('contract', { contract_no: 'S2' });
      const paused = await client.runLookup('contract', { contract_no: 'S3' });
      assert.equal(paused.error.code, 'breaker');
      assert.ok(client.sourceHealth('s').paused_until);
    } finally { client.tuning.breakerThreshold = keep; }
  });

  it('a refusal for one record (403) does not pause the whole system, but a refused key (401) does count', async () => {
    srv = await serve((req, res) => (req.url.includes('ok') ? send(res, 200, { data: { no: 'OK' } }) : send(res, req.url.includes('unauth') ? 401 : 403, { error: 'no' })));
    useConfig(oneSource(srv.url));
    const keep = client.tuning.breakerThreshold;
    client.tuning.breakerThreshold = 3;
    try {
      for (let i = 0; i < 6; i++) assert.equal((await client.runLookup('contract', { contract_no: `F${i}` })).error.code, 'auth');
      assert.equal(client.sourceHealth('s').paused_until, null, 'six 403s in a row do not pause it');
      assert.equal((await client.runLookup('contract', { contract_no: 'ok1' })).ok, true);
      for (let i = 0; i < 3; i++) await client.runLookup('contract', { contract_no: `unauth${i}` });
      assert.ok(client.sourceHealth('s').paused_until, 'three 401s do');
    } finally { client.tuning.breakerThreshold = keep; }
  });

  it('a key pasted with a curly quote is reported as such, not as a network failure that is retried', async () => {
    srv = await serve((req, res) => send(res, 200, { data: { no: 'A' } }));
    process.env.TEST_KEY = 'abc\u2019def';
    useConfig(oneSource(srv.url, { auth: { type: 'api_key', key_env: 'TEST_KEY' } }));
    const r = await client.runLookup('contract', { contract_no: 'A1' });
    assert.equal(r.error.code, 'config');
    assert.match(r.error.message, /contains a character that cannot be sent/);
    assert.ok(!r.error.message.includes('abc'));
    assert.equal(srv.hits.length, 0);
  });

  it('an enormous sign-in answer is refused without being read to the end', async () => {
    srv = await serve((req, res) => {
      if (req.url === '/token') { res.writeHead(200, { 'content-type': 'application/json' }); const chunk = Buffer.alloc(1024 * 1024, 120); let n = 0; const push = () => { while (n < 60) { n++; if (!res.write(chunk)) { res.once('drain', push); return; } } res.end(); }; push(); return; }
      return send(res, 200, { data: { no: 'A' } });
    });
    process.env.OA_ID = 'id'; process.env.OA_SECRET = 'secret';
    useConfig(oneSource(srv.url, { auth: { type: 'oauth2_client_credentials', token_url: `${srv.url}/token`, client_id_env: 'OA_ID', client_secret_env: 'OA_SECRET' } }));
    const t0 = Date.now();
    const r = await client.runLookup('contract', { contract_no: 'A1' });
    assert.equal(r.error.code, 'auth');
    assert.match(r.error.message, /sign-in was refused/);
    assert.ok(Date.now() - t0 < 5000);
  });

  it('the answer cache stays inside its memory budget', async () => {
    srv = await serve((req, res) => send(res, 200, { data: [{ no: 'A', pad: 'x'.repeat(50_000) }] }));
    useConfig(oneSource(srv.url));
    const keep = { ...client.tuning };
    client.tuning.cacheBudget = 2 * 1024 * 1024;
    try {
      for (let i = 0; i < 40; i++) await client.runLookup('contract', { contract_no: `AST-${100000 + i}` });
      const st = client.cacheStats();
      assert.ok(st.bytes <= 2 * 1024 * 1024, `cache holds ${st.bytes} bytes`);
      assert.ok(st.entries < 40, 'older answers were dropped');
      // an answer too big to be worth remembering is not kept at all
      srv.hits.length = 0;
    } finally { Object.assign(client.tuning, keep); }
  });
});

/* ================================================================================================ 5. is the answer about what was asked */
describe('an answer is only used when it proves it is about the sender or the contract asked for', () => {
  let api;
  const data = () => ({
    customers: [
      { id: 'C-1', fullName: 'Sara Khan', email: 'sara@example.test', altEmails: [], mobile: '+971500000001', loyalty: 'GOLD', accountType: 'INDIVIDUAL' },
      { id: 'C-2', fullName: 'Omar Ali', email: 'omar@example.test', altEmails: [], mobile: '+971500000002', loyalty: 'STANDARD', accountType: 'INDIVIDUAL' },
    ],
    contracts: [
      { contractNumber: 'AST-100001', state: 'RETURNED', product: 'Daily', grandTotal: 1250, paymentState: 'PAID', customerId: 'C-1', customerEmail: 'sara@example.test', startDate: iso(-20), endDate: iso(-10), pickupBranch: { name: 'Dubai Airport T3', emirate: 'Dubai' }, vehicle: { make: 'Nissan', model: 'Sunny', plate: 'A 12345' } },
      { contractNumber: 'AST-100002', state: 'ON_RENT', product: 'Monthly', grandTotal: 3000, paymentState: 'UNPAID', customerId: 'C-1', customerEmail: 'sara@example.test', startDate: iso(-3), endDate: iso(27), pickupBranch: null, vehicle: null },
      { contractNumber: 'AST-100003', state: 'RETURNED', product: 'Daily', grandTotal: 500, paymentState: 'PAID', customerId: 'C-2', customerEmail: 'omar@example.test', startDate: iso(-9), endDate: iso(-5), pickupBranch: null, vehicle: null },
    ],
    invoices: [{ invoiceNo: 'INV-1', contractNumber: 'AST-100001', customerId: 'C-1', gross: 1250, vat: 59.52, state: 'PAID', issuedOn: dmy(-10), dueOn: dmy(4), outstanding: '0.00' }],
    fines: [], deposits: { 'AST-100001': { deposit: { amount: 1000, state: 'HELD', refundDue: null }, cardHold: null } },
  });
  before(async () => {
    api = createMockApi({ data: data(), apiKey: 'orion-test-key' });
    const url = await api.listen(0);
    process.env.ORION_BASE_URL = url; process.env.CNR_BASE_URL = url;
  });
  after(async () => { await api.close(); });
  const calm = () => { api.reset(); client.resetClient(); };
  const ask = (o) => resolveDetailed({ bypassCache: true, ...o }).then((r) => r.snapshot);
  const listRow = (c) => ({ contractNumber: c.contractNumber, state: c.state, customerId: c.customerId, pickup: { at: c.startDate }, return: { at: c.endDate }, grandTotal: c.grandTotal });

  it('a list that ignores its filter cannot hand somebody else\'s contract to a sender who named none', async () => {
    // the sender's rentals are asked for with a query parameter the system ignores: it answers with Sara's contracts for everybody
    variant((c) => { const l = c.lookups.contracts_by_customer; l.path = '/contracts'; l.query = { customerId: '{customer_id}' }; });
    calm();
    api.intercept({ match: (r) => r.path === '/v1/contracts', reply: (_r, res, json) => json(res, 200, { data: data().contracts.filter((c) => c.customerId === 'C-1').map(listRow) }) });
    const s = await ask({ email: 'omar@example.test' });
    assert.equal(s.customer.name, 'Omar Ali');
    assert.equal(s.contract, null, 'nothing is guessed from rows that belong to Sara');
    assert.equal(s.inferred, false);
    assert.deepEqual(s.other_contracts, []);
    assert.match(s.warnings.join(' '), /could not be shown to belong to this customer/);
    // with rows that carry the right owner the same question works
    calm();
    api.intercept({ match: (r) => r.path === '/v1/contracts', reply: (_r, res, json) => json(res, 200, { data: data().contracts.map(listRow) }) });
    const ok = await ask({ email: 'omar@example.test' });
    assert.equal(ok.contract.contract_no, 'AST-100003', 'only Omar\'s own row was used');
    assert.equal(ok.identity, 'email');
  });

  it('a list without an owner on its rows is only trusted when the configuration says it is scoped, or the customer is in the address', async () => {
    variant((c) => { const l = c.lookups.contracts_by_customer; l.path = '/contracts'; l.query = { customerId: '{customer_id}' }; delete l.map.customer_id; });
    calm();
    api.intercept({ match: (r) => r.path === '/v1/contracts', reply: (_r, res, json) => json(res, 200, { data: [listRow(data().contracts[2])] }) });
    assert.equal((await ask({ email: 'omar@example.test' })).contract, null, 'no proof, not used');
    variant((c) => { const l = c.lookups.contracts_by_customer; l.path = '/contracts'; l.query = { customerId: '{customer_id}' }; l.scoped = true; delete l.map.customer_id; });
    calm();
    api.intercept({ match: (r) => r.path === '/v1/contracts', reply: (_r, res, json) => json(res, 200, { data: [listRow(data().contracts[2])] }) });
    assert.equal((await ask({ email: 'omar@example.test' })).contract.contract_no, 'AST-100003', '"scoped": true is the owner of the system vouching for it');
    useConfig(EXAMPLE);
    calm();
    assert.equal((await ask({ email: 'omar@example.test' })).contract.contract_no, 'AST-100003', 'the customer in the path (/customers/{id}/contracts) needs no proof on the rows');
  });

  it('a full contract read that is not the contract chosen is not used', async () => {
    useConfig(EXAMPLE);
    calm();
    api.intercept({ match: (r) => r.path === '/v1/contracts/AST-100002', reply: (_r, res, json) => json(res, 200, { data: { contractNumber: 'AST-100001', state: 'RETURNED', customerId: 'C-1', pickup: { at: iso(-20) }, return: { at: iso(-10) } } }) });
    const s = await ask({ email: 'sara@example.test' });
    assert.equal(s.contract.contract_no, 'AST-100002', 'the list row stays');
    assert.match(s.warnings.join(' '), /did not match it/);
    // and a full read that names another customer is not used either
    calm();
    api.intercept({ match: (r) => r.path === '/v1/contracts/AST-100002', reply: (_r, res, json) => json(res, 200, { data: { contractNumber: 'AST-100002', state: 'ON_RENT', customerId: 'C-2', customerEmail: 'omar@example.test', pickup: { at: iso(-3) }, return: { at: iso(27) } } }) });
    const t = await ask({ email: 'sara@example.test' });
    assert.equal(t.contract.contract_no, 'AST-100002');
    assert.equal(t.contract.customer.id, 'C-1', 'the other customer\'s record was not taken over');
    assert.match(t.warnings.join(' '), /did not match it/);
  });

  it('invoices and fines that do not say which contract they belong to are dropped when the question was only filtered by a query', async () => {
    useConfig(EXAMPLE);
    calm();
    api.intercept({ match: (r) => r.path === '/v1/invoices', reply: (_r, res, json) => json(res, 200, { data: [
      { invoiceNo: 'ANYONE-1', amount: { gross: 999 }, state: 'SENT', issuedOn: dmy(-1), dueOn: dmy(9), outstanding: '999' },
      { invoiceNo: 'OTHER-1', contractNumber: 'AST-100003', amount: { gross: 500 }, state: 'SENT', issuedOn: dmy(-1), dueOn: dmy(9), outstanding: '500' },
      { invoiceNo: 'MINE-1', contractNumber: 'AST-100001', amount: { gross: 400 }, state: 'SENT', issuedOn: dmy(-1), dueOn: dmy(9), outstanding: '400' },
    ] }) });
    const s = await ask({ email: 'sara@example.test', contractNo: 'AST-100001' });
    assert.deepEqual(s.contract.invoices.map((i) => i.number), ['MINE-1']);
    assert.match(s.warnings.join(' '), /2 records from "invoices" could not be shown to belong to this contract/, 'the one with no contract and the one of another contract');
    assert.equal(s.contract.invoice_summary.outstanding, 400, 'what is owed counts only records that were shown to be this customer\'s');
  });

  it('the contract\'s own invoice is found even when it is far down a long list, and the lists are filtered before they are cut', async () => {
    useConfig(EXAMPLE);
    calm();
    const many = Array.from({ length: 40 }, (_x, i) => ({ invoiceNo: `OLD-${i}`, contractNumber: i === 39 ? 'AST-100001' : 'AST-100003', amount: { gross: 10 }, state: 'PAID', issuedOn: dmy(-100 + i), dueOn: dmy(-90 + i), outstanding: '0' }));
    api.intercept({ match: (r) => r.path === '/v1/invoices', reply: (_r, res, json) => json(res, 200, { data: many }) });
    const s = await ask({ email: 'sara@example.test', contractNo: 'AST-100001' });
    assert.deepEqual(s.contract.invoices.map((i) => i.number), ['OLD-39']);
  });

  it('a running rental far down the sender\'s list is still found', async () => {
    useConfig(EXAMPLE);
    calm();
    const rows = Array.from({ length: 12 }, (_x, i) => ({ contractNumber: `AST-2000${pad(i)}`, state: i === 11 ? 'ON_RENT' : 'RETURNED', customerId: 'C-2', pickup: { at: iso(-400 + i) }, return: { at: i === 11 ? iso(20) : iso(-300 + i) } }));
    api.intercept({ match: (r) => r.path === '/v1/customers/C-2/contracts', reply: (_r, res, json) => json(res, 200, { data: rows }) });
    api.intercept({ match: (r) => r.path === '/v1/contracts/AST-200011', reply: (_r, res, json) => json(res, 200, { data: { contractNumber: 'AST-200011', state: 'ON_RENT', customerId: 'C-2', pickup: { at: iso(-390) }, return: { at: iso(20) } } }) });
    const s = await ask({ email: 'omar@example.test' });
    assert.equal(s.contract.contract_no, 'AST-200011');
    assert.equal(s.other_contracts.length, 9, 'the shortlist is cut to ten, and the contract itself is not in it');
  });

  it('two customers sharing the sender\'s address: the one the contract names is chosen', async () => {
    useConfig(EXAMPLE);
    calm();
    api.intercept({ match: (r) => r.path === '/v1/customers' && !!r.query.email, reply: (_r, res, json) => json(res, 200, { data: [
      { id: 'C-9', fullName: 'Shared Mailbox', emailAddress: 'family@example.test', otherEmails: [], mobile: '', loyalty: 'STANDARD', accountType: 'INDIVIDUAL' },
      { id: 'C-1', fullName: 'Sara Khan', emailAddress: 'family@example.test', otherEmails: [], mobile: '', loyalty: 'GOLD', accountType: 'INDIVIDUAL' },
    ] }) });
    const s = await ask({ email: 'family@example.test', contractNo: 'AST-100001' });
    assert.equal(s.customer.id, 'C-1');
    assert.equal(s.identity, 'email', 'the contract is Sara\'s and so is one of the customers at this address');
    assert.match(s.notes.join(' '), /2 customers share the address/);
  });

  it('a guessed contract that itself names another customer is not treated as the sender\'s', async () => {
    useConfig(EXAMPLE);
    calm();
    // the list is path-scoped, so its rows are trusted; but the row's own owner says otherwise
    api.intercept({ match: (r) => r.path === '/v1/customers/C-2/contracts', reply: (_r, res, json) => json(res, 200, { data: [{ contractNumber: 'AST-100001', state: 'ON_RENT', customerId: 'C-1', pickup: { at: iso(-3) }, return: { at: iso(20) } }] }) });
    const s = await ask({ email: 'omar@example.test' });
    assert.equal(s.inferred, true);
    assert.equal(s.identity, 'contract_only');
  });
});

/* ================================================================================================ 6. the account on a case */
describe('stored details, drafts and recipients', () => {
  let api;
  let user;
  let counter = 0;
  const email = (o) => ({
    providerId: `rv-${++counter}`, conversationId: `rv-conv-${counter}`, direction: 'in', from: { name: 'Sara Khan', email: 'sara@example.test' }, to: ['helpdesk@autostrad.com'],
    subject: 'Security deposit refund', body: 'Hello, when will I get my security deposit back for contract AST-100001? Thank you', receivedAt: nowUtc(), ...o,
  });
  const data = () => ({
    customers: [
      { id: 'C-1', fullName: 'Sara Khan', email: 'sara@example.test', altEmails: [], mobile: '+971500000001', loyalty: 'GOLD', accountType: 'INDIVIDUAL' },
      { id: 'C-2', fullName: 'Omar Ali', email: 'omar@example.test', altEmails: [], mobile: '+971500000002', loyalty: 'STANDARD', accountType: 'INDIVIDUAL' },
    ],
    contracts: [
      { contractNumber: 'AST-100001', state: 'RETURNED', product: 'Daily', grandTotal: 1250, paymentState: 'PAID', customerId: 'C-1', customerEmail: 'sara@example.test', startDate: iso(-20), endDate: iso(-10), pickupBranch: { name: 'Dubai Airport T3', emirate: 'Dubai' }, vehicle: { make: 'Nissan', model: 'Sunny', plate: 'A 12345' } },
      { contractNumber: 'AST-100002', state: 'ON_RENT', product: 'Monthly', grandTotal: 3000, paymentState: 'UNPAID', customerId: 'C-1', customerEmail: 'sara@example.test', startDate: iso(-3), endDate: iso(27), pickupBranch: null, vehicle: null },
      { contractNumber: 'AST-100003', state: 'RETURNED', product: 'Daily', grandTotal: 500, paymentState: 'PAID', customerId: 'C-2', customerEmail: 'omar@example.test', startDate: iso(-9), endDate: iso(-5), pickupBranch: null, vehicle: null },
    ],
    invoices: [{ invoiceNo: 'INV-1', contractNumber: 'AST-100001', customerId: 'C-1', gross: 1250, vat: 59.52, state: 'PAID', issuedOn: dmy(-10), dueOn: dmy(4), outstanding: '0.00' }],
    fines: [], deposits: { 'AST-100001': { deposit: { amount: 1000, state: 'HELD', refundDue: null }, cardHold: null } },
  });
  before(async () => {
    api = createMockApi({ data: data(), apiKey: 'orion-test-key' });
    const url = await api.listen(0);
    process.env.ORION_BASE_URL = url; process.env.CNR_BASE_URL = url;
    useConfig(EXAMPLE);
    const id = db.prepare("INSERT INTO users (name, email, password_hash, role, status) VALUES ('Reviewer', 'rv@test.test', 'x', 'admin', 'active')").run().lastInsertRowid;
    user = { id: Number(id), name: 'Reviewer', role: 'admin' };
  });
  after(async () => { await api.close(); });
  const calm = () => { api.reset(); client.resetClient(); db.prepare("UPDATE hd_cases SET status = 'closed', closed_at = datetime('now') WHERE status <> 'closed'").run(); useConfig(EXAMPLE); };
  const pending = (id) => getCaseDetail(id, user).drafts.find((d) => d.status === 'pending');

  it('somebody else joining the thread cannot become the person the reply is created against, and the reply stays addressed to the customer', async () => {
    calm();
    const r = await ingestMessage(email({ providerId: 'rv-sara' }));
    assert.equal(r.action, 'created');
    const draft = pending(r.caseId);
    assert.match(draft.body, /AED 1,000\.00/);
    // Mallory writes about the same contract and request type: his message joins the case as the latest one
    const m = await ingestMessage(email({ providerId: 'rv-mallory', from: { name: 'Mallory', email: 'mallory@evil.test' }, subject: 'Deposit', body: 'Where is my security deposit refund for AST-100001?' }));
    assert.equal(m.action, 'attached');
    const last = db.prepare("SELECT from_email FROM hd_messages WHERE case_id = ? AND direction = 'in' ORDER BY received_at DESC, id DESC LIMIT 1").get(r.caseId);
    assert.equal(last.from_email, 'mallory@evil.test');
    assert.ok(getCaseDetail(r.caseId, user).audit.some((a) => /another address \(mallory@evil\.test\) joined this case/.test(a.detail)), 'the history says so');

    let seen = null;
    const provider = {
      async createDraft(x) { seen = { fn: 'createDraft', replyTo: x.replyTo, to: x.draft.to_email }; return { providerId: 'drv-1' }; },
      async sendReply(x) { seen = { fn: 'sendReply', replyTo: x.replyTo, to: x.draft.to_email }; return { providerId: 'sent-1', sentAt: nowUtc() }; },
    };
    await approveDraft(draft.id, user, provider);
    assert.equal(seen.to, 'sara@example.test');
    assert.equal(seen.replyTo.from_email, 'sara@example.test', 'the reply is created against Sara\'s message, not the latest one');
  });

  it('the graph connector addresses the reply to the draft\'s recipient whatever the message it answers says', async () => {
    const calls = [];
    const world = await serve(async (req, res) => {
      let text = ''; for await (const c of req) text += c;
      calls.push({ method: req.method, url: req.url, json: text ? JSON.parse(text) : null });
      if (req.method === 'POST' && req.url.endsWith('/createReply')) return send(res, 201, { id: 'reply-1', webLink: 'https://outlook.test/r1' });
      if (req.method === 'GET') return send(res, 200, { body: { content: '<p>quoted</p>' } });
      return send(res, 200, {});
    });
    const login = await serve((req, res) => send(res, 200, { access_token: 't', expires_in: 3600 }));
    try {
      Object.assign(process.env, { GRAPH_BASE: `${world.url}/v1.0`, GRAPH_LOGIN_BASE: login.url, GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's' });
      const { graphProvider } = await import('../src/helpdesk/mail/graph.js');
      await graphProvider.createDraft({ draft: { to_email: 'sara@example.test', body: 'Dear Sara', language: 'en', subject: 'Re: x' }, replyTo: { provider_id: 'AAMk-mallory-message' } });
      const patch = calls.find((c) => c.method === 'PATCH');
      assert.deepEqual(patch.json.toRecipients, [{ emailAddress: { address: 'sara@example.test' } }]);
      assert.deepEqual(patch.json.ccRecipients, []);
    } finally { for (const k of ['GRAPH_BASE', 'GRAPH_LOGIN_BASE', 'GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET']) delete process.env[k]; await world.close(); await login.close(); }
  });

  it('a reply written for one address cannot be approved after staff changed the customer\'s address on the case', async () => {
    calm();
    const r = await ingestMessage(email({ providerId: 'rv-addr' }));
    const draft = pending(r.caseId);
    updateCase(r.caseId, { customer_email: 'sara.other@example.test' }, user);
    await assert.rejects(() => approveDraft(draft.id, user, { createDraft: async () => ({}), sendReply: async () => ({}) }), /address on the case changed/);
  });

  it('a lookup that fails halfway never replaces good details about the same contract, and keeps staff\'s confirmation', async () => {
    calm();
    const r = await ingestMessage(email({ providerId: 'rv-partial', from: { name: 'Omar Ali', email: 'omar@example.test' } }));
    assert.equal(getCaseDetail(r.caseId, user).account.identity, 'contract_only');
    await actions.verifySender(r.caseId, user);
    assert.equal(getCaseDetail(r.caseId, user).contract.invoices.length, 1);
    api.intercept({ match: (x) => x.path === '/v1/invoices', reply: (_x, res, json) => json(res, 500, { error: { code: 'BOOM' } }) });
    client.resetClient();
    const view = await account.refreshAccount(r.caseId, { user });
    assert.equal(view.stale, true);
    assert.equal(view.identity, 'staff', 'the confirmation was not lost');
    assert.equal(view.snapshot.contract.invoices.length, 1, 'the invoices are still there');
    // and it works again once the system does
    api.reset(); client.resetClient();
    const again = await account.refreshAccount(r.caseId, { user });
    assert.equal(again.stale, false);
    assert.equal(again.identity, 'staff');
  });

  it('old details about another contract do not stay when staff change the contract while the system is down', async () => {
    calm();
    const r = await ingestMessage(email({ providerId: 'rv-switch' }));
    assert.match(pending(r.caseId).body, /AED 1,000\.00/);
    updateCase(r.caseId, { contract_no: 'AST-100002' }, user);
    api.state.down = true;
    client.resetClient();
    const { view } = await actions.refreshCase(r.caseId, { user });
    assert.equal(view.status, 'unavailable', 'it says it does not know, rather than keeping the old contract');
    const c = getCaseDetail(r.caseId, user);
    assert.equal(c.contract, null);
    assert.ok(!/AED 1,000\.00/.test(pending(r.caseId).body), 'the redrafted reply does not quote the deposit of the other contract');
  });

  it('a contract number the customer types is never turned back into a guess, even if it could not be looked up at once', async () => {
    calm();
    const first = await ingestMessage(email({ providerId: 'rv-guess', conversationId: 'rv-guess-thread', subject: 'Deposit refund', body: 'Where is my deposit refund?' }));
    assert.equal(getCaseRow(first.caseId).contract_inferred, 1);
    assert.equal(getCaseRow(first.caseId).contract_no, 'AST-100002');
    api.state.down = true;
    client.resetClient();
    const second = await ingestMessage(email({ providerId: 'rv-guess-2', conversationId: 'rv-guess-thread', subject: 'Re: Deposit refund', body: 'Sorry, the contract is AST-100001.' }));
    assert.equal(second.action, 'attached');
    assert.equal(getCaseRow(first.caseId).contract_no, 'AST-100001');
    assert.equal(getCaseRow(first.caseId).contract_inferred, 0, 'typed by the customer');
    api.state.down = false;
    client.resetClient();
    await account.refreshAccount(first.caseId, { user });
    assert.equal(getCaseRow(first.caseId).contract_no, 'AST-100001', 'the next Refresh keeps what the customer wrote');
    assert.equal(getCaseDetail(first.caseId, user).contract.contract_no, 'AST-100001');
  });

  it('demo records never replace details that came from the customer systems just because somebody opened the case', async () => {
    calm();
    const r = await ingestMessage(email({ providerId: 'rv-crm' }));
    assert.equal(getCaseDetail(r.caseId, user).account.source, 'api');
    process.env.HELPDESK_ACCOUNT_SOURCE = 'crm';
    try {
      const c = getCaseDetail(r.caseId, user);
      assert.equal(c.account.source, 'api', 'still the details from the systems');
      assert.equal(c.contract.contract_no, 'AST-100001');
    } finally { process.env.HELPDESK_ACCOUNT_SOURCE = 'api'; }
  });

  it('a stranger quoting a customer\'s contract does not borrow the customer\'s name, tier or priority', async () => {
    calm();
    const r = await ingestMessage(email({ providerId: 'rv-stranger', from: { name: '', email: 'stranger@nowhere.test' }, subject: 'URGENT: charge I do not recognise', body: 'This is urgent: there is a charge on my card that I do not recognise. Contract AST-100001.' }));
    const c = getCaseDetail(r.caseId, user);
    assert.equal(c.account.identity, 'contract_only');
    assert.equal(c.customer_name, null, 'not Sara Khan');
    assert.ok(!c.priority_reasons.some((x) => /Gold customer/.test(x)), JSON.stringify(c.priority_reasons));
    assert.equal(c.priority, 'Average');
    assert.match(pending(r.caseId).body, /^Dear Customer,/);
  });

  it('a late arrival of the customer\'s details does not raise the priority for a sender who is not that customer', async () => {
    calm();
    api.state.down = true;
    const r = await ingestMessage(email({ providerId: 'rv-late', from: { name: 'Mallory', email: 'mallory@evil.test' }, subject: 'URGENT: charge I do not recognise', body: 'This is urgent: there is a charge on my card that I do not recognise. Contract AST-100001.' }));
    assert.equal(getCaseDetail(r.caseId, user).priority, 'Average');
    api.state.down = false;
    client.resetClient();
    db.prepare("UPDATE hd_case_accounts SET next_try_at = datetime('now', '-1 minute') WHERE case_id = ?").run(r.caseId);
    await actions.retryPendingAccounts();
    const c = getCaseDetail(r.caseId, user);
    assert.equal(c.account.identity, 'contract_only');
    assert.equal(c.priority, 'Average', 'Sara\'s Gold tier is Sara\'s');
  });

  it('a sender who is not the customer gets no vehicle and no branch in the reply either', async () => {
    calm();
    const r = await ingestMessage(email({ providerId: 'rv-vehicle', from: { name: 'Omar Ali', email: 'omar@example.test' }, subject: 'Please collect my car', body: 'My car broke down, please come and collect it. Contract AST-100001.' }));
    const c = getCaseDetail(r.caseId, user);
    assert.equal(c.sub_key, 'vehicle_collection');
    assert.equal(c.account.identity, 'contract_only');
    const draft = pending(r.caseId);
    assert.ok(!/Nissan|Sunny|A 12345|Dubai Airport/.test(draft.body), draft.body);
    assert.match(draft.notes, /vehicle and branch details were left out/);
  });

  it('when staff\'s confirmation no longer holds (another contract), a draft nobody edited is written again without the figures', async () => {
    calm();
    const r = await ingestMessage(email({ providerId: 'rv-redraft', from: { name: 'Omar Ali', email: 'omar@example.test' } }));
    await actions.verifySender(r.caseId, user);
    assert.match(pending(r.caseId).body, /AED 1,000\.00/, 'confirmed: the figures are quoted');
    updateCase(r.caseId, { contract_no: 'AST-100002' }, user);
    const { changed } = await actions.refreshCase(r.caseId, { user });
    assert.equal(changed, true);
    assert.equal(getCaseDetail(r.caseId, user).account.identity, 'contract_only');
    assert.ok(!/AED 1,000\.00/.test(pending(r.caseId).body));
  });
});
