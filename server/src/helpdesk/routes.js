// The helpdesk API, mounted at /api/helpdesk behind the CRM sign-in. Roles are enforced here, not just
// in the screens (who may do what: server/src/roles.js): setup, wording and the AI lab are for admin and IT, the mailbox
// switches are for IT only, and replies to sensitive financial requests need a finance, admin or IT approver.
import { Router } from 'express';
import { db } from '../db.js';
import { crudRouter } from '../crud.js';
import { audit } from './audit.js';
import { addNote, closeCase, getCaseDetail, getCaseRow, listCases, reopenCase, setStatus, tabCounts, updateCase } from './cases.js';
import { approveDraft, createDraft, discardDraft, getDraft, SENSITIVE_APPROVER_ROLES, updateDraft } from './drafts.js';
import { redraftIfUntouched, refreshCase, verifySender } from './systems/actions.js';
import { accountMode, loadConfig, sourceRuntime } from './systems/config.js';
import { systemsStatus, testLookup } from './systems/status.js';
import { can } from '../roles.js';
import { dashboard } from './metrics.js';
import { invalidateDictionary } from './knowledge.js';
import { getProvider, lastSync, syncMailbox } from './mail/index.js';
import { queueCustomerReply, queueNewEmails, queueSampleEmail } from './mail/demo.js';
import { modelInfo } from './learner.js';
import { generateReport, getReport, listReports } from './reports.js';
import { DEFAULTS, getSettings, lockedSettings, setSettings } from './settings.js';
import { CLOSURE_REASONS, DEPARTMENTS, SUBCATEGORIES, SUB_BY_KEY } from './taxonomy.js';
import { TEMPLATE_VARIABLES } from './templates.defaults.js';
import { diagnoseGraph } from './mail/diagnose.js';
import { graphConfigured, missingGraphEnv } from './mail/graph.js';
import { llmConfigured, llmHealth, classifyModel } from './llm.js';
import labRouter from './lab.js';
import { nowUtc } from './routing.js';

export const helpdeskRouter = Router();

const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message || 'Something went wrong' }); } };
const deny = (res, msg = 'Your role cannot do this.') => res.status(403).json({ error: msg });
/** Needs one helpdesk ability (see roles.js): helpdesk.view, .work, .lab, .setup, .rules, .system, .approve_sensitive */
const needCap = (cap, msg) => (req, res, next) => (can(req.me.role, cap) ? next() : deny(res, msg));
/** Reading needs `read`, changing needs `write`. */
const readWrite = (read, write, msg) => (req, res, next) => (can(req.me.role, req.method === 'GET' ? read : write) ? next() : deny(res, msg));

// the full user (name, department) behind the token
helpdeskRouter.use((req, res, next) => {
  const me = db.prepare("SELECT id, name, email, role, department, branch_id FROM users WHERE id = ? AND status = 'active'").get(req.user.id);
  if (!me) return res.status(401).json({ error: 'Session expired' });
  if (!can(me.role, 'helpdesk.view')) return deny(res, 'Your role has no access to the helpdesk.');
  req.me = me;
  next();
});

/* ---------------------------------------------------------------- numbers */
helpdeskRouter.get('/summary', wrap((req, res) => {
  const q = (sql, ...p) => db.prepare(sql).get(...p).n;
  res.json({
    open: q("SELECT COUNT(*) n FROM hd_cases WHERE status <> 'closed'"),
    overdue: q("SELECT COUNT(*) n FROM hd_cases WHERE status IN ('open','pending_internal') AND due_at < datetime('now')"),
    needs_triage: q("SELECT COUNT(*) n FROM hd_cases WHERE status <> 'closed' AND needs_review = 1"),
    drafts_pending: q("SELECT COUNT(*) n FROM hd_drafts d JOIN hd_cases c ON c.id = d.case_id WHERE d.status = 'pending' AND c.status <> 'closed'"),
    mine: q("SELECT COUNT(*) n FROM hd_cases WHERE status <> 'closed' AND owner_id = ?", req.me.id),
    mine_overdue: q("SELECT COUNT(*) n FROM hd_cases WHERE status IN ('open','pending_internal') AND due_at < datetime('now') AND owner_id = ?", req.me.id),
    escalated: q("SELECT COUNT(*) n FROM hd_cases WHERE status <> 'closed' AND escalation_level > 0"),
    total: q('SELECT COUNT(*) n FROM hd_cases'),
    latest_case_id: q('SELECT COALESCE(MAX(id), 0) n FROM hd_cases'),
    last_checked_at: lastSync().at,
    sync_minutes: getSettings().sync_minutes,
    provider: getSettings().provider,
  });
}));

helpdeskRouter.get('/dashboard', wrap((req, res) => res.json(dashboard({ days: Math.min(180, Math.max(1, Number(req.query.days) || 30)) }))));

helpdeskRouter.get('/meta', wrap((_req, res) => res.json({
  subcategories: SUBCATEGORIES.map(({ key, name, category, impact, department, sensitive, top5 }) => ({ key, name, category, impact, department, sensitive: Boolean(sensitive), top5: Boolean(top5) })),
  departments: DEPARTMENTS, closure_reasons: CLOSURE_REASONS, template_variables: TEMPLATE_VARIABLES,
  send_mode: getSettings().send_mode, provider: getSettings().provider, sla_hours: getSettings().sla_hours, sensitive_approver_roles: SENSITIVE_APPROVER_ROLES,
  people: db.prepare("SELECT id, name, role, department FROM users WHERE status = 'active' ORDER BY name").all(),
})));

/* ---------------------------------------------------------------- cases */
helpdeskRouter.get('/cases', wrap((req, res) => res.json(listCases(req.query, req.me))));
helpdeskRouter.get('/cases/counts', wrap((req, res) => res.json(tabCounts(req.query, req.me))));
helpdeskRouter.get('/cases/:id', wrap((req, res) => {
  const c = getCaseDetail(Number(req.params.id), req.me);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  res.json(c);
}));

helpdeskRouter.patch('/cases/:id', wrap(async (req, res) => {
  const before = getCaseRow(Number(req.params.id));
  const c = updateCase(Number(req.params.id), req.body || {}, req.me);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  // a different contract number or sender address means different customer facts: ask again, and rewrite an untouched draft with them
  if (before && (before.contract_no !== c.contract_no || before.customer_email !== c.customer_email)) {
    const { changed } = await refreshCase(c.id, { user: req.me, bypassCache: true });
    if (!changed) await redraftIfUntouched(c.id); // a new contract or a new address: a draft nobody touched was written for the old one
  }
  res.json(getCaseDetail(c.id, req.me));
}));
helpdeskRouter.post('/cases/:id/account/refresh', needCap('helpdesk.work'), wrap(async (req, res) => {
  const c = getCaseRow(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Case not found' });
  await refreshCase(c.id, { user: req.me, bypassCache: true });
  res.json(getCaseDetail(c.id, req.me));
}));
helpdeskRouter.post('/cases/:id/account/verify', needCap('helpdesk.work'), wrap(async (req, res) => {
  const c = getCaseRow(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Case not found' });
  await verifySender(c.id, req.me);
  res.json(getCaseDetail(c.id, req.me));
}));
helpdeskRouter.post('/cases/:id/status', wrap((req, res) => {
  const c = setStatus(Number(req.params.id), req.body && req.body.status, req.me);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  res.json(getCaseDetail(c.id, req.me));
}));
helpdeskRouter.post('/cases/:id/close', wrap((req, res) => {
  const c = closeCase(Number(req.params.id), req.body || {}, req.me);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  res.json(getCaseDetail(c.id, req.me));
}));
helpdeskRouter.post('/cases/:id/reopen', wrap((req, res) => {
  const c = reopenCase(Number(req.params.id), req.me);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  res.json(getCaseDetail(c.id, req.me));
}));
helpdeskRouter.post('/cases/:id/escalate', wrap((req, res) => {
  const c = getCaseRow(Number(req.params.id));
  if (!c || c.status === 'closed') return res.status(404).json({ error: 'Case not found or already closed' });
  const level = Math.min(3, c.escalation_level + 1);
  db.prepare('UPDATE hd_cases SET escalation_level = ?, escalated_at = ?, updated_at = ? WHERE id = ?').run(level, nowUtc(), nowUtc(), c.id);
  audit({ caseId: c.id, actor: req.me, action: 'escalated', oldValue: String(c.escalation_level), newValue: String(level), detail: req.body && req.body.note ? String(req.body.note).slice(0, 300) : 'Escalated by staff' });
  res.json(getCaseDetail(c.id, req.me));
}));

helpdeskRouter.post('/cases/:id/notes', wrap((req, res) => {
  const c = addNote(Number(req.params.id), req.body && req.body.body, req.me);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  res.status(201).json(getCaseDetail(c.id, req.me));
}));

/* ---------------------------------------------------------------- sample emails (demo mailbox) */
helpdeskRouter.get('/samples', wrap((req, res) => {
  const where = ["source <> 'independent'"];
  const p = [];
  if (req.query.type) { where.push('expected_sub_key = ?'); p.push(req.query.type); }
  if (req.query.lang) { where.push('language = ?'); p.push(req.query.lang); }
  if (req.query.q) { where.push('(subject LIKE ? OR body LIKE ?)'); p.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const data = db.prepare(`SELECT id, subject, body, expected_sub_key AS sub_key, language FROM hd_test_cases WHERE ${where.join(' AND ')} ORDER BY expected_sub_key, id LIMIT 300`).all(...p);
  res.json({ data, total: data.length, can_send: getSettings().provider === 'demo' });
}));
helpdeskRouter.post('/samples/send', wrap(async (req, res) => {
  if (getSettings().provider !== 'demo') throw new Error('Sample emails go through the demo mailbox. With Outlook connected, send a real test email to the support address and it appears here by itself.');
  const b = req.body || {};
  let { subject, body } = b;
  if (b.sample_id) {
    const t = db.prepare("SELECT subject, body FROM hd_test_cases WHERE id = ? AND source <> 'independent'").get(Number(b.sample_id));
    if (!t) return res.status(404).json({ error: 'Sample not found' });
    subject = t.subject; body = t.body;
  }
  if (!String(body || '').trim()) throw new Error('Write the email first.');
  const { providerId, customer } = queueSampleEmail({ subject: String(subject || '').slice(0, 300), body: String(body).slice(0, 20000), customerId: b.customer_id });
  let sync = await syncMailbox();
  let item = (sync.items || []).find((i) => i.providerId === providerId);
  if (!item) { sync = await syncMailbox(); item = (sync.items || []).find((i) => i.providerId === providerId); }
  if (!item) throw new Error('The email is in the demo mailbox but was not processed. Press "Check the mailbox now".');
  res.status(201).json({ case_id: item.caseId, case_no: item.caseNo, action: item.action, from: customer.name, errors: sync.errors });
}));

/* ---------------------------------------------------------------- is everything ready? */
/** The readiness line for the contract, customer and invoice systems. */
function customerData() {
  const base = { key: 'customer_data', title: 'Connect the contract, customer and invoice systems', link: '/helpdesk/setup?tab=customer' };
  if (accountMode() !== 'api') return { ...base, state: 'todo', detail: "Replies and the case screen use the CRM's own demo records. Connect Orion Fleet and the CNR Portal (or whichever systems hold the real contracts, customers and invoices) so they use the real ones." };
  const cfg = loadConfig();
  if (!cfg.exists || !cfg.ok) return { ...base, state: 'todo', detail: cfg.exists ? `The configuration needs fixing: ${cfg.problems[0]}` : 'The customer systems are switched on but the configuration file is missing.' };
  const missing = Object.keys(cfg.config.sources).flatMap((n) => sourceRuntime(n, cfg.config).missing);
  if (missing.length) return { ...base, state: 'todo', detail: `Still missing on the server: ${[...new Set(missing)].join(', ')}.` };
  return { ...base, state: 'done', detail: `Connected: ${Object.values(cfg.config.sources).map((x) => x.label).join(', ')}. Each new email is looked up by the sender and the contract number.` };
}

helpdeskRouter.get('/readiness', wrap(async (_req, res) => {
  const settings = getSettings();
  const st = await getProvider().status().catch(() => ({ connected: false }));
  const approvedByPerson = db.prepare("SELECT COUNT(DISTINCT sub_key) n FROM hd_templates WHERE approved_by IS NOT NULL AND active = 1 AND sub_key IN ('unrecognized_charge','preauth_followup','invoice_request','deposit_refund','vehicle_collection')").get().n;
  const teams = DEPARTMENTS.map((d) => ({ d, n: db.prepare("SELECT COUNT(*) n FROM users WHERE status = 'active' AND department = ?").get(d).n }));
  const empty = teams.filter((t) => ['Customer Happiness', 'Accounts'].includes(t.d) && !t.n).map((t) => t.d);
  const patternsSaved = Boolean(db.prepare("SELECT 1 FROM hd_settings WHERE key = 'contract_patterns'").get());
  const items = [
    { key: 'mailbox', state: settings.provider === 'graph' && st.connected ? 'done' : 'todo', title: 'Connect the Outlook mailbox', link: '/helpdesk/setup',
      detail: settings.provider === 'graph' ? (st.connected ? 'Connected: new emails arrive by themselves.' : st.detail || 'Not connected yet.') : 'You are using the built-in demo mailbox. Connect Outlook so real emails flow in by themselves.' },
    { key: 'wording', state: approvedByPerson >= 5 ? 'done' : 'todo', title: 'Approve the reply wording', link: '/helpdesk/setup?tab=wording',
      detail: approvedByPerson >= 5 ? 'A person has approved the wording for the five first-wave request types.' : 'The sample wording works, but Autostrad should replace it with its own approved text and approve it.' },
    { key: 'contract', state: patternsSaved ? 'done' : 'todo', title: 'Confirm how contract numbers look', link: '/helpdesk/setup?tab=routing',
      detail: patternsSaved ? 'Saved.' : 'The default expects AST-123456. Check it against real emails and the Orion Fleet contract format.' },
    customerData(),
    { key: 'team', state: empty.length ? 'todo' : 'done', title: 'Put staff in their support teams', link: '/team', detail: empty.length ? `No active person in: ${empty.join(', ')}.` : 'Customer Happiness and Accounts both have people.' },
    { key: 'ai', state: llmConfigured() ? 'done' : 'optional', title: 'Switch on the AI (optional)', link: '/helpdesk/setup', detail: llmConfigured() ? 'The AI reads each email and polishes replies.' : 'Works well without it, thanks to the keyword rules and the learned model. The AI adds accuracy on messy emails. Needs an Anthropic key on the server.' },
  ];
  res.json({ items, done: items.filter((i) => i.state === 'done').length, total: items.length, model: modelInfo() });
}));

/* ---------------------------------------------------------------- drafts */
helpdeskRouter.post('/cases/:id/drafts', wrap(async (req, res) => {
  const c = getCaseRow(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Case not found' });
  if (c.status === 'closed') return res.status(400).json({ error: 'Reopen the case before drafting a reply.' });
  const d = await createDraft(c.id, { kind: (req.body && req.body.kind) === 'followup' ? 'followup' : 'initial', user: req.me, templateId: req.body && req.body.template_id ? Number(req.body.template_id) : null });
  if (!d) return res.status(400).json({ error: 'No approved template covers this request type. Approve a template first (Helpdesk setup, Templates).' });
  res.status(201).json(getCaseDetail(c.id, req.me));
}));
helpdeskRouter.patch('/drafts/:id', wrap((req, res) => {
  const d = updateDraft(Number(req.params.id), req.body || {}, req.me);
  res.json(getCaseDetail(d.case_id, req.me));
}));
helpdeskRouter.post('/drafts/:id/approve', wrap(async (req, res) => {
  const d0 = getDraft(Number(req.params.id));
  if (!d0) return res.status(404).json({ error: 'Draft not found' });
  const out = await approveDraft(d0.id, req.me, getProvider(), req.body || {});
  res.json({ mode: out.mode, case: getCaseDetail(d0.case_id, req.me) });
}));
helpdeskRouter.post('/drafts/:id/discard', wrap((req, res) => {
  const d0 = getDraft(Number(req.params.id));
  if (!d0) return res.status(404).json({ error: 'Draft not found' });
  discardDraft(d0.id, req.me, req.body && req.body.reason);
  res.json(getCaseDetail(d0.case_id, req.me));
}));

/* ---------------------------------------------------------------- reports */
helpdeskRouter.get('/reports', wrap((req, res) => res.json({ data: listReports(req.query.kind || null) })));
helpdeskRouter.get('/reports/:id', wrap((req, res) => { const r = getReport(Number(req.params.id)); return r ? res.json(r) : res.status(404).json({ error: 'Report not found' }); }));
helpdeskRouter.post('/reports/generate', needCap('helpdesk.work'), wrap((req, res) => {
  const kind = req.body && req.body.kind === 'weekly' ? 'weekly' : 'daily';
  const r = generateReport(kind, { day: req.body && req.body.day });
  const stored = db.prepare('SELECT id FROM hd_reports WHERE kind = ? AND period_start = ?').get(kind, r.period_start);
  res.status(201).json({ ...r, id: stored && stored.id });
}));

/* ---------------------------------------------------------------- mailbox */
helpdeskRouter.get('/mailbox', wrap(async (_req, res) => {
  const settings = getSettings();
  const status = await getProvider().status().catch((e) => ({ connected: false, detail: e.message }));
  res.json({
    provider: settings.provider, status, last_sync: lastSync(),
    send_mode: settings.send_mode, outlook_writeback: settings.outlook_writeback, sync_minutes: settings.sync_minutes, locked: lockedSettings(),
    graph: { configured: graphConfigured(), missing: missingGraphEnv() },
    ai: { configured: llmConfigured(), mode: settings.llm_mode, model: llmConfigured() ? classifyModel() : null, health: llmHealth },
    counts: { messages: db.prepare('SELECT COUNT(*) n FROM hd_messages').get().n, cases: db.prepare('SELECT COUNT(*) n FROM hd_cases').get().n },
  });
}));
helpdeskRouter.post('/mailbox/sync', wrap(async (_req, res) => res.json(await syncMailbox())));
helpdeskRouter.post('/mailbox/test', needCap('helpdesk.setup'), wrap(async (_req, res) => res.json({ provider: getSettings().provider, steps: await diagnoseGraph() })));
helpdeskRouter.post('/mailbox/demo/emails', needCap('helpdesk.work'), wrap(async (req, res) => {
  if (getSettings().provider !== 'demo') return res.status(400).json({ error: 'Only available with the demo mailbox.' });
  const n = Math.min(10, Math.max(1, Number(req.body && req.body.count) || 3));
  queueNewEmails(n, { subKey: req.body && req.body.sub_key && SUB_BY_KEY[req.body.sub_key] ? req.body.sub_key : null, lang: req.body && ['en', 'ar'].includes(req.body.lang) ? req.body.lang : null });
  res.json(await syncMailbox());
}));
helpdeskRouter.post('/mailbox/demo/reply', needCap('helpdesk.work'), wrap(async (req, res) => {
  if (getSettings().provider !== 'demo') return res.status(400).json({ error: 'Only available with the demo mailbox.' });
  const c = getCaseRow(Number(req.body && req.body.case_id));
  if (!c) return res.status(404).json({ error: 'Case not found' });
  queueCustomerReply(c, { text: req.body && req.body.text, subject: req.body && req.body.subject });
  res.json(await syncMailbox());
}));

/* ---------------------------------------------------------------- customer systems (contract, customer and invoice data) */
helpdeskRouter.get('/systems', needCap('helpdesk.setup'), wrap((_req, res) => res.json(systemsStatus())));
helpdeskRouter.post('/systems/test', needCap('helpdesk.setup'), wrap(async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Error('That is not an email address.');
  // the untouched answers show every field of other people's records: only IT sees them
  audit({ actor: req.me, action: 'systems_test', detail: `Test lookup${email ? ' by e-mail address' : ''}${email && b.contract_no ? ' and' : ''}${b.contract_no ? ' by contract number' : ''}${b.raw && can(req.me.role, 'helpdesk.system') ? ', untouched answers shown' : ''}` });
  res.json(await testLookup({ email: email || null, contractNo: String(b.contract_no || '').trim().slice(0, 60) || null, withRaw: Boolean(b.raw) && can(req.me.role, 'helpdesk.system') }));
}));

/* ---------------------------------------------------------------- settings (admin) */
// the switches that connect the mailbox, turn the AI on and decide whether replies are sent: IT only
const SYSTEM_KEYS = ['provider', 'mailbox', 'send_mode', 'outlook_writeback', 'llm_mode', 'llm_fallback_threshold', 'draft_llm_personalize', 'sync_minutes'];
helpdeskRouter.get('/settings', needCap('helpdesk.setup'), wrap((req, res) => res.json({ values: getSettings(), defaults: DEFAULTS, locked: lockedSettings(), can_change_system: can(req.me.role, 'helpdesk.system') })));
helpdeskRouter.put('/settings', needCap('helpdesk.rules'), wrap((req, res) => {
  const body = { ...(req.body || {}) };
  for (const k of lockedSettings()) delete body[k];
  if (!can(req.me.role, 'helpdesk.system') && SYSTEM_KEYS.some((k) => k in body)) return deny(res, 'Only IT can change the mailbox, AI and sending switches.');
  if (body.send_mode && !['draft_only', 'send_after_approval'].includes(body.send_mode)) throw new Error('Unknown send mode.');
  const before = getSettings();
  const changed = setSettings(body);
  for (const k of changed) audit({ actor: req.me, action: 'setting_changed', field: k, oldValue: JSON.stringify(before[k]), newValue: JSON.stringify(body[k]) });
  res.json({ values: getSettings(), changed });
}));

/* ---------------------------------------------------------------- templates, keywords, routing, channel counts */
const guarded = [readWrite('helpdesk.setup', 'helpdesk.rules', 'Only IT and admin users can change this.')];

helpdeskRouter.use('/templates', ...guarded, crudRouter({
  table: 'hd_templates',
  columns: ['sub_key', 'kind', 'language', 'name', 'subject', 'body', 'approved', 'active', 'note'],
  searchable: ['t.name', 't.body', 't.sub_key'],
  orderBy: 't.sub_key ASC, t.kind ASC, t.language ASC',
  beforeWrite: (body, op, _raw, req) => {
    const prev = op === 'update' ? db.prepare('SELECT * FROM hd_templates WHERE id = ?').get(req.params.id) : null;
    // new or reworded text must be approved (again) as its own step, so the approver sees what was saved
    const reworded = !prev || ('body' in body && body.body !== prev.body) || ('subject' in body && (body.subject ?? null) !== (prev.subject ?? null));
    if (reworded) body.approved = 0;
    else if ('approved' in body) body.approved = body.approved === 1 || body.approved === '1' || body.approved === true ? 1 : 0;
    if (body.approved === 1 && !(prev && prev.approved)) { body.approved_by = req.me.id; body.approved_at = nowUtc(); }
    body.updated_at = nowUtc();
    return body;
  },
  afterWrite: (row, _op, prev, req) => {
    const approvedNow = row.approved && !(prev && prev.approved);
    const unapproved = prev && prev.approved && !row.approved;
    audit({ actor: req.me, action: approvedNow ? 'template_approved' : 'template_changed', field: row.name, detail: `${row.sub_key}/${row.kind}/${row.language}${unapproved ? ', approval removed (wording changed or switched off)' : ''}` });
  },
  afterDelete: (prev, req) => audit({ actor: req.me, action: 'template_deleted', field: prev.name }),
}));

helpdeskRouter.use('/keywords', ...guarded, crudRouter({
  table: 'hd_keywords',
  columns: ['sub_key', 'language', 'term', 'weight', 'kind', 'active'],
  searchable: ['t.term', 't.sub_key'],
  orderBy: 't.sub_key ASC, t.weight DESC, t.term ASC',
  beforeWrite: (body, op, _raw, req) => { if (op === 'create') body.source = `added by ${req.me.name}`; return body; },
  afterWrite: (row, _op, _prev, req) => { invalidateDictionary(); audit({ actor: req.me, action: 'keyword_changed', field: row.sub_key, newValue: row.term, detail: `weight ${row.weight}, ${row.language}${row.active ? '' : ', inactive'}` }); },
  afterDelete: (prev, req) => { invalidateDictionary(); audit({ actor: req.me, action: 'keyword_deleted', field: prev.sub_key, oldValue: prev.term }); },
}));

helpdeskRouter.use('/routing', ...guarded, crudRouter({
  table: 'hd_routing_rules',
  columns: ['sub_key', 'department', 'owner_id', 'active', 'note'],
  selectSql: 'SELECT t.*, u.name AS owner_name FROM hd_routing_rules t LEFT JOIN users u ON u.id = t.owner_id',
  searchable: ['t.sub_key', 't.department'],
  orderBy: 't.sub_key ASC',
  afterWrite: (row, _op, _prev, req) => audit({ actor: req.me, action: 'routing_changed', field: row.sub_key, newValue: row.department }),
}));

helpdeskRouter.use('/channels', ...guarded, crudRouter({
  table: 'hd_channel_stats',
  columns: ['day', 'channel', 'count', 'note'],
  searchable: ['t.channel'],
  orderBy: 't.day DESC',
}));

/* ---------------------------------------------------------------- audit log (read only) */
helpdeskRouter.get('/audit', wrap((req, res) => {
  const where = [];
  const params = [];
  if (req.query.case_id) { where.push('a.case_id = ?'); params.push(Number(req.query.case_id)); }
  if (req.query.action) { where.push('a.action = ?'); params.push(req.query.action); }
  if (req.query.actor_type) { where.push('a.actor_type = ?'); params.push(req.query.actor_type); }
  if (req.query.q) { where.push('(a.detail LIKE ? OR a.field LIKE ? OR a.new_value LIKE ? OR c.case_no LIKE ? OR a.actor_name LIKE ?)'); const l = `%${req.query.q}%`; params.push(l, l, l, l, l); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Number(req.query.offset) || 0;
  const data = db.prepare(`SELECT a.*, c.case_no FROM hd_audit a LEFT JOIN hd_cases c ON c.id = a.case_id${w} ORDER BY a.at DESC, a.id DESC LIMIT ${limit} OFFSET ${offset}`).all(...params);
  const { n } = db.prepare(`SELECT COUNT(*) n FROM hd_audit a LEFT JOIN hd_cases c ON c.id = a.case_id${w}`).get(...params);
  const actions = db.prepare('SELECT DISTINCT action FROM hd_audit ORDER BY action').all().map((r) => r.action);
  res.json({ data, total: n, actions });
}));

helpdeskRouter.use('/lab', needCap('helpdesk.lab'), labRouter);
