import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ChevronLeft, ChevronRight, Download, Inbox, Kanban, LayoutGrid, Pencil, Plus, Search, Table2, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../toast';
import { Button, EmptyState, PageHeader, Pill, StatTile, Tabs } from './ui';
import { ConfirmDialog, Drawer, Modal } from './Modal';
import DataTable from './DataTable';
import RecordForm from './RecordForm';
import { toFormValues, toPayload, validate } from '../lib/formValues';
import { invalidateOptions, useOptions } from '../lib/options';
import { downloadCsv } from '../lib/csv';
import { fmtDate, fmtDateTime, humanize, money, todayStr } from '../lib/format';

const PAGE_SIZE = 20;
const LAYOUT_META = { table: ['Table', Table2], cards: ['Cards', LayoutGrid], board: ['Board', Kanban] };
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** How a form field is shown in the read-only part of the drawer. */
function viewValue(f, row) {
  if (f.view) return f.view(row);
  const v = row[f.key];
  if (v === null || v === undefined || v === '') return <span className="faint">—</span>;
  if (f.type === 'relation') return row[f.labelKey] ?? v;
  if (f.type === 'select') {
    const o = (f.options || []).map((x) => (typeof x === 'object' ? x : { value: x, label: x })).find((x) => String(x.value) === String(v));
    return o ? o.label : humanize(v);
  }
  if (f.type === 'date') return fmtDate(v);
  if (f.type === 'datetime') return fmtDateTime(v);
  if (f.format === 'money') return money(v);
  if (f.type === 'number') return `${nf.format(v)}${f.suffix ? ` ${f.suffix}` : ''}`;
  return String(v);
}

/* --------------------------- related records ---------------------------- */
function RelatedList({ rel, record }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const limit = rel.limit || 5;

  useEffect(() => {
    let alive = true;
    setRows(null);
    api.get(`/${rel.resource}`, { [rel.by]: record.id, limit, ...(rel.params || {}) })
      .then((r) => { if (alive) { setRows(r.data); setTotal(r.total); } })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [rel.resource, rel.by, record.id, limit]);

  return (
    <div>
      <div className="section-title">
        <span>{rel.title}</span>
        {total > limit ? <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>latest {limit} of {total}</span> : null}
      </div>
      <div className="related">
        {rows === null ? <div className="rnone"><span className="skel" style={{ width: '60%' }} /></div> : null}
        {rows && rows.length === 0 ? <div className="rnone">{rel.empty || 'Nothing yet.'}</div> : null}
        {rows && rows.map((r) => {
          const v = rel.row(r);
          return (
            <button type="button" key={r.id} className="rrow" onClick={() => navigate(`${rel.page}?open=${r.id}`)}>
              <div className="grow">
                <div className="cell-main ellipsis">{v.title}</div>
                {v.sub ? <div className="cell-sub">{v.sub}</div> : null}
              </div>
              <div className="right nowrap">{v.right}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------- board ---------------------------------- */
function Board({ config, rows, onOpen, onMove, ctx }) {
  const { field, columns, card, sum } = config.board;
  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState(null);
  const grouped = useMemo(() => {
    const g = Object.fromEntries(columns.map((c) => [c.value, []]));
    for (const r of rows) (g[r[field]] || (g[r[field]] = [])).push(r);
    return g;
  }, [rows, columns, field]);

  return (
    <div className="board">
      {columns.map((col) => {
        const list = grouped[col.value] || [];
        return (
          <div
            key={col.value}
            className={`bcol${over === col.value ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); if (over !== col.value) setOver(col.value); }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null); }}
            onDrop={(e) => {
              e.preventDefault();
              const id = Number(e.dataTransfer.getData('text/plain')) || dragId;
              setOver(null);
              setDragId(null);
              if (id && onMove) onMove(id, col.value);
            }}
          >
            <div className="bcol-head">
              <span className="dot-stage" style={{ background: col.color }} />
              <h4>{col.label}</h4>
              <span className="tag">{list.length}</span>
              {sum ? <span className="sum">{sum(list)}</span> : null}
            </div>
            {list.map((row) => (
              <div
                key={row.id}
                className={`bcard${dragId === row.id ? ' dragging' : ''}`}
                draggable={Boolean(onMove)}
                onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(row.id)); e.dataTransfer.effectAllowed = 'move'; setDragId(row.id); }}
                onDragEnd={() => { setDragId(null); setOver(null); }}
                onClick={() => onOpen(row)}
              >
                {card(row, ctx)}
              </div>
            ))}
            {!list.length ? <div className="muted small" style={{ padding: '18px 8px', textAlign: 'center' }}>{onMove ? 'Drop a card here' : 'Nothing here'}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------- pager ---------------------------------- */
function Pager({ page, pages, onChange }) {
  const nums = [];
  for (let p = 1; p <= pages; p++) if (p === 1 || p === pages || Math.abs(p - page) <= 1) nums.push(p);
  const withGaps = nums.reduce((acc, p, i) => { if (i && p - nums[i - 1] > 1) acc.push('…'); acc.push(p); return acc; }, []);
  return (
    <div className="pager">
      <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page"><ChevronLeft size={16} /></button>
      {withGaps.map((p, i) => (p === '…'
        ? <span key={`g${i}`} className="faint">…</span>
        : <button type="button" key={p} className={p === page ? 'active' : ''} onClick={() => onChange(p)}>{p}</button>))}
      <button type="button" disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label="Next page"><ChevronRight size={16} /></button>
    </div>
  );
}

/* --------------------------------- page --------------------------------- */
export default function CrudPage({ config, embedded = false }) {
  const { resource, form } = config;
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const options = useOptions();
  const { can } = useAuth();
  // changing data needs the 'edit' ability of this area (server/src/roles.js); view-only roles get a read-only page
  const editable = can(config.editCap || `${resource}.edit`);

  const tabField = config.tabs && config.tabs.field;
  const tabDefault = config.tabs && config.tabs.default !== undefined ? config.tabs.default : '';
  const filterKeys = useMemo(() => [tabField, ...(config.filters || []).map((f) => f.key)].filter(Boolean), [config, tabField]);

  const [page, setPage] = useState(1);
  const [q, setQ] = useState(params.get('q') || '');
  const dq = useDebounced(q, 280);
  const [filters, setFilters] = useState(() => Object.fromEntries(filterKeys.map((k) => [k, params.get(k) ?? (k === tabField ? tabDefault : '')])));
  const [sort, setSort] = useState(config.defaultSort || null);

  const layouts = config.layouts || ['table'];
  const [layoutPref, setLayoutPref] = useState(() => { try { return localStorage.getItem(`autostrad.layout.${resource}`); } catch { return null; } });
  const layout = layouts.includes(layoutPref) ? layoutPref : layouts[0];
  const chooseLayout = (l) => {
    setLayoutPref(l);
    setPage(1);
    try { localStorage.setItem(`autostrad.layout.${resource}`, l); } catch { /* ignore */ }
  };

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [counts, setCounts] = useState(null);
  const [dash, setDash] = useState(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const reqId = useRef(0);

  const [record, setRecord] = useState(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({});
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const fields = form ? form.fields : [];
  const query = useMemo(() => ({ q: dq, ...filters, sort: sort && sort.key, dir: sort && sort.dir }), [dq, filters, sort]);
  const otherFilters = useMemo(() => { const { [tabField]: _tab, ...rest } = filters; return rest; }, [filters, tabField]);
  const filtersActive = Boolean(q) || Object.entries(filters).some(([k, v]) => v && !(k === tabField && v === tabDefault));

  /* ---- list ---- */
  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    const board = layout === 'board';
    api.get(`/${resource}`, { ...query, limit: board ? 500 : PAGE_SIZE, offset: board ? 0 : (page - 1) * PAGE_SIZE })
      .then((r) => { if (id === reqId.current) { setRows(r.data); setTotal(r.total); setError(''); } })
      .catch((e) => { if (id === reqId.current) setError(e.message); })
      .finally(() => { if (id === reqId.current) setLoading(false); });
  }, [resource, query, page, layout, version]);

  /* ---- tab counts ---- */
  useEffect(() => {
    if (!tabField) return undefined;
    let alive = true;
    api.get(`/${resource}/_counts`, { field: tabField, q: dq, ...otherFilters })
      .then((r) => { if (alive) setCounts(r); })
      .catch(() => {});
    return () => { alive = false; };
  }, [resource, tabField, dq, otherFilters, version]);

  /* ---- summary tiles ---- */
  useEffect(() => {
    if (!config.stats) return;
    api.get('/stats/dashboard').then(setDash).catch(() => {});
  }, [config, version]);

  /* ---- deep links: ?open=ID and ?new=1 ---- */
  useEffect(() => {
    const open = params.get('open');
    const wantsNew = params.get('new');
    if (!open && !wantsNew) return;
    const next = new URLSearchParams(params);
    next.delete('open');
    next.delete('new');
    setParams(next, { replace: true });
    if (wantsNew && form && editable) startCreate();
    if (open) api.get(`/${resource}/${open}`).then((row) => { setRecord(row); setEditing(false); }).catch((e) => toast.error(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- helpers ---- */
  const setFilter = (key, value) => { setFilters((f) => ({ ...f, [key]: value })); setPage(1); };
  const clearFilters = () => { setQ(''); setFilters(Object.fromEntries(filterKeys.map((k) => [k, k === tabField ? tabDefault : '']))); setPage(1); };
  const toggleSort = (key) => {
    setSort((s) => (s && s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
    setPage(1);
  };

  const setField = useCallback((key, value) => {
    setDraft((d) => {
      const next = { ...d, [key]: value };
      const patch = form && form.compute ? form.compute(next, key, { options, mode: creating ? 'create' : 'edit' }) : null;
      return patch ? { ...next, ...patch } : next;
    });
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  }, [form, options, creating]);

  function startCreate() {
    setDraft(toFormValues(fields, form.defaults ? form.defaults() : {}));
    setErrors({});
    setFormError('');
    setCreating(true);
  }
  const startEdit = (row) => {
    setDraft(toFormValues(fields, row));
    setErrors({});
    setFormError('');
    setEditing(true);
  };
  const openRecord = (row) => { setRecord(row); setEditing(false); setFormError(''); };
  const closeRecord = () => { setRecord(null); setEditing(false); };

  const save = async () => {
    const mode = creating ? 'create' : 'edit';
    const errs = validate(fields, draft, mode);
    if (Object.keys(errs).length) { setErrors(errs); setFormError('Please fix the highlighted fields.'); return; }
    setSaving(true);
    setFormError('');
    try {
      const payload = toPayload(fields, draft);
      if (creating) {
        const created = await api.post(`/${resource}`, payload);
        toast.success(`${cap(config.singular)} created`);
        setCreating(false);
        if (config.openAfterCreate) openRecord(created);
      } else {
        const updated = await api.put(`/${resource}/${record.id}`, payload);
        setRecord(updated);
        setEditing(false);
        toast.success('Changes saved');
      }
      invalidateOptions();
      refresh();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const askDelete = (row) => setConfirm({
    title: `Delete this ${config.singular}?`,
    message: `${config.recordTitle(row)} will be removed permanently. This cannot be undone.`,
    label: 'Delete',
    run: async () => {
      await api.del(`/${resource}/${row.id}`);
      toast.success(`${cap(config.singular)} deleted`);
      closeRecord();
      invalidateOptions();
      refresh();
    },
  });

  const actionsFor = (row) => (config.actions ? config.actions(row).filter((a) => !a.when || a.when(row)) : []);
  const runAction = async (a, row) => {
    const exec = async () => {
      const updated = await api.put(`/${resource}/${row.id}`, a.patch(row));
      toast.success(a.success || 'Updated');
      if (record && record.id === row.id) setRecord(updated);
      invalidateOptions();
      refresh();
    };
    if (a.confirm) setConfirm({ title: `${a.label}?`, message: a.confirm, label: a.label, tone: a.confirmTone || (a.tone === 'danger' ? 'danger' : 'primary'), run: exec });
    else { try { await exec(); } catch (e) { toast.error(e.message); } }
  };

  const confirmRun = async () => {
    setBusy(true);
    try { await confirm.run(); } catch (e) { toast.error(e.message); } finally { setBusy(false); setConfirm(null); }
  };

  const moveCard = async (id, value) => {
    const field = config.board.field;
    const row = rows.find((r) => r.id === id);
    if (!row || row[field] === value) return;
    setRows((list) => list.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    try {
      await api.put(`/${resource}/${id}`, { [field]: value });
      toast.success(config.board.movedMessage ? config.board.movedMessage(row, value) : 'Moved');
      refresh();
    } catch (e) {
      setRows((list) => list.map((r) => (r.id === id ? { ...r, [field]: row[field] } : r)));
      toast.error(e.message);
    }
  };

  const exportCsv = async () => {
    try {
      const r = await api.get(`/${resource}`, { ...query, limit: 1000 });
      const cols = (config.exportColumns || config.columns).filter((c) => c.label).map((c) => ({ label: c.label, value: c.export || ((row) => row[c.key]) }));
      downloadCsv(`autostrad-${resource.replace(/\//g, '-')}-${todayStr()}.csv`, cols.map((c) => c.label), r.data.map((row) => cols.map((c) => c.value(row))));
      toast.success(`Exported ${r.data.length} ${config.plural || 'records'}`);
    } catch (e) { toast.error(e.message); }
  };

  const ctx = { refresh, toast, options, navigate };
  const columns = config.actions && editable
    ? [...config.columns, {
      key: '_actions',
      label: '',
      align: 'right',
      render: (row) => {
        const a = actionsFor(row)[0];
        return a ? (
          <Button variant={a.tone || 'soft'} size="xs" icon={a.icon} onClick={(e) => { e.stopPropagation(); runAction(a, row); }}>{a.short || a.label}</Button>
        ) : null;
      },
    }]
    : config.columns;

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(total, page * PAGE_SIZE);
  const empty = !loading && !error && rows.length === 0;

  const tabItems = config.tabs
    ? [
      { value: '', label: config.tabs.all || 'All', count: counts ? counts.total : undefined },
      ...config.tabs.options.map((o) => ({ value: o.value, label: o.label, count: counts ? (counts.counts[o.value] || 0) : undefined })),
    ]
    : null;

  const filterOptions = (f) => (f.options || []).map((o) => (typeof o === 'object' ? o : { value: o, label: o }));

  /* ---------------------------------- render --------------------------------- */
  return (
    <>
      {embedded ? (
        <div className="row between wrap" style={{ marginBottom: 14, gap: 12 }}>
          <p className="muted grow" style={{ margin: 0, minWidth: 220 }}>{config.subtitle}</p>
          <div className="row" style={{ gap: 10 }}>
            <Button icon={Download} onClick={exportCsv}>Export</Button>
            {form && config.canCreate !== false && editable ? <Button variant="primary" arrow icon={Plus} onClick={startCreate}>{config.addLabel || `New ${config.singular}`}</Button> : null}
          </div>
        </div>
      ) : (
        <PageHeader title={config.title} subtitle={config.subtitle}>
          <Button icon={Download} onClick={exportCsv}>Export</Button>
          {config.HeaderExtra ? <config.HeaderExtra /> : null}
          {form && !editable ? <Pill tone="neutral" dot={false}>View only for your role</Pill> : null}
          {form && config.canCreate !== false && editable ? (
            <Button variant="primary" arrow icon={Plus} onClick={startCreate}>{config.addLabel || `New ${config.singular}`}</Button>
          ) : null}
        </PageHeader>
      )}

      {config.stats ? (
        <div className="strip">
          {config.stats.map((s) => (
            <StatTile key={s.label} label={s.label} icon={s.icon} tone={s.tone} to={s.to}
              value={dash ? s.value(dash) : <span className="skel" style={{ width: 90, height: 26 }} />}
              foot={dash && s.foot ? s.foot(dash) : null} />
          ))}
        </div>
      ) : null}

      <div className="toolbar">
        {tabItems ? <Tabs value={filters[tabField] || ''} onChange={(v) => setFilter(tabField, v)} items={tabItems} /> : null}
        <div className="search">
          <Search size={18} />
          <input className="input" type="search" placeholder={config.searchPlaceholder || 'Search…'} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Search" />
        </div>
        <div className="filters">
          {(config.filters || []).map((f) => {
            const opts = f.relation
              ? ((options && options[f.relation]) || []).map((o) => ({ value: o.id, label: o.name || o.ref }))
              : filterOptions(f);
            return (
              <select key={f.key} className="select" aria-label={f.label} value={filters[f.key] || ''} onChange={(e) => setFilter(f.key, e.target.value)}>
                <option value="">{f.label}: all</option>
                {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            );
          })}
          {filtersActive ? <Button variant="soft" onClick={clearFilters}>Clear</Button> : null}
        </div>
        {layouts.length > 1 ? (
          <div style={{ marginLeft: 'auto' }}>
            <Tabs value={layout} onChange={chooseLayout} items={layouts.map((l) => ({ value: l, label: LAYOUT_META[l][0], icon: LAYOUT_META[l][1] }))} />
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="notice" style={{ marginBottom: 16 }}>
          <AlertTriangle size={20} />
          <div className="grow">{error}</div>
          <Button size="sm" onClick={refresh}>Try again</Button>
        </div>
      ) : null}

      {layout === 'board' ? (
        loading && !rows.length
          ? <div className="board">{[0, 1, 2, 3].map((i) => <div key={i} className="bcol"><span className="skel" style={{ width: '50%', margin: '8px 6px 16px' }} />{[0, 1].map((j) => <div key={j} className="bcard"><span className="skel" style={{ width: '70%', marginBottom: 10 }} /><span className="skel" style={{ width: '40%' }} /></div>)}</div>)}</div>
          : <Board config={config} rows={rows} onOpen={openRecord} onMove={editable ? moveCard : undefined} ctx={ctx} />
      ) : null}

      {layout === 'cards' ? (
        <>
          <div className="grid-cards">
            {loading && !rows.length
              ? Array.from({ length: 6 }, (_, i) => <div key={i} className="card ccard"><span className="skel" style={{ width: '60%', marginBottom: 14 }} /><span className="skel" style={{ width: '90%', marginBottom: 8 }} /><span className="skel" style={{ width: '40%' }} /></div>)
              : rows.map((row) => <div key={row.id} className="card ccard" onClick={() => openRecord(row)}>{config.card(row, ctx)}</div>)}
          </div>
          {empty ? <div className="card" style={{ marginTop: 16 }}><EmptyState icon={Inbox} title={`No ${config.plural || 'records'} found`} text={filtersActive ? 'Try a different search or clear the filters.' : undefined} /></div> : null}
        </>
      ) : null}

      {layout === 'table' ? (
        <div className="card table-card">
          <DataTable columns={columns} rows={rows} loading={loading} sort={sort} onSort={toggleSort} onRowClick={openRecord} selectedId={record && record.id} ctx={ctx} />
          {empty ? (
            <EmptyState icon={Inbox} title={`No ${config.plural || 'records'} found`} text={filtersActive ? 'Try a different search or clear the filters.' : 'Nothing here yet.'}
              action={filtersActive ? <Button variant="soft" onClick={clearFilters}>Clear filters</Button> : null} />
          ) : null}
        </div>
      ) : null}

      {layout !== 'board' && total > 0 ? (
        <div className="table-foot" style={layout === 'table' ? { background: '#fff', borderRadius: '0 0 18px 18px', marginTop: -1, boxShadow: 'var(--shadow)' } : undefined}>
          <span>Showing {from}–{to} of {total} {total === 1 ? config.singular : (config.plural || 'records')}</span>
          {pages > 1 ? <Pager page={page} pages={pages} onChange={setPage} /> : null}
        </div>
      ) : null}
      {layout === 'board' && !loading ? <div className="muted small" style={{ marginTop: 4 }}>{total} {total === 1 ? config.singular : (config.plural || 'records')} · drag a card to change its {config.board.field}</div> : null}

      {/* record drawer */}
      <Drawer
        open={Boolean(record)}
        onClose={closeRecord}
        head={record ? (
          <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
            {config.avatar ? config.avatar(record) : null}
            <div className="grow">
              <h2>{editing ? `Edit ${config.singular}` : config.recordTitle(record)}</h2>
              <div className="muted" style={{ marginTop: 2 }}>{editing ? config.recordTitle(record) : (config.recordSubtitle ? config.recordSubtitle(record) : null)}</div>
              {!editing && config.badges ? <div className="row wrap" style={{ marginTop: 10, gap: 8 }}>{config.badges(record)}</div> : null}
            </div>
          </div>
        ) : null}
        footer={record ? (
          editing ? (
            <>
              <Button variant="primary" arrow loading={saving} onClick={save}>Save changes</Button>
              <Button onClick={() => { setEditing(false); setFormError(''); }}>Cancel</Button>
              {formError ? <span className="err" style={{ color: 'var(--danger-fg)', fontWeight: 600 }}>{formError}</span> : null}
            </>
          ) : (
            <>
              {form && config.canEdit !== false && editable ? <Button variant="primary" icon={Pencil} onClick={() => startEdit(record)}>Edit</Button> : null}
              {editable ? actionsFor(record).map((a) => <Button key={a.key} variant={a.tone || 'soft'} icon={a.icon} onClick={() => runAction(a, record)}>{a.label}</Button>) : null}
              {config.canDelete !== false && editable ? <Button variant="danger" icon={Trash2} onClick={() => askDelete(record)} className="grow-gap" style={{ marginLeft: 'auto' }}>Delete</Button> : null}
            </>
          )
        ) : null}
      >
        {record ? (editing ? (
          <RecordForm fields={fields} values={draft} onChange={setField} errors={errors} mode="edit" />
        ) : (
          <>
            {config.highlights ? config.highlights(record, ctx) : null}
            {form ? (
              <dl className="dl">
                {fields.filter((f) => f.type !== 'section' && f.type !== 'password' && !(f.hideInView) && !(f.hidden && f.hidden('edit', record))).map((f) => (
                  <div key={f.key} className={f.type === 'textarea' || f.span === 2 ? 'full' : ''}>
                    <dt>{f.label}</dt>
                    <dd>{viewValue(f, record)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {(config.related || []).map((rel) => <RelatedList key={rel.title} rel={rel} record={record} />)}
          </>
        )) : null}
      </Drawer>

      {/* create */}
      {form ? (
        <Modal
          open={creating}
          onClose={() => setCreating(false)}
          title={`New ${config.singular}`}
          subtitle={config.createHint}
          footer={(
            <>
              {formError ? <span style={{ color: 'var(--danger-fg)', fontWeight: 600, marginRight: 'auto' }}>{formError}</span> : null}
              <Button onClick={() => setCreating(false)}>Cancel</Button>
              <Button variant="primary" arrow loading={saving} onClick={save}>{config.createLabel || `Create ${config.singular}`}</Button>
            </>
          )}
        >
          <RecordForm fields={fields} values={draft} onChange={setField} errors={errors} mode="create" />
        </Modal>
      ) : null}

      <ConfirmDialog open={Boolean(confirm)} title={confirm && confirm.title} message={confirm && confirm.message} confirmLabel={confirm && confirm.label} tone={confirm && confirm.tone} busy={busy} onConfirm={confirmRun} onCancel={() => setConfirm(null)} />
    </>
  );
}
