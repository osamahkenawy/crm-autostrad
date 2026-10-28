// Customer-service dashboard: what is open, late, waiting and trending, and how the AI is doing.
// Every tile and bar opens the matching list of cases. The numbers refresh every 15 minutes.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, CheckCircle2, ChevronRight, Clock, FileEdit, Hourglass, Inbox, RefreshCw, ScanSearch } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Avatar, Button, Card, EmptyState, PageHeader, Pill, ProgressBar, StatTile, Tabs } from '../components/ui';
import { fmtDate, fmtTime, monthLabel, num } from '../lib/format';
import Readiness from './Readiness';
import { CATEGORY_COLOR, CaseStatusPill, DueText, LiveBadge, PRIORITIES, PRIORITY_COLOR, PriorityPill, useLiveSummary } from './shared';

const REFRESH_MS = 15 * 60 * 1000;
const axisTick = { fill: '#667b96', fontSize: 12, fontWeight: 600 };
const tick = (view, key) => (view === 'monthly' ? monthLabel(key) : fmtDate(key).slice(0, 6));
const hoursText = (h) => (h === null || h === undefined ? 'n/a' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h} h` : `${Math.round(h / 24)} days`);
const pct = (v) => (v === null || v === undefined ? 'n/a' : `${v}%`);

function TrendTip({ active, payload, label, view }) {
  if (!active || !payload || !payload.length) return null;
  const total = payload.reduce((a, p) => a + (p.value || 0), 0);
  return (
    <div className="card" style={{ padding: '10px 14px', boxShadow: 'var(--shadow-pop)', minWidth: 170 }}>
      <div className="muted small" style={{ fontWeight: 700, marginBottom: 4 }}>{view === 'weekly' ? `Week of ${fmtDate(label)}` : view === 'monthly' ? monthLabel(label) : fmtDate(label)}</div>
      {payload.filter((p) => p.value).reverse().map((p) => (
        <div key={p.dataKey} className="row between" style={{ gap: 14, fontSize: 13 }}><span><i className="dot-stage" style={{ background: p.color, marginRight: 6 }} />{p.dataKey}</span><b>{p.value}</b></div>
      ))}
      <div className="row between" style={{ gap: 14, marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--line)', fontWeight: 800 }}><span>Total</span><span>{total}</span></div>
    </div>
  );
}

export default function HelpdeskDashboard() {
  const { can } = useAuth();
  const [days, setDays] = useState(30);
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState('daily');

  const load = useCallback(() => {
    setLoading(true);
    return api.get('/helpdesk/dashboard', { days })
      .then((r) => { setD(r); setError(''); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [days]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, REFRESH_MS); return () => clearInterval(t); }, [load]);

  const t = d && d.totals;
  const maxAge = d ? Math.max(1, ...d.aging.map((a) => a.count)) : 1;
  const maxOwner = d ? Math.max(1, ...d.overdue_by_owner.map((o) => o.count)) : 1;
  const trend = d ? d.trends[view] : [];
  const canSetup = can('helpdesk.setup');
  const live = useLiveSummary((n) => { load(); });

  return (
    <>
      <PageHeader title="Customer service" subtitle="The support mailbox at a glance: what needs doing, what is late and what is coming in.">
        <select className="select" aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <Button icon={RefreshCw} loading={loading} onClick={load}>Refresh</Button>
        <Link to="/helpdesk/cases" className="btn btn-primary">Open cases<span className="arrow"><ChevronRight size={15} strokeWidth={2.4} /></span></Link>
      </PageHeader>
      <div style={{ margin: '-6px 0 10px' }}><LiveBadge summary={live} /></div>
      {canSetup ? <Readiness compact /> : null}
      <p className="hd-note" style={{ marginTop: -8, marginBottom: 16 }}>
        {d ? `Updated ${fmtTime(d.generated_at)}. Refreshes every ${d.refresh_minutes} minutes. Tiles and bars open the matching cases.` : 'Loading the latest numbers...'}
      </p>

      {error ? <div className="notice" style={{ marginBottom: 16 }}><AlertTriangle size={20} /><div className="grow">{error}</div><Button size="sm" onClick={load}>Try again</Button></div> : null}

      <div className="hd-kpis">
        <StatTile label="Open cases" icon={Inbox} to="/helpdesk/cases?tab=active" value={t ? num(t.open) : <span className="skel" style={{ width: 60, height: 28 }} />} foot={t ? `${t.working} to work on` : null} />
        <StatTile label="Overdue" icon={Clock} tone="danger" to="/helpdesk/cases?tab=overdue" value={t ? num(t.overdue) : <span className="skel" style={{ width: 60, height: 28 }} />} foot={t ? `${t.escalated} escalated` : null} />
        <StatTile label="Replies to approve" icon={FileEdit} tone="warn" to="/helpdesk/cases?tab=drafts" value={t ? num(t.drafts_pending) : <span className="skel" style={{ width: 60, height: 28 }} />} foot="drafted by the AI" />
        <StatTile label="Waiting for customer" icon={Hourglass} to="/helpdesk/cases?tab=pending_customer" value={t ? num(t.pending_customer) : <span className="skel" style={{ width: 60, height: 28 }} />} foot={t ? `${t.pending_internal} waiting internally` : null} />
        <StatTile label="To check" icon={ScanSearch} tone="warn" to="/helpdesk/cases?tab=triage" value={t ? num(t.needs_triage) : <span className="skel" style={{ width: 60, height: 28 }} />} foot="AI was unsure" />
        <StatTile label={`Closed, ${days} days`} icon={CheckCircle2} tone="ok" to="/helpdesk/cases?tab=closed" value={t ? num(t.closed_in_period) : <span className="skel" style={{ width: 60, height: 28 }} />} foot={t ? `${t.new_in_period} new in the period` : null} />
      </div>

      <div className="hd-grid c3">
        <Card title="Open cases by age" sub="Since the email arrived">
          <div className="hd-stack">
            {(d ? d.aging : [0, 1, 2].map(() => null)).map((a, i) => (a ? (
              <Link key={a.key} to={`/helpdesk/cases?aging=${a.key}`} className="hd-row-link">
                <div className="top"><span>{a.bucket}</span><span>{a.count}</span></div>
                <ProgressBar value={(a.count / maxAge) * 100} tone={a.key === '8+' ? 'danger' : a.key === '3-7' ? 'warn' : ''} label={a.bucket} />
              </Link>
            ) : <span key={i} className="skel" style={{ width: '90%', height: 22 }} />))}
          </div>
        </Card>

        <Card title="Overdue by owner" sub="Past the service-level time">
          {d && d.overdue_by_owner.length === 0 ? <EmptyState icon={CheckCircle2} title="Nothing is overdue" text="Every open case is inside its service-level time." /> : null}
          <div className="hd-stack">
            {d ? d.overdue_by_owner.slice(0, 6).map((o) => (
              <Link key={o.owner_id || 'none'} to={`/helpdesk/cases?tab=overdue&owner_id=${o.owner_id || 'none'}`} className="hd-row-link">
                <div className="top"><span className="row" style={{ gap: 8 }}><Avatar name={o.owner} size={24} />{o.owner}</span><span>{o.count}</span></div>
                <ProgressBar value={(o.count / maxOwner) * 100} tone="danger" label={o.owner} />
              </Link>
            )) : <span className="skel" style={{ width: '90%', height: 22 }} />}
          </div>
        </Card>

        <Card title="Open cases by priority">
          <div className="hd-stack">
            {PRIORITIES.map((p) => {
              const n = d ? d.priority[p] : null;
              const total = d ? Math.max(1, t.open) : 1;
              return (
                <Link key={p} to={`/helpdesk/cases?tab=active&priority=${p}`} className="hd-row-link">
                  <div className="top"><span><i className="dot-stage" style={{ background: PRIORITY_COLOR[p], marginRight: 8 }} />{p}</span><span>{n === null ? '' : n}</span></div>
                  <div className="bar"><i style={{ width: `${n === null ? 0 : (n / total) * 100}%`, background: PRIORITY_COLOR[p] }} /></div>
                </Link>
              );
            })}
          </div>
        </Card>
      </div>

      <Card
        title="New cases by category"
        sub="Each bar is one day, week or month of incoming requests"
        action={<Tabs value={view} onChange={setView} items={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }]} />}
        className="hd-mb"
      >
        <div style={{ height: 290 }}>
          {d ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trend} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#e3ecf7" />
                <XAxis dataKey="key" tickFormatter={(k) => tick(view, k)} tick={axisTick} axisLine={false} tickLine={false} interval={view === 'daily' ? 'preserveStartEnd' : 0} minTickGap={18} />
                <YAxis allowDecimals={false} tick={axisTick} axisLine={false} tickLine={false} />
                <Tooltip content={<TrendTip view={view} />} cursor={{ fill: 'rgba(46,134,206,0.08)' }} />
                {d.trends.categories.map((c, i) => <Bar key={c} dataKey={c} stackId="a" fill={CATEGORY_COLOR[c] || '#94a3b8'} radius={i === d.trends.categories.length - 1 ? [4, 4, 0, 0] : 0} />)}
              </BarChart>
            </ResponsiveContainer>
          ) : <span className="skel" style={{ width: '100%', height: 260 }} />}
        </div>
        {d ? (
          <div className="row wrap" style={{ gap: 16, marginTop: 10 }}>
            {d.trends.categories.map((c) => (
              <Link key={c} to={`/helpdesk/cases?tab=all&category=${encodeURIComponent(c)}`} className="row small" style={{ gap: 6, fontWeight: 700, color: 'var(--muted)' }}><i className="dot-stage" style={{ background: CATEGORY_COLOR[c] || '#94a3b8' }} />{c}</Link>
            ))}
          </div>
        ) : null}
      </Card>

      <div className="hd-grid c2" style={{ marginTop: 16 }}>
        <Card title="Top 5 issues" sub={`${days} days. Share of everything that came in`}>
          {d && d.top_issues.length === 0 ? <EmptyState icon={Inbox} title="No cases in this period" /> : null}
          <div className="hd-stack">
            {d ? d.top_issues.map((x, i) => (
              <Link key={x.sub_key} to={`/helpdesk/cases?tab=all&sub_key=${x.sub_key}`} className="hd-row-link">
                <div className="top"><span><span className="muted" style={{ marginRight: 8 }}>{i + 1}</span>{x.name}</span><span>{x.count} <small>({pct(x.share)})</small></span></div>
                <ProgressBar value={x.share} label={x.name} />
              </Link>
            )) : <span className="skel" style={{ width: '90%', height: 22 }} />}
          </div>
        </Card>

        <Card title="Where requests come from" sub="Email is read from the mailbox. The other channels are typed in">
          {d ? (
            <div className="row" style={{ gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ width: 150, height: 150, flex: 'none' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={d.channels.filter((c) => c.count > 0)} dataKey="count" nameKey="channel" innerRadius={44} outerRadius={70} paddingAngle={2} stroke="none">
                      {d.channels.filter((c) => c.count > 0).map((c) => <Cell key={c.key} fill={{ email: '#2e86ce', whatsapp: '#1fa971', calls: '#e8a23a' }[c.key]} />)}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="grow" style={{ minWidth: 220 }}>
                {d.channels.map((c) => (
                  <div className="hd-chan" key={c.key}>
                    <i className="sw" style={{ background: { email: '#2e86ce', whatsapp: '#1fa971', calls: '#e8a23a' }[c.key] }} />
                    <span>{c.channel}</span>
                    <Pill tone={c.connected ? 'ok' : c.manual ? 'info' : 'neutral'} dot={false}>{c.connected ? 'Mailbox' : c.manual ? 'Entered by hand' : 'Not connected'}</Pill>
                    <b>{num(c.count)}</b>
                  </div>
                ))}
              </div>
            </div>
          ) : <span className="skel" style={{ width: '100%', height: 150 }} />}
          <p className="hd-note" style={{ marginTop: 10 }}>
            WhatsApp and phone calls are not connected to this module, so they are not analysed or answered here.
            {canSetup ? <> Daily counts can be typed in under <Link to="/helpdesk/setup?tab=channels" style={{ color: 'var(--blue-deep)', fontWeight: 700 }}>Setup, Channels</Link>.</> : null}
          </p>
        </Card>
      </div>

      <div className="hd-grid c21">
        <Card title="AI performance" sub={`Cases that arrived in the last ${days} days`}>
          <div className="hd-trio">
            <div><div className="hd-big">{d ? pct(d.ai.classification_rate) : '...'}</div><div className="lbl">Classified with confidence<br /><span className="faint">{d ? `${d.ai.classified} cases` : ''}</span></div></div>
            <div><div className="hd-big">{d ? pct(d.ai.draft_acceptance_rate) : '...'}</div><div className="lbl">Drafts approved without edits<br /><span className="faint">{d ? `${d.ai.drafts_accepted} of ${d.ai.drafts_reviewed} reviewed` : ''}</span></div></div>
            <div><div className="hd-big">{d ? pct(d.ai.override_rate) : '...'}</div><div className="lbl">Classifications changed by staff<br /><span className="faint">{d ? `${d.ai.overrides} corrections, lower is better` : ''}</span></div></div>
          </div>
          {d ? (
            <p className="hd-note" style={{ marginTop: 14 }}>
              Average confidence {pct(d.ai.avg_confidence)}. Engine: {Object.entries(d.ai.engine_mix || {}).map(([k, v]) => `${k === 'rules' ? 'keyword rules' : k === 'rules+llm' ? 'rules with AI' : k} ${v}`).join(', ') || 'no cases yet'}.
              {' '}Replies are drafts only: a person approves every one.
              {canSetup ? <> See <Link to="/helpdesk/lab" style={{ color: 'var(--blue-deep)', fontWeight: 700 }}>AI lab</Link> to test and tune it.</> : null}
            </p>
          ) : null}
        </Card>

        <Card title="Response times">
          <div className="hd-lines">
            <div className="ln"><span>First response (average)</span><b>{d ? hoursText(d.response.avg_first_response_hours) : '...'}</b></div>
            <div className="ln"><span>Time to resolve (average)</span><b>{d ? hoursText(d.response.avg_resolution_hours) : '...'}</b></div>
            <div className="ln"><span>Answered inside the service-level time</span><b>{d ? pct(d.response.sla_compliance) : '...'}</b></div>
            <div className="ln"><span>Cases answered</span><b>{d ? num(d.response.responded) : '...'}</b></div>
          </div>
        </Card>
      </div>

      <Card title="Needs attention" sub="Overdue and critical cases, most urgent first">
        {d && d.attention.length === 0 ? <EmptyState icon={CheckCircle2} title="All clear" text="No overdue or critical cases right now." /> : null}
        {d ? d.attention.map((c) => (
          <Link key={c.id} to={`/helpdesk/cases?open=${c.id}`} className="attn">
            <span className="ico" style={{ background: c.is_overdue ? 'var(--danger-bg)' : 'var(--warn-bg)', color: c.is_overdue ? 'var(--danger-fg)' : 'var(--warn-fg)' }}><Clock size={17} strokeWidth={1.9} /></span>
            <span className="grow" style={{ minWidth: 0 }}>
              <div className="strong ellipsis" dir="auto">{c.subject}</div>
              <div className="muted small">{c.case_no} · {c.sub_category} · {c.owner || 'Unassigned'}</div>
            </span>
            <PriorityPill value={c.priority} />
            <CaseStatusPill value={c.status} />
            <DueText c={{ due_at: c.due_at, status: c.status }} />
            <ChevronRight size={16} className="chev" />
          </Link>
        )) : <span className="skel" style={{ width: '100%', height: 60 }} />}
      </Card>
    </>
  );
}
