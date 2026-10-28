// The AI lab end to end on throw-away databases (src/helpdesk/lab.js): who may use it, the "try an email" box, the labelled test set, CSV import and
// its three modes, the accuracy runs (their arithmetic is re-derived from the stored emails, not copied from the code), what the learned model may
// and may not train on, "teach a phrase", staff corrections, hostile input, and the AI run against a stand-in for the Anthropic API.
// Nothing leaves the machine and the API key used for the AI part is fake.
// Run: node --test test/helpdesk.lab.test.js
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autostrad-lab-'));
const mainDb = path.join(dir, 'main.db');
const PORT = 5800 + Math.floor(Math.random() * 120); // main server, AI off
const AI_PORT = 5950 + Math.floor(Math.random() * 120); // second server, AI on, talking to the stand-in
const MOCK_PORT = 6100 + Math.floor(Math.random() * 120); // the stand-in Anthropic API
const baseEnv = { ...process.env, HELPDESK_SCHEDULER: 'off', ARC_SKIP_ENV_FILE: '1' };
for (const k of Object.keys(baseEnv)) if (/^(ANTHROPIC_|GRAPH_|HELPDESK_(?!SCHEDULER)|ORION_|CNR_|CUSTOMER_)/.test(k)) delete baseEnv[k];

const USERS = { it: 'it@autostrad.ae', admin: 'admin@autostrad.ae', operations: 'khalid@autostrad.ae', finance: 'mariam@autostrad.ae', cs: 'noor@autostrad.ae' };
const servers = [];

/** A client for one running server: signed-in tokens per role and a small fetch wrapper. */
function client(port) {
  const base = `http://127.0.0.1:${port}/api`;
  const tokens = {};
  const call = async (method, route, { as = 'admin', body } = {}) => {
    const res = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  };
  return { base, tokens, call, lab: (method, route, opts) => call(method, `/helpdesk/lab${route}`, opts) };
}
const main = client(PORT);
const aiServer = client(AI_PORT);
const { lab } = main;

async function start(c, port, env) {
  const server = spawn(process.execPath, ['src/index.js'], { cwd: root, env: { ...env, API_PORT: String(port) }, stdio: 'ignore' });
  servers.push(server);
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${c.base}/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  for (const [role, email] of Object.entries(USERS)) {
    const r = await fetch(`${c.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'autostrad123' }) });
    c.tokens[role] = (await r.json()).token;
    assert.ok(c.tokens[role], `could not sign in as ${role}`);
  }
}

/* ------------------------------------------------------------------------------------------ the stand-in for the Anthropic API */
const stand = { requests: [], mode: 'ok' }; // mode: 'ok' | 'down'
let messageCount = 0;
const classification = () => ({
  request_type: 'invoice_request', confidence: 0.93, impact: 'Administrative', priority: 'Low', urgent: false, sensitive_financial: false, language: 'en',
  summary: 'STAND-IN SUMMARY: the customer wants a document.', contract_no: null, amount_aed: null, fine_reference: null, card_last4: null, location: null, customer_name: null,
});
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let json = null;
  try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
  stand.requests.push({ path: req.url.split('?')[0], json });
  if (stand.mode === 'down') {
    res.writeHead(500, { 'content-type': 'application/json', 'x-should-retry': 'false' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'stand-in is down' } }));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: `msg_test_${++messageCount}`, type: 'message', role: 'assistant', model: (json && json.model) || 'claude-opus-5-5',
    content: [{ type: 'text', text: JSON.stringify(classification()) }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }));
});

before(async () => {
  const seeded = spawnSync(process.execPath, ['src/seed.js'], { cwd: root, env: { ...baseEnv, ARC_DB_PATH: mainDb }, encoding: 'utf8' });
  assert.equal(seeded.status, 0, `seed failed: ${seeded.stderr || seeded.stdout}`);
  fs.copyFileSync(mainDb, path.join(dir, 'ai.db'));
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  await start(main, PORT, { ...baseEnv, ARC_DB_PATH: mainDb });
  await start(aiServer, AI_PORT, { ...baseEnv, ARC_DB_PATH: path.join(dir, 'ai.db'), ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}` });
});

after(() => {
  for (const s of servers) s.kill();
  mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------------------------ helpers */
const round = (n, d = 1) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const pct = (a, b) => (b ? round((a / b) * 100) : null);
const countBy = (list, key) => list.reduce((m, x) => ((m[x[key]] = (m[x[key]] || 0) + 1), m), {});
const tests = async (c = main) => (await c.lab('GET', '/tests')).json.data;
const model = async (c = main) => (await c.lab('GET', '/model')).json;
const healthy = async (c = main) => (await fetch(`${c.base}/health`)).ok;
const csvOf = (rows) => rows.map((r) => r.map((cell) => (/[",\n\r]/.test(cell) ? `"${String(cell).replaceAll('"', '""')}"` : cell)).join(',')).join('\n');
const importCsv = (csv, mode, c = main) => c.lab('POST', '/tests/import', { body: { csv, mode } });
const removeWhere = async (pred, c = main) => { for (const t of (await tests(c)).filter(pred)) assert.equal((await c.lab('DELETE', `/tests/${t.id}`)).status, 200); };
const EMAIL = { subject: 'Pre-authorization still on my card', body: 'Hello, the AED 2,000 pre-authorization is still on my card ending 4421 since I returned the car 10 days ago. Contract AST-100123. Regards, Sara Khan' };

/* ------------------------------------------------------------------------------------------ access */
test('the lab is for admin and IT only: every route, every role, and no sign-in', async () => {
  const routes = [['GET', '/tests'], ['POST', '/tests', {}], ['DELETE', '/tests/999999'], ['POST', '/tests/reset', {}], ['POST', '/tests/import', {}], ['POST', '/classify', {}],
    ['POST', '/run', { engine: 'ai' }], ['GET', '/runs'], ['GET', '/runs/999999'], ['GET', '/model'], ['POST', '/model/retrain', {}], ['GET', '/feedback']];
  for (const [method, route, body] of routes) {
    for (const who of ['cs', 'operations', 'finance']) assert.equal((await lab(method, route, { as: who, body })).status, 403, `${who} ${method} ${route}`);
    assert.equal((await lab(method, route, { as: null, body })).status, 401, `no sign-in ${method} ${route}`);
    for (const who of ['it', 'admin']) { const s = (await lab(method, route, { as: who, body })).status; assert.ok(![401, 403].includes(s), `${who} ${method} ${route} answered ${s}`); }
  }
  assert.equal((await main.call('GET', '/helpdesk/lab/tests', { as: null })).status, 401);
});

/* ------------------------------------------------------------------------------------------ try an email */
test('try an email: validation, no side effects, the engines, details found', async () => {
  const before = { cases: (await main.call('GET', '/helpdesk/summary')).json.total, audit: (await main.call('GET', '/helpdesk/audit?limit=1')).json.total };
  assert.equal((await lab('POST', '/classify', { body: {} })).status, 400);
  for (const blank of [{ subject: '', body: '' }, { subject: '   ', body: ' \n ' }]) {
    const r = await lab('POST', '/classify', { body: blank });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Paste an email/);
  }
  const tooLong = await lab('POST', '/classify', { body: { subject: 'x', body: 'a'.repeat(20001) } });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.json.error, /too long/);
  assert.equal((await lab('POST', '/classify', { body: { subject: 'x', body: 'a'.repeat(20000) } })).status, 200, 'exactly 20,000 characters is allowed');

  const smart = await lab('POST', '/classify', { body: EMAIL });
  assert.equal(smart.status, 200);
  assert.equal(smart.json.sub_key, 'preauth_followup');
  assert.equal(smart.json.engine, 'rules+model');
  assert.equal(smart.json.learned.top.length, 3);
  assert.equal(smart.json.entities.contract_no, 'AST-100123');
  assert.equal(smart.json.entities.amount, 2000);
  assert.equal(smart.json.entities.card_last4, '4421');
  assert.ok(smart.json.priority_reasons.length >= 1);
  assert.ok(smart.json.confidence > 0 && smart.json.confidence <= 1);

  const rules = await lab('POST', '/classify', { body: { ...EMAIL, learn: false } });
  assert.equal(rules.json.engine, 'rules');
  assert.equal(rules.json.learned, null, 'the rules-only engine does not consult the learned model');

  const ai = await lab('POST', '/classify', { body: { ...EMAIL, ai: true } });
  assert.equal(ai.status, 200);
  assert.deepEqual([ai.json.ai_requested, ai.json.ai_available, ai.json.ai.used], [true, false, false], 'asking for the AI without a key falls back to the keyword result');
  assert.equal(ai.json.sub_key, smart.json.sub_key);

  assert.deepEqual((await lab('POST', '/classify', { body: EMAIL })).json, smart.json, 'the same email always gets the same answer');

  const arabic = await lab('POST', '/classify', { body: { subject: 'استرجاع مبلغ التأمين', body: 'السلام عليكم، لم يصلني مبلغ التأمين المدفوع بعد إرجاع السيارة بثلاثة أسابيع. العقد AST-100456' } });
  assert.equal(arabic.status, 200);
  assert.equal(arabic.json.language, 'ar');
  assert.equal(arabic.json.sub_key, 'deposit_refund');
  assert.equal(arabic.json.entities.contract_no, 'AST-100456');

  for (const odd of [{ subject: 123, body: 456 }, { subject: ['a', 'b'], body: { x: 1 } }, { subject: null, body: 'hello there' }, { subject: true, body: false }]) {
    assert.ok([200, 400].includes((await lab('POST', '/classify', { body: odd })).status), `odd input ${JSON.stringify(odd)}`);
  }
  assert.ok(await healthy());

  assert.equal((await main.call('GET', '/helpdesk/summary')).json.total, before.cases, 'trying an email creates no case');
  assert.equal((await main.call('GET', '/helpdesk/audit?limit=1')).json.total, before.audit, 'and writes nothing to the audit log');
});

/* ------------------------------------------------------------------------------------------ the labelled test set */
test('the test set: what is in it, adding with validation, the type may be a key or a name, the source cannot be forged, deleting', async () => {
  const list = (await lab('GET', '/tests')).json;
  assert.equal(list.data.length, list.total);
  assert.equal(Object.values(list.per_type).reduce((a, b) => a + b, 0), list.total, 'the per-type counts add up to the total');
  const src = countBy(list.data, 'source');
  assert.ok(src['built-in'] >= 100 && src.independent >= 60, JSON.stringify(src));
  assert.equal(list.ai_available, false);

  const bad = [{}, { body: 'text' }, { body: 'text', expected_sub_key: 'not a type' }, { expected_sub_key: 'invoice_request' }, { body: '   ', expected_sub_key: 'invoice_request' }, { body: 'x', expected_sub_key: 'invoice_request', expected_priority: 'Urgent' }];
  for (const b of bad) assert.equal((await lab('POST', '/tests', { body: b })).status, 400, JSON.stringify(b));

  const ids = [];
  for (const t of ['invoice_request', 'Invoice Request', '  invoice request ', 'invoice-request', 'INVOICE REQUEST']) {
    const r = await lab('POST', '/tests', { body: { subject: `T3 ${t}`, body: 'Please send the tax invoice.', expected_sub_key: t } });
    assert.equal(r.status, 201, t);
    assert.equal(r.json.expected_sub_key, 'invoice_request', `"${t}" should resolve to invoice_request`);
    ids.push(r.json.id);
  }
  const arabic = await lab('POST', '/tests', { body: { subject: 'T3 arabic', body: 'أرجو إرسال الفاتورة الضريبية للعقد', expected_sub_key: 'invoice_request', expected_priority: 'Low' } });
  assert.equal(arabic.json.language, 'ar');
  assert.equal(arabic.json.expected_priority, 'Low');
  const capped = await lab('POST', '/tests', { body: { subject: 's'.repeat(500), body: 'b'.repeat(25000), expected_sub_key: 'general_inquiry' } });
  assert.equal(capped.json.subject.length, 300);
  assert.equal(capped.json.body.length, 20000);
  ids.push(arabic.json.id, capped.json.id);

  const sources = {};
  for (const wanted of ['override', 'independent', 'imported', 'imported-train', 'built-in', 'whatever', undefined]) {
    const r = await lab('POST', '/tests', { body: { subject: `T3 source ${wanted}`, body: 'some email text', expected_sub_key: 'general_inquiry', source: wanted } });
    sources[wanted] = r.json.source;
    ids.push(r.json.id);
  }
  assert.equal(sources.override, 'override');
  for (const k of ['independent', 'imported', 'imported-train', 'built-in', 'whatever', undefined]) assert.equal(sources[k], 'added', `source "${k}" must not be accepted from a caller`);

  assert.equal((await lab('DELETE', '/tests/999999')).status, 404);
  assert.equal((await lab('DELETE', '/tests/abc')).status, 404);
  assert.equal((await lab('DELETE', '/tests/-1')).status, 404);
  for (const id of ids) assert.equal((await lab('DELETE', `/tests/${id}`)).status, 200);
  assert.equal((await lab('DELETE', `/tests/${ids[0]}`)).status, 404, 'already gone');
  assert.equal((await lab('GET', '/tests')).json.total, list.total, 'everything this test added is gone again');
});

test('restore samples: puts the built-in and independent emails back, keeps the ones people added or imported', async () => {
  const before = await tests();
  const builtin = before.filter((t) => ['built-in', 'independent'].includes(t.source));
  const mine = await lab('POST', '/tests', { body: { subject: 'T-restore keep me', body: 'This one must survive a restore.', expected_sub_key: 'general_inquiry' } });
  const imp = await importCsv(csvOf([['subject', 'body', 'expected'], ['T-restore imported', 'An imported email that must survive a restore.', 'Invoice Request']]), 'measure');
  assert.equal(imp.json.added, 1);
  for (const t of [builtin.find((x) => x.source === 'independent'), builtin.find((x) => x.source === 'built-in')]) assert.equal((await lab('DELETE', `/tests/${t.id}`)).status, 200);
  assert.equal((await tests()).filter((t) => ['built-in', 'independent'].includes(t.source)).length, builtin.length - 2);
  const r = await lab('POST', '/tests/reset', { body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.restored, builtin.length, 'the restored count is every built-in and independent email');
  const after = await tests();
  assert.equal(after.filter((t) => ['built-in', 'independent'].includes(t.source)).length, builtin.length);
  assert.ok(after.some((t) => t.subject === 'T-restore keep me') && after.some((t) => t.subject === 'T-restore imported'));
  assert.equal((await lab('POST', '/tests/reset', { body: {} })).json.restored, builtin.length, 'restoring twice does not duplicate anything');
  assert.equal((await tests()).length, after.length);
  await removeWhere((t) => t.subject.startsWith('T-restore'));
  assert.ok(mine.json.id);
});

/* ------------------------------------------------------------------------------------------ CSV import */
test('CSV import: header names, quotes, line endings, byte-order mark, blank rows, skipped rows with reasons', async () => {
  const body = 'He said "send it", twice,\nthen added a second line.';
  const csv = `﻿${csvOf([['Title', 'Email', 'Request_Type', 'Expected_Priority'], ['T-csv one', body, 'Invoice Request', 'HIGH'], ['T-csv two', 'plain text', 'fine_dispute', ' low '], ['T-csv three', 'third', 'Contract Extension or Change', 'urgent']])}\r\n\r\n   ,  ,  ,  \r\n`;
  const r = await importCsv(csv.replaceAll('\n', '\r\n').replaceAll('\r\r\n', '\r\n'), 'measure');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.added, r.json.skipped], [3, 0]);
  const got = Object.fromEntries((await tests()).filter((t) => t.subject.startsWith('T-csv')).map((t) => [t.subject, t]));
  assert.equal(got['T-csv one'].body.replace(/\r/g, ''), body, 'commas, doubled quotes and a line break inside quotes come through intact');
  assert.equal(got['T-csv one'].expected_priority, 'High');
  assert.equal(got['T-csv two'].expected_sub_key, 'fine_dispute');
  assert.equal(got['T-csv two'].expected_priority, 'Low', 'a priority is read whatever its case and spaces');
  assert.equal(got['T-csv three'].expected_priority, null, 'an unknown priority is ignored, not stored');
  assert.equal(got['T-csv three'].expected_sub_key, 'contract_extension');
  await removeWhere((t) => t.subject.startsWith('T-csv'));

  const lone = await importCsv('subject,body,expected\rT-cr one,first,Invoice Request\rT-cr two,second,Invoice Request', 'measure');
  assert.equal(lone.json.added, 2, 'old-style line endings (a lone carriage return) work');
  await removeWhere((t) => t.subject.startsWith('T-cr'));

  assert.equal((await importCsv('', 'measure')).status, 400);
  assert.equal((await importCsv('subject,body,expected', 'measure')).status, 400, 'a header and nothing else');
  const noCols = await importCsv('subject,text\nhello,world', 'measure');
  assert.equal(noCols.status, 400);
  assert.match(noCols.json.error, /Columns needed/);
  assert.equal((await lab('POST', '/tests/import', { body: {} })).status, 400);

  const rows = [['subject', 'body', 'expected'], ['T-skip ok', 'a real email', 'Invoice Request'], ['T-skip empty', '', 'Invoice Request'], ['T-skip odd', 'text', 'Not a real type']];
  const skipped = await importCsv(csvOf(rows), 'measure');
  assert.deepEqual([skipped.json.added, skipped.json.skipped], [1, 2]);
  assert.deepEqual(skipped.json.errors, ['Row 3: empty email body', 'Row 4: unknown request type "Not a real type"'], 'the row numbers are the ones a person sees in the file');
  await removeWhere((t) => t.subject.startsWith('T-skip'));

  const many = [['subject', 'body', 'expected'], ...Array.from({ length: 30 }, (_, i) => [`T-many ${i}`, 'body', 'nonsense type'])];
  const capped = await importCsv(csvOf(many), 'measure');
  assert.deepEqual([capped.json.added, capped.json.skipped, capped.json.errors.length], [0, 30, 20], 'all skipped rows are counted, the list of reasons stops at 20');

  const caps = await importCsv(csvOf([['subject', 'body', 'expected'], ['s'.repeat(400), 'b'.repeat(25000), 'Invoice Request']]), 'measure');
  assert.equal(caps.json.added, 1);
  const long = (await tests()).find((t) => t.subject.startsWith('ssss'));
  assert.deepEqual([long.subject.length, long.body.length], [300, 20000]);
  await removeWhere((t) => t.subject.startsWith('ssss'));
});

test('CSV import modes: measure keeps emails out of training, train puts them in, split alternates', async () => {
  const sample = (tag) => csvOf([['subject', 'body', 'expected'], ...[1, 2, 3, 4].map((i) => [`T-mode ${tag} ${i}`, `Please send the tax invoice number ${i}`, 'Invoice Request']), ['T-mode bad', 'text', 'nonsense']]);
  const m0 = await model();

  const measure = await importCsv(sample('m'), 'measure');
  assert.equal(measure.json.mode, 'measure');
  assert.deepEqual((await tests()).filter((t) => t.subject.startsWith('T-mode m ')).map((t) => t.source), ['imported', 'imported', 'imported', 'imported']);
  const m1 = await model();
  assert.equal(m1.samples, m0.samples, 'measure: the model learned nothing from them');
  assert.equal(m1.docs, m0.docs);

  const train = await importCsv(sample('t'), 'train');
  assert.equal(train.json.mode, 'train');
  assert.ok((await tests()).filter((t) => t.subject.startsWith('T-mode t ')).every((t) => t.source === 'imported-train'));
  const m2 = await model();
  assert.equal(m2.samples, m1.samples + 4, 'train: the model counts the four new emails');
  assert.equal(m2.docs, m1.docs + 4);

  const split = await importCsv(sample('s'), 'split');
  assert.equal(split.json.mode, 'split');
  assert.deepEqual((await tests()).filter((t) => t.subject.startsWith('T-mode s ')).sort((a, b) => a.id - b.id).map((t) => t.source), ['imported', 'imported-train', 'imported', 'imported-train'], 'split alternates, and a skipped row does not shift it');
  const m3 = await model();
  assert.equal(m3.samples, m2.samples + 2);

  for (const none of [undefined, null, '']) {
    const r = await importCsv(csvOf([['subject', 'body', 'expected'], [`T-mode none ${none}`, 'some text', 'Invoice Request']]), none);
    assert.equal(r.json.mode, 'split', `no mode (${JSON.stringify(none)}) means the recommended split`);
  }
  assert.equal((await importCsv(csvOf([['subject', 'body', 'expected'], ['T-mode upper', 'some text', 'Invoice Request']]), ' MEASURE ')).json.mode, 'measure', 'the mode is read whatever its case');
  for (const typo of ['bogus', 'trian', 7, true, {}]) {
    const r = await importCsv(sample('typo'), typo);
    assert.equal(r.status, 400, `mode ${JSON.stringify(typo)} must be refused, not quietly turned into a split that trains on half of it`);
    assert.match(r.json.error, /Unknown mode/);
  }
  assert.equal((await tests()).filter((t) => t.subject.startsWith('T-mode typo')).length, 0, 'a refused import adds nothing');
  await removeWhere((t) => t.subject.startsWith('T-mode'));
  assert.equal((await model()).samples, m0.samples, 'removing them takes them out of the model again');
});

/* ------------------------------------------------------------------------------------------ training integrity */
test('the model never learns from the independent or the imported-for-measuring emails, and does learn from the rest', async () => {
  const all = await tests();
  const m = await model();
  assert.equal(m.samples, all.filter((t) => !['independent', 'imported'].includes(t.source)).length, 'every other email is a training sample, those two kinds are not');

  const added = await lab('POST', '/tests', { body: { subject: 'T-train added', body: 'zorbatrex plimquaff wenzlefrap', expected_sub_key: 'vehicle_issue' } });
  const over = await lab('POST', '/tests', { body: { subject: 'T-train override', body: 'grumblewick snorfelpoot', expected_sub_key: 'vehicle_issue', source: 'override' } });
  const m1 = await model();
  assert.equal(m1.samples, m.samples + 2);
  assert.equal(m1.docs, m.docs + 2);
  await lab('DELETE', `/tests/${added.json.id}`);
  await lab('DELETE', `/tests/${over.json.id}`);
  assert.equal((await model()).samples, m.samples);

  // a hold-out email is invisible to the model: the exact same words get no special treatment...
  const nonsense = 'quibblezork flandrimont thistlewump';
  await importCsv(csvOf([['subject', 'body', 'expected'], ['T-hold out', nonsense, 'Damage or Fuel Charge Dispute']]), 'measure');
  const held = (await lab('POST', '/classify', { body: { subject: '', body: nonsense } })).json;
  assert.ok(!held.learned || held.learned.top[0].p < 0.3, `a measuring email must not be memorised (top ${JSON.stringify(held.learned && held.learned.top[0])})`);
  // ...while the same words imported for training are recognised straight away
  await importCsv(csvOf([['subject', 'body', 'expected'], ['T-hold in', nonsense, 'Damage or Fuel Charge Dispute']]), 'train');
  const learned = (await lab('POST', '/classify', { body: { subject: '', body: nonsense } })).json;
  assert.equal(learned.learned.top[0].sub_key, 'damage_dispute', 'a training email is learned (the model retrained by itself)');
  assert.ok(learned.learned.top[0].p > 0.3);
  await removeWhere((t) => t.subject.startsWith('T-hold'));
});

test('teach a phrase: it is used by the next email, the model counts it, and removing it removes it', async () => {
  const phrase = 'zzquux flibberwock';
  const probe = { subject: 'hello', body: `please help with ${phrase} thanks` };
  const before = await lab('POST', '/classify', { body: probe });
  assert.ok(!before.json.rules.matched.some((m) => m.term === phrase));
  const kw0 = (await model()).keywords;
  assert.equal((await main.call('POST', '/helpdesk/keywords', { as: 'operations', body: { sub_key: 'invoice_request', term: phrase, weight: 4, language: 'en', kind: 'phrase', active: 1 } })).status, 403, 'only admin and IT may teach phrases');
  const made = await main.call('POST', '/helpdesk/keywords', { body: { sub_key: 'invoice_request', term: phrase, weight: 4, language: 'en', kind: 'phrase', active: 1 } });
  assert.equal(made.status, 201);
  assert.equal((await model()).keywords, kw0 + 1);
  const after = (await lab('POST', '/classify', { body: probe })).json;
  assert.ok(after.rules.matched.some((m) => m.term === phrase), 'the phrase is matched');
  assert.equal(after.sub_key, 'invoice_request');
  assert.equal((await main.call('DELETE', `/helpdesk/keywords/${made.json.id}`)).status, 200);
  assert.equal((await model()).keywords, kw0);
  assert.ok(!(await lab('POST', '/classify', { body: probe })).json.rules.matched.some((m) => m.term === phrase));
});

/* ------------------------------------------------------------------------------------------ accuracy runs */
/** The summary a run must report, rebuilt from the stored emails by asking /classify about each one (never from lab.js). */
async function expectedRun(engine) {
  const all = await tests();
  const learn = engine !== 'rules';
  const results = [];
  for (let i = 0; i < all.length; i += 25) {
    results.push(...await Promise.all(all.slice(i, i + 25).map(async (t) => {
      const r = (await lab('POST', '/classify', { body: { subject: t.subject || '', body: t.body, learn } })).json;
      return { t, got: r.sub_key, priority: r.priority, confidence: r.confidence, flagged: r.needs_review, ok: r.sub_key === t.expected_sub_key, priority_ok: t.expected_priority ? r.priority === t.expected_priority : null };
    })));
  }
  const meta = (await main.call('GET', '/helpdesk/meta')).json.subcategories;
  const correct = results.filter((r) => r.ok).length;
  const grouped = (keyOf) => Object.fromEntries(Object.entries(results.reduce((m, r) => { const k = keyOf(r); (m[k] ||= { total: 0, correct: 0 }); m[k].total++; if (r.ok) m[k].correct++; return m; }, {})).map(([k, v]) => [k, { ...v, accuracy: pct(v.correct, v.total) }]));
  const confident = results.filter((r) => !r.flagged);
  const prio = results.filter((r) => r.priority_ok !== null);
  const avg = (list) => (list.length ? list.reduce((a, r) => a + (r.confidence || 0), 0) / list.length : null);
  return {
    total: results.length, correct, accuracy: pct(correct, results.length),
    priority_checked: prio.length, priority_correct: prio.filter((r) => r.priority_ok).length, flagged_for_triage: results.filter((r) => r.flagged).length,
    avg_confidence_correct: round(avg(results.filter((r) => r.ok)), 2), avg_confidence_wrong: round(avg(results.filter((r) => !r.ok)), 2),
    by_language: grouped((r) => r.t.language || 'en'), by_source: grouped((r) => r.t.source || 'added'),
    confident_total: confident.length, confident_correct: confident.filter((r) => r.ok).length, confident_accuracy: pct(confident.filter((r) => r.ok).length, confident.length),
    types: meta.map((s) => { const exp = results.filter((r) => r.t.expected_sub_key === s.key); const pred = results.filter((r) => r.got === s.key); const tp = exp.filter((r) => r.ok).length; return { sub_key: s.key, name: s.name, tests: exp.length, correct: tp, predicted: pred.length, recall: pct(tp, exp.length), precision: pct(tp, pred.length) }; }).filter((t) => t.tests || t.predicted),
    failure_ids: results.filter((r) => !r.ok || r.priority_ok === false).map((r) => r.t.id).sort((a, b) => a - b),
  };
}

test('accuracy runs: every number is re-derived independently, for the rules engine and for the smart engine', async () => {
  for (const engine of ['rules', 'smart']) {
    const want = await expectedRun(engine);
    const run = await lab('POST', '/run', { body: { engine } });
    assert.equal(run.status, 201, JSON.stringify(run.json));
    const got = run.json;
    assert.equal(got.engine, engine);
    for (const k of ['total', 'correct', 'accuracy', 'priority_checked', 'priority_correct', 'flagged_for_triage', 'avg_confidence_correct', 'avg_confidence_wrong', 'confident_total', 'confident_correct', 'confident_accuracy']) assert.equal(got[k], want[k], `${engine}: ${k}`);
    assert.deepEqual(got.by_source, want.by_source, `${engine}: by_source`);
    assert.deepEqual(got.by_language, want.by_language, `${engine}: by_language`);
    assert.deepEqual(got.types, want.types, `${engine}: per request type`);
    assert.deepEqual(got.failures.map((f) => f.id).sort((a, b) => a - b), want.failure_ids, `${engine}: the list of wrong answers`);
    assert.equal(Object.values(got.by_source).reduce((a, v) => a + v.total, 0), got.total, 'the sets add up to the total');
    assert.equal(Object.values(got.by_language).reduce((a, v) => a + v.total, 0), got.total, 'the languages add up to the total');
    assert.equal(got.types.reduce((a, t) => a + t.tests, 0), got.total, 'the request types add up to the total');
    assert.equal(got.types.reduce((a, t) => a + t.correct, 0), got.correct);
    assert.ok(got.by_source.independent && got.by_source.independent.total >= 60, 'the independent emails are measured separately');
    assert.ok(got.accuracy >= 55, `${engine} accuracy ${got.accuracy}`);
  }
});

test('accuracy runs: the history, the fallback engine, the AI refusal, repeatability and concurrent runs', async () => {
  const first = (await lab('POST', '/run', { body: { engine: 'rules' } })).json;
  const stored = await lab('GET', `/runs/${first.id}`);
  assert.deepEqual(stored.json, { ...first }, 'a stored run reads back exactly as it was reported');
  const odd = await lab('POST', '/run', { body: { engine: 'quantum' } });
  assert.equal(odd.json.engine, 'smart', 'an unknown engine name means the smart engine');
  assert.equal((await lab('POST', '/run', { body: {} })).json.engine, 'smart');
  const ai = await lab('POST', '/run', { body: { engine: 'ai' } });
  assert.equal(ai.status, 400);
  assert.match(ai.json.error, /ANTHROPIC_API_KEY/);

  const history = (await lab('GET', '/runs')).json.data;
  assert.ok(history.length >= 4 && history.length <= 30);
  assert.deepEqual(history.map((h) => h.id), [...history.map((h) => h.id)].sort((a, b) => b - a), 'newest first');
  assert.deepEqual(Object.keys(history[0]).sort(), ['correct', 'engine', 'id', 'ran_at', 'total']);
  for (const id of ['999999', 'abc', '-1']) assert.equal((await lab('GET', `/runs/${id}`)).status, 404, id);

  const again = (await lab('POST', '/run', { body: { engine: 'rules' } })).json;
  assert.deepEqual([again.correct, again.accuracy, again.flagged_for_triage], [first.correct, first.accuracy, first.flagged_for_triage], 'the same test set gives the same score');

  const n0 = (await lab('GET', '/runs')).json.data.length;
  const par = await Promise.all([1, 2, 3, 4].map(() => lab('POST', '/run', { body: { engine: 'smart' } })));
  assert.ok(par.every((r) => r.status === 201));
  assert.equal(new Set(par.map((r) => `${r.json.correct}/${r.json.total}/${r.json.flagged_for_triage}`)).size, 1, 'concurrent runs agree');
  assert.equal(new Set(par.map((r) => r.json.id)).size, 4, 'each run is stored on its own');
  assert.equal((await lab('GET', '/runs')).json.data.length, Math.min(30, n0 + 4));
  const audit = (await main.call('GET', '/helpdesk/audit?limit=200')).json;
  assert.ok(audit.data.some((a) => a.action === 'test_run' && /correct/.test(a.detail || '')), 'runs are written to the audit log');
});

test('the smart engine measures better than the rules alone on the independent emails, and the model can be retrained on request', async () => {
  const rules = (await lab('POST', '/run', { body: { engine: 'rules' } })).json;
  const smart = (await lab('POST', '/run', { body: { engine: 'smart' } })).json;
  assert.ok(smart.by_source.independent.accuracy >= rules.by_source.independent.accuracy, `${smart.by_source.independent.accuracy} vs ${rules.by_source.independent.accuracy}`);
  const m = await model();
  const re = await lab('POST', '/model/retrain', { body: {} });
  assert.equal(re.status, 200);
  assert.deepEqual([re.json.keywords, re.json.samples, re.json.corrected, re.json.closed], [m.keywords, m.samples, m.corrected, m.closed]);
  assert.ok(re.json.features > 1000 && re.json.docs >= re.json.samples + re.json.keywords);
  const audit = (await main.call('GET', '/helpdesk/audit?limit=100')).json;
  assert.ok(audit.data.some((a) => a.action === 'model_retrained'));
});

/* ------------------------------------------------------------------------------------------ staff corrections */
test('corrections: the period is clamped, an override appears with its suggestion, and the rates add up', async () => {
  for (const [days, want] of [['abc', 30], ['0', 30], ['', 30], ['-5', 1], ['9999', 365], ['90', 90], ['1', 1]]) assert.equal((await lab('GET', `/feedback?days=${days}`)).json.days, want, `days=${days}`);
  const before = (await lab('GET', '/feedback?days=30')).json;
  const cases = (await main.call('GET', '/helpdesk/cases?tab=all&limit=100')).json.data;
  const target = cases.find((c) => c.sub_key !== 'invoice_request' && c.subject && c.subject.trim().split(/\s+/).length >= 3);
  assert.ok(target, 'a seeded case to correct');
  const patched = await main.call('PATCH', `/helpdesk/cases/${target.id}`, { body: { sub_key: 'invoice_request' } });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  const after = (await lab('GET', '/feedback?days=30')).json;
  // changing the type re-routes the case, which can change its owner too (a second entry), so only the type changes are counted exactly
  assert.equal((after.by_field.sub_key || 0), (before.by_field.sub_key || 0) + 1, 'one more type change');
  assert.ok(after.overrides >= before.overrides + 1);
  assert.equal(after.classified, before.classified, 'a correction is not a new classification');
  const row = after.data.find((o) => o.case_id === target.id && o.field === 'sub_key');
  assert.ok(row, 'the correction is listed');
  assert.deepEqual([row.old_value, row.new_value], [target.sub_key, 'invoice_request']);
  assert.ok(row.case_no && row.actor_name);
  assert.ok(after.confused_pairs.some((p) => p.from === target.sub_key && p.to === 'invoice_request'), 'the mix-up is counted');
  if (row.suggestion) assert.deepEqual(Object.keys(row.suggestion).sort(), ['sub_key', 'term']);
  const correctedCases = new Set(after.data.filter((o) => o.field === 'sub_key' || o.field === 'priority').map((o) => o.case_id)).size;
  assert.equal(after.override_rate, pct(correctedCases, after.classified), 'the correction rate is emails whose type or priority was changed, each once, over emails classified');
  assert.deepEqual((await lab('GET', '/feedback?days=1')).json.confused_pairs.length >= 1, true);
});

/* ------------------------------------------------------------------------------------------ hostile input */
test('hostile input: nothing that fits in the 20,000-character box makes the analysis slow or the server unwell', async () => {
  const nasty = {
    'one word repeated': 'invoice '.repeat(2500),
    'one very long word': 'a'.repeat(20000),
    'digits and dashes': '1-'.repeat(10000),
    'contract-like runs': 'AST-'.repeat(5000),
    'contract word and separators': `contract${' : '.repeat(6000)}12345`,
    'dots and at signs': 'a@b.'.repeat(5000),
    'quote markers': `${'> '.repeat(10000)}hello`,
    'thousands of short lines': 'x\n'.repeat(10000),
    'arabic with diacritics': 'السَّلامُ عَلَيْكُمْ '.repeat(1000),
    'only spaces then a word': `${' '.repeat(19990)}invoice`,
    'card-like numbers': '4111 1111 1111 1111 '.repeat(1000),
    'tatweel': 'ـ'.repeat(20000),
    'amounts': 'AED 1,000.00 '.repeat(1500),
    'emoji': '😀🚗'.repeat(5000),
    'control characters': '\u0000\u0007\u001b'.repeat(6000),
    'forwarded headers': 'From: a@b.c\nSent: Monday\nTo: d@e.f\nSubject: Re: Re: Re:\n'.repeat(300),
  };
  const slow = [];
  for (const [name, text] of Object.entries(nasty)) {
    const t0 = Date.now();
    const r = await lab('POST', '/classify', { body: { subject: 'x', body: text.slice(0, 20000) } });
    const ms = Date.now() - t0;
    assert.ok([200, 400].includes(r.status), `${name}: status ${r.status}`);
    if (ms > 1500) slow.push(`${name} took ${ms} ms`);
  }
  assert.deepEqual(slow, [], 'every hostile input is answered within 1.5 seconds');
  const t0 = Date.now();
  const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => lab('POST', '/classify', { body: { subject: 'x', body: `${'AST-12345 invoice '.repeat(1100)}${i}` } })));
  assert.ok(burst.every((r) => r.status === 200));
  assert.ok(Date.now() - t0 < 6000, 'six large emails at once');
  assert.ok(await healthy());
});

/* ------------------------------------------------------------------------------------------ the AI, against a stand-in */
test('AI on (stand-in for the Anthropic API): "also ask the AI" and the AI run send only what they should', async () => {
  const L = aiServer.lab;
  assert.equal((await L('GET', '/tests')).json.ai_available, true);

  stand.requests.length = 0;
  const plain = await L('POST', '/classify', { body: EMAIL });
  assert.equal(plain.json.ai_available, true);
  assert.equal(plain.json.ai.used, false, 'without asking, the AI is not called');
  assert.equal(stand.requests.length, 0);

  const asked = await L('POST', '/classify', { body: { ...EMAIL, ai: true } });
  assert.equal(asked.status, 200);
  assert.deepEqual([asked.json.ai_requested, asked.json.ai_available, asked.json.ai.used], [true, true, true]);
  assert.match(asked.json.ai.summary, /STAND-IN SUMMARY/);
  assert.equal(stand.requests.length, 1);
  assert.equal(stand.requests[0].path, '/v1/messages');
  const sent = JSON.stringify(stand.requests[0].json);
  assert.ok(sent.includes('Pre-authorization still on my card') && sent.includes('AST-100123'), 'the email itself is what is sent');
  const leak = sent.match(/.{0,30}(@autostrad|autostrad123|bearer|api[_-]?key|test-key).{0,30}/i);
  assert.equal(leak, null, `nothing else leaves (no account emails, no credentials), but this was in the request: ${leak && leak[0]}`);
  assert.ok(!Object.values(aiServer.tokens).some((t) => sent.includes(t)), 'no session token is sent');

  // an AI run asks about the independent and imported emails only, never the tuning samples
  const set = await tests(aiServer);
  const wantedAsked = set.filter((t) => t.source !== 'built-in');
  stand.requests.length = 0;
  const run = await L('POST', '/run', { body: { engine: 'ai' } });
  assert.equal(run.status, 201, JSON.stringify(run.json));
  assert.equal(run.json.engine, 'ai');
  assert.equal(run.json.total, wantedAsked.length, 'only the independent and imported emails are measured by an AI run');
  assert.deepEqual(Object.keys(run.json.by_source), ['independent']);
  assert.equal(stand.requests.length, wantedAsked.length, 'one AI call per measured email, no more');
  const tuning = set.find((t) => t.source === 'built-in');
  assert.ok(!stand.requests.some((r) => JSON.stringify(r.json).includes(tuning.body.slice(0, 60))), 'a tuning sample is never sent to the AI');

  // the cost cap: more than 150 emails to ask about is refused before anything is sent
  const extra = csvOf([['subject', 'body', 'expected'], ...Array.from({ length: 100 }, (_, i) => [`T-ai ${i}`, `Please send invoice number ${i}`, 'Invoice Request'])]);
  assert.equal((await importCsv(extra, 'measure', aiServer)).json.added, 100);
  stand.requests.length = 0;
  const capped = await L('POST', '/run', { body: { engine: 'ai' } });
  assert.equal(capped.status, 400);
  assert.match(capped.json.error, /150/);
  assert.equal(stand.requests.length, 0, 'nothing was sent');
  await removeWhere((t) => t.subject.startsWith('T-ai '), aiServer);

  // the AI being down never breaks the lab: the run completes with the keyword and model answers
  stand.mode = 'down';
  const down = await L('POST', '/run', { body: { engine: 'ai' } });
  assert.equal(down.status, 201, JSON.stringify(down.json));
  assert.equal(down.json.total, wantedAsked.length);
  const ok = await L('POST', '/classify', { body: { ...EMAIL, ai: true } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ai.used, false);
  assert.equal(ok.json.sub_key, 'preauth_followup');
  stand.mode = 'ok';
  assert.ok(await healthy(aiServer));
});

/* ------------------------------------------------------------------------------------------ found by an independent tester (2026-10-28) */
test('try an email: the subject is capped like the body, and null is no text', async () => {
  assert.equal((await lab('POST', '/classify', { body: { subject: 's'.repeat(1001), body: 'hello' } })).status, 400);
  assert.equal((await lab('POST', '/classify', { body: { subject: 's'.repeat(1000), body: 'hello' } })).status, 200);
  const t0 = Date.now();
  const huge = await lab('POST', '/classify', { body: { subject: 'refund '.repeat(28572), body: 'hello' } });
  assert.equal(huge.status, 400);
  assert.ok(Date.now() - t0 < 1000, 'a 200,000-character subject is refused at once instead of being analysed for seconds');
  const nullSubject = (await lab('POST', '/classify', { body: { subject: null, body: EMAIL.body } })).json;
  const emptySubject = (await lab('POST', '/classify', { body: { subject: '', body: EMAIL.body } })).json;
  assert.deepEqual(nullSubject, emptySubject, 'a null subject is no subject, not the word "null"');
  assert.equal((await lab('POST', '/classify', { body: { subject: null, body: null } })).status, 400);
});

test('keywords: the save route refuses what would bend the classifier, and editing one retrains the learned model', async () => {
  const good = { sub_key: 'invoice_request', term: 'zzquux flibberwock', weight: 4, language: 'en', kind: 'phrase', active: 1 };
  const refused = [{ ...good, sub_key: 'bogus_type' }, { ...good, sub_key: undefined }, { ...good, weight: 'abc' }, { ...good, weight: 9 }, { ...good, weight: 0 }, { ...good, weight: 2.5 }, { ...good, term: 'a' }, { ...good, term: 'x'.repeat(201) },
    { ...good, kind: 'regex', term: 'x*' }, { ...good, kind: 'regex', term: '(a+)+$' }, { ...good, kind: 'regex', term: '(' }, { ...good, language: 'fr' }, { ...good, kind: 'sql' }];
  const kw0 = (await model()).keywords;
  for (const body of refused) {
    const r = await main.call('POST', '/helpdesk/keywords', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.json.error);
  }
  assert.equal((await model()).keywords, kw0, 'none of the refused ones was saved');

  const made = await main.call('POST', '/helpdesk/keywords', { body: { ...good, weight: '4' } });
  assert.equal(made.status, 201);
  assert.equal(made.json.weight, 4, 'a weight sent as text is stored as a number');
  assert.equal((await main.call('POST', '/helpdesk/keywords', { body: { sub_key: 'refund_request', term: 'money back please' } })).status, 201, 'only the type and the phrase are needed');

  const m1 = await model();
  await new Promise((r) => setTimeout(r, 5));
  const edited = await main.call('PUT', `/helpdesk/keywords/${made.json.id}`, { body: { sub_key: 'refund_request' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.sub_key, 'refund_request');
  assert.equal(edited.json.term, 'zzquux flibberwock', 'an update that sends one field keeps the others');
  assert.notEqual((await model()).trained_at, m1.trained_at, 'editing a keyword retrains the learned model (it used to keep the old type until someone pressed Retrain)');
  assert.equal((await main.call('PUT', `/helpdesk/keywords/${made.json.id}`, { body: { weight: 'abc' } })).status, 400);
  assert.equal((await main.call('PUT', `/helpdesk/keywords/${made.json.id}`, { body: { active: 0 } })).json.active, 0);
  for (const k of (await main.call('GET', '/helpdesk/keywords?limit=1000')).json.data.filter((x) => ['zzquux flibberwock', 'money back please'].includes(x.term))) assert.equal((await main.call('DELETE', `/helpdesk/keywords/${k.id}`)).status, 200);
  assert.equal((await model()).keywords, kw0);
});

test('a bad keyword row already in the database cannot poison the classifier', async () => {
  const email = { subject: 'Cancel my booking', body: 'My plans changed and I would like to cancel my booking for next week and get a refund of the prepaid amount.' };
  const before = (await lab('POST', '/classify', { body: email })).json;
  assert.equal(before.sub_key, 'refund_request');
  const db = new Database(mainDb);
  const add = db.prepare("INSERT INTO hd_keywords (sub_key, language, term, weight, kind, active, source) VALUES (?, 'en', ?, ?, ?, 1, 'test-bad-row')");
  add.run('bogus_type', 'cancel my booking refund prepaid', 5, 'phrase');
  add.run('refund_request', 'zz bad weight phrase', 'abc', 'phrase');
  add.run('refund_request', 'x*', 3, 'regex');
  add.run('refund_request', '(a+)+$', 3, 'regex');
  try {
    // a valid keyword saved through the route makes the server reload its keyword list and retrain, bad rows included
    const kick = await main.call('POST', '/helpdesk/keywords', { body: { sub_key: 'general_inquiry', term: 'zzkick phrase', weight: 2 } });
    assert.equal(kick.status, 201);
    const after = (await lab('POST', '/classify', { body: email })).json;
    assert.ok(Number.isFinite(after.confidence), `confidence is ${after.confidence}`);
    assert.equal(after.sub_key, 'refund_request');
    assert.ok(Math.abs(after.confidence - before.confidence) < 0.05);
    assert.equal(after.needs_review, before.needs_review);
    assert.ok(Number.isFinite(after.learned.top[0].p));
    await main.call('DELETE', `/helpdesk/keywords/${kick.json.id}`);
  } finally {
    db.prepare("DELETE FROM hd_keywords WHERE source = 'test-bad-row'").run();
    db.close();
  }
  assert.ok(Number.isFinite((await lab('POST', '/classify', { body: email })).json.confidence));
});

test('card numbers, Emirates IDs and IBANs in a test email are masked before they are stored, listed or logged; deleting one is audited', async () => {
  const card = '4111 1111 1111 1111';
  const eid = '784-1990-1234567-1';
  const iban = 'AE070331234567890123456';
  const text = `Please refund to card ${card}. My Emirates ID is ${eid} and my IBAN is ${iban}. CVV 123.`;
  const raws = [card, eid, iban, '1234567890123456', 'CVV 123'];
  const added = await lab('POST', '/tests', { body: { subject: `T-pii card ${card}`, body: text, expected_sub_key: 'refund_request' } });
  assert.equal(added.status, 201);
  const imported = await importCsv(csvOf([['subject', 'body', 'expected'], [`T-pii csv ${card}`, text, 'Refund Request']]), 'measure');
  assert.equal(imported.json.added, 1);
  const stored = (await tests()).filter((t) => t.subject.startsWith('T-pii'));
  assert.equal(stored.length, 2);
  for (const t of stored) {
    for (const raw of raws) assert.ok(!`${t.subject} ${t.body}`.includes(raw), `"${raw}" must not be stored`);
    assert.match(t.body, /\*\*\*\* \*\*\*\* \*\*\*\* 1111/);
    assert.match(t.body, /784-\*{4}-\*{7}-1/);
    assert.match(t.body, /AE\*\* \*{4} \*{4} \*{4} 3456/);
  }
  // listed to every helpdesk role in the sample library, and copied into the audit log
  const samples = JSON.stringify((await main.call('GET', '/helpdesk/samples', { as: 'cs' })).json);
  const audit = JSON.stringify((await main.call('GET', '/helpdesk/audit?limit=200')).json);
  for (const raw of raws) { assert.ok(!samples.includes(raw), `"${raw}" must not be listed in the sample library`); assert.ok(!audit.includes(raw), `"${raw}" must not reach the audit log`); }
  // deleting a test email leaves a trace
  assert.equal((await lab('DELETE', `/tests/${added.json.id}`)).status, 200);
  const log = (await main.call('GET', '/helpdesk/audit?limit=50')).json.data;
  assert.ok(log.some((a) => a.action === 'test_case_deleted' && /T-pii card/.test(a.detail || '')), 'the deletion is in the audit log');
  await removeWhere((t) => t.subject.startsWith('T-pii'));
});

test('CSV import: the body column beats a sender "email" column, and nothing is dropped silently', async () => {
  const both = await importCsv(csvOf([['email', 'subject', 'body', 'expected'], ['someone@example.com', 'T-q1', 'Please send the tax invoice', 'Invoice Request']]), 'measure');
  assert.equal(both.json.added, 1);
  assert.equal((await tests()).find((t) => t.subject === 'T-q1').body, 'Please send the tax invoice', 'the body column is the email text, not the sender address');
  const onlyEmail = await importCsv(csvOf([['email', 'expected'], ['T-q1b please send the tax invoice', 'Invoice Request']]), 'measure');
  assert.equal(onlyEmail.json.added, 1, 'a file whose only text column is called "email" still works');

  const prio = await importCsv(csvOf([['subject', 'body', 'expected', 'priority'], ['T-q2', 'text for the priority check', 'Invoice Request', 'urgent'], ['T-q2b', 'another one', 'Invoice Request', 'High']]), 'measure');
  assert.equal(prio.json.added, 2);
  assert.equal(prio.json.warnings.length, 1);
  assert.match(prio.json.warnings[0], /Row 2: priority "urgent"/, 'a priority that is not understood is reported, not silently dropped');
  assert.equal((await tests()).find((t) => t.subject === 'T-q2').expected_priority, null);

  const open = await importCsv('subject,body,expected\nT-q3,"never closed,Invoice Request\nT-q4,second,Invoice Request', 'measure');
  assert.equal(open.status, 400);
  assert.match(open.json.error, /never closed/);
  assert.match(open.json.error, /row 2/);
  assert.equal((await tests()).filter((t) => /^T-q[34]/.test(t.subject)).length, 0, 'nothing is imported from a file with an open quote');
  await removeWhere((t) => /^T-q/.test(t.subject));
});

test('copying held-out emails into the training set does not inflate the independent score', async () => {
  const before = (await lab('POST', '/run', { body: { engine: 'smart' } })).json;
  const m0 = await model();
  const copies = [];
  for (const t of (await tests()).filter((x) => x.source === 'independent')) {
    const r = await lab('POST', '/tests', { body: { subject: t.subject, body: t.body, expected_sub_key: t.expected_sub_key } });
    assert.equal(r.status, 201);
    copies.push(r.json.id);
  }
  assert.ok(copies.length >= 60);
  assert.equal((await model()).samples, m0.samples, 'an exact copy of a held-out email is not a training sample');
  const after = (await lab('POST', '/run', { body: { engine: 'smart' } })).json;
  assert.equal(after.by_source.independent.correct, before.by_source.independent.correct, 'so the independent score did not move');
  for (const id of copies) assert.equal((await lab('DELETE', `/tests/${id}`)).status, 200);
});

test('corrections: more than 200 of them are all counted, and the rate cannot pass 100', async () => {
  const cases = (await main.call('GET', '/helpdesk/cases?tab=all&limit=20')).json.data.slice(0, 5);
  const before = (await lab('GET', '/feedback?days=30')).json;
  const db = new Database(mainDb);
  const ins = db.prepare("INSERT INTO hd_audit (case_id, actor_type, actor_name, action, field, old_value, new_value) VALUES (?, 'user', 'Test', 'override', 'sub_key', 'invoice_request', 'refund_request')");
  db.transaction(() => { for (let i = 0; i < 250; i++) ins.run(cases[i % cases.length].id); })();
  db.close();
  const after = (await lab('GET', '/feedback?days=30')).json;
  assert.equal(after.overrides, before.overrides + 250, 'every correction is counted, not just the 200 that are listed');
  assert.equal(after.data.length, 200);
  assert.equal(after.shown, 200);
  assert.ok(after.by_field.sub_key >= 250);
  assert.ok(after.confused_pairs.some((p) => p.from === 'invoice_request' && p.to === 'refund_request' && p.count >= 250));
  assert.ok(after.override_rate >= 0 && after.override_rate <= 100, `override rate ${after.override_rate}`);
  assert.equal((await lab('GET', '/feedback?days=1')).json.overrides >= 250, true);
});

test('client mistakes are 4xx answers, never 500', async () => {
  const raw = (method, route, body) => fetch(`${main.base}${route}`, { method, headers: { authorization: `Bearer ${main.tokens.admin}`, 'content-type': 'application/json' }, body });
  const badJson = await raw('POST', '/helpdesk/lab/classify', '{not json');
  assert.equal(badJson.status, 400);
  assert.match((await badJson.json()).error, /not valid JSON/);
  assert.equal((await raw('POST', '/helpdesk/lab/classify', JSON.stringify({ subject: 'x', body: 'y'.repeat(3 * 1024 * 1024) }))).status, 413);
  assert.equal((await raw('GET', '/helpdesk/lab/runs/%')).status, 400);
  assert.equal((await raw('DELETE', '/helpdesk/lab/tests/%')).status, 400);
  assert.equal((await raw('GET', '/helpdesk/lab/runs/%E0%A4%A')).status, 400);
  assert.ok(await healthy());
});

/* ------------------------------------------------------------------------------------------ limits, last because they leave a lot behind */
test('limits: only the first 1,000 rows of a file are read; an empty test set cannot be run and can be restored', async () => {
  const rows = [['subject', 'body', 'expected'], ...Array.from({ length: 1005 }, (_, i) => [`T-big ${i}`, `invoice request number ${i}`, 'Invoice Request'])];
  const r = await importCsv(csvOf(rows), 'measure');
  assert.equal(r.status, 200);
  assert.equal(r.json.added, 1000, 'the 1,001st row onwards is not read');
  assert.equal(r.json.truncated, 5);
  assert.match(r.json.warnings.join(' '), /first 1,000 rows were read; 5 more were not imported/, 'and the person importing is told');
  assert.equal((await tests()).filter((t) => t.subject.startsWith('T-big ')).length, 1000);

  // a run over a large test set is slow, but other requests are served between its batches: it used to freeze the whole server
  const long = lab('POST', '/run', { body: { engine: 'smart' } });
  let worst = 0;
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    await fetch(`${main.base}/health`);
    worst = Math.max(worst, Date.now() - t0);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal((await long).status, 201);
  assert.ok(worst < 400, `other requests waited up to ${worst} ms while a run was going`);

  for (const t of await tests()) await lab('DELETE', `/tests/${t.id}`);
  assert.equal((await lab('GET', '/tests')).json.total, 0);
  const empty = await lab('POST', '/run', { body: { engine: 'smart' } });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /empty/);
  assert.equal((await lab('POST', '/model/retrain', { body: {} })).status, 200, 'retraining with no samples still works');
  const back = await lab('POST', '/tests/reset', { body: {} });
  assert.ok(back.json.restored >= 160);
  assert.equal((await lab('POST', '/run', { body: { engine: 'smart' } })).status, 201, 'and a run works again after the restore');
});
