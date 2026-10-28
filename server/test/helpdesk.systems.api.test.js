// The customer-systems connector through the real server: boot it on a throw-away database with the connector switched on, point it at
// the stand-in API (scripts/mock-customer-api.mjs, filled from the same seeded CRM records), and walk emails through the HTTP API:
// the account on the case, the sender check, refresh, a system that is down, the setup page's status and test box, and who may do what.
// Run: node --test test/helpdesk.systems.api.test.js
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autostrad-hd-systems-api-'));
const PORT = 4900 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${PORT}/api`;
const KEY = 'api-test-key';
const env = { ...process.env, ARC_DB_PATH: path.join(dir, 'test.db'), API_PORT: String(PORT), HELPDESK_SCHEDULER: 'off' };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|GRAPH_|HELPDESK_(?!SCHEDULER)|ORION_|CNR_|CUSTOMER_)/.test(k)) delete env[k];

let server;
let mock;
let fixtures;
const tokens = {};

async function api(method, route, { as = 'admin', body } = {}) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

before(async () => {
  const seeded = spawnSync(process.execPath, ['src/seed.js'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seeded.status, 0, `seed failed: ${seeded.stderr || seeded.stdout}`);

  // the stand-in API serves the very records the seed put in the CRM, in its own vocabulary
  process.env.ARC_DB_PATH = env.ARC_DB_PATH;
  const { createMockApi, crmFixtures } = await import('../scripts/mock-customer-api.mjs');
  fixtures = await crmFixtures();
  mock = createMockApi({ data: fixtures, apiKey: KEY });
  const url = await mock.listen(0);

  Object.assign(env, {
    HELPDESK_ACCOUNT_SOURCE: 'api', CUSTOMER_SYSTEMS_CONFIG: path.join(root, 'config', 'customer-systems.example.json'),
    ORION_BASE_URL: url, CNR_BASE_URL: url, ORION_API_KEY: KEY, CNR_API_KEY: KEY,
  });
  server = spawn(process.execPath, ['src/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  const users = { it: 'it@autostrad.ae', admin: 'admin@autostrad.ae', finance: 'mariam@autostrad.ae', cs: 'noor@autostrad.ae', operations: 'khalid@autostrad.ae' };
  for (const [role, email] of Object.entries(users)) {
    const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'autostrad123' }) });
    tokens[role] = (await r.json()).token;
    assert.ok(tokens[role], `could not sign in as ${role}`);
  }
});

after(async () => {
  // Windows cannot delete the database while anything still has it open: wait for the server to exit, and close
  // this process's own connection (opened by crmFixtures).
  if (server && server.exitCode === null && server.signalCode === null) await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  if (mock) await mock.close();
  if (fixtures) (await import('../src/db.js')).db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Individuals with a finished or running rental, so the demo mailbox can write as them: { id, email, name, ref, otherRef }. */
function people() {
  const active = (c) => fixtures.contracts.filter((k) => k.customerId === c.id && ['RETURNED', 'ON_RENT'].includes(k.state)).sort((a, b) => String(b.endDate).localeCompare(String(a.endDate)));
  const ok = fixtures.customers.filter((c) => c.accountType === 'INDIVIDUAL' && c.email && active(c).length);
  return ok.map((c) => ({ id: Number(c.id.slice(2)), email: c.email, name: c.fullName, ref: active(c)[0].contractNumber, all: active(c).map((k) => k.contractNumber) }));
}

test('the setup page can see the connection, and only IT and admin may', async () => {
  const st = (await api('GET', '/helpdesk/systems', { as: 'it' })).json;
  assert.equal(st.mode, 'api');
  assert.equal(st.config.ok, true, JSON.stringify(st.config.problems));
  assert.deepEqual(st.sources.map((s) => [s.name, s.missing.length]), [['orion', 0], ['cnr', 0]]);
  assert.equal(st.lookups.filter((l) => l.configured).length, 7);
  assert.ok(!JSON.stringify(st).includes(KEY), 'no key is ever shown');
  assert.equal((await api('GET', '/helpdesk/systems', { as: 'admin' })).status, 200);
  assert.equal((await api('GET', '/helpdesk/systems', { as: 'cs' })).status, 403);
  assert.equal((await api('GET', '/helpdesk/systems', { as: 'finance' })).status, 403);
  assert.equal((await api('GET', '/helpdesk/systems', { as: null })).status, 401);
  const ready = (await api('GET', '/helpdesk/readiness', { as: 'admin' })).json.items.find((i) => i.key === 'customer_data');
  assert.equal(ready.state, 'done');
  assert.match(ready.detail, /Orion Fleet, CNR Portal/);
});

test('the test box runs a real lookup; only IT may see the untouched answers', async () => {
  const p = people()[0];
  const asAdmin = (await api('POST', '/helpdesk/systems/test', { as: 'admin', body: { email: p.email, contract_no: p.ref, raw: true } })).json;
  assert.equal(asAdmin.mode, 'api');
  assert.equal(asAdmin.snapshot.contract.contract_no, p.ref);
  assert.equal(asAdmin.snapshot.identity, 'email');
  assert.ok(asAdmin.steps.length >= 5 && asAdmin.steps.every((s) => s.raw === undefined), 'admin gets the steps but not the raw records');
  const asIt = (await api('POST', '/helpdesk/systems/test', { as: 'it', body: { email: p.email, contract_no: p.ref, raw: true } })).json;
  assert.ok(asIt.steps.some((s) => s.raw !== undefined), 'IT sees what each system answered');
  assert.equal((await api('POST', '/helpdesk/systems/test', { as: 'admin', body: {} })).status, 400);
  assert.equal((await api('POST', '/helpdesk/systems/test', { as: 'admin', body: { email: 'not an email' } })).status, 400);
  assert.equal((await api('POST', '/helpdesk/systems/test', { as: 'cs', body: { email: p.email } })).status, 403);
});

test('a customer\'s email arrives with the contract, customer and invoices from the systems', async () => {
  const p = people()[0];
  const sent = (await api('POST', '/helpdesk/samples/send', { as: 'cs', body: { customer_id: p.id, subject: 'Security deposit refund', body: 'Hello, when will I get my security deposit back for contract AST-100001? Thank you' } })).json;
  assert.equal(sent.action, 'created', JSON.stringify(sent));
  const c = (await api('GET', `/helpdesk/cases/${sent.case_id}`, { as: 'cs' })).json;
  assert.equal(c.contract_no, p.ref);
  assert.equal(c.customer_id, null, 'no CRM ids on a case that came from the customer systems');
  assert.equal(c.account.source, 'api');
  assert.equal(c.account.status, 'ok');
  assert.equal(c.account.identity, 'email');
  assert.deepEqual(c.account.systems.sort(), ['CNR Portal', 'Orion Fleet']);
  assert.equal(c.contract.contract_no, p.ref);
  assert.equal(c.customer_name, p.name);
  assert.ok(c.audit.some((a) => a.action === 'customer_matched' && /Orion Fleet/.test(a.detail)));
  assert.ok(mock.requests.some((r) => r.path === `/v1/contracts/${p.ref}`), 'the contract was read from the system');
});

test('a contract number typed by somebody else is flagged, the reply leaves the figures out, and staff can confirm', async () => {
  const [a, b] = people().filter((x) => x.email !== people()[0].email);
  assert.ok(a && b, 'the seed has at least two customers with rentals');
  // a writes about b's contract: first without a number, then the number arrives in a reply on the same thread
  const sent = (await api('POST', '/helpdesk/samples/send', { as: 'cs', body: { customer_id: a.id, subject: 'Pre-authorization still showing', body: 'The hold on my card is still showing, please release it.' } })).json;
  assert.equal(sent.action, 'created', JSON.stringify(sent));
  await api('POST', '/helpdesk/mailbox/demo/reply', { as: 'cs', body: { case_id: sent.case_id, text: `Sorry, the contract is ${b.ref}.` } });
  let c = (await api('GET', `/helpdesk/cases/${sent.case_id}`, { as: 'cs' })).json;
  assert.equal(c.contract_no, b.ref);
  assert.equal(c.account.identity, 'contract_only');
  assert.ok(c.insights.some((i) => i.tone === 'danger' && /sender is not the customer/.test(i.title)));

  const made = (await api('POST', `/helpdesk/cases/${sent.case_id}/drafts`, { as: 'cs', body: {} })).json;
  const draft = made.drafts.find((d) => d.status === 'pending');
  assert.ok(draft);
  assert.match(draft.notes, /not the customer on contract/);
  assert.ok(!/ending \d{4}/.test(draft.body), 'no card digits from the record in the reply');

  const confirmed = await api('POST', `/helpdesk/cases/${sent.case_id}/account/verify`, { as: 'cs' });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.json.account.identity, 'staff');
  assert.ok(confirmed.json.audit.some((x) => x.action === 'sender_verified'));
  assert.equal((await api('POST', `/helpdesk/cases/${sent.case_id}/account/verify`, { as: null })).status, 401);
  assert.equal((await api('POST', '/helpdesk/cases/999999/account/verify', { as: 'cs' })).status, 404);
});

test('changing the contract number on a case asks the systems about the new one', async () => {
  const p = people().find((x) => x.all.length > 1) || people()[1];
  const sent = (await api('POST', '/helpdesk/samples/send', { as: 'cs', body: { customer_id: p.id, subject: 'Invoice request', body: 'Please send me the invoice for my rental.' } })).json;
  assert.equal(sent.action, 'created', JSON.stringify(sent));
  const other = (people().find((x) => x.email !== p.email) || {}).ref;
  const patched = await api('PATCH', `/helpdesk/cases/${sent.case_id}`, { as: 'cs', body: { contract_no: other } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.contract_no, other);
  assert.equal(patched.json.contract_inferred, 0);
  assert.equal(patched.json.contract.contract_no, other);
  assert.equal(patched.json.account.identity, 'contract_only', 'it is another customer\'s contract');
});

test('when a system is down the case still opens, says so, and the Refresh button fills it in', async () => {
  const p = people().at(-1); // somebody not looked up before: answers already remembered would hide the outage
  mock.state.down = true;
  const sent = (await api('POST', '/helpdesk/samples/send', { as: 'cs', body: { customer_id: p.id, subject: 'Salik charge I do not recognise', body: 'There is a Salik toll on my account that I do not recognise, AST-100001.' } })).json;
  assert.ok(sent.case_id, JSON.stringify(sent));
  let c = (await api('GET', `/helpdesk/cases/${sent.case_id}`, { as: 'cs' })).json;
  assert.equal(c.account.status, 'unavailable');
  assert.equal(c.account.will_retry, true);
  assert.equal(c.contract, null);
  assert.ok(c.insights.some((i) => /Customer details are not available yet/.test(i.title)));
  assert.equal((await api('GET', '/helpdesk/readiness', { as: 'admin' })).json.items.find((i) => i.key === 'customer_data').state, 'done', 'a short outage does not undo the setup');

  mock.state.down = false;
  await new Promise((r) => setTimeout(r, 300));
  // the breaker may be holding the system back for a minute: the button asks anyway once it lets one request through
  let refreshed;
  for (let i = 0; i < 4; i++) {
    refreshed = (await api('POST', `/helpdesk/cases/${sent.case_id}/account/refresh`, { as: 'cs' })).json;
    if (refreshed.account.status === 'ok') break;
    await new Promise((r) => setTimeout(r, 1200));
  }
  assert.equal(refreshed.account.status, 'ok', JSON.stringify(refreshed.account.errors));
  assert.equal(refreshed.contract.contract_no, p.ref);
});

test('the case list stays light: no account payload travels with every row', async () => {
  const list = (await api('GET', '/helpdesk/cases?tab=all&limit=5', { as: 'cs' })).json;
  assert.ok(list.data.length > 0);
  for (const row of list.data) {
    assert.equal(row.account_json, undefined);
    assert.equal(row.json, undefined);
    assert.equal(row.contract, undefined);
  }
});
