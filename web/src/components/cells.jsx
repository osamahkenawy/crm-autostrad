import { Car, CarFront, Check, Truck, Zap } from 'lucide-react';
import { Avatar } from './ui';
import { daysUntil, fmtDate } from '../lib/format';

/** A date with a warning when it is close or past (insurance, registration, licences). */
export function ExpiryCell({ date }) {
  if (!date) return <span className="faint">—</span>;
  const d = daysUntil(date);
  const tone = d === null ? null : d < 0 ? 'danger' : d <= 45 ? 'warn' : null;
  return (
    <div>
      <div className="cell-main" style={tone ? { color: `var(--${tone}-fg)` } : undefined}>{fmtDate(date)}</div>
      {tone ? <div className="cell-sub" style={{ color: `var(--${tone}-fg)` }}>{d < 0 ? `Expired ${-d}d ago` : d === 0 ? 'Expires today' : `Expires in ${d}d`}</div> : null}
    </div>
  );
}

export function CategoryIcon({ category, size = 40 }) {
  const Icon = category === 'Electric' ? Zap : category === 'Van' ? Truck : /SUV/.test(category || '') ? CarFront : Car;
  return <span className="cat-ico" style={{ width: size, height: size }}><Icon size={Math.round(size * 0.5)} strokeWidth={1.8} /></span>;
}

export function PersonCell({ name, sub, size = 36 }) {
  return (
    <div className="row" style={{ gap: 12 }}>
      <Avatar name={name} size={size} />
      <div style={{ minWidth: 0 }}>
        <div className="cell-main ellipsis">{name}</div>
        {sub ? <div className="cell-sub ellipsis">{sub}</div> : null}
      </div>
    </div>
  );
}

export function MiniStats({ items }) {
  return (
    <div className="mini-stats">
      {items.map((it) => (
        <div className="mini" key={it.label}><div className="l">{it.label}</div><div className="v">{it.value}</div></div>
      ))}
    </div>
  );
}

export function CheckToggle({ on, onClick, label }) {
  return (
    <button type="button" className={`check${on ? ' on' : ''}`} onClick={(e) => { e.stopPropagation(); onClick(); }} aria-label={label} aria-pressed={on}>
      <Check size={14} strokeWidth={3} />
    </button>
  );
}
