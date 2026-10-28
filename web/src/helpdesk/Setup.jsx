// Helpdesk setup: the mailbox connection and safety switches, reply wording, keywords, routing and timing, the other
// channels' counts, and the audit log. Admin and IT change wording and rules; the connection and switches are for IT only.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, FlaskConical, Lock, MailCheck, RefreshCw, Save, Sparkles, Stethoscope, XCircle } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../toast';
import CrudPage from '../components/CrudPage';
import { Button, Card, EmptyState, PageHeader, Pill, Tabs } from '../components/ui';
import { fmtDateTime, relTime } from '../lib/format';
import { buildConfigs } from './config';
import CustomerData from './CustomerData';
import Readiness from './Readiness';
import { ACTION, FIELD, Pager, sentence, useDebounced, useMeta } from './shared';

const TABS = [['mailbox', 'Mailbox and AI'], ['customer', 'Customer data'], ['wording', 'Reply wording'], ['keywords', 'Keywords'], ['routing', 'Routing and timing'], ['channels', 'Other channels'], ['audit', 'Audit log']];

/* ------------------------------------ mailbox and AI ------------------------------------ */
function Mailbox({ system }) {
  const toast = useToast();
  const meta = useMeta();
  const [m, setM] = useState(null);
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState('');
  const [demo, setDemo] = useState({ count: 3, sub_key: '', lang: '' });
  const [test, setTest] = useState(null);

  const load = useCallback(() => Promise.all([
    api.get('/helpdesk/mailbox').then(setM),
    api.get('/helpdesk/settings').then(setS),
  ]).catch((e) => toast.error(e.message)), [toast]);
  useEffect(() => { load(); }, [load]);

  const save = async (patch, ok) => {
    setBusy('save');
    try { await api.put('/helpdesk/settings', patch); toast.success(ok || 'Saved'); await load(); } catch (e) { toast.error(e.message); } finally { setBusy(''); }
  };
  const sync = async () => {
    setBusy('sync');
    try { const r = await api.post('/helpdesk/mailbox/sync'); toast[r.errors && r.errors.length ? 'error' : 'success'](r.errors && r.errors.length ? `Problem: ${r.errors[0]}` : `Checked: ${r.created} new, ${r.attached} replies, ${r.outbound} sent`); await load(); } catch (e) { toast.error(e.message); } finally { setBusy(''); }
  };
  const runTest = async () => {
    setBusy('test');
    try { setTest(await api.post('/helpdesk/mailbox/test', {})); } catch (e) { toast.error(e.message); } finally { setBusy(''); }
  };
  const receive = async () => {
    setBusy('demo');
    try { const r = await api.post('/helpdesk/mailbox/demo/emails', { count: Number(demo.count), sub_key: demo.sub_key || undefined, lang: demo.lang || undefined }); toast.success(`${r.created} new case${r.created === 1 ? '' : 's'} from the sample emails`); await load(); } catch (e) { toast.error(e.message); } finally { setBusy(''); }
  };

  if (!m) return <span className="skel" style={{ width: '100%', height: 160 }} />;
  const values = s ? s.values : null;
  const locked = (k) => Boolean(s && s.locked.includes(k));
  const st = m.status;
  const last = m.last_sync;

  return (
    <>
      <Readiness />
      <div className="hd-grid c2" style={{ alignItems: 'start' }}>
        <Card title="Support mailbox" sub={m.status.mailbox} action={<Pill tone={st.connected ? 'ok' : 'danger'}>{st.connected ? 'Connected' : 'Not connected'}</Pill>}>
          <div className="hd-lines">
            <div className="ln"><span>Source</span><b>{m.provider === 'graph' ? 'Microsoft 365 (shared mailbox)' : 'Built-in demo mailbox'}</b></div>
            <div className="ln"><span>Last checked</span><b>{last && last.at ? `${relTime(last.at.replace('T', ' ').slice(0, 19))} (${fmtDateTime(last.at.replace('T', ' ').slice(0, 19))})` : 'never'}</b></div>
            {last && last.ok_at && last.ok_at !== last.at ? <div className="ln"><span>Last successful read</span><b>{`${relTime(last.ok_at.replace('T', ' ').slice(0, 19))} (${fmtDateTime(last.ok_at.replace('T', ' ').slice(0, 19))})`}</b></div> : null}
            {last && last.result ? <div className="ln"><span>Last result</span><b>{last.result.created} new, {last.result.attached} replies, {last.result.outbound} sent{last.result.errors && last.result.errors.length ? `, ${last.result.errors.length} problem(s)` : ''}</b></div> : null}
            <div className="ln"><span>In the helpdesk</span><b>{m.counts.cases} cases, {m.counts.messages} messages</b></div>
          </div>
          <p className="hd-note" style={{ margin: '10px 0' }}>{st.detail}</p>
          {last && last.result && last.result.errors && last.result.errors.length ? <div className="hd-banner danger"><AlertTriangle size={18} /><div className="grow">{last.result.errors[0]}</div></div> : null}
          <div className="hd-actions" style={{ marginTop: 12 }}>
            <Button variant="primary" icon={MailCheck} loading={busy === 'sync'} onClick={sync}>Check the mailbox now</Button>
            <Button icon={Stethoscope} loading={busy === 'test'} onClick={runTest}>Test the Outlook connection</Button>
          </div>
          {test ? (
            <div style={{ marginTop: 12 }}>
              {test.steps.map((x) => (
                <div className="hd-step" key={x.key}>
                  <span className={`mark ${x.ok ? 'done' : x.optional ? 'optional' : ''}`} style={!x.ok && !x.optional ? { background: 'var(--danger-bg)', color: 'var(--danger-fg)' } : undefined}>{x.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}</span>
                  <div className="grow"><b>{x.title}</b><div className="hd-note">{x.detail}</div>{x.fix ? <div className="hd-note" style={{ color: x.optional ? undefined : 'var(--danger-fg)' }}>How to fix: {x.fix}</div> : null}</div>
                </div>
              ))}
            </div>
          ) : null}
          <p className="hd-note" style={{ marginTop: 10 }}>The mailbox is also checked automatically every {m.sync_minutes} minutes. Follow-up reminders and escalations run every 15 minutes.</p>
        </Card>

        <Card title="Safety" sub="Nothing is ever sent without a person approving it">
          <div className="field">
            <label>When a reply is approved</label>
            <div className="hd-stack" style={{ gap: 8 }}>
              {[['draft_only', 'Save it in the Outlook Drafts folder (recommended)', 'Staff open Outlook, read it once more and press Send. The safest way to start.'], ['send_after_approval', 'Send it from the helpdesk', 'The reply is sent from the support mailbox the moment a person approves it.']].map(([v, label, hint]) => (
                <label key={v} className="row" style={{ gap: 10, alignItems: 'flex-start', opacity: system && !locked('send_mode') ? 1 : 0.7 }}>
                  <input type="radio" name="send_mode" checked={m.send_mode === v} disabled={!system || locked('send_mode') || busy === 'save'} onChange={() => save({ send_mode: v }, 'Saved')} style={{ marginTop: 4 }} />
                  <span><b>{label}</b><br /><span className="hd-note">{hint}</span></span>
                </label>
              ))}
            </div>
            {locked('send_mode') ? <span className="hint"><Lock size={12} /> Fixed by the server setting HELPDESK_SEND_MODE.</span> : null}
          </div>
          <label className="row" style={{ gap: 10, marginTop: 14, fontWeight: 600 }}>
            <input type="checkbox" checked={Boolean(m.outlook_writeback)} disabled={!system || busy === 'save'} onChange={(e) => save({ outlook_writeback: e.target.checked })} />
            Tag each customer email in Outlook with the category, priority, owner and due date
          </label>
          <p className="hd-note" style={{ marginTop: 6 }}>Sensitive financial replies (charges, refunds, deposits, card changes) always need a finance, admin or IT user to approve them.</p>
          {!system ? <p className="hd-note"><Lock size={12} /> Only IT can change these.</p> : null}
        </Card>
      </div>

      <Card title="AI" sub="Optional. It reads each email, suggests the type, priority and details, and rewrites replies where there is no approved wording" className="hd-mt"
        action={<Pill tone={m.ai.configured ? 'ok' : 'neutral'}>{m.ai.configured ? 'Key found on the server' : 'No key: rules and learned model'}</Pill>}>
        <div className="hd-grid c2" style={{ marginBottom: 0 }}>
          <div className="hd-lines">
            <div className="ln"><span>Model</span><b>{m.ai.configured ? m.ai.model : 'not in use'}</b></div>
            <div className="ln"><span>Calls this session</span><b>{m.ai.health.calls} ({m.ai.health.failures} failed)</b></div>
            {m.ai.health.lastError ? <div className="ln"><span>Last problem</span><b>{m.ai.health.lastError}</b></div> : null}
          </div>
          <div>
            <div className="field">
              <label htmlFor="llm-mode">When the AI is used</label>
              <select id="llm-mode" className="select" value={m.ai.mode} disabled={!system || !m.ai.configured || locked('llm_mode') || busy === 'save'} onChange={(e) => save({ llm_mode: e.target.value })}>
                <option value="always">On every new email</option>
                <option value="fallback">Only when the keyword rules are unsure</option>
                <option value="off">Never</option>
              </select>
            </div>
            <label className="row" style={{ gap: 10, marginTop: 12, fontWeight: 600 }}>
              <input type="checkbox" checked={Boolean(values && values.draft_llm_personalize)} disabled={!system || !m.ai.configured || busy === 'save'} onChange={(e) => save({ draft_llm_personalize: e.target.checked })} />
              Let the AI polish approved reply wording for each customer
            </label>
          </div>
        </div>
        <p className="hd-note" style={{ marginTop: 12 }}>
          {m.ai.configured ? 'Emails are stripped of card numbers, IDs and bank details before they are sent to the AI. The AI can be wrong, which is why a person approves every reply and can correct every classification.' : 'To switch it on, IT adds ANTHROPIC_API_KEY to the server file shown below. The key is never typed into this app.'}
        </p>
      </Card>

      {m.provider === 'demo' ? (
        <Card title="Demo mailbox tools" sub="This copy runs on a built-in mailbox so you can try everything without connecting Microsoft 365" className="hd-mt">
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
            <div className="field"><label htmlFor="d-n">How many emails</label><select id="d-n" className="select" value={demo.count} onChange={(e) => setDemo({ ...demo, count: e.target.value })}>{[1, 3, 5, 10].map((n) => <option key={n}>{n}</option>)}</select></div>
            <div className="field"><label htmlFor="d-t">About</label><select id="d-t" className="select" value={demo.sub_key} onChange={(e) => setDemo({ ...demo, sub_key: e.target.value })}><option value="">A realistic mix</option>{meta ? meta.subcategories.map((x) => <option key={x.key} value={x.key}>{x.name}</option>) : null}</select></div>
            <div className="field"><label htmlFor="d-l">Language</label><select id="d-l" className="select" value={demo.lang} onChange={(e) => setDemo({ ...demo, lang: e.target.value })}><option value="">Mostly English</option><option value="en">English</option><option value="ar">Arabic</option></select></div>
          </div>
          <div className="hd-actions" style={{ marginTop: 12 }}><Button icon={FlaskConical} loading={busy === 'demo'} disabled={!system && false} onClick={receive}>Receive sample emails</Button><Link to="/helpdesk/cases" className="btn btn-ghost">Open the cases</Link></div>
          <p className="hd-note" style={{ marginTop: 10 }}>The sample emails use real customers and contracts from this CRM and go through exactly the same steps as live mail. In a case you can also pretend the customer replied.</p>
        </Card>
      ) : null}

      <Card title="Connecting the real Microsoft 365 mailbox" sub="A one-time job for whoever administers Autostrad's Microsoft 365" className="hd-mt">
        <ol className="hd-steps">
          <li>In the Microsoft Entra admin center, open <b>App registrations</b> and create an app called "Autostrad Helpdesk" (this directory only).</li>
          <li>Under <b>API permissions</b> add Microsoft Graph <b>application</b> permissions <span className="hd-code">Mail.ReadWrite</span> (read, tag and draft), <span className="hd-code">Mail.Send</span> (only if replies should be sent from here) and optionally <span className="hd-code">MailboxSettings.ReadWrite</span> (creates the coloured category labels). Then <b>grant admin consent</b>.</li>
          <li>Under <b>Certificates and secrets</b> create a client secret and copy its value.</li>
          <li>Limit the app to the helpdesk mailbox only, with an Exchange Online application access policy (or the newer RBAC for Applications scope), so it cannot read anyone else's mail.</li>
          <li>On the server, create or edit the file <span className="hd-code">server/.env</span> with the lines below, then restart the server. The secret stays on the server and is never entered in this app.</li>
          <li>Come back to this page: the status above should say <b>Connected</b>. Start with "Save it in the Outlook Drafts folder". Switch to sending from the helpdesk later, once the team trusts the drafts.</li>
        </ol>
        <div className="hd-pre" style={{ marginTop: 12 }}>{`HELPDESK_PROVIDER=graph
HELPDESK_MAILBOX=helpdesk@autostrad.com
GRAPH_TENANT_ID=<directory (tenant) ID>
GRAPH_CLIENT_ID=<application (client) ID>
GRAPH_CLIENT_SECRET=<client secret value>
# optional: switches the AI on
ANTHROPIC_API_KEY=<key from console.anthropic.com>`}</div>
        {m.graph.missing.length ? <p className="hd-note" style={{ marginTop: 10 }}>Still missing on the server: {m.graph.missing.join(', ')}.</p> : <p className="hd-note" style={{ marginTop: 10 }}><CheckCircle2 size={13} style={{ verticalAlign: -2 }} /> All three Microsoft settings are present on the server.</p>}
        <p className="hd-note" style={{ marginTop: 6 }}>Not tested against Autostrad's tenant yet. Try it first on a test mailbox.</p>
      </Card>
    </>
  );
}

/* ------------------------------------ routing and timing ------------------------------------ */
function Timing({ rules, configs }) {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get('/helpdesk/settings').then((r) => {
    setS(r);
    const v = r.values;
    setF({
      Critical: v.sla_hours.Critical, High: v.sla_hours.High, Average: v.sla_hours.Average, Low: v.sla_hours.Low,
      r1: v.followup_hours[0], r2: v.followup_hours[1], autoclose_days: v.autoclose_days,
      e1: v.escalation_hours[0], e2: v.escalation_hours[1], e3: v.escalation_hours[2],
      threshold: Math.round(v.confidence_threshold * 100), sync_minutes: v.sync_minutes, report_hour_gulf: v.report_hour_gulf,
      company_name: v.company_name, support_phone: v.support_phone, release_days_en: v.release_days_en, release_days_ar: v.release_days_ar,
      contract_patterns: (v.contract_patterns || []).join('\n'),
    });
  }).catch(() => {}), []);
  useEffect(() => { if (rules) load(); }, [rules, load]);

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    const n = (k) => Number(f[k]);
    for (const k of ['Critical', 'High', 'Average', 'Low', 'r1', 'r2', 'autoclose_days', 'e1', 'e2', 'e3', 'threshold', 'sync_minutes', 'report_hour_gulf']) if (!(n(k) >= 0) || Number.isNaN(n(k))) { toast.error('Timings must be numbers.'); return; }
    if (n('r2') <= n('r1')) { toast.error('The second reminder must come after the first.'); return; }
    const patterns = f.contract_patterns.split('\n').map((x) => x.trim()).filter(Boolean);
    for (const p of patterns) { try { new RegExp(p, 'i'); } catch { toast.error(`This contract pattern is not valid: ${p}`); return; } }
    setBusy(true);
    try {
      await api.put('/helpdesk/settings', {
        sla_hours: { Critical: n('Critical'), High: n('High'), Average: n('Average'), Low: n('Low') },
        followup_hours: [n('r1'), n('r2')], autoclose_days: n('autoclose_days'), escalation_hours: [n('e1'), n('e2'), n('e3')],
        confidence_threshold: Math.min(0.95, Math.max(0.3, n('threshold') / 100)), sync_minutes: Math.max(1, n('sync_minutes')), report_hour_gulf: Math.min(23, n('report_hour_gulf')),
        company_name: f.company_name, support_phone: f.support_phone, release_days_en: f.release_days_en, release_days_ar: f.release_days_ar, contract_patterns: patterns,
      });
      toast.success('Timing saved. It applies to new cases from now on.');
      load();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  const num = (k, label, hint) => (
    <div className="field"><label htmlFor={`t-${k}`}>{label}</label><input id={`t-${k}`} className="input" inputMode="numeric" value={f ? f[k] : ''} disabled={!rules} onChange={set(k)} />{hint ? <span className="hint">{hint}</span> : null}</div>
  );
  return (
    <>
      {rules ? (
        <Card title="Service-level times and follow-up" sub="How long each priority has, when customers are chased and when cases escalate">
          {!f ? <span className="skel" style={{ width: '100%', height: 140 }} /> : (
            <>
              <div className="section-title"><span>Hours allowed to answer, by priority</span></div>
              <div className="form-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>{num('Critical', 'Critical')}{num('High', 'High')}{num('Average', 'Average')}{num('Low', 'Low')}</div>
              <div className="section-title" style={{ marginTop: 18 }}><span>Chasing a customer who went quiet</span></div>
              <div className="form-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                {num('r1', 'First reminder after (hours)', 'counted from our last reply')}{num('r2', 'Second reminder after (hours)')}{num('autoclose_days', 'Close with no response after (days)', 'after the second reminder')}
              </div>
              <div className="section-title" style={{ marginTop: 18 }}><span>Escalation: hours past the due time</span></div>
              <div className="form-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                {num('e1', 'Level 1, the owner', 'use 0 for as soon as it is late')}{num('e2', 'Level 2, the team lead')}{num('e3', 'Level 3, management')}
              </div>
              <div className="section-title" style={{ marginTop: 18 }}><span>Automation</span></div>
              <div className="form-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                {num('threshold', 'Send to "To check" below (% confident)', 'a person looks at anything less certain')}{num('sync_minutes', 'Check the mailbox every (minutes)')}{num('report_hour_gulf', 'Daily summary at (hour, Gulf time)')}
              </div>
              <div className="section-title" style={{ marginTop: 18 }}><span>Used in the reply wording</span></div>
              <div className="form-grid">
                <div className="field"><label htmlFor="t-cn">Company name</label><input id="t-cn" className="input" value={f.company_name} onChange={set('company_name')} /></div>
                <div className="field"><label htmlFor="t-sp">Support phone</label><input id="t-sp" className="input" value={f.support_phone} onChange={set('support_phone')} /></div>
                <div className="field"><label htmlFor="t-re">Deposit and card-hold release time (English)</label><input id="t-re" className="input" value={f.release_days_en} onChange={set('release_days_en')} /></div>
                <div className="field"><label htmlFor="t-ra">Deposit and card-hold release time (Arabic)</label><input id="t-ra" className="input" dir="rtl" value={f.release_days_ar} onChange={set('release_days_ar')} /></div>
                <div className="field span2"><label htmlFor="t-cp">How contract numbers look in emails (one pattern per line)</label>
                  <textarea id="t-cp" className="textarea" rows={4} value={f.contract_patterns} onChange={set('contract_patterns')} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5 }} />
                  <span className="hint">Regular expressions; the first bracketed group is the contract number. Add Autostrad's real format here if it differs from AST-123456.</span></div>
              </div>
              <div className="hd-actions" style={{ marginTop: 16 }}><Button variant="primary" icon={Save} loading={busy} onClick={save}>Save timing</Button><Button icon={RefreshCw} onClick={load}>Undo changes</Button></div>
            </>
          )}
        </Card>
      ) : <div className="hd-banner info" style={{ marginBottom: 16 }}><Lock size={18} /><div className="grow">Service-level times and follow-up timing can only be changed by IT and admin users. The routing rules below are read-only for you.</div></div>}
      <div className="hd-mt"><div className="section-title"><span>Routing: who handles what</span></div><CrudPage embedded config={configs.routing} /></div>
    </>
  );
}

/* ------------------------------------ audit log ------------------------------------ */
function Audit() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [page, setPage] = useState(1);
  const [d, setD] = useState(null);
  const PAGE = 40;
  useEffect(() => {
    let alive = true;
    api.get('/helpdesk/audit', { q: dq, action, actor_type: actor, limit: PAGE, offset: (page - 1) * PAGE }).then((r) => { if (alive) setD(r); }).catch(() => {});
    return () => { alive = false; };
  }, [dq, action, actor, page]);
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>Everything the AI, the system and staff did, with who and when. It cannot be edited or deleted from here.</p>
      <div className="toolbar">
        <div className="search"><input className="input" type="search" placeholder="Search by case, person or detail..." value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Search the audit log" /></div>
        <div className="filters">
          <select className="select" value={actor} onChange={(e) => { setActor(e.target.value); setPage(1); }} aria-label="Who"><option value="">Who: anyone</option><option value="ai">The AI</option><option value="user">Staff</option><option value="system">The system</option></select>
          <select className="select" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} aria-label="What"><option value="">What: anything</option>{d ? d.actions.map((a) => <option key={a} value={a}>{ACTION[a] || sentence(a)}</option>) : null}</select>
        </div>
      </div>
      <div className="card table-card">
        <div className="table-wrap">
          <table className="hd-table" style={{ minWidth: 760 }}>
            <thead><tr><th>When</th><th>Case</th><th>Who</th><th>What</th></tr></thead>
            <tbody>{d ? d.data.map((a) => (
              <tr key={a.id}>
                <td className="nowrap muted" title={fmtDateTime(a.at)}>{fmtDateTime(a.at)}</td>
                <td>{a.case_no ? <Link to={`/helpdesk/cases?tab=all&open=${a.case_id}`} style={{ color: 'var(--blue-deep)', fontWeight: 700 }}>{a.case_no}</Link> : <span className="faint">-</span>}</td>
                <td>{a.actor_name}</td>
                <td dir="auto"><b>{ACTION[a.action] || sentence(a.action)}</b>{a.field ? `: ${FIELD[a.field] || a.field}` : ''}{a.old_value || a.new_value ? <span className="muted">{a.old_value ? ` ${a.old_value}` : ''}{a.old_value && a.new_value ? ' to' : ''}{a.new_value ? ` ${a.new_value}` : ''}</span> : null}{a.detail ? <div className="muted small">{a.detail}</div> : null}</td>
              </tr>
            )) : null}</tbody>
          </table>
        </div>
        {d && d.data.length === 0 ? <EmptyState icon={Sparkles} title="Nothing matches" /> : null}
        <div className="table-foot"><span className="muted small">{d && d.total ? `${(page - 1) * PAGE + 1} to ${Math.min(d.total, page * PAGE)} of ${d.total}` : ''}</span><Pager page={page} pages={d ? Math.max(1, Math.ceil(d.total / PAGE)) : 1} onChange={setPage} /></div>
      </div>
    </>
  );
}

export default function HelpdeskSetup() {
  const { can } = useAuth();
  const meta = useMeta();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([v]) => v === params.get('tab')) ? params.get('tab') : 'mailbox';
  const system = can('helpdesk.system');
  const rules = can('helpdesk.rules');
  const configs = useMemo(() => (meta ? buildConfigs(meta) : null), [meta]);
  return (
    <>
      <PageHeader title="Helpdesk setup" subtitle="The mailbox, the AI, where customer and contract details come from, the approved reply wording and the rules the helpdesk follows." />
      <div className="toolbar"><Tabs value={tab} onChange={(v) => setParams(v === 'mailbox' ? {} : { tab: v }, { replace: true })} items={TABS.map(([value, label]) => ({ value, label }))} /></div>
      {tab === 'mailbox' ? <Mailbox system={system} /> : null}
      {tab === 'customer' ? <CustomerData system={system} /> : null}
      {tab === 'audit' ? <Audit /> : null}
      {tab !== 'mailbox' && tab !== 'customer' && tab !== 'audit' && !configs ? <span className="skel" style={{ width: '100%', height: 160 }} /> : null}
      {configs && tab === 'wording' ? <CrudPage key="wording" embedded config={configs.templates} /> : null}
      {configs && tab === 'keywords' ? <CrudPage key="keywords" embedded config={configs.keywords} /> : null}
      {configs && tab === 'routing' ? <Timing rules={rules} configs={configs} /> : null}
      {configs && tab === 'channels' ? <CrudPage key="channels" embedded config={configs.channels} /> : null}
    </>
  );
}
