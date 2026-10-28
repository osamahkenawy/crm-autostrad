// End-to-end check of the helpdesk API on a throw-away database: seed it, start the server, then walk a
// case through the pipeline (new email, draft, approval rules, override, customer reply, closure).
// Runs without the Anthropic API or Microsoft Graph, whatever the environment says.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autostrad-hd-'));
const PORT = 4300 + Math.floor(Math.random() * 600);
const base = `http://127.0.0.1:${PORT}/api`;
const env = { ...process.env, ARC_DB_PATH: path.join(dir, 'test.db'), API_PORT: String(PORT), HELPDESK_SCHEDULER: 'off', ARC_SKIP_ENV_FILE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'HELPDESK_PROVIDER', 'HELPDESK_SEND_MODE', 'HELPDESK_LLM_MODE', 'HELPDESK_MAILBOX']) delete env[k];

let server;
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
  server = spawn(process.execPath, ['src/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  const users = { it: 'it@autostrad.ae', admin: 'admin@autostrad.ae', operations: 'khalid@autostrad.ae', finance: 'mariam@autostrad.ae', cs: 'noor@autostrad.ae' };
  for (const [role, email] of Object.entries(users)) {
    const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'autostrad123' }) });
    tokens[role] = (await r.json()).token;
    assert.ok(tokens[role], `could not sign in as ${role}`);
  }
});

after(async () => {
  // Windows cannot delete the database while the server still has it open, so wait for the server to exit first.
  if (server && server.exitCode === null && server.signalCode === null) await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  fs.rmSync(dir, { recursive: true, force: true });
});

const pendingDrafts = async () => {
  const list = (await api('GET', '/helpdesk/cases?tab=drafts&limit=200')).json.data;
  const out = [];
  for (const c of list) {
    const d = (await api('GET', `/helpdesk/cases/${c.id}`)).json;
    const draft = d.drafts.find((x) => x.status === 'pending');
    if (draft) out.push({ c: d, draft });
  }
  return out;
};

test('the helpdesk needs a signed-in user', async () => {
  assert.equal((await api('GET', '/helpdesk/summary', { as: null })).status, 401);
});

test('seeded data: dashboard, case list and tab counts agree', async () => {
  const dash = (await api('GET', '/helpdesk/dashboard')).json;
  assert.ok(dash.totals.open > 0 && dash.refresh_minutes === 15);
  assert.equal(dash.top_issues.length, 5);
  assert.deepEqual(dash.aging.map((a) => a.bucket).length, 3);
  assert.ok(dash.channels.some((c) => c.channel === 'Email' && c.connected));
  const counts = (await api('GET', '/helpdesk/cases/counts')).json;
  const all = (await api('GET', '/helpdesk/cases?tab=all&limit=1')).json;
  assert.equal(counts.all, all.total);
  assert.equal(counts.active + counts.closed, counts.all);
  const summary = (await api('GET', '/helpdesk/summary')).json;
  assert.equal(summary.open, counts.active);
});

test('new emails become cases with a classification, an owner, a due time and a draft', async () => {
  const before = (await api('GET', '/helpdesk/cases/counts')).json.all;
  const sync = (await api('POST', '/helpdesk/mailbox/demo/emails', { body: { count: 3, sub_key: 'unrecognized_charge', lang: 'en' } })).json;
  // two of the three may land on a contract that already has an open case of this type: those join it instead
  assert.equal(sync.created + sync.attached, 3, JSON.stringify(sync));
  const made = sync.items.filter((i) => i.action === 'created');
  assert.ok(made.length >= 1);
  assert.equal((await api('GET', '/helpdesk/cases/counts')).json.all, before + made.length);
  for (const it of made) {
    const d = (await api('GET', `/helpdesk/cases/${it.caseId}`)).json;
    assert.equal(d.status, 'open');
    assert.ok(d.sub_key && d.category && d.owner_id && d.due_at, 'classified, routed and given a due time');
    assert.ok(d.audit.some((a) => a.action === 'classified'));
    assert.ok(d.drafts.some((x) => x.status === 'pending'), 'a draft is waiting for review');
  }
});

test('a reply to a sensitive financial request needs a finance, admin or IT approver', async () => {
  const found = (await pendingDrafts()).find((x) => x.draft.sensitive && !x.draft.incomplete);
  assert.ok(found, 'no sensitive pending draft in the seed');
  const denied = await api('POST', `/helpdesk/drafts/${found.draft.id}/approve`, { as: 'cs', body: {} });
  assert.equal(denied.status, 400);
  assert.match(denied.json.error, /sensitive/i);
  const stillPending = (await api('GET', `/helpdesk/cases/${found.c.id}`)).json;
  assert.equal(stillPending.drafts.find((d) => d.id === found.draft.id).status, 'pending');

  const ok = await api('POST', `/helpdesk/drafts/${found.draft.id}/approve`, { as: 'finance', body: {} });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.mode, 'send_after_approval');
  assert.equal(ok.json.case.status, 'pending_customer');
  assert.ok(ok.json.case.messages.some((m) => m.direction === 'out'));
  assert.ok(ok.json.case.audit.some((a) => a.action === 'draft_approved'));
  assert.ok(ok.json.case.next_followup_at, 'the first reminder is scheduled');
});

test('editing a draft is recorded and unfilled [[placeholders]] block sending', async () => {
  const found = (await pendingDrafts()).find((x) => !x.draft.sensitive);
  assert.ok(found);
  const edited = await api('PATCH', `/helpdesk/drafts/${found.draft.id}`, { body: { body: `${found.draft.body}\n\nPS: [[attach the statement]]` } });
  assert.equal(edited.status, 200);
  const d = edited.json.drafts.find((x) => x.id === found.draft.id);
  assert.equal(d.edited, 1);
  assert.equal(d.incomplete, 1);
  const blocked = await api('POST', `/helpdesk/drafts/${found.draft.id}/approve`, { as: 'cs', body: {} });
  assert.equal(blocked.status, 400);
  assert.match(blocked.json.error, /placeholders/);
  const fixed = await api('POST', `/helpdesk/drafts/${found.draft.id}/approve`, { as: 'cs', body: { body: found.draft.body } });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
});

test('staff corrections are logged as overrides and change the due time', async () => {
  const c = (await api('GET', '/helpdesk/cases?tab=action&limit=50')).json.data.find((x) => x.priority !== 'Critical' && x.classified_by);
  assert.ok(c);
  const r = await api('PATCH', `/helpdesk/cases/${c.id}`, { as: 'operations', body: { priority: 'Critical', reason: 'Customer called the manager' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.priority, 'Critical');
  const ov = r.json.audit.find((a) => a.action === 'override' && a.field === 'priority');
  assert.ok(ov && ov.new_value === 'Critical' && ov.actor_name === 'Khalid Al Mansoori');
  assert.notEqual(r.json.due_at, c.due_at);
  assert.equal((await api('PATCH', `/helpdesk/cases/${c.id}`, { body: { priority: 'Urgent' } })).status, 400);
});

test('a customer reply restarts the clock; closing needs a reason and a closed case can be reopened', async () => {
  const waiting = (await api('GET', '/helpdesk/cases?tab=pending_customer&sort=first_received_at&dir=asc&limit=1')).json.data[0];
  assert.ok(waiting);
  const sync = (await api('POST', '/helpdesk/mailbox/demo/reply', { body: { case_id: waiting.id, text: 'Thank you, that is resolved now.' } })).json;
  assert.equal(sync.attached, 1, JSON.stringify(sync));
  const d = (await api('GET', `/helpdesk/cases/${waiting.id}`)).json;
  assert.equal(d.status, 'open');
  assert.ok(d.suggest_close, 'a thank-you reply suggests closing');
  assert.notEqual(d.due_at, waiting.due_at);

  assert.equal((await api('POST', `/helpdesk/cases/${waiting.id}/close`, { body: {} })).status, 400);
  const closed = await api('POST', `/helpdesk/cases/${waiting.id}/close`, { body: { reason: 'customer_confirmed', note: 'Customer confirmed' } });
  assert.equal(closed.json.status, 'closed');
  assert.equal(closed.json.closure_reason, 'customer_confirmed');
  const reopened = await api('POST', `/helpdesk/cases/${waiting.id}/reopen`, { body: {} });
  assert.equal(reopened.json.status, 'open');
  assert.equal(reopened.json.reopened_count, 1);
});

test('out-of-office replies and bounces do not reopen or restart a case', async () => {
  const waiting = (await api('GET', '/helpdesk/cases?tab=pending_customer&sort=first_received_at&dir=asc&limit=1')).json.data[0];
  assert.ok(waiting);
  const before = (await api('GET', `/helpdesk/cases/${waiting.id}`)).json;
  const sync = (await api('POST', '/helpdesk/mailbox/demo/reply', { body: { case_id: waiting.id, subject: `Automatic reply: Re: ${waiting.subject}`, text: 'I am out of the office until Monday with limited access to email.' } })).json;
  assert.equal(sync.attached, 1);
  const after = (await api('GET', `/helpdesk/cases/${waiting.id}`)).json;
  assert.equal(after.status, 'pending_customer');
  assert.equal(after.due_at, before.due_at);
  assert.equal(after.messages.length, before.messages.length + 1, 'the message is kept in the conversation');
  assert.ok(after.audit.some((a) => a.action === 'auto_reply_ignored'));
});

test('reply wording: staff cannot edit it, a reworded template must be approved again', async () => {
  const tpl = (await api('GET', '/helpdesk/templates?sub_key=invoice_request&kind=initial&language=en')).json.data[0];
  assert.ok(tpl && tpl.approved === 1);
  assert.equal((await api('PUT', `/helpdesk/templates/${tpl.id}`, { as: 'cs', body: { body: 'x' } })).status, 403);
  const reworded = await api('PUT', `/helpdesk/templates/${tpl.id}`, { as: 'admin', body: { body: `${tpl.body}\n\nKind regards` } });
  assert.equal(reworded.json.approved, 0, 'new wording is not live until someone approves it');
  const approved = await api('PUT', `/helpdesk/templates/${tpl.id}`, { as: 'admin', body: { approved: 1 } });
  assert.equal(approved.json.approved, 1);
  assert.ok(approved.json.approved_by && approved.json.approved_at);
});

test('timing rules can be changed by admin and IT, the mailbox and AI switches by IT only, and every change is audited', async () => {
  for (const who of ['cs', 'operations', 'finance']) {
    assert.equal((await api('GET', '/helpdesk/settings', { as: who })).status, 403, who);
    assert.equal((await api('PUT', '/helpdesk/settings', { as: who, body: { autoclose_days: 9 } })).status, 403, who);
  }
  const r = await api('PUT', '/helpdesk/settings', { as: 'admin', body: { autoclose_days: 9, sla_hours: { Critical: 2, High: 24, Average: 48, Low: 72 } } });
  assert.deepEqual(r.json.changed.sort(), ['autoclose_days', 'sla_hours']);
  const system = await api('PUT', '/helpdesk/settings', { as: 'admin', body: { outlook_writeback: false } });
  assert.equal(system.status, 403);
  assert.match(system.json.error, /Only IT/);
  assert.equal((await api('GET', '/helpdesk/settings', { as: 'admin' })).json.can_change_system, false);
  const it = await api('PUT', '/helpdesk/settings', { as: 'it', body: { outlook_writeback: false } });
  assert.deepEqual(it.json.changed, ['outlook_writeback']);
  assert.equal((await api('GET', '/helpdesk/settings', { as: 'it' })).json.can_change_system, true);
  const log = (await api('GET', '/helpdesk/audit?action=setting_changed')).json;
  assert.ok(log.data.length >= 3);
  await api('PUT', '/helpdesk/settings', { as: 'it', body: { outlook_writeback: true, autoclose_days: 7, sla_hours: { Critical: 4, High: 24, Average: 48, Low: 72 } } });
});

test('daily and weekly reports can be generated and read back', async () => {
  const made = await api('POST', '/helpdesk/reports/generate', { body: { kind: 'daily' } });
  assert.equal(made.status, 201);
  assert.ok(made.json.summary.length > 20);
  const got = await api('GET', `/helpdesk/reports/${made.json.id}`);
  assert.equal(got.json.kind, 'daily');
  assert.ok(got.json.data.new_cases >= 0);
  assert.ok((await api('GET', '/helpdesk/reports?kind=weekly')).json.data.length >= 1);
});

test('AI lab: try an email, run the test set, see staff corrections (admin and IT only)', async () => {
  for (const who of ['cs', 'operations', 'finance']) assert.equal((await api('POST', '/helpdesk/lab/classify', { as: who, body: { body: 'x' } })).status, 403, who);
  const t = await api('POST', '/helpdesk/lab/classify', { as: 'admin', body: { subject: 'Hold on my card', body: 'The AED 2,000 pre-authorization is still on my card since I returned the car 10 days ago. Contract AST-100123.' } });
  assert.equal(t.json.sub_key, 'preauth_followup');
  assert.equal(t.json.entities.contract_no, 'AST-100123');
  assert.equal(t.json.engine, 'rules+model');
  assert.ok(t.json.learned && t.json.learned.top.length === 3, 'the learned model gives its own opinion');
  const rules = await api('POST', '/helpdesk/lab/run', { body: { engine: 'rules' } });
  const run = await api('POST', '/helpdesk/lab/run', { body: { engine: 'smart' } });
  assert.equal(run.status, 201);
  assert.ok(run.json.total >= 100 && run.json.accuracy >= 60, `accuracy ${run.json.accuracy}`);
  assert.ok(run.json.by_source.independent.total >= 60, 'the independent emails are measured separately');
  assert.ok(run.json.by_source.independent.accuracy >= rules.json.by_source.independent.accuracy, 'the learned model does not make the independent score worse');
  assert.ok(run.json.confident_total >= 0 && 'confident_accuracy' in run.json);
  assert.equal((await api('POST', '/helpdesk/lab/run', { body: { engine: 'ai' } })).status, 400, 'the AI run needs an API key');
  const fb = (await api('GET', '/helpdesk/lab/feedback?days=90')).json;
  assert.ok(fb.classified > 0 && fb.overrides >= 1);
  const imported = await api('POST', '/helpdesk/lab/tests/import', { body: { csv: 'subject,body,expected,priority\n"Invoice, please","Send the tax invoice for contract AST-100200",Invoice Request,Low\n"x","y",Not a type,' } });
  assert.equal(imported.json.added, 1);
  assert.equal(imported.json.skipped, 1);
});

test('the audit log can be searched by case', async () => {
  const c = (await api('GET', '/helpdesk/cases?limit=1')).json.data[0];
  const log = (await api('GET', `/helpdesk/audit?case_id=${c.id}`)).json;
  assert.ok(log.total >= 4 && log.data.every((a) => a.case_id === c.id));
});

test('card numbers in a subject line are masked before the case is stored', async () => {
  const sent = await api('POST', '/helpdesk/samples/send', { body: { subject: 'Charge on card 4111 1111 1111 1111', body: 'I do not recognise this charge on my card.' } });
  assert.equal(sent.status, 201);
  const c = (await api('GET', `/helpdesk/cases/${sent.json.case_id}`)).json;
  assert.ok(!/4111 1111 1111 1111/.test(c.subject) && /\*\*\*\* 1111/.test(c.subject), c.subject);
  assert.ok(c.messages.every((m) => !/4111 1111 1111 1111/.test(m.subject || '')));
});

test('sample emails: pick one, send it, and watch it become a case with a draft', async () => {
  const list = (await api('GET', '/helpdesk/samples')).json;
  assert.ok(list.can_send && list.data.length >= 40);
  const sample = list.data.find((x) => x.sub_key === 'invoice_request');
  const sent = await api('POST', '/helpdesk/samples/send', { as: 'cs', body: { sample_id: sample.id } });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  // a random customer may already have an open invoice request on the same contract: then the email joins that case
  assert.ok(['created', 'attached'].includes(sent.json.action), sent.json.action);
  const c = (await api('GET', `/helpdesk/cases/${sent.json.case_id}`)).json;
  assert.equal(c.sub_key, 'invoice_request');
  assert.ok(c.contract, 'the sample was given the sender\'s real contract number');
  if (sent.json.action === 'created') assert.ok(c.drafts.some((d) => d.status === 'pending'));
  const own = await api('POST', '/helpdesk/samples/send', { body: { subject: 'Where is my deposit', body: 'My security deposit has not been refunded since I returned the car three weeks ago.' } });
  assert.equal(own.status, 201);
  assert.equal((await api('GET', `/helpdesk/cases/${own.json.case_id}`)).json.sub_key, 'deposit_refund');
  assert.equal((await api('POST', '/helpdesk/samples/send', { body: { body: '  ' } })).status, 400);
});

test('a case shows what to look at, similar past cases and internal notes', async () => {
  const withContract = (await api('GET', '/helpdesk/cases?tab=all&limit=60')).json.data.find((x) => x.contract_no && x.sub_key === 'deposit_refund');
  assert.ok(withContract);
  const d = (await api('GET', `/helpdesk/cases/${withContract.id}`)).json;
  assert.ok(Array.isArray(d.insights) && d.insights.length > 0 && d.insights.every((i) => i.title && ['danger', 'warn', 'info', 'ok'].includes(i.tone)));
  assert.ok(Array.isArray(d.similar));
  assert.equal((await api('POST', `/helpdesk/cases/${d.id}/notes`, { body: { body: ' ' } })).status, 400);
  const noted = await api('POST', `/helpdesk/cases/${d.id}/notes`, { as: 'cs', body: { body: 'Called Accounts, refund goes out on Thursday.' } });
  assert.equal(noted.status, 201);
  assert.equal(noted.json.notes.length, 1);
  assert.equal(noted.json.notes[0].user_name, 'Noor Al Hashimi');
  assert.ok(noted.json.audit.some((a) => a.action === 'note_added'));
});

test('summary, readiness checklist and the learned model', async () => {
  const sum = (await api('GET', '/helpdesk/summary')).json;
  assert.ok(sum.total > 100 && sum.latest_case_id > 0 && sum.sync_minutes === 2 && sum.provider === 'demo');
  const mb = (await api('GET', '/helpdesk/mailbox')).json;
  assert.ok(mb.last_sync.ok_at && mb.last_sync.at, 'the last successful read of the mailbox is recorded');
  const ready = (await api('GET', '/helpdesk/readiness')).json;
  assert.equal(ready.total, ready.items.length);
  assert.ok(ready.items.find((i) => i.key === 'mailbox').state === 'todo', 'the demo mailbox is not the real connection');
  assert.ok(ready.items.find((i) => i.key === 'ai').state === 'optional');
  const model = (await api('GET', '/helpdesk/lab/model', { as: 'admin' })).json;
  assert.ok(model.docs > 500 && model.keywords > 300 && model.features > 1000);
  const tests = (await api('GET', '/helpdesk/lab/tests', { as: 'admin' })).json.data;
  assert.equal(model.samples, tests.filter((t) => !['independent', 'imported'].includes(t.source)).length, 'emails kept for measuring are never trained on');
  assert.ok(tests.some((t) => t.source === 'imported'), 'the imported email kept for measuring is in the test set');
  const again = await api('POST', '/helpdesk/lab/model/retrain', { as: 'admin', body: {} });
  assert.equal(again.status, 200);
  assert.equal(again.json.docs, model.docs + (again.json.closed - model.closed) + (again.json.corrected - model.corrected));
});
