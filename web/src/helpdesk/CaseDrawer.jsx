// One customer case: the conversation, the drafted reply waiting for approval, how the AI classified it
// (and the controls to correct it), the CRM record behind it, and everything that happened, in order.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowUpRight, Check, CheckCircle2, ChevronLeft, ChevronRight, Clock, Cog, Copy, ExternalLink, FileText, Info, Lightbulb, Lock, RefreshCw, Send, Sparkles, StickyNote, Trash2, User } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../toast';
import { Button, Pill } from '../components/ui';
import { ConfirmDialog, Drawer, Modal } from '../components/Modal';
import { fmtDate, fmtDateTime, relTime } from '../lib/format';
import AccountPanel from './AccountPanel';
import { ACTION, CaseStatusPill, Confidence, DueText, ENGINE_LABEL, FIELD, OwnerCell, PRIORITIES, PriorityPill, sentence, useMeta } from './shared';

const PLACEHOLDER = /\[\[[^\]]+\]\]/;

const Line = ({ k, children }) => (children === null || children === undefined || children === '' ? null : <div className="ln"><span>{k}</span><b>{children}</b></div>);

/* --------------------------------- the drafted reply --------------------------------- */
function DraftPanel({ c, draft, meta, user, busy, run, hasNext, onNext }) {
  const [subject, setSubject] = useState(draft.subject || '');
  const [body, setBody] = useState(draft.body || '');
  const [confirmSend, setConfirmSend] = useState(false);
  const [discard, setDiscard] = useState(false);
  useEffect(() => { setSubject(draft.subject || ''); setBody(draft.body || ''); }, [draft.id, draft.subject, draft.body]);

  const dirty = subject !== (draft.subject || '') || body !== (draft.body || '');
  const incomplete = PLACEHOLDER.test(body);
  const sends = meta && meta.send_mode === 'send_after_approval';
  const real = meta && meta.provider === 'graph';
  const mayApproveSensitive = meta && meta.sensitive_approver_roles.includes(user.role);
  const blocked = draft.sensitive && !mayApproveSensitive;
  const rtl = c.language === 'ar' || /[؀-ۿ]/.test(body.slice(0, 80));

  const approve = () => run('approve', () => api.post(`/helpdesk/drafts/${draft.id}/approve`, { subject, body }), sends ? 'Reply sent' : 'Saved to the Outlook Drafts folder');
  return (
    <section className="hd-panel hd-draft">
      <header>
        <h4>{draft.kind === 'followup' ? 'Reminder to the customer' : 'Reply to the customer'}, waiting for your approval</h4>
        <div className="meta">
          <Pill tone={draft.generated_by === 'llm' ? 'navy' : 'info'} dot={false}>{draft.generated_by === 'llm' ? 'Written by the AI' : `Template: ${draft.template_name || 'standard'}`}</Pill>
          {draft.edited ? <Pill tone="warn" dot={false}>Edited</Pill> : null}
          {draft.sensitive ? <Pill tone="danger" dot={false}><Lock size={11} style={{ marginRight: 4 }} />Sensitive</Pill> : null}
        </div>
      </header>
      <div className="body">
        {draft.notes ? <div className="hd-banner warn"><AlertTriangle size={18} /><div className="grow">{draft.notes}</div></div> : null}
        {draft.sensitive ? (
          <div className={`hd-banner ${blocked ? 'danger' : 'info'}`}>
            <Lock size={18} />
            <div className="grow">{blocked
              ? 'This reply concerns a sensitive financial request (a charge, refund, deposit or card change). Only a finance, admin or IT user can approve it. You can still edit it, then ask one of them to approve.'
              : 'Sensitive financial request: check every amount and date against the contract before approving.'}</div>
          </div>
        ) : null}
        <div className="field"><label htmlFor="d-to">To</label><input id="d-to" className="input" value={draft.to_email || ''} readOnly /></div>
        <div className="field"><label htmlFor="d-subject">Subject</label><input id="d-subject" className="input" dir="auto" value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
        <div className="field">
          <label htmlFor="d-body">Message</label>
          <textarea id="d-body" className="textarea" dir={rtl ? 'rtl' : 'auto'} value={body} onChange={(e) => setBody(e.target.value)} />
          {incomplete ? <span className="warn-line">Replace every [[placeholder]] with the real detail before approving.</span> : <span className="hint">Nothing is sent until you approve it. {sends ? 'Approving sends the reply from the support mailbox.' : 'Approving saves it in the support mailbox Drafts folder, ready to send from Outlook.'}</span>}
        </div>
        <div className="hd-actions">
          <Button variant="primary" icon={Send} loading={busy === 'approve'} disabled={blocked || incomplete || !body.trim()} onClick={() => (sends && real ? setConfirmSend(true) : approve())}>
            {sends ? 'Approve and send' : 'Approve and save to Outlook'}
          </Button>
          {hasNext ? <Button icon={ChevronRight} disabled={blocked || incomplete || !body.trim() || busy === 'approve'} onClick={async () => { if (sends && real && !window.confirm(`Send this reply to ${draft.to_email} and open the next case?`)) return; if (await approve()) onNext(); }}>Approve, then next case</Button> : null}
          {dirty ? <Button icon={Check} loading={busy === 'save-draft'} onClick={() => run('save-draft', () => api.patch(`/helpdesk/drafts/${draft.id}`, { subject, body }), 'Draft saved')}>Save edits</Button> : null}
          <Button icon={RefreshCw} loading={busy === 'regen'} onClick={() => run('regen', () => api.post(`/helpdesk/cases/${c.id}/drafts`, { kind: draft.kind === 'followup' ? 'followup' : 'initial' }), 'New draft written')}>Write it again</Button>
          <Button icon={Trash2} onClick={() => setDiscard(true)}>Discard</Button>
        </div>
      </div>
      <ConfirmDialog open={confirmSend} title="Send this reply?" tone="primary" confirmLabel="Send reply" busy={busy === 'approve'}
        message={`The reply goes from the support mailbox to ${draft.to_email} straight away.`} onCancel={() => setConfirmSend(false)} onConfirm={async () => { await approve(); setConfirmSend(false); }} />
      <ConfirmDialog open={discard} title="Discard this draft?" confirmLabel="Discard" busy={busy === 'discard'} message="The draft is deleted. You can ask for a new one at any time."
        onCancel={() => setDiscard(false)} onConfirm={async () => { await run('discard', () => api.post(`/helpdesk/drafts/${draft.id}/discard`, { reason: 'Discarded by staff' }), 'Draft discarded'); setDiscard(false); }} />
    </section>
  );
}

/* ---------------------------- classification and routing ---------------------------- */
function ClassificationPanel({ c, meta, busy, run }) {
  const base = useMemo(() => ({ sub_key: c.sub_key || '', priority: c.priority || '', department: c.department || '', owner_id: c.owner_id ? String(c.owner_id) : '', contract_no: c.contract_no || '', amount: c.amount ?? '', location: c.location || '', customer_name: c.customer_name || '' }), [c]);
  const [f, setF] = useState(base);
  const [reason, setReason] = useState('');
  useEffect(() => { setF(base); setReason(''); }, [base]);
  const changed = Object.keys(base).filter((k) => String(f[k] ?? '') !== String(base[k] ?? ''));
  const judgement = changed.some((k) => ['sub_key', 'priority', 'department', 'owner_id'].includes(k));
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const cats = meta ? [...new Set(meta.subcategories.map((s) => s.category))] : [];
  const closed = c.status === 'closed';

  const save = () => {
    const patch = Object.fromEntries(changed.map((k) => [k, f[k] === '' ? null : f[k]]));
    return run('save-class', () => api.patch(`/helpdesk/cases/${c.id}`, { ...patch, reason: reason || undefined }), 'Saved');
  };
  return (
    <section className="hd-panel">
      <header>
        <h4>How the AI read this email</h4>
        <div className="row" style={{ gap: 8 }}>
          <Pill tone="neutral" dot={false}>{ENGINE_LABEL[c.classified_by] || sentence(c.classified_by || 'manual')}</Pill>
          <Confidence value={c.confidence} engine={c.classified_by} />
        </div>
      </header>
      <div className="body">
        {c.ai_summary ? <div className="hd-note" dir="auto" style={{ color: 'var(--text)' }}>{c.ai_summary}</div> : null}
        {c.matched_terms && c.matched_terms.length ? (
          <div><div className="hd-note" style={{ marginBottom: 6 }}>Wording that pointed to this request type</div><div className="hd-chips">{c.matched_terms.map((m, i) => <span key={i} className="tag" dir="auto">{m.term}{m.where === 'subject' ? ' (subject)' : ''}</span>)}</div></div>
        ) : null}
        <div className="form-grid">
          <div className="field"><label htmlFor="c-type">Request type</label>
            <select id="c-type" className="select" value={f.sub_key} onChange={set('sub_key')} disabled={closed || !meta}>
              {cats.map((cat) => <optgroup key={cat} label={cat}>{meta.subcategories.filter((s) => s.category === cat).map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</optgroup>)}
            </select></div>
          <div className="field"><label htmlFor="c-pri">Priority</label>
            <select id="c-pri" className="select" value={f.priority} onChange={set('priority')} disabled={closed}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></div>
          <div className="field"><label htmlFor="c-dep">Team</label>
            <select id="c-dep" className="select" value={f.department} onChange={set('department')} disabled={closed || !meta}>{meta ? meta.departments.map((d) => <option key={d}>{d}</option>) : null}</select></div>
          <div className="field"><label htmlFor="c-own">Owner</label>
            <select id="c-own" className="select" value={f.owner_id} onChange={set('owner_id')} disabled={closed || !meta}><option value="">Unassigned</option>{meta ? meta.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.department ? ` (${p.department})` : ''}</option>) : null}</select></div>
          <div className="field"><label htmlFor="c-con">Contract number</label><input id="c-con" className="input" value={f.contract_no} onChange={set('contract_no')} disabled={closed} placeholder="AST-100123" />
            {c.contract_inferred ? <span className="warn-line">Guessed from the sender's latest rental. Confirm it with the customer.</span> : null}</div>
          <div className="field"><label htmlFor="c-amt">Amount (AED)</label><input id="c-amt" className="input" inputMode="decimal" value={f.amount} onChange={set('amount')} disabled={closed} /></div>
          <div className="field"><label htmlFor="c-loc">Location</label><input id="c-loc" className="input" value={f.location} onChange={set('location')} disabled={closed} /></div>
          <div className="field"><label htmlFor="c-nam">Customer name</label><input id="c-nam" className="input" value={f.customer_name} onChange={set('customer_name')} disabled={closed} /></div>
        </div>
        {c.priority_reasons && c.priority_reasons.length ? (
          <div><div className="hd-note" style={{ marginBottom: 4 }}>Why this priority</div><ul className="hd-reasons">{c.priority_reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
        ) : null}
        {judgement ? (
          <div className="field"><label htmlFor="c-why">Why are you changing it? (optional, it helps tune the AI)</label><input id="c-why" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: the customer is also disputing a fine" /></div>
        ) : null}
        <div className="hd-actions">
          {changed.length ? <Button variant="primary" icon={Check} loading={busy === 'save-class'} onClick={save}>Save changes</Button> : null}
          {changed.length ? <Button onClick={() => { setF(base); setReason(''); }}>Undo</Button> : null}
          {c.needs_review && !changed.length && !closed ? <Button variant="primary" icon={CheckCircle2} loading={busy === 'confirm'} onClick={() => run('confirm', () => api.patch(`/helpdesk/cases/${c.id}`, { confirm: true }), 'Classification confirmed')}>The classification is right</Button> : null}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ facts, history and notes ------------------------------ */
const INSIGHT_ICON = { danger: AlertTriangle, warn: AlertTriangle, info: Info, ok: CheckCircle2 };

function InsightsPanel({ insights }) {
  if (!insights || !insights.length) return null;
  return (
    <section className="hd-panel">
      <header><h4><Lightbulb size={15} style={{ verticalAlign: -2, marginRight: 6 }} />What to look at</h4><span className="hd-note">From the customer records and the case history</span></header>
      <div className="body" style={{ gap: 0 }}>
        {insights.map((i, n) => {
          const Icon = INSIGHT_ICON[i.tone] || Info;
          return <div className="hd-insight" key={n}><span className={`ico ${i.tone}`}><Icon size={16} strokeWidth={2} /></span><div><b dir="auto">{i.title}</b>{i.detail ? <span dir="auto">{i.detail}</span> : null}</div></div>;
        })}
      </div>
    </section>
  );
}

function SimilarPanel({ similar, onOpenCase }) {
  const toast = useToast();
  const [open, setOpen] = useState(null);
  if (!similar || !similar.length) return null;
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast.success('Copied'); } catch { toast.error('Could not copy'); } };
  return (
    <div>
      <div className="section-title"><span>Cases like this one, and how we answered</span></div>
      <div className="related">
        {similar.map((x) => (
          <div key={x.id} style={{ borderBottom: '1px solid var(--line)' }}>
            <button type="button" className="rrow" style={{ borderBottom: 0 }} onClick={() => onOpenCase(x.id)}>
              <div className="grow"><div className="cell-main ellipsis" dir="auto">{x.subject}</div><div className="cell-sub">{x.case_no} · {x.sub_category} · {x.status === 'closed' ? `closed (${x.closure_reason ? x.closure_reason.replace(/_/g, ' ') : 'done'})` : 'still open'} · {Math.round(x.similarity * 100)}% alike</div></div>
            </button>
            {x.reply ? (
              <div style={{ padding: '0 14px 12px' }}>
                <button type="button" className="btn btn-xs btn-soft" onClick={() => setOpen(open === x.id ? null : x.id)}>{open === x.id ? 'Hide our reply' : 'Show our reply'}</button>
                {open === x.id ? (
                  <div className="hd-note-item" style={{ marginTop: 8, background: 'var(--tint-50)' }}>
                    <div className="hd-body" dir="auto" style={{ fontSize: 13 }}>{x.reply.body}</div>
                    <div className="hd-actions" style={{ marginTop: 8 }}><Button size="xs" icon={Copy} onClick={() => copy(x.reply.body)}>Copy the text</Button><span className="hd-note">For reference only. Names and amounts belong to the other customer.</span></div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function NotesPanel({ c, busy, run }) {
  const [text, setText] = useState('');
  return (
    <div>
      <div className="section-title"><span>Internal notes</span><span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>never sent to the customer</span></div>
      <div className="hd-stack" style={{ gap: 8 }}>
        {c.notes.map((n) => <div className="hd-note-item" key={n.id}><div className="who">{n.user_name} · {relTime(n.created_at)}</div><div className="hd-body" dir="auto">{n.body}</div></div>)}
        <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <textarea className="textarea" rows={2} dir="auto" placeholder="Leave a note for colleagues, for example: called Accounts, refund goes out Thursday" value={text} onChange={(e) => setText(e.target.value)} aria-label="New internal note" />
          <Button icon={StickyNote} loading={busy === 'note'} disabled={!text.trim()} onClick={async () => { if (await run('note', () => api.post(`/helpdesk/cases/${c.id}/notes`, { body: text }), 'Note added')) setText(''); }}>Add</Button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------- page ---------------------------------------- */
export default function CaseDrawer({ caseId, ids = [], onClose, onChanged, onOpenCase }) {
  const { user, can } = useAuth();
  const toast = useToast();
  const meta = useMeta();
  const [c, setC] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('resolved');
  const [note, setNote] = useState('');
  const [simulate, setSimulate] = useState('');

  const load = useCallback(() => api.get(`/helpdesk/cases/${caseId}`).then((r) => { setC(r); setError(''); }).catch((e) => setError(e.message)), [caseId]);
  useEffect(() => { setC(null); load(); }, [load]);

  /** Runs an action, shows the result, refreshes this case and the list behind it. */
  const run = useCallback(async (key, fn, ok) => {
    setBusy(key);
    try {
      const res = await fn();
      const next = res && res.case ? res.case : res;
      if (next && next.id) setC(next); else await load();
      if (ok) toast.success(ok);
      if (onChanged) onChanged();
      return true;
    } catch (e) {
      toast.error(e.message);
      return false;
    } finally {
      setBusy('');
    }
  }, [load, onChanged, toast]);

  const pos = ids.indexOf(caseId);
  const prevId = pos > 0 ? ids[pos - 1] : null;
  const nextId = pos >= 0 && pos < ids.length - 1 ? ids[pos + 1] : null;
  const pendingDraft = c ? c.drafts.find((d) => d.status === 'pending') : null;
  const closed = c && c.status === 'closed';
  const hasReply = c && c.messages.some((m) => m.direction === 'out');
  const openClose = (preset) => { setReason(preset || 'resolved'); setNote(''); setClosing(true); };

  const head = c ? (
    <div className="hd-case-head">
      <div className="row wrap" style={{ gap: 8 }}>
        <span className="mono strong">{c.case_no}</span>
        <CaseStatusPill value={c.status} />
        <PriorityPill value={c.priority} />
        {c.escalation_level > 0 ? <Pill tone="danger" dot={false}>Escalated, level {c.escalation_level}</Pill> : null}
        {c.sensitive ? <Pill tone="navy" dot={false}><Lock size={11} style={{ marginRight: 4 }} />Sensitive</Pill> : null}
        {c.parent_case_id ? <Pill tone="info" dot={false}>Split from another case</Pill> : null}
      </div>
      {pos >= 0 && ids.length > 1 ? (
        <div className="hd-nav" style={{ marginTop: 8 }}>
          <button type="button" className="icon-btn sm" aria-label="Previous case" disabled={!prevId} onClick={() => onOpenCase(prevId)}><ChevronLeft size={16} /></button>
          <span className="muted small">{pos + 1} of {ids.length} in this list</span>
          <button type="button" className="icon-btn sm" aria-label="Next case" disabled={!nextId} onClick={() => onOpenCase(nextId)}><ChevronRight size={16} /></button>
        </div>
      ) : null}
      <h2 dir="auto">{c.subject}</h2>
      <div className="muted small">{c.customer_name || 'Unknown sender'} · {c.customer_email} · {c.sub_category} · received {fmtDateTime(c.first_received_at)}</div>
      <div className="row wrap" style={{ gap: 14, marginTop: 8 }}>
        <span className="row small" style={{ gap: 6 }}><Clock size={14} /><DueText c={c} /></span>
        <OwnerCell name={c.owner_name} />
        {!closed && c.owner_id !== user.id ? <Button size="xs" icon={User} loading={busy === 'take'} onClick={() => run('take', () => api.patch(`/helpdesk/cases/${c.id}`, { owner_id: user.id }), 'This case is yours now')}>Take it</Button> : null}
        <span className="muted small">{c.department}</span>
      </div>
    </div>
  ) : <span className="skel" style={{ width: '60%', height: 24 }} />;

  const footer = c ? (
    <>
      {!closed ? (
        <select className="select" aria-label="Case status" style={{ width: 'auto' }} value={c.status} onChange={(e) => run('status', () => api.post(`/helpdesk/cases/${c.id}/status`, { status: e.target.value }), 'Status updated')}>
          <option value="open">Open, we are working on it</option>
          <option value="pending_customer">Waiting for the customer</option>
          <option value="pending_internal">Waiting for another team</option>
        </select>
      ) : null}
      {c.mailbox_link ? <a className="btn btn-ghost" href={c.mailbox_link} target="_blank" rel="noreferrer"><ExternalLink size={16} />Open in Outlook</a> : null}
      <span style={{ marginLeft: 'auto' }} />
      {closed
        ? <Button variant="primary" loading={busy === 'reopen'} onClick={() => run('reopen', () => api.post(`/helpdesk/cases/${c.id}/reopen`, {}), 'Case reopened')}>Reopen case</Button>
        : <Button variant="primary" icon={CheckCircle2} onClick={() => openClose()}>Close case</Button>}
    </>
  ) : null;

  return (
    <Drawer open onClose={onClose} head={head} footer={footer} className="hd-wide">
      {error ? <div className="notice"><AlertTriangle size={20} /><div className="grow">{error}</div><Button size="sm" onClick={load}>Try again</Button></div> : null}
      {!c && !error ? <><span className="skel" style={{ width: '90%', height: 18 }} /><span className="skel" style={{ width: '70%', height: 18 }} /><span className="skel" style={{ width: '80%', height: 120 }} /></> : null}
      {c ? (
        <>
          {closed ? (
            <div className="hd-banner ok"><CheckCircle2 size={18} /><div className="grow">Closed {fmtDateTime(c.closed_at)}: {meta ? (meta.closure_reasons.find((r) => r.value === c.closure_reason) || {}).label || sentence(c.closure_reason) : sentence(c.closure_reason)}{c.closure_note ? `. ${c.closure_note}` : ''}</div></div>
          ) : null}
          {!closed && c.suggest_close ? (
            <div className="hd-banner info"><CheckCircle2 size={18} /><div className="grow">The customer's last message sounds like thanks. If it is resolved, close the case.</div><Button size="sm" variant="primary" onClick={() => openClose('customer_confirmed')}>Close it</Button></div>
          ) : null}
          {!closed && c.escalation_level > 0 ? (
            <div className="hd-banner danger"><AlertTriangle size={18} /><div className="grow">This case is past its service-level time and was escalated (level {c.escalation_level}). The audit trail below shows who was told.</div></div>
          ) : null}
          {!closed && c.needs_review ? (
            <div className="hd-banner warn"><Sparkles size={18} /><div className="grow">The AI was only {Math.round((c.confidence || 0) * 100)}% sure about the request type. Check it below.</div></div>
          ) : null}

          {pendingDraft ? <DraftPanel c={c} draft={pendingDraft} meta={meta} user={user} busy={busy} run={run} hasNext={Boolean(nextId)} onNext={() => onOpenCase(nextId)} /> : null}
          <InsightsPanel insights={c.insights} />
          {!pendingDraft && !closed ? (
            <div className="hd-banner info">
              <FileText size={18} />
              <div className="grow">No reply is waiting. {hasReply ? 'Draft a reminder if the customer has gone quiet.' : 'Draft a reply from the approved wording.'}</div>
              <Button size="sm" loading={busy === 'draft'} onClick={() => run('draft', () => api.post(`/helpdesk/cases/${c.id}/drafts`, { kind: 'initial' }), 'Reply drafted')}>Draft a reply</Button>
              {hasReply ? <Button size="sm" loading={busy === 'remind'} onClick={() => run('remind', () => api.post(`/helpdesk/cases/${c.id}/drafts`, { kind: 'followup' }), 'Reminder drafted')}>Draft a reminder</Button> : null}
            </div>
          ) : null}

          <div>
            <div className="section-title"><span>Conversation</span><span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>{c.messages.length} message{c.messages.length === 1 ? '' : 's'}</span></div>
            <div className="hd-stack" style={{ gap: 10 }}>
              {c.messages.map((m) => (
                <div key={m.id} className={`hd-msg ${m.direction}`}>
                  <div className="who"><span><b>{m.direction === 'out' ? 'Autostrad' : (m.from_name || m.from_email)}</b>{m.direction === 'in' && m.from_name ? ` <${m.from_email}>` : ''}</span><span title={fmtDateTime(m.received_at)}>{relTime(m.received_at)}</span></div>
                  <div className="hd-body" dir="auto">{m.body}</div>
                  {m.attachments && m.attachments.length ? <div className="hd-note" style={{ marginTop: 6 }}>Has attachments. Open the message in Outlook to see them.</div> : null}
                </div>
              ))}
            </div>
            {meta && meta.provider === 'demo' && !closed ? (
              <div className="hd-panel" style={{ marginTop: 12 }}>
                <header><h4>Demo mailbox: pretend the customer wrote back</h4></header>
                <div className="body">
                  <input className="input" dir="auto" placeholder="Leave empty for a random customer reply" value={simulate} onChange={(e) => setSimulate(e.target.value)} aria-label="Customer reply text" />
                  <div className="hd-actions"><Button icon={ArrowUpRight} loading={busy === 'simulate'} onClick={async () => { const ok = await run('simulate', async () => { await api.post('/helpdesk/mailbox/demo/reply', { case_id: c.id, text: simulate || undefined }); return api.get(`/helpdesk/cases/${c.id}`); }, 'The customer replied'); if (ok) setSimulate(''); }}>Send the customer's reply</Button></div>
                </div>
              </div>
            ) : null}
          </div>

          <NotesPanel c={c} busy={busy} run={run} />
          <ClassificationPanel c={c} meta={meta} busy={busy} run={run} />
          <AccountPanel c={c} busy={busy} run={run} canWork={can('helpdesk.work')} />
          <SimilarPanel similar={c.similar} onOpenCase={onOpenCase} />

          {c.related.length ? (
            <div>
              <div className="section-title"><span>Other cases for this contract or sender</span></div>
              <div className="related">
                {c.related.map((r) => (
                  <button type="button" key={r.id} className="rrow" onClick={() => onOpenCase(r.id)}>
                    <div className="grow"><div className="cell-main ellipsis" dir="auto">{r.subject}</div><div className="cell-sub">{r.case_no} · {r.sub_category} · {fmtDate(r.first_received_at)}</div></div>
                    <div className="right nowrap"><CaseStatusPill value={r.status} /></div>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <div className="section-title"><span>Everything that happened</span><span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>newest first</span></div>
            <div className="hd-timeline">
              {c.audit.map((a) => (
                <div className="ev" key={a.id}>
                  <span className={`dot ${a.actor_type}`}>{a.actor_type === 'ai' ? <Sparkles size={14} /> : a.actor_type === 'user' ? <User size={14} /> : <Cog size={14} />}</span>
                  <div>
                    <div className="what">{ACTION[a.action] || sentence(a.action)}{a.field ? `: ${FIELD[a.field] || a.field}` : ''}{a.old_value || a.new_value ? <span className="muted" style={{ fontWeight: 600 }}>{a.old_value ? ` ${a.old_value}` : ''}{a.old_value && a.new_value ? ' to' : ''}{a.new_value ? ` ${a.new_value}` : ''}</span> : null}</div>
                    <div className="det" dir="auto">{a.actor_name}{a.detail ? `. ${a.detail}` : ''}</div>
                  </div>
                  <span className="t" title={fmtDateTime(a.at)}>{relTime(a.at)}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}

      <Modal open={closing} onClose={() => setClosing(false)} title="Close this case" size="sm"
        footer={(<><Button onClick={() => setClosing(false)}>Cancel</Button><Button variant="primary" loading={busy === 'close'} onClick={async () => { const ok = await run('close', () => api.post(`/helpdesk/cases/${caseId}/close`, { reason, note }), 'Case closed'); if (ok) setClosing(false); }}>Close case</Button></>)}>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
          <div className="field"><label htmlFor="cl-r">Why is it closed?</label>
            <select id="cl-r" className="select" value={reason} onChange={(e) => setReason(e.target.value)}>{meta ? meta.closure_reasons.map((r) => <option key={r.value} value={r.value}>{r.label}</option>) : null}</select></div>
          <div className="field"><label htmlFor="cl-n">Note (optional)</label><textarea id="cl-n" className="textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </div>
      </Modal>
    </Drawer>
  );
}
