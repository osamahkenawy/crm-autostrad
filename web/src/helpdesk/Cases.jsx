// The case list: one row per customer request, grouped into work queues (tabs). Opening a row shows the whole case.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Download, FlaskConical, Inbox, Lock, MailCheck, Search } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../toast';
import { Button, EmptyState, PageHeader, Tabs } from '../components/ui';
import DataTable from '../components/DataTable';
import { downloadCsv } from '../lib/csv';
import { fmtDateTime, relTime, todayStr } from '../lib/format';
import SampleEmails from './Samples';
import CaseDrawer from './CaseDrawer';
import { CaseStatusPill, DueText, LiveBadge, OwnerCell, PRIORITIES, Pager, PriorityPill, useDebounced, useLiveSummary, useMeta } from './shared';

const PAGE = 25;
const TABS = [
  ['active', 'Active'], ['action', 'Needs action'], ['drafts', 'Replies to approve'], ['pending_customer', 'Waiting for customer'],
  ['overdue', 'Overdue'], ['triage', 'To check'], ['mine', 'Mine'], ['closed', 'Closed'], ['all', 'All'],
];
const SORT_BY_TAB = { closed: { key: 'first_received_at', dir: 'desc' }, all: { key: 'first_received_at', dir: 'desc' }, triage: { key: 'first_received_at', dir: 'desc' } };
const FILTERS = ['priority', 'category', 'sub_key', 'department', 'owner_id', 'aging'];

export default function Cases() {
  const toast = useToast();
  const meta = useMeta();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([v]) => v === params.get('tab')) ? params.get('tab') : 'active';
  const filters = Object.fromEntries(FILTERS.map((k) => [k, params.get(k) || '']));
  const openId = Number(params.get('open')) || null;

  const [q, setQ] = useState(params.get('q') || '');
  const dq = useDebounced(q);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const [samplesOpen, setSamplesOpen] = useState(false);
  const quiet = useRef(0);
  const live = useLiveSummary((n) => { if (Date.now() > quiet.current) toast.success(`${n} new case${n > 1 ? 's' : ''} arrived from the mailbox`); refresh(); });

  const effSort = sort || SORT_BY_TAB[tab] || { key: 'due_at', dir: 'asc' };
  const filterKey = JSON.stringify(filters);

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: key === 'open' ? false : true });
  };
  const changeTab = (v) => { setParam('tab', v === 'active' ? '' : v); setPage(1); setSort(null); };
  const setFilter = (k, v) => { setParam(k, v); setPage(1); };
  const clear = () => {
    const next = new URLSearchParams();
    if (tab !== 'active') next.set('tab', tab);
    setParams(next, { replace: true });
    setQ(''); setPage(1);
  };
  const filtersActive = Boolean(dq) || FILTERS.some((k) => filters[k]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get('/helpdesk/cases', { tab, ...filters, q: dq, sort: effSort.key, dir: effSort.dir, limit: PAGE, offset: (page - 1) * PAGE })
      .then((r) => { if (alive) { setRows(r.data); setTotal(r.total); setError(''); } })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, filterKey, dq, effSort.key, effSort.dir, page, version]);

  useEffect(() => {
    let alive = true;
    api.get('/helpdesk/cases/counts', { ...filters, q: dq }).then((c) => { if (alive) setCounts(c); }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, dq, version]);

  const toggleSort = (key) => { setSort((s) => { const cur = s || effSort; return cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'priority' ? 'asc' : 'desc' }; }); setPage(1); };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await api.post('/helpdesk/mailbox/sync');
      const bits = [r.created && `${r.created} new case${r.created > 1 ? 's' : ''}`, r.attached && `${r.attached} customer repl${r.attached > 1 ? 'ies' : 'y'}`, r.outbound && `${r.outbound} sent`].filter(Boolean);
      if (r.errors && r.errors.length) toast.error(`Mailbox check had a problem: ${r.errors[0]}`); else toast.success(bits.length ? `Mailbox checked: ${bits.join(', ')}` : 'Mailbox checked: nothing new');
      refresh();
    } catch (e) { toast.error(e.message); } finally { setSyncing(false); }
  };
  const exportCsv = async () => {
    try {
      const r = await api.get('/helpdesk/cases', { tab, ...filters, q: dq, sort: effSort.key, dir: effSort.dir, limit: 500 });
      downloadCsv(`autostrad-cases-${todayStr()}.csv`,
        ['Case', 'Subject', 'Customer', 'Email', 'Contract', 'Category', 'Request', 'Priority', 'Status', 'Owner', 'Team', 'Received', 'Due', 'Closed', 'Closure reason'],
        r.data.map((c) => [c.case_no, c.subject, c.customer_name, c.customer_email, c.contract_no, c.category, c.sub_category, c.priority, c.status, c.owner_name, c.department, c.first_received_at, c.due_at, c.closed_at, c.closure_reason]));
      toast.success(`Exported ${r.data.length} cases`);
    } catch (e) { toast.error(e.message); }
  };

  const categories = useMemo(() => (meta ? [...new Set(meta.subcategories.map((s) => s.category))] : []), [meta]);
  const columns = [
    {
      key: 'case', label: 'Case', render: (c) => (
        <div style={{ minWidth: 200, maxWidth: 300 }}>
          <div className="cell-main ellipsis" dir="auto">{c.subject}</div>
          <div className="cell-sub">{c.case_no} · {c.customer_name || c.customer_email}{c.contract_no ? ` · ${c.contract_no}` : ''}</div>
        </div>
      ),
    },
    {
      key: 'type', label: 'Request', render: (c) => (
        <div>
          <div className="cell-main">{c.sub_category}{c.sensitive ? <Lock size={12} style={{ marginLeft: 6, color: 'var(--muted)' }} aria-label="Sensitive financial request" /> : null}</div>
          <div className="cell-sub">{c.category}{c.needs_review ? ' · to check' : ''}</div>
        </div>
      ),
    },
    { key: 'priority', label: 'Priority', sortable: true, render: (c) => <PriorityPill value={c.priority} /> },
    {
      key: 'status', label: 'Status', sortable: true, render: (c) => (
        <div>
          <CaseStatusPill value={c.status} />
          {c.has_draft || c.escalation_level > 0 ? (
            <div className="cell-sub nowrap">
              {c.has_draft ? 'Reply ready' : null}{c.has_draft && c.escalation_level > 0 ? ' · ' : null}
              {c.escalation_level > 0 ? <span style={{ color: 'var(--danger-fg)', fontWeight: 700 }}>Escalated</span> : null}
            </div>
          ) : null}
        </div>
      ),
    },
    { key: 'owner', label: 'Owner', render: (c) => <OwnerCell name={c.owner_name} /> },
    { key: 'due_at', label: 'Due', sortable: true, render: (c) => <DueText c={c} /> },
    { key: 'first_received_at', label: 'Received', sortable: true, render: (c) => <span className="nowrap muted" title={fmtDateTime(c.first_received_at)}>{relTime(c.first_received_at)}</span> },
  ];

  const canDemo = meta && meta.provider === 'demo';

  return (
    <>
      <PageHeader title="Cases" subtitle="Every customer email becomes a case. Work through the queues, review the drafted replies, close what is done.">
        <Button icon={Download} onClick={exportCsv}>Export</Button>
        {canDemo ? <Button icon={FlaskConical} onClick={() => setSamplesOpen(true)} title="Demo mailbox: send a made-up customer email through the real steps">Sample emails</Button> : null}
        <Button variant="primary" icon={MailCheck} loading={syncing} onClick={syncNow}>Check mailbox now</Button>
      </PageHeader>
      <div style={{ margin: '-6px 0 14px' }}><LiveBadge summary={live} /></div>

      <div className="toolbar">
        <Tabs value={tab} onChange={changeTab} items={TABS.map(([value, label]) => ({ value, label, count: counts ? counts[value] : undefined }))} />
      </div>
      <div className="toolbar" style={{ marginTop: -4 }}>
        <div className="search">
          <Search size={18} />
          <input className="input" type="search" placeholder="Search case number, customer, contract, subject..." value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Search cases" />
        </div>
        <div className="filters hd-filters">
          <select className="select" aria-label="Priority" value={filters.priority} onChange={(e) => setFilter('priority', e.target.value)}>
            <option value="">Priority: all</option>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select className="select" aria-label="Category" value={filters.category} onChange={(e) => setFilter('category', e.target.value)}>
            <option value="">Category: all</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="select" aria-label="Request type" value={filters.sub_key} onChange={(e) => setFilter('sub_key', e.target.value)}>
            <option value="">Request: all</option>
            {meta ? meta.subcategories.map((s) => <option key={s.key} value={s.key}>{s.name}</option>) : null}
          </select>
          <select className="select" aria-label="Team" value={filters.department} onChange={(e) => setFilter('department', e.target.value)}>
            <option value="">Team: all</option>
            {meta ? meta.departments.map((d) => <option key={d} value={d}>{d}</option>) : null}
          </select>
          <select className="select" aria-label="Owner" value={filters.owner_id} onChange={(e) => setFilter('owner_id', e.target.value)}>
            <option value="">Owner: all</option>
            <option value="me">Me</option>
            <option value="none">Unassigned</option>
            {meta ? meta.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>) : null}
          </select>
          <select className="select" aria-label="Age" value={filters.aging} onChange={(e) => setFilter('aging', e.target.value)}>
            <option value="">Age: any</option>
            <option value="0-2">Open 0 to 2 days</option>
            <option value="3-7">Open 3 to 7 days</option>
            <option value="8+">Open 8+ days</option>
          </select>
          {filtersActive ? <Button variant="soft" onClick={clear}>Clear</Button> : null}
        </div>
      </div>

      {error ? <div className="notice" style={{ marginBottom: 16 }}><AlertTriangle size={20} /><div className="grow">{error}</div><Button size="sm" onClick={refresh}>Try again</Button></div> : null}

      <div className="card table-card">
        <DataTable columns={columns} rows={rows} loading={loading} sort={effSort} onSort={toggleSort} onRowClick={(c) => setParam('open', String(c.id))} selectedId={openId} />
        {!loading && !error && rows.length === 0 ? (
          <EmptyState icon={Inbox} title="No cases here" text={filtersActive ? 'Try a different search or clear the filters.' : tab === 'overdue' ? 'Nothing is overdue.' : 'Nothing in this queue right now.'} />
        ) : null}
        <div className="table-foot">
          <span className="muted small">{total ? `${(page - 1) * PAGE + 1} to ${Math.min(total, page * PAGE)} of ${total}` : ''}</span>
          <Pager page={page} pages={Math.max(1, Math.ceil(total / PAGE))} onChange={setPage} />
        </div>
      </div>

      {openId ? <CaseDrawer key={openId} caseId={openId} ids={rows.map((r) => r.id)} onClose={() => setParam('open', '')} onChanged={refresh} onOpenCase={(id) => setParam('open', String(id))} /> : null}
      <SampleEmails open={samplesOpen} onClose={() => setSamplesOpen(false)} onSent={(id) => { quiet.current = Date.now() + 45000; refresh(); setParam('open', String(id)); }} />
    </>
  );
}
