// Helpdesk setup, "Customer data": which systems the contract, customer and invoice facts come from, whether the connection is sound,
// how each system has been answering, and a test box that runs a real lookup and shows every step. The configuration itself is a file
// on the server and the keys are lines in server/.env, so nothing secret is ever typed into or shown by this page.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Lock, Play, RefreshCw, XCircle } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../toast';
import { Button, Card, Pill, StatusPill } from '../components/ui';
import { fmtDateTime, money, relTime } from '../lib/format';
import { sentence } from './shared';

const utc = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 19) : '');

function ResultPill({ s }) {
  if (s.skipped) return <Pill tone="neutral" dot={false}>Not asked ({s.reason})</Pill>;
  if (!s.ok) return <Pill tone="danger">Failed</Pill>;
  return s.found ? <Pill tone="ok">Found</Pill> : <Pill tone="warn">Nothing found</Pill>;
}

function Steps({ steps }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="hd-table">
        <thead><tr><th>Question</th><th>System</th><th>Result</th><th className="num">HTTP</th><th className="num">Time</th></tr></thead>
        <tbody>
          {steps.map((s, i) => (
            <tr key={`${s.name}-${i}`}>
              <td className="strong">{s.name.replace(/_/g, ' ')}{s.cached ? <span className="hd-note"> (remembered)</span> : null}
                {s.url ? <div className="hd-note mono" style={{ wordBreak: 'break-all' }}>{s.url}</div> : null}
                {s.error ? <div className="hd-note" style={{ color: 'var(--danger-fg)' }}>{s.error}</div> : null}
                {s.raw !== undefined ? <details style={{ marginTop: 6 }}><summary className="hd-note" style={{ cursor: 'pointer' }}>What the system answered</summary><pre className="hd-pre" style={{ marginTop: 6, maxHeight: 260 }}>{JSON.stringify(s.raw, null, 2)}</pre></details> : null}
              </td>
              <td>{s.source || '-'}</td>
              <td><ResultPill s={s} /></td>
              <td className="num">{s.status || '-'}</td>
              <td className="num">{s.skipped ? '-' : s.cached ? 'cached' : `${s.ms} ms`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TestBox({ system, live }) {
  const toast = useToast();
  const [f, setF] = useState({ email: '', contract_no: '', raw: false });
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(null);
  const run = async () => {
    setBusy(true);
    try { setOut(await api.post('/helpdesk/systems/test', { email: f.email.trim(), contract_no: f.contract_no.trim(), raw: f.raw })); } catch (e) { setOut(null); toast.error(e.message); } finally { setBusy(false); }
  };
  const s = out && out.snapshot;
  return (
    <Card title="Try a lookup" sub={live ? 'Asks the real systems exactly what a new email would ask. Nothing is saved.' : 'Reads the CRM, like a new email does today. Nothing is saved.'} className="hd-mt">
      <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <div className="field"><label htmlFor="t-email">Sender's email address</label><input id="t-email" className="input" dir="auto" inputMode="email" placeholder="customer@example.com" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        <div className="field"><label htmlFor="t-con">Contract number (optional)</label><input id="t-con" className="input" placeholder="AST-100123" value={f.contract_no} onChange={(e) => setF({ ...f, contract_no: e.target.value })} /></div>
      </div>
      <div className="hd-actions" style={{ marginTop: 12 }}>
        <Button variant="primary" icon={Play} loading={busy} disabled={!f.email.trim() && !f.contract_no.trim()} onClick={run}>Run the lookup</Button>
        {live ? (
          <label className="row" style={{ gap: 8, fontWeight: 600, opacity: system ? 1 : 0.6 }}>
            <input type="checkbox" checked={f.raw && system} disabled={!system} onChange={(e) => setF({ ...f, raw: e.target.checked })} />
            Show what each system answered{system ? '' : ' (IT only)'}
          </label>
        ) : null}
      </div>
      {s ? (
        <div style={{ marginTop: 16, display: 'grid', gap: 12 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <Pill tone={{ ok: 'ok', partial: 'warn', not_found: 'warn', unavailable: 'danger' }[s.status] || 'neutral'}>{{ ok: 'Found', partial: 'Partly found', not_found: 'Nothing found', unavailable: 'Could not ask' }[s.status] || s.status}</Pill>
            <Pill tone={s.identity === 'email' ? 'ok' : s.identity === 'contract_only' ? 'danger' : 'neutral'} dot={false}>
              {{ email: 'The sender is the customer', contract_only: 'The sender is NOT the customer on this contract', staff: 'Confirmed by staff', none: 'No customer matched the sender' }[s.identity]}
            </Pill>
            {s.inferred ? <Pill tone="warn" dot={false}>Contract guessed from the sender</Pill> : null}
          </div>
          <div className="hd-grid c2" style={{ marginBottom: 0 }}>
            <div className="hd-lines">
              <div className="ln"><span>Customer</span><b>{s.customer ? `${s.customer.name || s.customer.email}${s.customer.tier && s.customer.tier !== 'Standard' ? ` (${s.customer.tier})` : ''}${s.customer.segment === 'Corporate' ? ', corporate' : ''}` : '-'}</b></div>
              <div className="ln"><span>Contact</span><b>{s.customer ? [s.customer.email, s.customer.phone].filter(Boolean).join(' · ') || '-' : '-'}</b></div>
              <div className="ln"><span>Contract</span><b>{s.contract ? `${s.contract.contract_no}${s.contract.status ? `, ${sentence(s.contract.status)}` : ''}` : '-'}</b></div>
              <div className="ln"><span>Vehicle</span><b>{s.contract && s.contract.vehicle ? [s.contract.vehicle.name, s.contract.vehicle.plate].filter(Boolean).join(', ') : '-'}</b></div>
              <div className="ln"><span>Rental period</span><b>{s.contract && (s.contract.start_at || s.contract.end_at) ? `${(s.contract.start_at || '?').slice(0, 10)} to ${(s.contract.end_at || '?').slice(0, 10)}` : '-'}</b></div>
            </div>
            <div className="hd-lines">
              <div className="ln"><span>Invoices</span><b>{s.contract ? `${s.contract.invoices.length}${s.contract.invoice_summary && s.contract.invoice_summary.unpaid_count ? `, ${s.contract.invoice_summary.unpaid_count} unpaid` : ''}` : '-'}</b></div>
              <div className="ln"><span>Fines and Salik</span><b>{s.contract ? s.contract.fines.length : '-'}</b></div>
              <div className="ln"><span>Security deposit</span><b>{s.contract && s.contract.financials && s.contract.financials.deposit_amount ? `${money(s.contract.financials.deposit_amount)}, ${sentence(s.contract.financials.deposit_status)}` : '-'}</b></div>
              <div className="ln"><span>Card hold</span><b>{s.contract && s.contract.financials && s.contract.financials.preauth_amount ? `${money(s.contract.financials.preauth_amount)}, ${sentence(s.contract.financials.preauth_status)}` : '-'}</b></div>
              <div className="ln"><span>Other contracts</span><b>{(s.other_contracts || []).length}</b></div>
            </div>
          </div>
          {s.contract && s.contract.invoices.length ? (
            <div style={{ overflowX: 'auto' }}>
              <table className="hd-table">
                <thead><tr><th>Invoice</th><th>Issued</th><th>Due</th><th className="num">Total</th><th className="num">To pay</th><th>Status</th></tr></thead>
                <tbody>{s.contract.invoices.slice(0, 6).map((i) => <tr key={i.id}><td className="strong">{i.number}</td><td>{i.issue_date || '-'}</td><td>{i.due_date || '-'}</td><td className="num">{i.total === null || i.total === undefined ? '-' : money(i.total)}</td><td className="num">{i.balance === null || i.balance === undefined ? '-' : money(i.balance)}</td><td><StatusPill kind="invoice" value={i.status} /></td></tr>)}</tbody>
              </table>
            </div>
          ) : null}
          {s.notes && s.notes.length ? s.notes.map((n, i) => <div key={i} className="hd-banner info"><AlertTriangle size={18} /><div className="grow">{n}</div></div>) : null}
          {s.warnings && s.warnings.length ? (
            <div className="hd-banner warn"><AlertTriangle size={18} /><div className="grow"><b>The answer did not match the configuration in these places:</b><ul className="hd-reasons" style={{ color: 'inherit', marginTop: 4 }}>{s.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div></div>
          ) : null}
          {out.steps.length ? <Steps steps={out.steps} /> : null}
        </div>
      ) : null}
    </Card>
  );
}

export default function CustomerData({ system }) {
  const toast = useToast();
  const [st, setSt] = useState(null);
  const load = useCallback(() => api.get('/helpdesk/systems').then(setSt).catch((e) => toast.error(e.message)), [toast]);
  useEffect(() => { load(); }, [load]);
  if (!st) return <span className="skel" style={{ width: '100%', height: 160 }} />;

  const live = st.mode === 'api';
  const missing = st.sources.flatMap((s) => s.missing);
  return (
    <>
      <div className="hd-grid c2" style={{ alignItems: 'start' }}>
        <Card title="Where the facts come from" sub="Contract, customer and invoice details for every email" action={<Pill tone={live ? 'ok' : 'info'}>{live ? 'Live customer systems' : st.mode === 'none' ? 'Not connected yet' : 'CRM demo records'}</Pill>}>
          <p className="hd-note" style={{ margin: '0 0 10px' }}>
            {live
              ? 'Each new email is looked up by the sender address and the contract number in it. The answers are kept with the case, so the screen and the drafted reply use the same facts. If a system is down the case still opens and is completed by itself when it answers again.'
              : st.mode === 'none'
                ? 'Nothing is connected yet, so nothing is looked up for real emails: each case says that customer details are not available, and replies leave out account figures. The CRM\'s demo records are never used for a real mailbox. Connect the systems below when their APIs are ready.'
                : 'The helpdesk reads the CRM\'s own records. That is fine for trying things out. To use the real contracts, customers and invoices, connect the systems below.'}
          </p>
          <div className="hd-lines">
            <div className="ln"><span>Configuration file</span><b className="mono" style={{ fontSize: 12.5 }}>{st.config.file}</b></div>
            <div className="ln"><span>File is</span><b>{!st.config.exists ? 'missing' : st.config.ok ? 'valid' : 'not valid'}</b></div>
            <div className="ln"><span>Switched on in the file</span><b>{st.enabled ? 'yes' : 'no'}</b></div>
            {st.forced_by_env ? <div className="ln"><span>Set by the server</span><b>HELPDESK_ACCOUNT_SOURCE = {st.mode}, which wins over the file</b></div> : null}
            <div className="ln"><span>Details are asked again after</span><b>{st.freshness_minutes} min, before a reply is drafted</b></div>
            <div className="ln"><span>If nothing is found, use the CRM</span><b>{st.fallback_to_crm ? 'yes' : 'no'}</b></div>
            <div className="ln"><span>Cases filled from the systems</span><b>{st.cases.from_systems}</b></div>
            <div className="ln"><span>Cases waiting for a system to answer</span><b>{st.cases.waiting}</b></div>
            <div className="ln"><span>Open cases where the sender is not the contract's customer</span><b>{st.cases.mismatched}</b></div>
          </div>
          {st.config.problems.length ? (
            <div className="hd-banner danger" style={{ marginTop: 12 }}><XCircle size={18} /><div className="grow"><b>The configuration file needs fixing{st.config.using_last_good ? ' (the last good version keeps working until it is fixed)' : ''}:</b><ul className="hd-reasons" style={{ color: 'inherit', marginTop: 4 }}>{st.config.problems.map((p, i) => <li key={i} dir="auto">{p}</li>)}</ul></div></div>
          ) : null}
          {live && missing.length ? <div className="hd-banner warn" style={{ marginTop: 12 }}><AlertTriangle size={18} /><div className="grow">Still missing on the server: <span className="hd-code">{[...new Set(missing)].join(', ')}</span>. Add them to server/.env and restart the server.</div></div> : null}
          {live && !st.config.problems.length && !missing.length ? <div className="hd-banner ok" style={{ marginTop: 12 }}><CheckCircle2 size={18} /><div className="grow">The configuration is sound and every key is on the server.</div></div> : null}
          <div className="hd-actions" style={{ marginTop: 12 }}><Button icon={RefreshCw} onClick={load}>Check again</Button></div>
        </Card>

        <Card title="The systems" sub="Addresses and keys are settings of the server, never typed here">
          {st.sources.length === 0 ? <p className="hd-note">No system is configured yet.</p> : st.sources.map((s) => (
            <div key={s.name} className="hd-step">
              <span className={`mark ${s.missing.length ? '' : s.health.last_error && (!s.health.last_ok_at || s.health.last_error_at > s.health.last_ok_at) ? '' : 'done'}`} style={s.health.last_error && (!s.health.last_ok_at || s.health.last_error_at > s.health.last_ok_at) ? { background: 'var(--danger-bg)', color: 'var(--danger-fg)' } : undefined}>
                {s.health.last_error && (!s.health.last_ok_at || s.health.last_error_at > s.health.last_ok_at) ? <XCircle size={15} /> : <CheckCircle2 size={15} />}
              </span>
              <div className="grow">
                <b>{s.label}</b> <span className="hd-note">({s.name})</span>
                <div className="hd-note mono" style={{ wordBreak: 'break-all' }}>{s.base_url || 'no address yet'}</div>
                <div className="hd-note">Signs in with: {{ none: 'nothing', api_key: 'an API key', bearer: 'a bearer token', basic: 'a user name and password', oauth2_client_credentials: 'OAuth (client credentials)' }[s.auth] || s.auth}. Gives up after {Math.round(s.timeout_ms / 1000)} s; remembers answers for {Math.round(s.cache_seconds / 60)} min.</div>
                {s.missing.length ? <div className="hd-note" style={{ color: 'var(--danger-fg)' }}>Missing in server/.env: {s.missing.join(', ')}</div> : null}
                <div className="hd-note">
                  {s.health.calls ? `${s.health.calls} calls since the server started, ${s.health.failures} failed${s.health.avg_ms !== null ? `, about ${s.health.avg_ms} ms` : ''}.` : 'Not called yet since the server started.'}
                  {s.health.last_ok_at ? ` Last good answer ${relTime(utc(s.health.last_ok_at))}.` : ''}
                </div>
                {s.health.last_error ? <div className="hd-note" style={{ color: 'var(--danger-fg)' }}>Last problem ({relTime(utc(s.health.last_error_at))}): {s.health.last_error}</div> : null}
                {s.health.paused_until ? <div className="hd-note" style={{ color: 'var(--warn-fg)' }}>Paused until {fmtDateTime(utc(s.health.paused_until))} after repeated failures; it is tried again by itself.</div> : null}
              </div>
            </div>
          ))}
        </Card>
      </div>

      <Card title="The questions it asks" sub="One question to one system. The first two are enough to start with" className="hd-mt">
        <div style={{ overflowX: 'auto' }}>
          <table className="hd-table">
            <thead><tr><th>Question</th><th>Asks</th><th>System</th><th>Request</th><th className="num">Fields read</th></tr></thead>
            <tbody>
              {st.lookups.map((l) => (
                <tr key={l.name}>
                  <td className="strong nowrap">{l.name.replace(/_/g, ' ')}</td>
                  <td>{l.about}</td>
                  <td>{l.configured ? (st.sources.find((s) => s.name === l.source) || {}).label || l.source : <span className="faint">not set</span>}</td>
                  <td className="mono" style={{ fontSize: 12.5, wordBreak: 'break-all' }}>{l.configured ? `${l.method} ${l.path}${l.query.length ? `?${l.query.map((q) => `${q}=…`).join('&')}` : ''}` : '-'}</td>
                  <td className="num">{l.configured ? l.fields.length : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!system ? <p className="hd-note" style={{ marginTop: 8 }}><Lock size={12} /> The configuration file and the keys are changed on the server by IT.</p> : null}
      </Card>

      <TestBox system={system} live={live} />

      <Card title="Connecting the real systems" sub="For whoever builds or looks after Orion Fleet, the CNR Portal or another system of record" className="hd-mt">
        <ol className="hd-steps">
          <li>Give the helpdesk a <b>read-only</b> service account on each system, with an API key or OAuth client. It only needs to read contracts, customers and invoices.</li>
          <li>Copy <span className="hd-code">server/config/customer-systems.example.json</span> over <span className="hd-code">server/config/customer-systems.json</span> and change the paths and field names to match the real API. The example maps a stand-in API, so every field has a worked answer. <span className="hd-code">CUSTOMER_API.md</span> lists what each question needs.</li>
          <li>Put the addresses and keys in <span className="hd-code">server/.env</span> (they are only <i>named</i> in the file) and restart the server. This page then shows what is still missing.</li>
          <li>Use <b>Try a lookup</b> above with a real customer's address and contract number. IT can tick "Show what each system answered" to see the field names. Fix the file until every field reads right.</li>
          <li>Open a few real cases and compare the panel with the system. When it matches, leave it on: new emails are looked up by themselves.</li>
        </ol>
        <div className="hd-pre" style={{ marginTop: 12 }}>{`# server/.env: the keys named in the configuration file
ORION_BASE_URL=https://orion.example.com/api/v2
ORION_API_KEY=<key issued by the Orion Fleet team>
CNR_BASE_URL=https://cnr.example.com/api
CNR_API_KEY=<key issued by the CNR Portal team>
# optional: force the source whatever the file says (api or crm)
# HELPDESK_ACCOUNT_SOURCE=api`}</div>
        <p className="hd-note" style={{ marginTop: 10 }}>Replies only quote deposit, card-hold and invoice figures when the sender's address is the customer on the contract. A contract number typed in an email proves nothing about who wrote it.</p>
      </Card>
    </>
  );
}
