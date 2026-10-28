// The email pipeline: a message from the mailbox becomes (or joins) a case. For a new case it extracts
// the customer and contract facts, classifies (rules, plus the AI when enabled), matches history,
// sets the priority, assigns an owner and due date, drafts a reply and writes the tracking back to
// Outlook. Every step is written to the audit log. Nothing is ever sent from here.
import { db } from '../db.js';
import { audit } from './audit.js';
import { attachOutbound, closeCase, getCaseRow, nextCaseNo } from './cases.js';
import { relatedCases } from './contracts.js';
import { createDraft } from './drafts.js';
import { extractEntities } from './extract.js';
import { classify } from './classify.js';
import { predictLearned } from './learner.js';
import { llmAvailable, llmClassify, verifyFacts } from './llm.js';
import { loadDictionary } from './knowledge.js';
import { scorePriority, raisePriority, priorityRank } from './priority.js';
import { branchForLocation, dueAtFor, nowUtc, pickOwner, routeFor } from './routing.js';
import { getSettings } from './settings.js';
import { notChecked, resolveAccount, saveSnapshot } from './systems/account.js';
import { redraftIfUntouched } from './systems/actions.js';
import { SUBCATEGORIES, SUB_BY_KEY } from './taxonomy.js';
import { detectLanguage, excerpt, normalize, redact, replyLanguage, stripQuoted } from './text.js';

const SENSITIVE_WORDS = /(iban|bank account|account number|change (?:my )?card|different card|another card|another account|transfer to|refund to (?:my )?(?:other|another)|الحساب البنكي|آيبان|حساب آخر|حساب اخر|بطاقه اخرى|بطاقة أخرى)/i;
const CASE_REF = /\bCS-\d{4}-\d{6}\b/i;
// out-of-office replies and bounces to our own messages must not reopen a closed case or restart the customer's clock
const AUTO_SUBJECT = /^\s*(?:(?:re|fw|fwd)\s*:\s*)*(?:automatic reply|auto[- ]?reply|autoreply|out of (?:the )?office|undeliverable|delivery (?:status notification|has failed)|mail delivery (?:failed|subsystem)|returned mail|failure notice|رد تلقائي|رد آلي|خارج المكتب)/i;
const AUTO_BODY = /^\s*(?:this is an automa(?:ted|tic)|i am (?:currently )?(?:out of (?:the )?office|away)|thank you for your (?:e-?mail|message)\. i am (?:currently )?(?:out|away)|your message (?:wasn'?t|was not|could not be) delivered|أنا خارج المكتب|هذه رسالة (?:تلقائية|آلية))/i;
const isAutoReply = (msg) => AUTO_SUBJECT.test(msg.subject || '') || AUTO_BODY.test(stripQuoted(msg.body || '').slice(0, 300));

/** Combine the keyword engine with the AI's answer. */
function reconcile(rules, llm, text) {
  const facts = verifyFacts(llm, text);
  const ruleSub = rules.sub_key;
  const aiSub = facts.request_type;
  const aiConf = Math.max(0, Math.min(1, Number(facts.confidence) || 0));
  let sub = ruleSub;
  let confidence = rules.confidence;
  let by = 'rules+llm';
  let disagree = false;

  if (aiSub === ruleSub) {
    confidence = Math.min(0.99, Math.max(rules.confidence, aiConf) + 0.05);
  } else if (rules.confidence >= 0.85 && aiConf < 0.7) {
    by = 'rules';
    disagree = true;
  } else {
    sub = aiSub;
    confidence = Math.round(aiConf * 0.92 * 100) / 100;
    by = 'llm';
    disagree = Math.abs(rules.confidence - aiConf) < 0.2;
  }
  return { sub, confidence: Math.round(confidence * 100) / 100, by, disagree, facts };
}

const KEYS = SUBCATEGORIES.map((s) => s.key);

/**
 * Chance that the blended answer is right, as a logistic curve over the blend's own signals (how far ahead the winner is, how
 * much evidence the model had, whether rules and model agree). The constants were set by hand and checked on a development set
 * of 85 emails written independently (a best-fit logistic regression on that set scores within 0.002 log-loss of them), so
 * "60% confident" means roughly nine in ten such answers are right and the "To check" threshold has a meaning. The 68-email
 * independent test set was not used for this. Refit with real labelled emails when Autostrad has them.
 */
export const CALIBRATION = { b0: -2.0, top: 3.0, margin: 3.0, evidence: 1.0, agree: 1.0, rules: 1.0 };
export const calibrate = (sig, k = CALIBRATION) => 1 / (1 + Math.exp(-(k.b0 + k.top * sig.top + k.margin * sig.margin + k.evidence * sig.evidence + k.agree * sig.agree + k.rules * sig.rules)));

/**
 * One opinion from two engines: the keyword rules and the learned model. Strong keyword evidence leads;
 * when the rules found nothing the model decides (and, being less sure, usually sends the case to "To check").
 */
function blendEngine(rules, learned) {
  if (!learned) return { sub: rules.sub_key, confidence: rules.confidence, by: 'rules', disagree: false, learned: null, signals: null };
  const hasRules = rules.scores.length > 0 && rules.confidence > 0.3;
  const alpha = !hasRules ? 0 : rules.confidence >= 0.75 ? 0.7 : rules.confidence >= 0.5 ? 0.55 : 0.4;
  const tot = rules.scores.reduce((a, s) => a + s.score, 0) || 1;
  const rv = Object.fromEntries(KEYS.map((k) => [k, hasRules ? (1 - rules.confidence) / KEYS.length : 0]));
  if (hasRules) for (const sc of rules.scores) rv[sc.sub_key] += rules.confidence * (sc.score / tot);
  const bl = Object.fromEntries(KEYS.map((k) => [k, alpha * rv[k] + (1 - alpha) * learned.p[k]]));
  const ranked = KEYS.slice().sort((a, b) => bl[b] - bl[a]);
  const top = ranked[0];
  const mTop = learned.top[0];
  const agree = mTop.sub_key === top && (!hasRules || rules.sub_key === top);
  const signals = {
    top: bl[top], margin: bl[top] - bl[ranked[1]], evidence: Math.min(1, learned.max_sim / 0.3),
    agree: agree && hasRules ? 1 : 0, rules: hasRules && rules.sub_key === top ? rules.confidence : 0,
  };
  const confidence = Math.min(0.97, Math.max(0.03, calibrate(signals)));
  const disagree = hasRules && rules.confidence >= 0.6 && mTop.sub_key !== rules.sub_key && mTop.p >= 0.45;
  return { sub: top, confidence: Math.round(confidence * 100) / 100, by: 'rules+model', disagree, signals, learned: { top: learned.top.slice(0, 3).map((t) => ({ sub_key: t.sub_key, p: Math.round(t.p * 100) / 100 })), max_sim: Math.round(learned.max_sim * 100) / 100 } };
}

const MAX_SUBJECT = 1000; // a subject is one line (Outlook allows 255 characters, the mail standard 998); nothing longer is analysed

/** What we know about a message before any case exists. */
async function analyse({ subject, ownBody, fullBody, fromName, fromEmail, settings, ai = true, learn = true }) {
  subject = String(subject ?? '').slice(0, MAX_SUBJECT);
  const branches = db.prepare('SELECT name, emirate, address FROM branches').all();
  const ctx = { patterns: settings.contract_patterns, branches };
  const entities = extractEntities({ subject, body: ownBody, fromName, fromEmail }, ctx);
  if (!entities.contract_no) {
    // the quoted history often carries the contract number we or the customer wrote earlier
    const wider = extractEntities({ subject, body: fullBody, fromName, fromEmail }, ctx);
    entities.contract_no = wider.contract_no;
    entities.contract_candidates = wider.contract_candidates;
    entities.card_last4 = entities.card_last4 || wider.card_last4;
  }
  const rules = classify({ subject, body: ownBody }, loadDictionary());
  const smart = blendEngine(rules, learn ? predictLearned(`${subject}\n${ownBody}`) : null);
  let sub = smart.sub;
  let confidence = smart.confidence;
  let by = smart.by;
  let disagree = smart.disagree;
  let aiCalled = false;
  let aiSummary = null;
  let aiPriority = null;
  let aiUrgent = false;
  let aiSensitive = false;

  if (ai && llmAvailable() && (settings.llm_mode === 'always' || rules.confidence < settings.llm_fallback_threshold || rules.sub_key === 'general_inquiry')) {
    const out = await llmClassify({ subject, body: ownBody, fromName, fromEmail, hint: rules });
    if (out && out.parsed) {
      const r = reconcile({ sub_key: smart.sub, confidence: smart.confidence }, out.parsed, `${subject}\n${ownBody}`);
      aiCalled = true;
      sub = r.sub; confidence = r.confidence; by = r.by === 'rules' && smart.learned ? 'rules+model' : r.by; disagree = r.disagree;
      aiSummary = out.parsed.summary;
      aiPriority = out.parsed.priority;
      aiUrgent = out.parsed.urgent;
      aiSensitive = out.parsed.sensitive_financial;
      entities.contract_no = entities.contract_no || r.facts.contract_no || null;
      entities.amount = entities.amount ?? r.facts.amount_aed ?? null;
      entities.fine_ref = entities.fine_ref || r.facts.fine_reference || null;
      entities.card_last4 = entities.card_last4 || r.facts.card_last4 || null;
      entities.location = entities.location || r.facts.location || null;
      entities.customer_name = entities.customer_name || r.facts.customer_name || null;
    }
  }
  return { entities, rules, learned: smart.learned, signals: smart.signals, aiCalled, sub, confidence, by, disagree, aiSummary, aiPriority, aiUrgent, aiSensitive };
}

const describe = (subKey, e) => {
  const bits = [];
  if (e.amount) bits.push(`AED ${Number(e.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  if (e.card_last4) bits.push(`card ending ${e.card_last4}`);
  if (e.fine_ref) bits.push(`fine ${e.fine_ref}`);
  if (e.location) bits.push(`at ${e.location}`);
  if (e.contract_no) bits.push(`contract ${e.contract_no}`);
  const name = (SUB_BY_KEY[subKey] || {}).name || 'Request';
  return bits.length ? `${name}: ${bits.join(', ')}` : name;
};

/**
 * The customer, contract and invoices behind a new email, from the customer systems (or the CRM in demo mode). Spam and automatic
 * replies are never looked up. Never throws: a system that is down leaves the case to be completed later.
 */
async function accountFor(a, msg) {
  if (a.sub === 'spam_or_auto') return notChecked();
  return resolveAccount({ email: a.entities.customer_email || (msg.from && msg.from.email), contractNo: a.entities.contract_no });
}

function newCaseFromAnalysis(msg, a, settings, { parentCaseId = null, account }) {
  const e = a.entities;
  const sub = SUB_BY_KEY[a.sub];
  const contract = account.contract;
  const customer = account.customer;
  const inferred = account.inferred ? 1 : 0;
  // a number found in the system is written the way the system writes it; a number the system does not know stays as the customer typed it
  const contractNo = (contract && !inferred ? contract.contract_no : e.contract_no) || (contract && contract.contract_no) || null;
  const related = relatedCases({ contractNo: contractNo, email: e.customer_email });
  const openRelated = related.filter((r) => r.status !== 'closed').length;

  const text = `${msg.subject}\n${stripQuoted(msg.body)}`;
  const known = ['email', 'staff'].includes(account.identity); // only a sender who is the customer brings the customer's tier and segment
  const pr = scorePriority({ subKey: a.sub, subject: msg.subject, body: stripQuoted(msg.body), amount: e.amount, tier: known && customer ? customer.tier : null, segment: known && customer ? customer.segment : null, openRelated });
  let priority = pr.priority;
  const reasons = [...pr.reasons];
  if (a.aiPriority && priorityRank(a.aiPriority) < priorityRank(priority) && (a.aiUrgent || priorityRank(a.aiPriority) === 0)) {
    priority = raisePriority(priority, 1);
    reasons.push(`AI judged it ${a.aiPriority}: raised one level`);
  }
  if (a.sub === 'spam_or_auto') priority = 'Low';

  const route = routeFor(a.sub);
  const contractBranch = contract && contract.pickup_branch ? (contract.pickup_branch.id || branchForLocation(contract.pickup_branch.name)) : null;
  const branchId = branchForLocation(e.location, contractBranch);
  const ownerId = a.sub === 'spam_or_auto' ? null : pickOwner(route.department, { branchId, ruleOwnerId: route.ownerId });
  const receivedAt = msg.receivedAt || nowUtc();
  const language = replyLanguage(text);
  const sensitive = sub.sensitive || a.aiSensitive || SENSITIVE_WORDS.test(text) ? 1 : 0;
  const needsReview = !(a.confidence >= settings.confidence_threshold) || a.disagree ? 1 : 0; // written so that a confidence that is not a number sends the email to a person
  const matched = (a.rules.sub_key === a.sub ? a.rules.matched : []).slice(0, 8).map(({ term, where, weight }) => ({ term, where, weight }));

  const caseNo = nextCaseNo();
  const info = db.prepare(`INSERT INTO hd_cases (case_no, status, category, sub_category, sub_key, details, impact, priority, priority_reasons, department, owner_id, language, subject,
      customer_name, customer_email, customer_id, contract_no, contract_inferred, booking_id, amount, currency, fine_ref, card_last4, location, conversation_id, parent_case_id, channel,
      sensitive, confidence, classified_by, matched_terms, ai_summary, needs_review, first_received_at, last_inbound_at, due_at, created_at, updated_at)
    VALUES (@case_no, 'open', @category, @sub_category, @sub_key, @details, @impact, @priority, @priority_reasons, @department, @owner_id, @language, @subject,
      @customer_name, @customer_email, @customer_id, @contract_no, @contract_inferred, @booking_id, @amount, 'AED', @fine_ref, @card_last4, @location, @conversation_id, @parent_case_id, 'email',
      @sensitive, @confidence, @classified_by, @matched_terms, @ai_summary, @needs_review, @received, @received, @due_at, @now, @now)`).run({
    case_no: caseNo, category: sub.category, sub_category: sub.name, sub_key: sub.key, details: describe(a.sub, e), impact: sub.impact, priority,
    priority_reasons: JSON.stringify(reasons), department: route.department, owner_id: ownerId, language, subject: redact(String(msg.subject || '(no subject)')).text.slice(0, 300),
    customer_name: account.identity === 'contract_only' ? (e.customer_name || msg.from.name || null) : ((customer && customer.name) || e.customer_name || msg.from.name || null), customer_email: e.customer_email || msg.from.email,
    customer_id: account.source === 'crm' && customer ? customer.id : null, contract_no: contractNo, contract_inferred: inferred, booking_id: account.source === 'crm' && contract ? contract.booking_id : null,
    amount: e.amount, fine_ref: e.fine_ref, card_last4: e.card_last4, location: e.location, conversation_id: msg.conversationId || null, parent_case_id: parentCaseId,
    sensitive, confidence: a.confidence, classified_by: a.by, matched_terms: JSON.stringify(matched), ai_summary: a.aiSummary, needs_review: needsReview,
    received: receivedAt, due_at: dueAtFor(priority, receivedAt, settings), now: nowUtc(),
  });
  const id = Number(info.lastInsertRowid);

  const found = Object.entries({ contract: contractNo, amount: e.amount, 'card digits': e.card_last4, 'fine reference': e.fine_ref, location: e.location })
    .filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ');
  audit({ caseId: id, actor: 'system', action: 'email_received', detail: `From ${msg.from.email}: ${excerpt(msg.subject, 120)}`, at: receivedAt });
  audit({ caseId: id, actor: 'ai', action: 'classified', newValue: `${sub.category} / ${sub.name}`, detail: `${a.by}, confidence ${Math.round(a.confidence * 100)}%${needsReview ? ', flagged for triage' : ''}${matched.length ? `; matched: ${matched.slice(0, 3).map((m) => m.term).join(', ')}` : ''}${a.aiSummary ? `; AI summary: ${a.aiSummary}` : ''}` });
  audit({ caseId: id, actor: 'ai', action: 'extracted', detail: found || 'No contract or amount found in the email' });
  if (account.status !== 'not_checked') saveSnapshot(id, account, { email: e.customer_email });
  const where = account.systems.length ? `${account.systems.join(' and ')}: ` : '';
  if (customer || contract) audit({ caseId: id, actor: 'ai', action: 'customer_matched', detail: `${where}${customer ? customer.name : 'Unknown customer'}${contract ? `, contract ${contract.contract_no}${inferred ? ' (inferred from the sender)' : ''}` : ''}${contract && account.identity === 'contract_only' ? '. The sender is not the customer on this contract' : ''}` });
  else if (account.status === 'unavailable') audit({ caseId: id, actor: 'system', action: 'account_lookup_failed', detail: `${account.errors[0] ? account.errors[0].message : 'The customer systems did not answer.'} The case was opened without them and will be completed automatically.` });
  else if (account.status === 'not_found') audit({ caseId: id, actor: 'ai', action: 'customer_matched', detail: `${where}No customer or contract found for ${e.customer_email || 'the sender'}${e.contract_no ? ` and ${e.contract_no}` : ''}` });
  audit({ caseId: id, actor: 'ai', action: 'history_matched', detail: related.length ? `${related.length} earlier case(s): ${related.slice(0, 3).map((r) => r.case_no).join(', ')}` : 'No earlier cases for this contract or sender' });
  audit({ caseId: id, actor: 'ai', action: 'priority_set', newValue: priority, detail: reasons.join('; ') });
  audit({ caseId: id, actor: 'ai', action: 'assigned', newValue: ownerId ? (db.prepare('SELECT name FROM users WHERE id = ?').get(ownerId) || {}).name : 'Unassigned', detail: `${route.department}${branchId && route.department === 'Branch' ? ' (nearest branch)' : ''}` });
  return id;
}

function insertInbound(caseId, msg) {
  const body = redact(stripQuoted(msg.body)).text;
  db.prepare(`INSERT OR IGNORE INTO hd_messages (case_id, provider_id, internet_id, conversation_id, direction, from_name, from_email, to_email, cc, subject, body, attachments, web_link, received_at)
              VALUES (?, ?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    caseId, msg.providerId, msg.internetId || null, msg.conversationId || null, msg.from.name || null, msg.from.email, (msg.to || []).join(', '), (msg.cc || []).join(', '),
    redact(msg.subject || '').text || null, body, msg.attachments && msg.attachments.length ? JSON.stringify(msg.attachments) : null, msg.webLink || null, msg.receivedAt || nowUtc(),
  );
}

/** A customer wrote again on a case we already have. */
async function attachInbound(c, msg, settings) {
  insertInbound(c.id, msg);
  if (c.customer_email && msg.from && msg.from.email && String(msg.from.email).toLowerCase() !== String(c.customer_email).toLowerCase()) {
    audit({ caseId: c.id, actor: 'system', action: 'history_matched', detail: `A message from another address (${msg.from.email}) joined this case. Replies still go to ${c.customer_email} only.`, at: msg.receivedAt });
  }
  const at = msg.receivedAt || nowUtc();
  const own = stripQuoted(msg.body);
  const sets = { last_inbound_at: at, updated_at: nowUtc() };

  // fill in facts we did not have yet
  const e = extractEntities({ subject: msg.subject, body: own, fromName: msg.from.name, fromEmail: msg.from.email }, { patterns: settings.contract_patterns });
  const newly = [];
  for (const [col, v] of [['contract_no', e.contract_no], ['amount', e.amount], ['card_last4', e.card_last4], ['fine_ref', e.fine_ref], ['location', e.location]]) {
    // a contract the system guessed from the sender gives way to the one the customer now writes
    if (v && (!c[col] || (col === 'contract_no' && c.contract_inferred && String(c[col]).toUpperCase() !== String(v).toUpperCase()))) { sets[col] = v; newly.push(`${col.replace('_', ' ')} ${v}`); }
  }
  let learned = null;
  const typedNo = sets.contract_no || null; // what the customer wrote, before the system's spelling replaces it
  if (sets.contract_no) {
    sets.contract_inferred = 0; // typed by the customer: no longer a guess, even if the systems cannot be asked just now
    learned = await resolveAccount({ email: c.customer_email, contractNo: sets.contract_no });
    const k = learned.contract;
    if (k) {
      sets.contract_no = k.contract_no;
      if (learned.source === 'crm') { sets.booking_id = k.booking_id; if (!c.customer_id && k.customer) sets.customer_id = k.customer.id; }
    }
  }
  if (newly.length) audit({ caseId: c.id, actor: 'ai', action: 'extracted', detail: `New in the customer's reply: ${newly.join(', ')}` });

  if (c.status === 'closed') {
    Object.assign(sets, { status: 'open', closed_at: null, closure_reason: null, closure_note: null, closed_by: null, reopened_count: c.reopened_count + 1, due_at: dueAtFor(c.priority, at, settings), escalation_level: 0 });
    audit({ caseId: c.id, actor: 'system', action: 'reopened', oldValue: 'closed', newValue: 'open', detail: 'The customer wrote again' });
  } else if (c.status === 'pending_customer') {
    Object.assign(sets, { status: 'open', due_at: dueAtFor(c.priority, at, settings), next_followup_at: null });
    audit({ caseId: c.id, actor: 'system', action: 'customer_replied', oldValue: 'pending_customer', newValue: 'open', detail: 'The SLA clock restarted' });
  }
  db.prepare(`UPDATE hd_cases SET ${Object.keys(sets).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...sets, id: c.id });
  if (learned && learned.status !== 'not_checked') saveSnapshot(c.id, learned, { email: c.customer_email, contractNo: typedNo });
  // the customer named another contract: a reply nobody has touched was written about the old one
  if (sets.contract_no && String(sets.contract_no).toUpperCase() !== String(c.contract_no || '').toUpperCase()) await redraftIfUntouched(c.id);
  return getCaseRow(c.id);
}

/** Opened for a new request type that appears inside an existing thread. */
function isNewTopic(c, msg, settings) {
  const own = stripQuoted(msg.body);
  const r = classify({ subject: '', body: own }, loadDictionary());
  const strong = r.scores[0] && r.scores[0].score >= 8;
  return r.confidence >= 0.8 && strong && r.sub_key !== c.sub_key && !['general_inquiry', 'spam_or_auto'].includes(r.sub_key) && c.sub_key !== 'general_inquiry';
}

/**
 * Entry point for every mailbox message. -> { action, caseId, caseNo }.
 * Idempotent: a message that was already imported is skipped.
 */
export async function ingestMessage(msg, { provider = null } = {}) {
  const settings = getSettings();
  if (!msg.providerId) msg = { ...msg, providerId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  if (db.prepare('SELECT 1 FROM hd_messages WHERE provider_id = ?').get(msg.providerId)) return { action: 'duplicate' };
  const mailbox = String(settings.mailbox || '').toLowerCase();
  const direction = msg.direction || (String(msg.from.email).toLowerCase() === mailbox ? 'out' : 'in');
  msg = { ...msg, direction, subject: msg.subject || '', body: msg.body || '', from: msg.from || { name: '', email: '' }, receivedAt: msg.receivedAt || nowUtc() };
  const text = `${msg.subject}\n${msg.body}`;

  // which case does it belong to?
  const ref = CASE_REF.exec(text);
  let c = (ref && db.prepare('SELECT id FROM hd_cases WHERE upper(case_no) = upper(?)').get(ref[0])) || (msg.conversationId && db.prepare('SELECT id FROM hd_cases WHERE conversation_id = ? ORDER BY id DESC').get(msg.conversationId));
  c = c ? getCaseRow(c.id) : null;

  if (direction === 'out') {
    if (!c) return { action: 'ignored', reason: 'outgoing mail that is not part of a case' };
    // a reply sent from the CRM comes back later through Sent Items: do not record it twice
    const mine = redact(stripQuoted(msg.body)).text;
    if (db.prepare("SELECT 1 FROM hd_messages WHERE case_id = ? AND direction = 'out' AND substr(body, 1, 100) = substr(?, 1, 100) AND ABS(julianday(received_at) - julianday(?)) < 0.05").get(c.id, mine, msg.receivedAt)) return { action: 'duplicate' };
    attachOutbound(c, { providerId: msg.providerId, internetId: msg.internetId, conversationId: msg.conversationId, receivedAt: msg.receivedAt, to: msg.to, subject: msg.subject, body: msg.body, fromName: msg.from.name, fromEmail: msg.from.email, webLink: msg.webLink }, {});
    db.prepare("UPDATE hd_drafts SET status = 'sent', sent_at = ? WHERE case_id = ? AND status = 'approved'").run(msg.receivedAt, c.id);
    db.prepare("UPDATE hd_drafts SET status = 'discarded', discard_reason = 'replied in the mailbox' WHERE case_id = ? AND status = 'pending'").run(c.id);
    return { action: 'outbound', caseId: c.id, caseNo: c.case_no };
  }

  if (c && isAutoReply(msg)) {
    insertInbound(c.id, msg);
    audit({ caseId: c.id, actor: 'system', action: 'auto_reply_ignored', detail: `Automatic message from ${msg.from.email}. The case was left as it is.`, at: msg.receivedAt });
    return { action: 'attached', caseId: c.id, caseNo: c.case_no, auto: true };
  }

  // same contract and request type, different thread: a chaser, not a new case
  const analysis = c ? null : await analyse({ subject: msg.subject, ownBody: stripQuoted(msg.body), fullBody: msg.body, fromName: msg.from.name, fromEmail: msg.from.email, settings });
  if (!c && analysis.entities.contract_no) {
    const dup = db.prepare(`SELECT id FROM hd_cases WHERE contract_no = ? AND sub_key = ? AND status <> 'closed' AND last_inbound_at >= datetime('now', '-14 days') ORDER BY id DESC LIMIT 1`).get(analysis.entities.contract_no, analysis.sub);
    if (dup) { c = getCaseRow(dup.id); audit({ caseId: c.id, actor: 'ai', action: 'history_matched', detail: `New email joined this case: same contract and request type (${msg.from.email})` }); }
  }

  if (c) {
    if (isNewTopic(c, msg, settings)) {
      const a = await analyse({ subject: msg.subject, ownBody: stripQuoted(msg.body), fullBody: msg.body, fromName: msg.from.name, fromEmail: msg.from.email, settings });
      const childId = newCaseFromAnalysis(msg, a, settings, { parentCaseId: c.id, account: await accountFor(a, msg) });
      insertInbound(childId, msg);
      audit({ caseId: c.id, actor: 'ai', action: 'case_split', detail: `A new request type appeared in this thread and was opened as ${getCaseRow(childId).case_no}` });
      const child = getCaseRow(childId);
      await finishNewCase(child, settings, provider, msg);
      return { action: 'split', caseId: childId, caseNo: child.case_no, parent: c.case_no };
    }
    const updated = await attachInbound(c, msg, settings);
    if (provider && provider.applyTracking) await track(updated, provider, msg).catch(() => {});
    return { action: 'attached', caseId: updated.id, caseNo: updated.case_no };
  }

  const id = newCaseFromAnalysis(msg, analysis, settings, { account: await accountFor(analysis, msg) });
  insertInbound(id, msg);
  const created = getCaseRow(id);
  await finishNewCase(created, settings, provider, msg);
  return { action: 'created', caseId: id, caseNo: created.case_no };
}

async function finishNewCase(c, settings, provider, msg) {
  if (c.sub_key === 'spam_or_auto') {
    closeCase(c.id, { reason: 'not_applicable', note: 'Spam or automatic reply' }, null, { auto: true });
    return;
  }
  await createDraft(c.id, { kind: 'initial' }).catch((e) => console.warn('[helpdesk] draft failed:', e.message));
  if (provider && provider.applyTracking) await track(getCaseRow(c.id), provider, msg).catch(() => {});
}

/** Write the case's tracking back to the Outlook message (categories, flag with the due date). Best effort. */
export async function track(c, provider, msg = null) {
  const settings = getSettings();
  if (!settings.outlook_writeback || !provider || !provider.applyTracking) return;
  const message = msg || db.prepare("SELECT * FROM hd_messages WHERE case_id = ? AND direction = 'in' ORDER BY received_at DESC LIMIT 1").get(c.id);
  if (!message) return;
  const providerId = message.providerId || message.provider_id;
  const owner = c.owner_id ? (db.prepare('SELECT name FROM users WHERE id = ?').get(c.owner_id) || {}).name : null;
  const categories = [`CH: ${c.category}`, `CH: ${c.sub_category}`, `Priority: ${c.priority}`, `Status: ${c.status.replace('_', ' ')}`, c.department ? `Dept: ${c.department}` : null, owner ? `Owner: ${owner}` : null, c.case_no].filter(Boolean);
  const done = await provider.applyTracking({ providerId, categories, dueAt: c.due_at, closed: c.status === 'closed' });
  if (done) audit({ caseId: c.id, actor: 'system', action: 'outlook_tagged', detail: `${categories.slice(0, 4).join(', ')}${c.due_at ? `, due ${c.due_at}` : ''}` });
}

/**
 * Dry run for the AI lab and the "try an email" box: the analysis a new email would get, without creating a case.
 * ai=false skips the AI layer so the rules engine can be measured on its own.
 */
export async function previewAnalysis({ subject = '', body = '', fromName = null, fromEmail = null, ai = true, learn = true } = {}) {
  const settings = getSettings();
  subject = String(subject ?? '').slice(0, MAX_SUBJECT);
  const ownBody = stripQuoted(body);
  const a = await analyse({ subject, ownBody, fullBody: body, fromName, fromEmail, settings, ai, learn });
  const sub = SUB_BY_KEY[a.sub];
  const text = `${subject}\n${ownBody}`;
  const pr = scorePriority({ subKey: a.sub, subject, body: ownBody, amount: a.entities.amount });
  let priority = pr.priority;
  const reasons = [...pr.reasons];
  if (a.aiPriority && priorityRank(a.aiPriority) < priorityRank(priority) && (a.aiUrgent || priorityRank(a.aiPriority) === 0)) {
    priority = raisePriority(priority, 1);
    reasons.push(`AI judged it ${a.aiPriority}: raised one level`);
  }
  if (a.sub === 'spam_or_auto') priority = 'Low';
  const route = routeFor(a.sub);
  return {
    sub_key: sub.key, sub_category: sub.name, category: sub.category, impact: sub.impact, department: route.department,
    sensitive: Boolean(sub.sensitive || a.aiSensitive || SENSITIVE_WORDS.test(text)),
    priority, priority_reasons: reasons, confidence: a.confidence, engine: a.by, language: replyLanguage(text),
    needs_review: !(a.confidence >= settings.confidence_threshold) || a.disagree,
    rules: { sub_key: a.rules.sub_key, confidence: a.rules.confidence, scores: a.rules.scores, matched: (a.rules.sub_key === a.sub ? a.rules.matched : []).slice(0, 12) },
    ai: { used: a.aiCalled, summary: a.aiSummary, priority: a.aiPriority, disagrees: a.disagree },
    learned: a.learned,
    signals: a.signals,
    entities: a.entities,
  };
}
