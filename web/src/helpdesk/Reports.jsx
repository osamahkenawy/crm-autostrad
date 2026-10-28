// Daily and weekly summaries of the support mailbox. They are built on a schedule (07:00 Gulf time, weekly on Mondays),
// can be generated on demand, and the text can be copied into an email. Nothing is sent from here.
import { useCallback, useEffect, useState } from 'react';
import { Copy, FilePlus2, FileText, Printer } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../toast';
import { Button, Card, EmptyState, PageHeader, Tabs } from '../components/ui';
import { fmtDate, fmtDateTime } from '../lib/format';
import { PriorityPill } from './shared';

const pct = (v) => (v === null || v === undefined ? 'n/a' : `${v}%`);
const hours = (h) => (h === null || h === undefined ? 'n/a' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h} h` : `${Math.round(h / 24)} days`);

function Table({ head, rows, empty }) {
  if (!rows.length) return <div className="hd-note">{empty}</div>;
  return (
    <table className="hd-table">
      <thead><tr>{head.map((h, i) => <th key={h} className={i ? 'num' : ''}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j ? 'num' : ''}>{c}</td>)}</tr>)}</tbody>
    </table>
  );
}

export default function Reports() {
  const toast = useToast();
  const [kind, setKind] = useState('daily');
  const [list, setList] = useState(null);
  const [sel, setSel] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(() => api.get('/helpdesk/reports', { kind }).then((r) => { setList(r.data); return r.data; }).catch((e) => { toast.error(e.message); return []; }), [kind, toast]);
  useEffect(() => { setSel(null); setReport(null); setList(null); loadList().then((rows) => { if (rows[0]) setSel(rows[0].id); }); }, [loadList]);
  useEffect(() => { if (sel) api.get(`/helpdesk/reports/${sel}`).then(setReport).catch((e) => toast.error(e.message)); }, [sel, toast]);

  const generate = async () => {
    setBusy(true);
    try {
      const r = await api.post('/helpdesk/reports/generate', { kind });
      toast.success(`${kind === 'weekly' ? 'Weekly' : 'Daily'} summary built`);
      await loadList();
      setSel(r.id);
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(report.summary); toast.success('Summary copied. Paste it into an email.'); } catch { toast.error('Could not copy. Select the text and copy it by hand.'); }
  };

  const d = report && report.data;
  return (
    <>
      <PageHeader title="Reports" subtitle="A daily and a weekly summary of the support mailbox, ready to read or paste into an email.">
        <Button icon={FilePlus2} loading={busy} onClick={generate}>{kind === 'weekly' ? 'Build last week now' : 'Build yesterday now'}</Button>
      </PageHeader>
      <div className="toolbar"><Tabs value={kind} onChange={setKind} items={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }]} /></div>

      <div className="hd-split">
        <div className="card hd-noprint" style={{ overflow: 'hidden' }}>
          <div className="hd-list">
            {list === null ? <div style={{ padding: 16 }}><span className="skel" style={{ width: '80%', height: 18 }} /></div> : null}
            {list && list.length === 0 ? <div style={{ padding: 18 }} className="hd-note">No {kind} summaries yet. They are built automatically at 07:00 Gulf time{kind === 'weekly' ? ' on Mondays' : ''}, or press the button.</div> : null}
            {list && list.map((r) => (
              <button type="button" key={r.id} className={r.id === sel ? 'active' : ''} onClick={() => setSel(r.id)}>
                <span><b>{kind === 'weekly' ? `Week of ${fmtDate(r.period_start)}` : fmtDate(r.period_start)}</b></span>
                <small>{fmtDateTime(r.generated_at).slice(-5)}</small>
              </button>
            ))}
          </div>
        </div>

        <div>
          {!report ? <div className="card"><EmptyState icon={FileText} title="Pick a summary" text="Choose a day or week on the left." /></div> : (
            <>
              <Card title={report.title} sub={`Built ${fmtDateTime(report.generated_at)}`} action={<div className="row hd-noprint" style={{ gap: 8 }}><Button size="sm" icon={Copy} onClick={copy}>Copy text</Button><Button size="sm" icon={Printer} onClick={() => window.print()}>Print</Button></div>}>
                <div className="hd-report-text" dir="auto">{report.summary}</div>
              </Card>

              <div className="hd-grid c2" style={{ marginTop: 16 }}>
                <Card title="The numbers">
                  <div className="hd-score">
                    <div className="box"><div className="n">{d.new_cases}</div><div className="l">New cases</div></div>
                    <div className="box"><div className="n">{d.closed_cases}</div><div className="l">Closed</div></div>
                    <div className="box"><div className="n">{d.open_cases}</div><div className="l">Open now</div></div>
                    <div className="box"><div className="n" style={{ color: d.overdue_cases ? 'var(--danger-fg)' : undefined }}>{d.overdue_cases}</div><div className="l">Overdue now</div></div>
                  </div>
                </Card>
                <Card title="Response and AI">
                  <div className="hd-lines">
                    <div className="ln"><span>First response (average)</span><b>{hours(d.response.avg_first_response_hours)}</b></div>
                    <div className="ln"><span>Answered inside the service-level time</span><b>{pct(d.response.sla_compliance)}</b></div>
                    <div className="ln"><span>Classified with confidence</span><b>{pct(d.ai.classification_rate)}</b></div>
                    <div className="ln"><span>Drafts approved without edits</span><b>{pct(d.ai.draft_acceptance_rate)}</b></div>
                    <div className="ln"><span>Classifications changed by staff</span><b>{pct(d.ai.override_rate)}</b></div>
                  </div>
                </Card>
              </div>

              <div className="hd-grid c2">
                <Card title="New cases by category"><Table head={['Category', 'Cases']} rows={d.by_category.map((c) => [c.category, c.count])} empty="None." /></Card>
                <Card title="Top requests"><Table head={['Request', 'Cases']} rows={d.top_issues.map((t) => [t.name, t.count])} empty="No cases in this period." /></Card>
                <Card title="Open cases by age (when the summary was built)"><Table head={['Age', 'Cases']} rows={d.aging.map((a) => [a.bucket, a.count])} empty="None." /></Card>
                <Card title="Overdue by owner"><Table head={['Owner', 'Cases']} rows={d.overdue_by_owner.map((o) => [o.owner, o.count])} empty="Nothing was overdue." /></Card>
              </div>

              {d.critical_open.length ? (
                <Card title="Critical cases still open">
                  <Table head={['Case', 'Owner', 'Priority']} rows={d.critical_open.map((c) => [<span dir="auto" key={c.case_no}><b>{c.case_no}</b> {c.subject}</span>, c.owner || 'Unassigned', <PriorityPill key="p" value="Critical" />])} empty="" />
                </Card>
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  );
}
