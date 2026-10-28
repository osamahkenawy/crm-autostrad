// Drafts: creating them from the approved templates (or the AI for request types without one), the
// human edits and approval, and sending. A draft is never sent without a person approving it, and
// sensitive financial requests need a finance, admin or IT approver (enforced here and in the route).
import { db } from '../db.js';
import { rolesWith } from '../roles.js';
import { audit } from './audit.js';
import { attachOutbound, getCaseRow } from './cases.js';
import { llmAvailable, llmDraft } from './llm.js';
import { nowUtc } from './routing.js';
import { getSettings } from './settings.js';
import { ensureFreshAccount, senderVerified } from './systems/account.js';
import { SUB_BY_KEY } from './taxonomy.js';
import { buildDraft, findTemplate, templateVars } from './templates.js';
import { redact, replyLanguage } from './text.js';

export const SENSITIVE_APPROVER_ROLES = rolesWith('helpdesk.approve_sensitive');
export const getDraft = (id) => db.prepare('SELECT * FROM hd_drafts WHERE id = ?').get(id);

const threadText = (caseId) => db.prepare('SELECT direction, body FROM hd_messages WHERE case_id = ? ORDER BY received_at DESC LIMIT 6').all(caseId)
  .reverse().map((m) => `${m.direction === 'in' ? 'CUSTOMER' : 'AUTOSTRAD TEAM'}: ${m.body}`).join('\n---\n');

/**
 * Builds and stores a draft for a case, replacing any pending one. kind: 'initial' | 'followup'.
 * Returns the stored draft, or null when there is no approved template and no AI to fall back on.
 */
export async function createDraft(caseId, { kind = 'initial', user = null, templateId = null, useAi = true } = {}) {
  let c = getCaseRow(caseId);
  if (!c || c.status === 'closed') return null;
  const settings = getSettings();
  // the facts the reply may quote: current (asked again when the stored ones are old) and only for a sender who is the customer
  const acct = await ensureFreshAccount(c);
  c = getCaseRow(caseId); // the refresh may have filled in the contract, the customer's name or the "guessed" flag
  const contract = acct && acct.snapshot ? acct.snapshot.contract : null;
  const verified = senderVerified(acct);
  const accountNote = acct && acct.stale ? `The customer system did not answer just now: account details are from ${String(acct.fetched_at).replace('T', ' ').slice(0, 16)} (UTC). Check the figures.` : null;
  const owner = c.owner_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(c.owner_id) : null;
  const agentName = user ? user.name : (owner && owner.name) || null;
  const lastIn = db.prepare("SELECT id FROM hd_messages WHERE case_id = ? AND direction = 'in' ORDER BY received_at DESC, id DESC LIMIT 1").get(caseId);

  let draft = null;
  if (templateId) {
    const t = db.prepare('SELECT * FROM hd_templates WHERE id = ? AND approved = 1 AND active = 1').get(templateId);
    if (t) {
      const language = t.language;
      draft = buildDraft({ ...c, language }, { kind: t.kind === 'followup' ? 'followup' : 'initial', contract, agentName, settings, verified, accountNote });
    }
  }
  if (!draft) draft = buildDraft({ ...c, language: c.language }, { kind, contract, agentName, settings, verified, accountNote });

  const approvedTemplate = Boolean(findTemplate(c.sub_key, kind, c.language === 'ar' ? 'ar' : 'en')) && SUB_BY_KEY[c.sub_key]?.top5;
  // AI: personalise the approved text (when enabled) or write a suggestion where no approved template covers the request type
  if (useAi && llmAvailable() && (settings.draft_llm_personalize || !draft || !approvedTemplate)) {
    const language = (draft && draft.language) || (c.language === 'ar' ? 'ar' : 'en');
    const vars = templateVars(c, { contract, agentName, language, settings, verified });
    const ai = await llmDraft({
      language, template: draft ? draft.body : null, subject: draft ? draft.subject : `Re: ${c.subject}`,
      facts: { case_no: c.case_no, customer_name: c.customer_name, contract_no: vars.contract_no, request_type: c.sub_category, amount: vars.amount_text, card_last4: vars.card_last4, location: c.location, deposit_status: vars.deposit_status, preauth_status: vars.preauth_status, invoice_no: vars.invoice_no, sla: vars.sla_text, signature: `${vars.agent_name}, ${vars.company_name}, ${vars.support_phone}` },
      thread: threadText(caseId),
    });
    if (ai) {
      draft = {
        ...(draft || { kind: kind === 'followup' ? 'followup' : 'reply', to_email: c.customer_email, language, template_id: null, template_name: null }),
        subject: ai.subject, body: ai.body, original_body: ai.body, generated_by: 'llm', incomplete: 0,
        notes: `${draft && draft.template_name ? `AI-adapted from "${draft.template_name}". ` : 'AI suggestion, no approved template for this request type. '}Check every figure before approving.`,
        sensitive: c.sensitive ? 1 : 0,
      };
    }
  }
  if (!draft) return null;

  db.prepare("UPDATE hd_drafts SET status = 'discarded', discard_reason = 'superseded' WHERE case_id = ? AND status = 'pending'").run(caseId);
  const info = db.prepare(`INSERT INTO hd_drafts (case_id, reply_to_message_id, kind, template_id, template_name, language, to_email, subject, body, original_body, status, generated_by, sensitive, incomplete, notes)
                           VALUES (@case_id, @reply_to, @kind, @template_id, @template_name, @language, @to_email, @subject, @body, @original_body, 'pending', @generated_by, @sensitive, @incomplete, @notes)`).run({
    case_id: caseId, reply_to: lastIn ? lastIn.id : null, kind: draft.kind, template_id: draft.template_id || null, template_name: draft.template_name || null,
    language: draft.language, to_email: draft.to_email, subject: draft.subject, body: draft.body, original_body: draft.original_body, generated_by: draft.generated_by,
    sensitive: draft.sensitive ? 1 : 0, incomplete: draft.incomplete ? 1 : 0, notes: draft.notes || null,
  });
  audit({ caseId, actor: user || 'ai', action: kind === 'followup' ? 'followup_drafted' : 'draft_generated', detail: `${draft.template_name || 'AI suggestion'} (${draft.language})${draft.sensitive ? ', sensitive' : ''}${draft.incomplete ? ', needs details' : ''}` });
  return getDraft(info.lastInsertRowid);
}

export function updateDraft(id, patch, user) {
  const d = getDraft(id);
  if (!d || d.status !== 'pending') throw new Error('This draft can no longer be edited.');
  const subject = patch.subject !== undefined ? String(patch.subject).slice(0, 300) : d.subject;
  const body = patch.body !== undefined ? String(patch.body).slice(0, 20000) : d.body;
  const edited = d.edited || body.trim() !== String(d.original_body || '').trim() ? 1 : 0;
  db.prepare('UPDATE hd_drafts SET subject = ?, body = ?, edited = ?, incomplete = ? WHERE id = ?').run(subject, body, edited, /\[\[[^\]]+\]\]/.test(body) ? 1 : 0, id);
  if (edited && !d.edited) audit({ caseId: d.case_id, actor: user, action: 'draft_edited', detail: `Draft changed by ${user.name}` });
  return getDraft(id);
}

export function discardDraft(id, user, reason = null) {
  const d = getDraft(id);
  if (!d || d.status !== 'pending') throw new Error('This draft is no longer pending.');
  db.prepare("UPDATE hd_drafts SET status = 'discarded', discard_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(reason ? String(reason).slice(0, 200) : 'discarded by staff', user.id, nowUtc(), id);
  if (d.kind === 'followup') db.prepare("UPDATE hd_cases SET next_followup_at = datetime('now', '+1 day') WHERE id = ? AND status = 'pending_customer'").run(d.case_id);
  audit({ caseId: d.case_id, actor: user, action: 'draft_discarded', detail: reason || null });
  return getDraft(id);
}

/**
 * A person approves the draft. Sensitive drafts need a finance, admin or IT user. With the
 * "send after approval" mode the reply goes out; otherwise it is saved into the mailbox Drafts folder
 * for the person to send from Outlook.
 */
export async function approveDraft(id, user, provider, { subject, body } = {}) {
  let d = getDraft(id);
  if (!d || d.status !== 'pending') throw new Error('This draft is no longer pending.');
  if (d.sensitive && !SENSITIVE_APPROVER_ROLES.includes(user.role)) throw new Error('This reply concerns a sensitive financial request. A finance, admin or IT user must approve it.');
  if (subject !== undefined || body !== undefined) d = updateDraft(id, { subject, body }, user);
  if (/\[\[[^\]]+\]\]/.test(d.body)) throw new Error('The draft still has [[placeholders]] to fill in.');
  if (!d.to_email) throw new Error('The draft has no recipient.');
  const c = getCaseRow(d.case_id);
  const settings = getSettings();
  // Who may receive the reply was decided for the case's customer address (see the sender check). Anybody else can join a thread, so the
  // reply is never created against the latest message of whoever wrote last, and a changed address means a new reply has to be written.
  if (String(d.to_email || '').trim().toLowerCase() !== String(c.customer_email || '').trim().toLowerCase()) throw new Error('The customer\'s address on the case changed after this reply was written. Write the reply again.');
  const replyTo = db.prepare("SELECT * FROM hd_messages WHERE case_id = ? AND direction = 'in' AND lower(from_email) = lower(?) ORDER BY received_at DESC, id DESC LIMIT 1").get(d.case_id, d.to_email) || null;
  const now = nowUtc();
  const mode = settings.send_mode;

  let result;
  if (mode === 'send_after_approval') {
    result = await provider.sendReply({ case: c, draft: d, replyTo });
    db.prepare("UPDATE hd_drafts SET status = 'sent', reviewed_by = ?, reviewed_at = ?, sent_at = ?, provider_draft_id = ? WHERE id = ?").run(user.id, now, result.sentAt || now, result.providerId || null, id);
    audit({ caseId: d.case_id, actor: user, action: 'draft_approved', detail: `${d.edited ? 'Edited, ' : 'Unedited, '}${d.sensitive ? 'sensitive, ' : ''}sent` });
    if (d.kind === 'followup') db.prepare('UPDATE hd_cases SET followup_count = followup_count + 1 WHERE id = ?').run(d.case_id);
    attachOutbound(getCaseRow(d.case_id), {
      providerId: result.providerId, internetId: result.internetId, conversationId: result.conversationId || c.conversation_id, receivedAt: result.sentAt || now,
      to: d.to_email, subject: d.subject, body: d.body, webLink: result.webLink,
    }, { user, viaDraft: true, kind: d.kind === 'followup' ? 'followup' : 'reply' });
  } else {
    result = await provider.createDraft({ case: c, draft: d, replyTo });
    db.prepare("UPDATE hd_drafts SET status = 'approved', reviewed_by = ?, reviewed_at = ?, provider_draft_id = ? WHERE id = ?").run(user.id, now, result.providerId || null, id);
    audit({ caseId: d.case_id, actor: user, action: 'draft_approved', detail: `${d.edited ? 'Edited, ' : 'Unedited, '}${d.sensitive ? 'sensitive, ' : ''}saved to the mailbox Drafts folder` });
  }
  return { draft: getDraft(id), mode };
}

