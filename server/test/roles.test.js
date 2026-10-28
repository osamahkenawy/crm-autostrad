// The five roles (IT, admin, operations, customer service, finance), enforced by the API itself and not just by the screens.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autostrad-roles-'));
const PORT = 5200 + Math.floor(Math.random() * 600);
const base = `http://127.0.0.1:${PORT}/api`;
const env = { ...process.env, ARC_DB_PATH: path.join(dir, 'test.db'), API_PORT: String(PORT), HELPDESK_SCHEDULER: 'off' };
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'HELPDESK_PROVIDER', 'HELPDESK_SEND_MODE', 'HELPDESK_LLM_MODE', 'JWT_SECRET', 'NODE_ENV']) delete env[k];
const DEMO = 'autostrad123'; // the shared demo password of the seeded accounts (test database only)
const TEST_PW = 'throwaway-test-value-1';

let server;
const tokens = {};
const ids = {};

async function call(who, method, route, body) {
  const token = tokens[who] || who; // a role name, or a raw token
  const res = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}
const signIn = async (email, password = DEMO) => {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return { status: r.status, json: await r.json() };
};

before(async () => {
  const seeded = spawnSync(process.execPath, ['src/seed.js'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
  server = spawn(process.execPath, ['src/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  const emails = { it: 'it@autostrad.ae', admin: 'admin@autostrad.ae', operations: 'khalid@autostrad.ae', cs: 'noor@autostrad.ae', finance: 'mariam@autostrad.ae' };
  for (const [who, email] of Object.entries(emails)) {
    const r = await signIn(email);
    assert.ok(r.json.token, `${who} could not sign in`);
    tokens[who] = r.json.token;
    ids[who] = r.json.user.id;
  }
  for (const [key, route] of [['vehicle', '/vehicles'], ['invoice', '/invoices'], ['booking', '/bookings'], ['customer', '/customers'], ['lead', '/leads']]) ids[key] = (await call('it', 'GET', `${route}?limit=1`)).json.data[0].id;
});

after(async () => {
  // Windows cannot delete the database while the server still has it open, so wait for the server to exit first.
  if (server && server.exitCode === null && server.signalCode === null) await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('each role signs in with its own label and abilities', async () => {
  const expectations = {
    it: { label: 'IT (super admin)', has: ['team.edit', 'settings.edit', 'helpdesk.system', 'helpdesk.lab', 'helpdesk.approve_sensitive'], lacks: [] },
    admin: { label: 'Admin', has: ['team.view', 'settings.edit', 'helpdesk.rules', 'helpdesk.approve_sensitive', 'dashboard.view'], lacks: ['team.edit', 'helpdesk.system'] },
    operations: { label: 'Operations', has: ['vehicles.edit', 'bookings.edit', 'dashboard.view', 'helpdesk.work'], lacks: ['team.view', 'invoices.edit', 'helpdesk.approve_sensitive', 'helpdesk.setup'] },
    cs: { label: 'Customer service', has: ['bookings.view', 'customers.edit', 'helpdesk.work'], lacks: ['bookings.edit', 'vehicles.view', 'dashboard.view', 'team.view', 'helpdesk.lab', 'helpdesk.approve_sensitive'] },
    finance: { label: 'Finance', has: ['invoices.edit', 'fines.edit', 'helpdesk.approve_sensitive', 'vehicles.view'], lacks: ['vehicles.edit', 'leads.view', 'helpdesk.rules'] },
  };
  for (const [who, e] of Object.entries(expectations)) {
    const me = (await call(who, 'GET', '/auth/me')).json;
    assert.equal(me.role_label, e.label, who);
    for (const c of e.has) assert.ok(me.caps.includes(c), `${who} should have ${c}`);
    for (const c of e.lacks) assert.ok(!me.caps.includes(c), `${who} should not have ${c}`);
    assert.equal(me.password_hash, undefined);
  }
  const g = (await call('cs', 'GET', '/auth/roles')).json;
  assert.deepEqual(g.roles.map((r) => r.key), ['it', 'admin', 'operations', 'customer_service', 'finance']);
  assert.ok(g.areas.length >= 15 && g.areas.every((a) => Object.keys(a.levels).length === 5));
});

test('the API refuses what a role may not do, and says whether it is "look but not change" or "no access"', async () => {
  const v = ids.vehicle; const i = ids.invoice; const b = ids.booking; const c = ids.customer; const l = ids.lead;
  const table = [
    // customer service: sees bookings, invoices and fines, works customers and the helpdesk
    ['cs', 'GET', '/bookings?limit=1', undefined, 200], ['cs', 'PUT', `/bookings/${b}`, { notes: 'x' }, 403], ['cs', 'GET', '/vehicles', undefined, 403],
    ['cs', 'GET', '/maintenance', undefined, 403], ['cs', 'GET', '/leads', undefined, 403], ['cs', 'GET', '/team', undefined, 403], ['cs', 'GET', '/settings', undefined, 403],
    ['cs', 'GET', '/stats/dashboard', undefined, 403], ['cs', 'GET', '/invoices?limit=1', undefined, 200], ['cs', 'PUT', `/invoices/${i}`, { method: 'Cash' }, 403],
    ['cs', 'PUT', `/customers/${c}`, { notes: 'called the customer' }, 200], ['cs', 'GET', '/helpdesk/cases?limit=1', undefined, 200],
    // operations
    ['operations', 'PUT', `/vehicles/${v}`, { color: 'Silver' }, 200], ['operations', 'PUT', `/invoices/${i}`, { method: 'Cash' }, 403], ['operations', 'GET', '/team', undefined, 403],
    ['operations', 'GET', '/stats/dashboard', undefined, 200], ['operations', 'GET', '/leads', undefined, 200], ['operations', 'PUT', `/leads/${l}`, { notes: 'x' }, 403],
    ['operations', 'GET', '/helpdesk/setup-not-a-route', undefined, 404], ['operations', 'GET', '/helpdesk/settings', undefined, 403],
    // finance
    ['finance', 'PUT', `/invoices/${i}`, { method: 'Cash' }, 200], ['finance', 'PUT', `/vehicles/${v}`, { color: 'Silver' }, 403], ['finance', 'GET', '/vehicles', undefined, 200],
    ['finance', 'GET', '/leads', undefined, 403], ['finance', 'GET', '/settings', undefined, 200], ['finance', 'PUT', '/settings', { vat_rate: '5' }, 403], ['finance', 'GET', '/team', undefined, 403],
    // admin sees everything, changes business data, but does not run accounts or the system
    ['admin', 'GET', '/team', undefined, 200], ['admin', 'POST', '/team', { name: 'X', email: 'x@example.com', role: 'agent', password: TEST_PW }, 403], ['admin', 'PUT', `/vehicles/${v}`, { color: 'Silver' }, 200],
    ['admin', 'PUT', '/settings', { vat_rate: '5' }, 200], ['admin', 'GET', '/helpdesk/lab/tests', undefined, 200], ['admin', 'GET', '/helpdesk/settings', undefined, 200],
    // IT
    ['it', 'GET', '/team', undefined, 200], ['it', 'PUT', `/vehicles/${v}`, { color: 'Silver' }, 200], ['it', 'PUT', '/settings', { vat_rate: '5' }, 200], ['it', 'GET', '/helpdesk/settings', undefined, 200],
    // nobody signed in
    [null, 'GET', '/bookings', undefined, 401],
  ];
  for (const [who, method, route, body, status] of table) {
    const r = await call(who, method, route, body);
    assert.equal(r.status, status, `${who} ${method} ${route} gave ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  }
  assert.match((await call('cs', 'PUT', `/bookings/${b}`, { notes: 'x' })).json.error, /look at this but not change/);
  assert.match((await call('cs', 'GET', '/vehicles')).json.error, /no access/);
});

test('pickers and search only return what the role may see', async () => {
  const opt = (await call('cs', 'GET', '/stats/options')).json;
  assert.equal(opt.vehicles.length, 0);
  assert.equal(opt.leads.length, 0);
  assert.ok(opt.customers.length > 10 && opt.users.length > 5);
  assert.ok((await call('operations', 'GET', '/stats/options')).json.vehicles.length > 10);
  const plate = (await call('it', 'GET', `/vehicles/${ids.vehicle}`)).json.plate;
  assert.equal((await call('cs', 'GET', `/stats/search?q=${encodeURIComponent(plate)}`)).json.vehicles.length, 0);
  assert.ok((await call('operations', 'GET', `/stats/search?q=${encodeURIComponent(plate)}`)).json.vehicles.length >= 1);
});

test('helpdesk: who may approve a sensitive reply, change wording, use the lab and flip the mailbox switches', async () => {
  const sensitive = (await call('it', 'GET', '/helpdesk/cases?tab=drafts&limit=100')).json.data.find((c) => c.sensitive);
  assert.ok(sensitive);
  const d = (await call('it', 'GET', `/helpdesk/cases/${sensitive.id}`)).json;
  const draft = d.drafts.find((x) => x.status === 'pending');
  for (const who of ['cs', 'operations']) {
    const r = await call(who, 'POST', `/helpdesk/drafts/${draft.id}/approve`, {});
    assert.equal(r.status, 400, who);
    assert.match(r.json.error, /finance, admin or IT/);
  }
  assert.equal((await call('finance', 'GET', '/helpdesk/meta')).json.sensitive_approver_roles.sort().join(), 'admin,finance,it');
  for (const who of ['cs', 'operations', 'finance']) {
    assert.equal((await call(who, 'POST', '/helpdesk/lab/classify', { body: 'x' })).status, 403, who);
    assert.equal((await call(who, 'GET', '/helpdesk/templates')).status, 403, who);
  }
  assert.equal((await call('admin', 'GET', '/helpdesk/templates')).status, 200);
  assert.equal((await call('admin', 'PUT', '/helpdesk/settings', { send_mode: 'send_after_approval' })).status, 403, 'only IT flips what is sent');
  assert.equal((await call('operations', 'POST', '/helpdesk/mailbox/test', {})).status, 403);
  assert.equal((await call('admin', 'POST', '/helpdesk/mailbox/test', {})).status, 200);
  assert.equal((await call('cs', 'POST', '/helpdesk/mailbox/sync', {})).status, 200, 'everyone can check the mailbox');
});

test('a role change or a disabled account takes effect at once, even on a token that is already signed in', async () => {
  const made = await call('it', 'POST', '/team', { name: 'Temp Person', email: 'temp.person@example.com', role: 'customer_service', password: TEST_PW, status: 'active' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const login = await signIn('temp.person@example.com', TEST_PW);
  const token = login.json.token;
  assert.equal(login.json.user.role, 'customer_service');
  assert.equal((await call(token, 'PUT', `/vehicles/${ids.vehicle}`, { color: 'Blue' })).status, 403);
  assert.equal((await call('it', 'PUT', `/team/${made.json.id}`, { role: 'operations' })).status, 200);
  assert.equal((await call(token, 'PUT', `/vehicles/${ids.vehicle}`, { color: 'Blue' })).status, 200, 'the same token now has the operations role');
  assert.equal((await call('it', 'PUT', `/team/${made.json.id}`, { status: 'disabled' })).status, 200);
  assert.equal((await call(token, 'GET', '/bookings')).status, 401, 'a disabled account is out immediately');
  assert.equal((await signIn('temp.person@example.com', TEST_PW)).status, 401);
  assert.equal((await call('it', 'DELETE', `/team/${made.json.id}`)).status, 200);
});

test('only five roles exist, and there is always at least one active IT account', async () => {
  const bad = await call('it', 'POST', '/team', { name: 'Old Role', email: 'old.role@example.com', role: 'manager', password: TEST_PW });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /five roles/);
  assert.equal((await call('it', 'PUT', `/team/${ids.finance}`, { role: 'superuser' })).status, 400);

  const demote = await call('it', 'PUT', `/team/${ids.it}`, { role: 'admin' });
  assert.equal(demote.status, 400);
  assert.match(demote.json.error, /At least one active IT/);
  assert.equal((await call('it', 'PUT', `/team/${ids.it}`, { status: 'disabled' })).status, 400);
  const own = await call('it', 'DELETE', `/team/${ids.it}`);
  assert.equal(own.status, 400);
  assert.match(own.json.error, /your own account/);

  // with a second IT account the first can step down, and the second then cannot
  const second = await call('it', 'POST', '/team', { name: 'Second IT', email: 'second.it@example.com', role: 'it', password: TEST_PW, status: 'active' });
  assert.equal(second.status, 201);
  const t2 = (await signIn('second.it@example.com', TEST_PW)).json.token;
  assert.equal((await call(t2, 'PUT', `/team/${ids.it}`, { role: 'admin' })).status, 200);
  assert.equal((await call(t2, 'PUT', `/team/${second.json.id}`, { role: 'admin' })).status, 400, 'the last IT cannot step down');
  assert.equal((await call(t2, 'PUT', `/team/${ids.it}`, { role: 'it' })).status, 200);
  assert.equal((await call('it', 'DELETE', `/team/${second.json.id}`)).status, 200);
});

test('a database from before the five roles is moved over once: admin became IT, manager admin, agent customer service', () => {
  const legacy = path.join(dir, 'legacy.db');
  const raw = new Database(legacy);
  raw.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'agent', job_title TEXT, phone TEXT, branch_id INTEGER, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const ins = raw.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)');
  for (const [n, r] of [['A', 'admin'], ['M', 'manager'], ['G', 'agent'], ['F', 'finance']]) ins.run(n, `${n.toLowerCase()}@old.example`, 'x', r);
  raw.close();
  for (let pass = 0; pass < 2; pass++) { // twice: the second run must not change anything
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', "const m = await import('./src/db.js'); m.migrate();"], { cwd: root, env: { ...env, ARC_DB_PATH: legacy }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  const db = new Database(legacy, { readonly: true });
  const roles = Object.fromEntries(db.prepare('SELECT name, role FROM users').all().map((u) => [u.name, u.role]));
  db.close();
  assert.deepEqual(roles, { A: 'it', M: 'admin', G: 'customer_service', F: 'finance' });
});
