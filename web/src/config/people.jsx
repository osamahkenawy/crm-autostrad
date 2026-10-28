import RolesGuide from '../components/RolesGuide';
import { ROLE_OPTIONS } from '../lib/roles';
import { BadgeCheck, Ban, Car, Check, RotateCcw, ThumbsUp, Users, XCircle } from 'lucide-react';
import { api } from '../api';
import { Avatar, Pill, StatusPill } from '../components/ui';
import { CheckToggle, ExpiryCell, MiniStats, PersonCell } from '../components/cells';
import { daysUntil, fmtDate, fmtDateTime, money, moneyCompact, moneyShort, num } from '../lib/format';


const NATIONALITIES = ['UAE', 'Saudi Arabia', 'Egypt', 'India', 'Pakistan', 'Philippines', 'Lebanon', 'Jordan', 'Syria', 'UK', 'Germany', 'Russia', 'Nigeria', 'Other'];
const TIERS = ['Standard', 'Silver', 'Gold', 'Platinum'];

/* -------------------------------------------------------------- customers */
export const customers = {
  resource: 'customers',
  title: 'Customers',
  subtitle: 'Drivers and corporate accounts, with their verification status.',
  singular: 'customer',
  plural: 'customers',
  searchPlaceholder: 'Search name, phone, email, Emirates ID or licence…',
  defaultSort: { key: 'join_date', dir: 'desc' },
  tabs: { field: 'verification_status', all: 'All customers', options: [{ value: 'verified', label: 'Verified' }, { value: 'pending', label: 'Pending' }, { value: 'rejected', label: 'Rejected' }] },
  filters: [
    { key: 'tier', label: 'Tier', options: TIERS },
    { key: 'segment', label: 'Segment', options: ['Individual', 'Corporate'] },
  ],
  stats: [
    { label: 'Waiting for verification', icon: BadgeCheck, tone: 'warn', value: (d) => d.kpis.pendingKyc, foot: () => 'licence and Emirates ID checks' },
    { label: 'New this month', icon: Users, value: (d) => d.kpis.newCustomers, foot: () => 'joined since the 1st' },
  ],
  columns: [
    { key: 'name', label: 'Customer', sortable: true, render: (r) => <PersonCell name={r.name} sub={r.email} />, export: (r) => r.name },
    { key: 'phone', label: 'Phone', render: (r) => <span className="nowrap">{r.phone}</span> },
    { key: 'tier', label: 'Tier', sortable: true, render: (r) => <div className="col" style={{ gap: 5, alignItems: 'flex-start' }}><StatusPill kind="tier" value={r.tier} /><span className="cell-sub">{r.segment}</span></div>, export: (r) => `${r.tier} (${r.segment})` },
    { key: 'verification_status', label: 'Verification', sortable: true, render: (r) => <StatusPill kind="kyc" value={r.verification_status} />, export: (r) => r.verification_status },
    { key: 'trips_count', label: 'Trips', align: 'right', sortable: true, render: (r) => num(r.trips_count) },
    { key: 'lifetime_value', label: 'Lifetime value', align: 'right', sortable: true, render: (r) => moneyShort(r.lifetime_value), export: (r) => r.lifetime_value },
    { key: 'wallet_balance', label: 'Wallet', align: 'right', sortable: true, render: (r) => money(r.wallet_balance), export: (r) => r.wallet_balance },
    { key: 'join_date', label: 'Joined', sortable: true, render: (r) => fmtDate(r.join_date), export: (r) => r.join_date },
  ],
  avatar: (r) => <Avatar name={r.name} size={52} />,
  recordTitle: (r) => r.name,
  recordSubtitle: (r) => [r.email, r.phone].filter(Boolean).join(' · '),
  badges: (r) => (
    <>
      <StatusPill kind="kyc" value={r.verification_status} />
      <StatusPill kind="tier" value={r.tier} />
      <StatusPill kind="segment" value={r.segment} />
      {r.status === 'blocked' ? <StatusPill kind="account" value="blocked" /> : null}
    </>
  ),
  highlights: (r) => (
    <MiniStats items={[
      { label: 'Lifetime value', value: moneyShort(r.lifetime_value) },
      { label: 'Trips', value: num(r.trips_count) },
      { label: 'Wallet', value: money(r.wallet_balance) },
    ]} />
  ),
  actions: () => [
    { key: 'verify', label: 'Verify documents', short: 'Verify', icon: BadgeCheck, tone: 'soft', when: (r) => r.verification_status !== 'verified', patch: () => ({ verification_status: 'verified' }), success: 'Customer verified' },
    { key: 'reject', label: 'Reject', short: 'Reject', icon: XCircle, tone: 'danger', when: (r) => r.verification_status === 'pending', patch: () => ({ verification_status: 'rejected' }), confirm: 'The customer will not be able to book until they upload valid documents again.', success: 'Verification rejected' },
  ],
  related: [
    { title: 'Bookings', resource: 'bookings', by: 'customer_id', page: '/bookings', empty: 'No bookings yet.',
      row: (b) => ({ title: `${b.ref} · ${b.vehicle_name}`, sub: `${fmtDate(b.start_at)} · ${b.product_line}`, right: <StatusPill kind="booking" value={b.status} /> }) },
    { title: 'Invoices', resource: 'invoices', by: 'customer_id', page: '/invoices', empty: 'No invoices yet.',
      row: (i) => ({ title: i.number, sub: `Issued ${fmtDate(i.issue_date)}`, right: <span className="row" style={{ gap: 8 }}><b>{money(i.total)}</b><StatusPill kind="invoice" value={i.status} /></span> }) },
    { title: 'Fines & Salik', resource: 'fines', by: 'customer_id', page: '/fines', empty: 'No fines.',
      row: (f) => ({ title: f.reference || f.type, sub: `${fmtDate(f.issued_at)} · ${f.location || ''}`, right: <StatusPill kind="fine" value={f.status} /> }) },
  ],
  form: {
    defaults: () => ({ tier: 'Standard', segment: 'Individual', verification_status: 'pending', status: 'active', nationality: 'UAE', wallet_balance: 0, trips_count: 0, lifetime_value: 0, join_date: new Date().toISOString().slice(0, 10) }),
    fields: [
      { type: 'section', label: 'Contact' },
      { key: 'name', label: 'Full name or company', type: 'text', required: true, span: 2 },
      { key: 'phone', label: 'Mobile', type: 'tel', placeholder: '+971 50 123 4567' },
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'nationality', label: 'Nationality', type: 'select', options: NATIONALITIES },
      { key: 'segment', label: 'Segment', type: 'select', options: ['Individual', 'Corporate'], required: true },
      { type: 'section', label: 'Documents' },
      { key: 'emirates_id', label: 'Emirates ID', type: 'text', placeholder: '784-1990-1234567-1' },
      { key: 'license_no', label: 'Driving licence no.', type: 'text' },
      { key: 'license_expiry', label: 'Licence expiry', type: 'date', view: (r) => <ExpiryCell date={r.license_expiry} /> },
      { key: 'verification_status', label: 'Verification', type: 'select', options: [{ value: 'verified', label: 'Verified' }, { value: 'pending', label: 'Pending' }, { value: 'rejected', label: 'Rejected' }], required: true },
      { type: 'section', label: 'Account' },
      { key: 'tier', label: 'Tier', type: 'select', options: TIERS, required: true },
      { key: 'status', label: 'Account status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'blocked', label: 'Blocked' }], required: true },
      { key: 'wallet_balance', label: 'Wallet balance', type: 'number', suffix: 'AED', step: 0.01, format: 'money' },
      { key: 'join_date', label: 'Joined', type: 'date' },
      { key: 'notes', label: 'Notes', type: 'textarea', span: 2 },
    ],
  },
};

/* ------------------------------------------------------------------ team */
export const team = {
  resource: 'team',
  title: 'Team and roles',
  subtitle: 'Staff accounts and the role that decides what each person can see and change.',
  HeaderExtra: RolesGuide,
  singular: 'team member',
  plural: 'team members',
  searchPlaceholder: 'Search name, email or job title…',
  defaultSort: { key: 'name', dir: 'asc' },
  filters: [
    { key: 'role', label: 'Role', options: ROLE_OPTIONS },
    { key: 'department', label: 'Support team', options: ['Customer Happiness', 'Accounts', 'Branch', 'Operations', 'Management'] },
    { key: 'branch_id', label: 'Branch', relation: 'branches' },
  ],
  columns: [
    { key: 'name', label: 'Member', sortable: true, render: (r) => <PersonCell name={r.name} sub={r.email} />, export: (r) => r.name },
    { key: 'role', label: 'Role', sortable: true, render: (r) => <StatusPill kind="role" value={r.role} />, export: (r) => r.role },
    { key: 'job_title', label: 'Job title' },
    { key: 'department', label: 'Support team' },
    { key: 'branch_name', label: 'Branch' },
    { key: 'phone', label: 'Phone', render: (r) => <span className="nowrap">{r.phone}</span> },
    { key: 'status', label: 'Status', render: (r) => <StatusPill kind="account" value={r.status} /> },
  ],
  avatar: (r) => <Avatar name={r.name} size={52} />,
  recordTitle: (r) => r.name,
  recordSubtitle: (r) => r.job_title,
  badges: (r) => (<><StatusPill kind="role" value={r.role} /><StatusPill kind="account" value={r.status} /></>),
  actions: () => [
    { key: 'disable', label: 'Disable access', short: 'Disable', icon: Ban, tone: 'soft', confirmTone: 'danger', when: (r) => r.status === 'active', patch: () => ({ status: 'disabled' }), confirm: 'They will no longer be able to sign in.', success: 'Access disabled' },
    { key: 'enable', label: 'Enable access', short: 'Enable', icon: Check, tone: 'soft', when: (r) => r.status !== 'active', patch: () => ({ status: 'active' }), success: 'Access restored' },
  ],
  form: {
    defaults: () => ({ role: 'customer_service', status: 'active' }),
    fields: [
      { key: 'name', label: 'Full name', type: 'text', required: true },
      { key: 'email', label: 'Work email', type: 'email', required: true },
      { key: 'role', label: 'Role', type: 'select', required: true, options: ROLE_OPTIONS, span: 2, hint: 'IT runs the system and the accounts. Admin sees everything but does not manage accounts. See "Who can do what?" at the top of this page.' },
      { key: 'status', label: 'Status', type: 'select', required: true, options: [{ value: 'active', label: 'Active' }, { value: 'disabled', label: 'Disabled' }] },
      { key: 'job_title', label: 'Job title', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'tel' },
      { key: 'department', label: 'Support team', type: 'select', options: ['Customer Happiness', 'Accounts', 'Branch', 'Operations', 'Management'], hint: 'Customer-service cases are routed to a team, then to its least busy person.' },
      { key: 'branch_id', label: 'Branch', type: 'relation', relation: 'branches', labelKey: 'branch_name' },
      {
        key: 'password', label: 'Password', type: 'password', required: (mode) => mode === 'create', span: 2, hideInView: true,
        hint: (mode) => (mode === 'create' ? 'At least 8 characters. They can sign in straight away.' : 'Leave blank to keep the current password.'),
      },
    ],
  },
};

/* ----------------------------------------------------------------- leads */
const STAGES = [
  { value: 'New', label: 'New', color: '#3db2e2', tone: 'info' },
  { value: 'Qualified', label: 'Qualified', color: '#2e86ce', tone: 'info' },
  { value: 'Proposal', label: 'Proposal', color: '#174371', tone: 'navy' },
  { value: 'Negotiation', label: 'Negotiation', color: '#e8a23a', tone: 'warn' },
  { value: 'Won', label: 'Won', color: '#1fa971', tone: 'ok' },
  { value: 'Lost', label: 'Lost', color: '#e5484d', tone: 'danger' },
];
const stageTone = (s) => (STAGES.find((x) => x.value === s) || {}).tone || 'neutral';
const isOpen = (r) => r.stage !== 'Won' && r.stage !== 'Lost';
const overdue = (r) => isOpen(r) && r.next_action_date && daysUntil(r.next_action_date) < 0;

export const leads = {
  resource: 'leads',
  title: 'Corporate leads',
  subtitle: 'Fleet-lease and corporate rental opportunities. Drag a card to move it along the pipeline.',
  singular: 'lead',
  plural: 'leads',
  addLabel: 'New lead',
  searchPlaceholder: 'Search company, contact or email…',
  defaultSort: { key: 'est_value', dir: 'desc' },
  layouts: ['board', 'table'],
  filters: [
    { key: 'source', label: 'Source', options: ['Website', 'Referral', 'Cold Call', 'Exhibition', 'Partner', 'LinkedIn'] },
    { key: 'owner_id', label: 'Owner', relation: 'users' },
  ],
  board: {
    field: 'stage',
    columns: STAGES,
    sum: (list) => moneyCompact(list.reduce((a, r) => a + (Number(r.est_value) || 0), 0)),
    movedMessage: (row, stage) => `${row.company} moved to ${stage}`,
    card: (r) => (
      <>
        <div className="row between" style={{ alignItems: 'flex-start', gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div className="strong ellipsis">{r.company}</div>
            <div className="muted small ellipsis">{r.contact_name || 'No contact yet'}</div>
          </div>
          {r.owner_name ? <Avatar name={r.owner_name} size={28} /> : null}
        </div>
        <div className="row between" style={{ marginTop: 12 }}>
          <span className="row small" style={{ gap: 6 }}><Car size={14} /> {num(r.fleet_size)} vehicles</span>
          <b>{moneyCompact(r.est_value)}</b>
        </div>
        <div className="meta">
          <span className="tag">{r.source}</span>
          {r.next_action_date ? <span className="tag" style={overdue(r) ? { background: 'var(--danger-bg)', color: 'var(--danger-fg)' } : undefined}>{fmtDate(r.next_action_date)}</span> : null}
        </div>
        {r.next_action ? <div className="small muted" style={{ marginTop: 10 }}>{r.next_action}</div> : null}
      </>
    ),
  },
  columns: [
    { key: 'company', label: 'Company', sortable: true, render: (r) => <div><div className="cell-main">{r.company}</div><div className="cell-sub">{r.contact_name}</div></div>, export: (r) => r.company },
    { key: 'stage', label: 'Stage', sortable: true, render: (r) => <Pill tone={stageTone(r.stage)}>{r.stage}</Pill>, export: (r) => r.stage },
    { key: 'fleet_size', label: 'Fleet size', align: 'right', sortable: true, render: (r) => num(r.fleet_size) },
    { key: 'est_value', label: 'Est. value', align: 'right', sortable: true, render: (r) => moneyShort(r.est_value), export: (r) => r.est_value },
    { key: 'source', label: 'Source', sortable: true },
    { key: 'owner_name', label: 'Owner', render: (r) => (r.owner_name ? <PersonCell name={r.owner_name} size={28} /> : <span className="faint">—</span>), export: (r) => r.owner_name },
    { key: 'next_action', label: 'Next action', wrap: true, render: (r) => <div><div>{r.next_action}</div><div className="cell-sub" style={overdue(r) ? { color: 'var(--danger-fg)' } : undefined}>{fmtDate(r.next_action_date)}</div></div>, export: (r) => `${r.next_action || ''} ${r.next_action_date || ''}`.trim() },
  ],
  avatar: (r) => <Avatar name={r.company} size={52} square />,
  recordTitle: (r) => r.company,
  recordSubtitle: (r) => [r.contact_name, r.email].filter(Boolean).join(' · '),
  badges: (r) => (<><Pill tone={stageTone(r.stage)}>{r.stage}</Pill><Pill tone="neutral" dot={false}>{r.source}</Pill></>),
  highlights: (r) => (
    <MiniStats items={[
      { label: 'Est. value', value: moneyShort(r.est_value) },
      { label: 'Fleet size', value: `${num(r.fleet_size)} cars` },
      { label: 'Next step', value: r.next_action_date ? fmtDate(r.next_action_date) : '—' },
    ]} />
  ),
  actions: () => [
    { key: 'won', label: 'Mark as won', short: 'Won', icon: ThumbsUp, tone: 'soft', when: isOpen, patch: () => ({ stage: 'Won' }), success: 'Lead won. Well done!' },
    { key: 'lost', label: 'Mark as lost', short: 'Lost', icon: XCircle, tone: 'danger', when: isOpen, patch: () => ({ stage: 'Lost' }), confirm: 'The lead moves to Lost. You can reopen it later.', success: 'Lead marked as lost' },
    { key: 'reopen', label: 'Reopen', short: 'Reopen', icon: RotateCcw, tone: 'soft', when: (r) => !isOpen(r), patch: () => ({ stage: 'Qualified' }), success: 'Lead reopened' },
  ],
  related: [
    { title: 'Tasks', resource: 'activities', by: 'related_id', params: { related_type: 'lead' }, page: '/tasks', empty: 'No tasks linked to this lead.',
      row: (a) => ({ title: a.subject, sub: `${a.type} · due ${fmtDateTime(a.due_at)}`, right: a.done ? <Pill tone="ok">Done</Pill> : <Pill tone="warn">Open</Pill> }) },
  ],
  form: {
    defaults: () => ({ stage: 'New', source: 'Website', fleet_size: 1 }),
    fields: [
      { key: 'company', label: 'Company', type: 'text', required: true, span: 2 },
      { key: 'contact_name', label: 'Contact person', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'tel' },
      { key: 'email', label: 'Email', type: 'email', span: 2 },
      { key: 'stage', label: 'Stage', type: 'select', options: STAGES.map((s) => ({ value: s.value, label: s.label })), required: true },
      { key: 'source', label: 'Source', type: 'select', options: ['Website', 'Referral', 'Cold Call', 'Exhibition', 'Partner', 'LinkedIn'] },
      { key: 'fleet_size', label: 'Fleet size', type: 'number', suffix: 'cars', min: 1, step: 1 },
      { key: 'est_value', label: 'Estimated value', type: 'number', suffix: 'AED', min: 0, format: 'money' },
      { key: 'owner_id', label: 'Owner', type: 'relation', relation: 'users', labelKey: 'owner_name' },
      { key: 'next_action_date', label: 'Next action date', type: 'date' },
      { key: 'next_action', label: 'Next action', type: 'text', span: 2 },
      { key: 'notes', label: 'Notes', type: 'textarea', span: 2 },
    ],
  },
};

/* ----------------------------------------------------------------- tasks */
const TASK_TYPES = ['Call', 'Email', 'Meeting', 'Task', 'Site Visit'];

export const tasks = {
  resource: 'activities',
  title: 'Tasks',
  subtitle: 'Calls, meetings and follow-ups for the sales team.',
  singular: 'task',
  plural: 'tasks',
  searchPlaceholder: 'Search tasks…',
  defaultSort: { key: 'due_at', dir: 'asc' },
  tabs: { field: 'done', all: 'All tasks', default: '0', options: [{ value: '0', label: 'Open' }, { value: '1', label: 'Done' }] },
  filters: [
    { key: 'type', label: 'Type', options: TASK_TYPES },
    { key: 'user_id', label: 'Owner', relation: 'users' },
  ],
  columns: [
    {
      key: 'done', label: '', width: 52,
      render: (r, ctx) => (
        <CheckToggle on={Boolean(r.done)} label={r.done ? 'Mark as open' : 'Mark as done'} onClick={async () => {
          try { await api.put(`/activities/${r.id}`, { done: r.done ? 0 : 1 }); ctx.toast.success(r.done ? 'Task reopened' : 'Task completed'); ctx.refresh(); } catch (e) { ctx.toast.error(e.message); }
        }} />
      ),
      export: (r) => (r.done ? 'done' : 'open'),
    },
    { key: 'subject', label: 'Task', sortable: true, wrap: true, render: (r) => <div><div className={`cell-main${r.done ? ' is-done' : ''}`}>{r.subject}</div><div className="cell-sub">{r.type}{r.related_name ? ` · ${r.related_name}` : ''}</div></div>, export: (r) => r.subject },
    { key: 'due_at', label: 'Due', sortable: true, render: (r) => <span style={!r.done && r.due_at && new Date(`${r.due_at.replace(' ', 'T')}Z`) < new Date() ? { color: 'var(--danger-fg)', fontWeight: 700 } : undefined}>{fmtDateTime(r.due_at)}</span>, export: (r) => r.due_at },
    { key: 'user_name', label: 'Owner', render: (r) => (r.user_name ? <PersonCell name={r.user_name} size={28} /> : <span className="faint">—</span>), export: (r) => r.user_name },
  ],
  recordTitle: (r) => r.subject,
  recordSubtitle: (r) => `${r.type}${r.related_name ? ` · ${r.related_name}` : ''}`,
  badges: (r) => (r.done ? <Pill tone="ok">Done</Pill> : <Pill tone="warn">Open</Pill>),
  actions: () => [
    { key: 'done', label: 'Mark as done', short: 'Done', icon: Check, tone: 'soft', when: (r) => !r.done, patch: () => ({ done: 1 }), success: 'Task completed' },
    { key: 'reopen', label: 'Reopen', short: 'Reopen', icon: RotateCcw, tone: 'soft', when: (r) => Boolean(r.done), patch: () => ({ done: 0 }), success: 'Task reopened' },
  ],
  form: {
    defaults: () => ({ type: 'Call', done: 0 }),
    compute: (v, key) => (key === 'related_id' ? { related_type: v.related_id ? 'lead' : null } : null),
    fields: [
      { key: 'subject', label: 'What needs doing', type: 'text', required: true, span: 2 },
      { key: 'type', label: 'Type', type: 'select', options: TASK_TYPES, required: true },
      { key: 'due_at', label: 'Due', type: 'datetime' },
      { key: 'user_id', label: 'Owner', type: 'relation', relation: 'users', labelKey: 'user_name' },
      { key: 'related_id', label: 'Linked lead', type: 'relation', relation: 'leads', labelKey: 'related_name' },
      { key: 'related_type', label: 'Related type', type: 'text', hidden: () => true },
      { key: 'done', label: 'Status', type: 'select', required: true, options: [{ value: 0, label: 'Open' }, { value: 1, label: 'Done' }], view: (r) => (r.done ? 'Done' : 'Open') },
    ],
  },
};
