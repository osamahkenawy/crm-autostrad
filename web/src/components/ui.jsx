import { Link } from 'react-router-dom';
import { ArrowRight, ArrowDown, ArrowUp, ArrowUpDown, Star } from 'lucide-react';
import { humanize, initials } from '../lib/format';

/* ------------------------------ buttons ------------------------------ */
// Primary = the Figma kit's navy→blue gradient pill with a circular arrow badge.
export function Button({ variant = 'ghost', size, icon: Icon, arrow, loading, className = '', children, ...rest }) {
  const cls = ['btn', `btn-${variant}`, size ? `btn-${size}` : '', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} {...rest} disabled={loading || rest.disabled}>
      {loading ? <span className="spin" /> : Icon ? <Icon size={size === 'xs' ? 14 : size === 'sm' ? 16 : 18} strokeWidth={1.9} /> : null}
      {children}
      {arrow && variant === 'primary' ? <span className="arrow"><ArrowRight size={size === 'sm' ? 13 : 15} strokeWidth={2.4} /></span> : null}
    </button>
  );
}

export function IconButton({ icon: Icon, label, size = 18, className = '', ...rest }) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      <Icon size={size} strokeWidth={1.9} />
      {rest.children}
    </button>
  );
}

/* ------------------------------ status ------------------------------- */
export const STATUS = {
  vehicle: { available: ['ok', 'Available'], on_trip: ['info', 'On rent'], reserved: ['warn', 'Reserved'], maintenance: ['danger', 'Maintenance'] },
  booking: { upcoming: ['warn', 'Upcoming'], active: ['info', 'Active'], completed: ['ok', 'Completed'], cancelled: ['neutral', 'Cancelled'] },
  payment: { paid: ['ok', 'Paid'], unpaid: ['warn', 'Unpaid'], refunded: ['neutral', 'Refunded'] },
  contract: { live: ['info', 'Open'], completed: ['ok', 'Closed'] },
  invoice: { paid: ['ok', 'Paid'], sent: ['info', 'Sent'], overdue: ['danger', 'Overdue'], draft: ['neutral', 'Draft'] },
  maintenance: { scheduled: ['warn', 'Scheduled'], in_progress: ['info', 'In progress'], completed: ['ok', 'Completed'] },
  fine: { recovered: ['ok', 'Recovered'], unrecovered: ['danger', 'Unrecovered'], disputed: ['warn', 'Disputed'] },
  kyc: { verified: ['ok', 'Verified'], pending: ['warn', 'Pending'], rejected: ['danger', 'Rejected'] },
  account: { active: ['ok', 'Active'], blocked: ['danger', 'Blocked'], disabled: ['neutral', 'Disabled'] },
  branch: { open: ['ok', 'Open'], closed: ['neutral', 'Closed'] },
  tier: { Standard: ['neutral', 'Standard'], Silver: ['silver', 'Silver'], Gold: ['gold', 'Gold'], Platinum: ['navy', 'Platinum'] },
  role: { it: ['navy', 'IT (super admin)'], admin: ['info', 'Admin'], operations: ['warn', 'Operations'], customer_service: ['neutral', 'Customer service'], finance: ['ok', 'Finance'] },
  segment: { Individual: ['neutral', 'Individual'], Corporate: ['info', 'Corporate'] },
  fineType: { 'Traffic Fine': ['danger', 'Traffic fine'], 'Salik Toll': ['info', 'Salik toll'] },
};

export function Pill({ tone = 'neutral', live, dot = true, children }) {
  return <span className={`pill pill-${tone}${live ? ' pill-live' : ''}${dot ? '' : ' nodot'}`}>{children}</span>;
}

export function StatusPill({ kind, value }) {
  if (value === null || value === undefined || value === '') return <span className="faint">—</span>;
  const [tone, label] = (STATUS[kind] || {})[value] || ['neutral', humanize(value)];
  return <Pill tone={tone} live={kind === 'contract' && value === 'live'}>{label}</Pill>;
}

/* ------------------------------ identity ----------------------------- */
const AVATAR_COLORS = ['#2e86ce', '#174371', '#1b6fb8', '#3db2e2', '#5b8fc7', '#2a6fa8'];
const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

export function Avatar({ name, size = 38, square, tone }) {
  const bg = tone || AVATAR_COLORS[hash(name) % AVATAR_COLORS.length];
  return (
    <span className={`avatar${square ? ' sq' : ''}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.38), background: bg }}>
      {initials(name)}
    </span>
  );
}

/** UAE-style number plate chip: "A 12345" with the emirate on top. */
export function Plate({ value, emirate }) {
  if (!value) return <span className="faint">—</span>;
  return <span className="plate">{emirate ? <small>{emirate}</small> : null}{value}</span>;
}

export function Stars({ value, size = 14 }) {
  if (!value) return <span className="faint">—</span>;
  return (
    <span className="row" style={{ gap: 2 }} title={`${value} / 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} size={size} strokeWidth={1.8} fill={i <= value ? '#f0b429' : 'none'} color={i <= value ? '#f0b429' : '#c7d3e3'} />
      ))}
    </span>
  );
}

export function ProgressBar({ value = 0, tone, label }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className={`bar ${tone || ''}`} role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <i style={{ width: `${v}%` }} />
    </div>
  );
}

export const fuelTone = (v) => (v < 20 ? 'danger' : v < 40 ? 'warn' : 'ok');

/* ------------------------------ layout bits -------------------------- */
export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {children ? <div className="actions">{children}</div> : null}
    </div>
  );
}

export function Card({ title, sub, action, children, className = '', pad = true }) {
  return (
    <section className={`card ${className}`}>
      {title || action ? (
        <div className="card-head">
          <div>
            <h3>{title}</h3>
            {sub ? <div className="sub">{sub}</div> : null}
          </div>
          {action}
        </div>
      ) : null}
      <div className={pad ? 'card-body' : ''}>{children}</div>
    </section>
  );
}

export function StatTile({ label, value, icon: Icon, tone, foot, to }) {
  const body = (
    <>
      <div className="top">
        <span className="label">{label}</span>
        {Icon ? <span className={`ico ${tone || ''}`}><Icon size={19} strokeWidth={1.9} /></span> : null}
      </div>
      <div className="value">{value}</div>
      {foot ? <div className="foot">{foot}</div> : null}
    </>
  );
  return to ? <Link to={to} className="tile">{body}</Link> : <div className="tile">{body}</div>;
}

export function Tabs({ value, onChange, items }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <button key={String(it.value)} type="button" role="tab" aria-selected={value === it.value} className={`tab${value === it.value ? ' active' : ''}`} onClick={() => onChange(it.value)}>
          {it.icon ? <it.icon size={16} strokeWidth={1.9} /> : null}
          {it.label}
          {it.count !== undefined && it.count !== null ? <span className="count">{it.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, text, action }) {
  return (
    <div className="empty">
      {Icon ? <div className="ico"><Icon size={28} strokeWidth={1.7} /></div> : null}
      <h4>{title}</h4>
      {text ? <p>{text}</p> : null}
      {action ? <div style={{ marginTop: 16 }}>{action}</div> : null}
    </div>
  );
}

export function SortIcon({ active, dir }) {
  const I = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return <span className="sort"><I size={13} strokeWidth={2.2} /></span>;
}
