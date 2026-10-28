// Sample emails for the demo mailbox: pick one from the library (or write your own as a customer), send it, and watch
// it go through the same steps as mail arriving from Outlook: classified, matched to the contract, prioritised, routed,
// and a reply drafted for approval.
import { useEffect, useMemo, useState } from 'react';
import { Search, Send } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../toast';
import { Button, EmptyState, Pill, Tabs } from '../components/ui';
import { Modal } from '../components/Modal';
import { useDebounced, useMeta } from './shared';

export default function SampleEmails({ open, onClose, onSent }) {
  const toast = useToast();
  const meta = useMeta();
  const [tab, setTab] = useState('library');
  const [data, setData] = useState(null);
  const [type, setType] = useState('');
  const [lang, setLang] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [busy, setBusy] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [mine, setMine] = useState({ customer_id: '', subject: '', body: '' });

  useEffect(() => {
    if (!open) return;
    api.get('/stats/options').then((o) => setCustomers(o.customers || [])).catch(() => {});
  }, [open]);
  useEffect(() => {
    if (!open) return;
    api.get('/helpdesk/samples', { type, lang, q: dq }).then(setData).catch((e) => toast.error(e.message));
  }, [open, type, lang, dq, toast]);

  const nameOf = useMemo(() => Object.fromEntries((meta ? meta.subcategories : []).map((s) => [s.key, s.name])), [meta]);

  const send = async (key, payload) => {
    setBusy(key);
    try {
      const r = await api.post('/helpdesk/samples/send', payload);
      toast.success(`Email from ${r.from} arrived and became ${r.case_no}`);
      onSent(r.case_id);
      onClose();
    } catch (e) { toast.error(e.message); } finally { setBusy(null); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Try a sample email" subtitle="It arrives in the demo mailbox as if a customer had written it, then goes through the real steps." size="lg">
      <div className="hd-stack" style={{ gap: 14 }}>
        <Tabs value={tab} onChange={setTab} items={[{ value: 'library', label: 'Sample library' }, { value: 'own', label: 'Write one yourself' }]} />
        {tab === 'library' ? (
          <>
            <div className="hd-filters">
              <div className="hd-search" style={{ flex: '1 1 200px' }}><Search size={16} /><input className="input" type="search" placeholder="Search the samples..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search samples" /></div>
              <select className="select" value={type} onChange={(e) => setType(e.target.value)} aria-label="Request type"><option value="">All request types</option>{meta ? meta.subcategories.map((s) => <option key={s.key} value={s.key}>{s.name}</option>) : null}</select>
              <select className="select" value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Language"><option value="">English and Arabic</option><option value="en">English</option><option value="ar">Arabic</option></select>
            </div>
            <div style={{ maxHeight: '52vh', overflowY: 'auto' }}>
              {data && data.data.length === 0 ? <EmptyState title="No samples match" /> : null}
              {data ? data.data.map((x) => (
                <div className="hd-sample" key={x.id}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row wrap" style={{ gap: 8, marginBottom: 3 }}>
                      <b dir="auto" className="ellipsis" style={{ maxWidth: '100%' }}>{x.subject || '(no subject)'}</b>
                      <Pill tone="neutral" dot={false}>{nameOf[x.sub_key] || x.sub_key}</Pill>
                      <Pill tone={x.language === 'ar' ? 'warn' : 'info'} dot={false}>{x.language === 'ar' ? 'Arabic' : x.language === 'mixed' ? 'Mixed' : 'English'}</Pill>
                    </div>
                    <div className="snip" dir="auto">{x.body.replace(/\s+/g, ' ')}</div>
                  </div>
                  <Button size="sm" variant="primary" icon={Send} loading={busy === x.id} disabled={busy !== null} onClick={() => send(x.id, { sample_id: x.id })}>Send</Button>
                </div>
              )) : <span className="skel" style={{ width: '100%', height: 90 }} />}
            </div>
            <p className="hd-note">The sample gets the real contract number of a random customer in this CRM, so the lookup, the amounts and the draft use real data.</p>
          </>
        ) : (
          <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
            <div className="field"><label htmlFor="s-cust">Send it as this customer</label>
              <select id="s-cust" className="select" value={mine.customer_id} onChange={(e) => setMine({ ...mine, customer_id: e.target.value })}><option value="">A random customer</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div className="field"><label htmlFor="s-sub">Subject</label><input id="s-sub" className="input" dir="auto" value={mine.subject} onChange={(e) => setMine({ ...mine, subject: e.target.value })} /></div>
            <div className="field"><label htmlFor="s-body">What the customer writes <span className="req">*</span></label><textarea id="s-body" className="textarea" rows={8} dir="auto" value={mine.body} onChange={(e) => setMine({ ...mine, body: e.target.value })} placeholder="For example: I returned the car three weeks ago and my deposit has not been refunded. Please tell me when I will receive it." /></div>
            <div className="hd-actions"><Button variant="primary" icon={Send} loading={busy === 'own'} disabled={!mine.body.trim() || busy !== null} onClick={() => send('own', { subject: mine.subject, body: mine.body, customer_id: mine.customer_id || undefined })}>Send it</Button></div>
          </div>
        )}
      </div>
    </Modal>
  );
}
