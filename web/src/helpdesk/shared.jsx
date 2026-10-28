// Small pieces shared by the helpdesk screens: labels and colours, the lookup lists, SLA wording, a pager.
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { Avatar, Pill } from '../components/ui';
import { toDate } from '../lib/format';

export const PRIORITIES = ['Critical', 'High', 'Average', 'Low'];
export const PRIORITY_TONE = { Critical: 'danger', High: 'warn', Average: 'info', Low: 'neutral' };
export const PRIORITY_COLOR = { Critical: '#e5484d', High: '#e8a23a', Average: '#2e86ce', Low: '#94a3b8' };
export const CASE_STATUS = {
  open: ['info', 'Open'], pending_customer: ['warn', 'Waiting for customer'], pending_internal: ['warn', 'Waiting internally'], closed: ['neutral', 'Closed'],
};
export const CATEGORY_COLOR = { Complaint: '#e5484d', 'Service Request': '#2e86ce', 'Pre-Authorization': '#e8a23a', Refund: '#1fa971', Dispute: '#7c5cd6', Other: '#94a3b8' };
export const ENGINE_LABEL = { rules: 'Keyword rules', 'rules+model': 'Keyword rules and learned model', 'rules+llm': 'Rules and AI agree', llm: 'AI', manual: 'Chosen by staff' };

export const PriorityPill = ({ value }) => (value ? <Pill tone={PRIORITY_TONE[value] || 'neutral'}>{value}</Pill> : <span className="faint">-</span>);
export const CaseStatusPill = ({ value }) => {
  const [tone, label] = CASE_STATUS[value] || ['neutral', value];
  return <Pill tone={tone}>{label}</Pill>;
};

/** Where a case stands against its service-level time. */
export function dueInfo(c) {
  if (!c || !c.due_at || c.status === 'closed') return { text: '', tone: 'neutral' };
  if (c.status === 'pending_customer') return { text: 'Clock paused', tone: 'neutral', paused: true };
  const d = toDate(c.due_at);
  if (!d) return { text: '', tone: 'neutral' };
  const hrs = (d.getTime() - Date.now()) / 3600000;
  const abs = Math.abs(hrs);
  const label = abs < 1 ? `${Math.max(1, Math.round(abs * 60))}m` : abs < 48 ? `${Math.round(abs)}h` : `${Math.round(abs / 24)}d`;
  return hrs < 0 ? { text: `${label} overdue`, tone: 'danger' } : { text: `Due in ${label}`, tone: hrs < 6 ? 'warn' : 'ok' };
}

export const DueText = ({ c }) => {
  const d = dueInfo(c);
  if (!d.text) return <span className="faint">-</span>;
  return <span className={`hd-due ${d.tone}`}>{d.text}</span>;
};

export const OwnerCell = ({ name }) => (name
  ? <span className="row" style={{ gap: 8 }}><Avatar name={name} size={26} /><span className="ellipsis" style={{ maxWidth: 110 }}>{name}</span></span>
  : <span className="faint">Unassigned</span>);

export function Confidence({ value, engine }) {
  const v = Math.round((Number(value) || 0) * 100);
  const tone = v >= 75 ? 'ok' : v >= 55 ? 'warn' : 'danger';
  return (
    <div className="hd-conf" title={engine ? ENGINE_LABEL[engine] || engine : undefined}>
      <div className={`bar ${tone}`}><i style={{ width: `${v}%` }} /></div>
      <b>{v}%</b>
    </div>
  );
}

/* lookup lists (request types, departments, people) load once */
let metaPromise = null;
export function loadMeta(force = false) {
  if (!metaPromise || force) metaPromise = api.get('/helpdesk/meta').catch((e) => { metaPromise = null; throw e; });
  return metaPromise;
}
export function useMeta() {
  const [meta, setMeta] = useState(null);
  useEffect(() => {
    let alive = true;
    loadMeta().then((m) => { if (alive) setMeta(m); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return meta;
}

export function Pager({ page, pages, onChange }) {
  if (pages <= 1) return null;
  const list = [];
  for (let p = 1; p <= pages; p++) if (p === 1 || p === pages || Math.abs(p - page) <= 1) list.push(p);
  const withGaps = list.flatMap((p, i) => (i && p - list[i - 1] > 1 ? ['...', p] : [p]));
  return (
    <div className="pager">
      <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page"><ChevronLeft size={16} /></button>
      {withGaps.map((p, i) => (p === '...' ? <span key={`g${i}`} className="faint">...</span> : <button type="button" key={p} className={p === page ? 'active' : ''} onClick={() => onChange(p)}>{p}</button>))}
      <button type="button" disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label="Next page"><ChevronRight size={16} /></button>
    </div>
  );
}

export const useDebounced = (value, ms = 280) => {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
};

export const sentence = (s) => { const t = String(s ?? '').replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };

/* wording for the audit trail */
export const ACTION = {
  email_received: 'Email received', classified: 'Classified', extracted: 'Details extracted', customer_matched: 'Customer matched', history_matched: 'History checked',
  priority_set: 'Priority set', assigned: 'Assigned', outlook_tagged: 'Tagged in Outlook', draft_generated: 'Reply drafted', followup_drafted: 'Reminder drafted',
  draft_edited: 'Draft edited', draft_approved: 'Draft approved', draft_discarded: 'Draft discarded', reply_sent: 'Reply sent', customer_replied: 'Customer replied',
  closed: 'Closed', reopened: 'Reopened', escalated: 'Escalated', override: 'Corrected by staff', field_changed: 'Edited', classification_confirmed: 'Classification confirmed',
  status_changed: 'Status changed', case_split: 'New topic split off', note_added: 'Note added', reassigned: 'Reassigned', auto_reply_ignored: 'Automatic reply ignored', model_retrained: 'Learned model retrained',
  test_run: 'Accuracy test run', setting_changed: 'Setting changed', mailbox_synced: 'Mailbox checked', report_generated: 'Report built',
  account_refreshed: 'Customer details loaded', account_lookup_failed: 'Customer details not available', sender_verified: 'Sender confirmed',
};
export const FIELD = { sub_key: 'request type', priority: 'priority', department: 'team', owner_id: 'owner', contract_no: 'contract', customer_name: 'customer', customer_email: 'email', amount: 'amount', location: 'location', fine_ref: 'fine reference', card_last4: 'card digits', details: 'details', language: 'language', status: 'status' };

/**
 * Polls the helpdesk summary every 30 seconds, so mail that arrives from Outlook shows up without anyone pressing a
 * button. `onNew(count, summary)` fires when more cases exist than the last time we looked.
 */
export function useLiveSummary(onNew) {
  const [summary, setSummary] = useState(null);
  const last = useRef(null);
  const cb = useRef(onNew);
  cb.current = onNew;
  useEffect(() => {
    let alive = true;
    const tick = () => api.get('/helpdesk/summary').then((r) => {
      if (!alive) return;
      if (last.current !== null && r.total > last.current && cb.current) cb.current(r.total - last.current, r);
      last.current = r.total;
      setSummary(r);
    }).catch(() => {});
    tick();
    const t = setInterval(tick, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return summary;
}

/** "Live: Outlook is checked every 2 minutes, last check 1m ago" */
export function LiveBadge({ summary }) {
  if (!summary) return null;
  const demo = summary.provider === 'demo';
  const mins = summary.last_checked_at ? Math.max(0, Math.round((Date.now() - new Date(summary.last_checked_at).getTime()) / 60000)) : null;
  return (
    <span className="hd-live" title={demo ? 'The demo mailbox is checked automatically too. Connect Outlook under Setup to receive real emails.' : 'New emails are read from Outlook automatically'}>
      <i className={demo ? 'demo' : ''} />
      {demo ? 'Demo mailbox' : 'Outlook'} checked every {summary.sync_minutes} min{mins === null ? '' : `, last ${mins < 1 ? 'just now' : `${mins} min ago`}`}
    </span>
  );
}
