// The customer-service modules never show made-up data for a real mailbox:
//  - an email from a real customer is never matched to a customer or contract of the CRM's demo records (the demo records answer for the demo mailbox only),
//  - a new install with a real mailbox starts with no demo cases, reports, channel counts or sample emails, and only people who work in a support team are offered as owners.
// Run: node --test test/helpdesk.nodummy.test.js
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autostrad-nodummy-'));
const baseEnv = { ...process.env, HELPDESK_SCHEDULER: 'off', ARC_SKIP_ENV_FILE: '1' };
for (const k of Object.keys(baseEnv)) if (/^(ANTHROPIC_|GRAPH_|HELPDESK_(?!SCHEDULER)|ORION_|CNR_|CUSTOMER_)/.test(k)) delete baseEnv[k];
let server = null;
const stop = () => (server && server.exitCode === null && server.signalCode === null ? new Promise((resolve) => { server.once('exit', resolve); server.kill(); }) : Promise.resolve());

/* ---------------------------------------------------------------- in this process: a demo database with its CRM records */
const demoDb = path.join(dir, 'demo.db');
const seeded = spawnSync(process.execPath, ['src/seed.js'], { cwd: root, env: { ...baseEnv, ARC_DB_PATH: demoDb }, encoding: 'utf8' });
assert.equal(seeded.status, 0, `seed failed: ${seeded.stderr || seeded.stdout}`);
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|GRAPH_|HELPDESK_|ORION_|CNR_|CUSTOMER_)/.test(k)) delete process.env[k];
process.env.ARC_DB_PATH = demoDb;
process.env.HELPDESK_SCHEDULER = 'off';
const { db } = await import('../src/db.js');
const { accountMode } = await import('../src/helpdesk/systems/config.js');
const { resolveAccount, refreshAccount } = await import('../src/helpdesk/systems/account.js');
const { ingestMessage } = await import('../src/helpdesk/pipeline.js');
const { getCaseDetail } = await import('../src/helpdesk/cases.js');
const { nowUtc } = await import('../src/helpdesk/routing.js');
after(async () => {
  // Windows cannot delete a database while anything still has it open: stop the server and close this process's own connection first
  await stop();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const crm = db.prepare('SELECT c.name, c.email, b.ref AS ref FROM customers c JOIN bookings b ON b.customer_id = c.id WHERE c.email IS NOT NULL ORDER BY b.id LIMIT 1').get();
const staff = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
const viewer = { id: staff.id, name: 'Test Admin', role: 'admin' };
let counter = 0;
const email = (o) => ({
  providerId: `nodummy-${++counter}`, conversationId: `nodummy-conv-${counter}`, direction: 'in', from: { name: 'Zed Realperson', email: crm.email }, to: ['helpdesk@autostrad.com'],
  subject: 'Security deposit refund', body: `Hello, when will I get my security deposit back for contract ${crm.ref}? Thank you`, receivedAt: nowUtc(), ...o,
});
const asDemo = () => { delete process.env.HELPDESK_PROVIDER; delete process.env.HELPDESK_ACCOUNT_SOURCE; };
const asRealMailbox = () => { process.env.HELPDESK_PROVIDER = 'graph'; delete process.env.HELPDESK_ACCOUNT_SOURCE; };

test('the demo records answer for the demo mailbox only', async () => {
  asDemo();
  assert.equal(accountMode(), 'crm');
  const demo = await resolveAccount({ email: crm.email, contractNo: crm.ref });
  assert.equal(demo.status, 'ok', 'the demo mailbox still finds its demo customer (the control)');
  assert.equal(demo.customer.name, crm.name);

  asRealMailbox();
  assert.equal(accountMode(), 'none', 'a real mailbox with no customer system connected has no source at all');
  const real = await resolveAccount({ email: crm.email, contractNo: crm.ref });
  assert.deepEqual([real.status, real.source, real.customer, real.contract], ['not_checked', 'none', null, null]);
  assert.match(real.notes[0], /not connected yet/);

  for (const forced of ['crm', 'api', 'none']) { process.env.HELPDESK_ACCOUNT_SOURCE = forced; assert.equal(accountMode(), forced, `HELPDESK_ACCOUNT_SOURCE=${forced} is honoured`); }
  asDemo();
});

test('an email from a real mailbox is not given a made-up customer, contract or figures, even when it names a demo contract', async () => {
  asRealMailbox();
  const r = await ingestMessage(email({}));
  assert.equal(r.action, 'created');
  const c = getCaseDetail(r.caseId, viewer);
  assert.equal(c.account.source, 'none');
  assert.equal(c.account.status, 'not_checked');
  assert.match(c.account.notes[0], /not connected yet/);
  assert.equal(c.contract, null, 'no contract from the demo records');
  assert.ok(c.insights.some((i) => i.title === 'Contract details are not available'), 'the hint says nothing could be looked up');
  assert.ok(!c.insights.some((i) => i.title === 'No contract found'), 'nothing was looked up, so nothing is "not found" and nobody "has no recent rental"');
  assert.equal(db.prepare('SELECT customer_id FROM hd_cases WHERE id = ?').get(r.caseId).customer_id, null, 'not linked to a demo customer');
  assert.equal(c.customer_name, 'Zed Realperson', 'the case is about the person who wrote, not the demo customer with that address');
  const draft = c.drafts.find((d) => d.status === 'pending');
  assert.ok(draft, 'a draft is still written');
  assert.ok(!draft.body.includes(crm.name), 'and it does not use the demo customer\'s name');
  asDemo();
});

test('what was looked up in the demo records is not shown for a real mailbox, and "refresh" has nothing to ask', async () => {
  asDemo();
  const r = await ingestMessage(email({}));
  assert.equal(getCaseDetail(r.caseId, viewer).account.source, 'crm', 'made in the demo mailbox: demo records');
  asRealMailbox();
  const shown = getCaseDetail(r.caseId, viewer);
  assert.deepEqual([shown.account.source, shown.account.status, shown.account.customer, shown.contract], ['none', 'not_checked', null, null]);
  assert.equal(await refreshAccount(r.caseId, {}), null);
  asDemo();
});

/* ---------------------------------------------------------------- a new install with a real mailbox */
const PORT = 6300 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${PORT}/api`;
const realDb = path.join(dir, 'real.db');
const realEnv = { ...baseEnv, ARC_DB_PATH: realDb, HELPDESK_PROVIDER: 'graph', API_PORT: String(PORT) };
const PASSWORD = 'throwaway-test-value-1';

async function start() {
  server = spawn(process.execPath, ['src/index.js'], { cwd: root, env: realEnv, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('the server did not start');
}
const login = async (email) => (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) })).json()).token;
const get = async (token, route) => { const r = await fetch(`${base}${route}`, { headers: { authorization: `Bearer ${token}` } }); return { status: r.status, json: await r.json() }; };

test('a new install with a real mailbox starts with no made-up data, and offers only people in a support team as owners', async () => {
  for (const args of [['real@example.com', 'Real Admin', 'admin', 'Customer Happiness'], ['it@example.com', 'Real IT', 'it']]) {
    const made = spawnSync(process.execPath, ['scripts/create-admin.mjs', ...args], { cwd: root, env: { ...realEnv, ADMIN_PASSWORD: PASSWORD }, encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
  }
  await start();
  const token = await login('real@example.com');
  assert.ok(token);
  const check = async () => {
    assert.equal((await get(token, '/helpdesk/lab/tests')).json.total, 0, 'no sample emails in the AI lab');
    assert.equal((await get(token, '/helpdesk/cases?tab=all')).json.total, 0, 'no demo cases');
    assert.deepEqual((await get(token, '/helpdesk/reports')).json.data, [], 'no demo reports');
    assert.equal((await get(token, '/helpdesk/channels')).json.total, 0, 'no demo channel counts');
    assert.ok((await get(token, '/helpdesk/keywords?limit=1')).json.total > 100, 'the starter keyword list is configuration, and is there');
    assert.ok((await get(token, '/helpdesk/templates?limit=1')).json.total > 0, 'so is the reply wording');
    assert.deepEqual((await get(token, '/helpdesk/meta')).json.people.map((p) => p.name), ['Real Admin'], 'only a person who works in a support team can own a case');
    assert.equal((await get(token, '/helpdesk/lab/model')).json.samples, 0);
  };
  await check();
  await stop();
  await start();
  assert.ok(await login('real@example.com'));
  await check(); // a restart does not put the sample emails back
});
