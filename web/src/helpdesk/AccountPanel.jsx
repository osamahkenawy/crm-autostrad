// The customer, contract and invoices behind a case, as the customer systems (or the demo CRM) reported them: where the facts came
// from and how fresh they are, whether the sender really is the customer on the contract, the money side, and the sender's other contracts.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { Button, Pill, StatusPill } from '../components/ui';
import { fmtDate, money, relTime } from '../lib/format';
import { sentence } from './shared';

const Line = ({ k, children }) => (children === null || children === undefined || children === '' ? null : <div className="ln"><span>{k}</span><b>{children}</b></div>);
const utc = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 19) : '');
/** "just now" instead of "0min ago". */
const ago = (iso) => (iso && Date.now() - Date.parse(`${utc(iso).replace(' ', 'T')}Z`) < 60000 ? 'just now' : relTime(utc(iso)));
const SHOWN = 5;

function SourcePill({ a }) {
  if (a.source === 'api') return <Pill tone="ok">Live: {a.systems && a.systems.length ? a.systems.join(' and ') : 'customer systems'}</Pill>;
  return <Pill tone="info">CRM demo records</Pill>;
}

function Invoices({ k }) {
  const [all, setAll] = useState(false);
  const list = k.invoices || [];
  if (!list.length) return null;
  const sum = k.invoice_summary;
  const rows = all ? list : list.slice(0, SHOWN);
  return (
    <div>
      <div className="section-title" style={{ marginBottom: 6 }}><span>Invoices</span>
        {sum && sum.unpaid_count ? <span className="hd-due warn" style={{ textTransform: 'none', letterSpacing: 0 }}>{sum.unpaid_count} unpaid, {money(sum.outstanding)} outstanding{sum.overdue_count ? `, ${sum.overdue_count} overdue` : ''}</span> : <span className="hd-due ok" style={{ textTransform: 'none', letterSpacing: 0 }}>Nothing outstanding</span>}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="hd-table">
          <thead><tr><th>Invoice</th><th>Issued</th><th>Due</th><th className="num">Total</th><th className="num">To pay</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id}>
                <td className="strong nowrap">{i.url ? <a href={i.url} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--blue-deep)' }}>{i.number}<ExternalLink size={11} style={{ marginLeft: 4, verticalAlign: -1 }} /></a> : i.number}</td>
                <td className="nowrap">{i.issue_date ? fmtDate(i.issue_date) : '-'}</td>
                <td className="nowrap">{i.due_date ? fmtDate(i.due_date) : '-'}</td>
                <td className="num nowrap">{money(i.total)}</td>
                <td className="num nowrap">{i.balance === null || i.balance === undefined ? '-' : money(i.balance)}</td>
                <td><StatusPill kind="invoice" value={i.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length > SHOWN ? <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${list.length}`}</button> : null}
    </div>
  );
}

export default function AccountPanel({ c, busy, run, canWork }) {
  const a = c.account || { source: 'crm', status: 'not_checked', identity: 'none', systems: [] };
  const k = c.contract;
  const closed = c.status === 'closed';
  const fin = k && k.financials;
  const owner = k && k.customer;
  const sender = a.customer;
  // the person who wrote and the contract's customer are two people when the sender is not the customer on it (or staff vouched for them)
  const another = Boolean(owner && sender && ['contract_only', 'staff'].includes(a.identity) && !(owner.id !== undefined && owner.id !== null && String(owner.id) === String(sender.id)));
  const refresh = () => run('account', () => api.post(`/helpdesk/cases/${c.id}/account/refresh`, {}), 'Details refreshed');
  const confirm = () => run('verify', () => api.post(`/helpdesk/cases/${c.id}/account/verify`, {}), 'Sender confirmed');
  const useContract = (no) => run('use', () => api.patch(`/helpdesk/cases/${c.id}`, { contract_no: no }), `Now using contract ${no}`);
  const where = a.systems && a.systems.length ? a.systems.join(' and ') : a.source === 'api' ? 'the customer systems' : 'the CRM';

  return (
    <section className="hd-panel">
      <header>
        <h4>Customer and contract</h4>
        <div className="row" style={{ gap: 8 }}>
          <SourcePill a={a} />
          {a.fetched_at ? <span className="hd-note nowrap" title={`${utc(a.fetched_at)} UTC`}>{ago(a.fetched_at)}</span> : null}
          {canWork ? <Button size="xs" icon={RefreshCw} loading={busy === 'account'} onClick={refresh} aria-label="Look the details up again">Refresh</Button> : null}
        </div>
      </header>
      <div className="body">
        {a.status === 'unavailable' ? (
          <div className="hd-banner warn"><AlertTriangle size={18} /><div className="grow">{a.last_error || `${where} did not answer.`} {a.will_retry ? 'The helpdesk keeps trying and fills the details in by itself.' : 'Automatic tries have ended: press Refresh.'}</div></div>
        ) : null}
        {a.status === 'partial' ? (
          <div className="hd-banner warn"><AlertTriangle size={18} /><div className="grow">Some details are missing: {(a.errors[0] && a.errors[0].message) || 'one of the systems did not answer.'} {a.will_retry ? 'It will be tried again automatically.' : ''}</div></div>
        ) : null}
        {a.stale ? (
          <div className="hd-banner info"><AlertTriangle size={18} /><div className="grow">The last refresh failed ({a.last_error}). These figures are from {ago(a.fetched_at)}: check them before quoting.</div></div>
        ) : null}
        {k && a.identity === 'contract_only' ? (
          <div className="hd-banner danger">
            <ShieldAlert size={18} />
            <div className="grow">{c.customer_email} is not the customer on this contract{owner ? ` (it belongs to ${owner.name || owner.email})` : ''}. The reply leaves the account figures out until you are sure who is writing.</div>
            {canWork && !closed ? <Button size="sm" icon={ShieldCheck} loading={busy === 'verify'} onClick={confirm}>Confirm sender</Button> : null}
          </div>
        ) : null}
        {k && a.identity === 'staff' ? (
          <div className="hd-banner ok"><ShieldCheck size={18} /><div className="grow">{a.verified_by || 'A colleague'} confirmed that this sender may receive the details of this contract{a.verified_at ? `, ${ago(a.verified_at)}` : ''}.</div></div>
        ) : null}

        {sender || owner ? (
          <dl className="hd-kv">
            {sender ? (
              <div><dt>{another ? 'Sender on file' : 'Customer'}</dt>
                <dd>{sender.id && a.source === 'crm' ? <Link to={`/customers?open=${sender.id}`} style={{ color: 'var(--blue-deep)' }}>{sender.name}</Link> : (sender.name || sender.email)}
                  {sender.tier && sender.tier !== 'Standard' ? ` (${sender.tier})` : ''}{sender.segment === 'Corporate' ? ', corporate' : ''}</dd></div>
            ) : null}
            {sender && (sender.email || sender.phone) ? <div><dt>Contact</dt><dd dir="auto">{[sender.email, sender.phone].filter(Boolean).join(' · ')}</dd></div> : null}
            {owner && (another || !sender) ? (
              <div><dt>Contract belongs to</dt><dd dir="auto">{owner.name || owner.email}{owner.tier && owner.tier !== 'Standard' ? ` (${owner.tier})` : ''}{owner.email ? ` · ${owner.email}` : ''}</dd></div>
            ) : null}
          </dl>
        ) : null}

        {!k ? (
          a.status === 'unavailable' ? null : (
            <div className="hd-note" dir="auto">
              {!sender && a.status === 'not_found' ? `No customer with the address ${c.customer_email} was found in ${where}. ` : ''}
              {a.notes && a.notes.length
                ? a.notes.join(' ')
                : c.contract_no ? `No contract with the number ${c.contract_no} was found in ${where}.` : 'No contract number was found in the email, and the sender has no recent rental. Ask the customer for it, then enter it above.'}
            </div>
          )
        ) : (
          <>
            <dl className="hd-kv">
              <div><dt>Contract</dt>
                <dd>
                  {k.booking_id && a.source === 'crm' ? <Link to={`/bookings?open=${k.booking_id}`} style={{ color: 'var(--blue-deep)' }}>{k.contract_no}</Link>
                    : k.url ? <a href={k.url} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--blue-deep)' }}>{k.contract_no}<ExternalLink size={11} style={{ marginLeft: 4, verticalAlign: -1 }} /></a> : k.contract_no}
                  {' '}{k.status ? <Pill tone={k.status === 'active' ? 'info' : k.status === 'completed' ? 'ok' : 'neutral'}>{sentence(k.status)}</Pill> : null}
                  {c.contract_inferred ? <>{' '}<Pill tone="warn" dot={false}>Guessed</Pill></> : null}
                </dd></div>
              <div><dt>Vehicle</dt><dd>{k.vehicle ? [k.vehicle.name, k.vehicle.plate].filter(Boolean).join(', ') : '-'}</dd></div>
              <div><dt>Rental period</dt><dd>{k.start_at || k.end_at ? `${k.start_at ? fmtDate(k.start_at) : '?'} to ${k.end_at ? fmtDate(k.end_at) : '?'}` : '-'}</dd></div>
              <div><dt>Pick-up branch</dt><dd>{k.pickup_branch ? k.pickup_branch.name : '-'}</dd></div>
              <div><dt>Contract value</dt><dd>{k.total_amount !== null && k.total_amount !== undefined ? `${money(k.total_amount)}${k.payment_status ? ` (${sentence(k.payment_status)})` : ''}` : '-'}</dd></div>
              <div><dt>Product</dt><dd>{k.product_line || '-'}</dd></div>
            </dl>
            {fin ? (
              <div className="hd-lines">
                <Line k="Security deposit">{fin.deposit_amount ? `${money(fin.deposit_amount)}, ${sentence(fin.deposit_status)}` : null}</Line>
                <Line k="Deposit refund expected by">{fin.deposit_refund_due ? fmtDate(fin.deposit_refund_due) : null}</Line>
                <Line k="Card hold (pre-authorization)">{fin.preauth_amount ? `${money(fin.preauth_amount)}, ${sentence(fin.preauth_status)}` : null}</Line>
                <Line k="Hold released on">{fin.preauth_released_at ? fmtDate(fin.preauth_released_at) : null}</Line>
                <Line k="Card ending">{fin.card_last4}</Line>
              </div>
            ) : <div className="hd-note">No deposit or card-hold record for this contract.</div>}
            <Invoices k={k} />
            {k.fines && k.fines.length ? <div className="hd-lines">{k.fines.map((f) => <Line key={f.id} k={`${f.type} ${f.reference || ''}`}>{`${money(Number(f.amount) + Number(f.admin_fee || 0))}, ${sentence(f.status)}`}</Line>)}</div> : null}
          </>
        )}

        {!k && a.open_invoices && a.open_invoices.items && a.open_invoices.items.length ? <Invoices k={{ invoices: a.open_invoices.items, invoice_summary: a.open_invoices }} /> : null}

        {a.other_contracts && a.other_contracts.length ? (
          <div>
            <div className="section-title" style={{ marginBottom: 6 }}><span>{k ? 'Other contracts of this customer' : 'Contracts of the sender'}</span></div>
            <div className="hd-lines">
              {a.other_contracts.slice(0, 6).map((o) => (
                <div className="ln" key={o.contract_no} style={{ alignItems: 'center' }}>
                  <span><b className="strong">{o.contract_no}</b>{o.status ? ` · ${sentence(o.status)}` : ''}{o.start_at || o.end_at ? ` · ${o.start_at ? fmtDate(o.start_at) : '?'} to ${o.end_at ? fmtDate(o.end_at) : '?'}` : ''}{o.vehicle ? ` · ${[o.vehicle.name, o.vehicle.plate].filter(Boolean).join(' ')}` : ''}</span>
                  {canWork && !closed ? <Button size="xs" loading={busy === 'use'} onClick={() => useContract(o.contract_no)}>Use this one</Button> : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {a.status === 'ok' && !a.stale && k ? <div className="hd-note"><CheckCircle2 size={12} style={{ verticalAlign: -2, marginRight: 4 }} />From {where}. Replies are written from these facts.</div> : null}
      </div>
    </section>
  );
}
