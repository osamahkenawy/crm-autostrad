import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarCheck, Car, Receipt, Search, Target, Users } from 'lucide-react';
import { api } from '../api';
import { StatusPill } from './ui';

const GROUPS = [
  { key: 'bookings', label: 'Bookings', icon: CalendarCheck, path: '/bookings', title: (r) => r.ref, sub: (r) => r.customer_name, pill: (r) => <StatusPill kind="booking" value={r.status} /> },
  { key: 'customers', label: 'Customers', icon: Users, path: '/customers', title: (r) => r.name, sub: (r) => r.phone, pill: (r) => <StatusPill kind="tier" value={r.tier} /> },
  { key: 'vehicles', label: 'Vehicles', icon: Car, path: '/fleet', title: (r) => r.name, sub: (r) => r.plate, pill: (r) => <StatusPill kind="vehicle" value={r.status} /> },
  { key: 'invoices', label: 'Invoices', icon: Receipt, path: '/invoices', title: (r) => r.number, sub: (r) => r.customer_name, pill: (r) => <StatusPill kind="invoice" value={r.status} /> },
  { key: 'leads', label: 'Leads', icon: Target, path: '/leads', title: (r) => r.company, sub: (r) => r.contact_name, pill: null },
];

export default function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [hi, setHi] = useState(0);
  const input = useRef(null);
  const wrap = useRef(null);
  const reqId = useRef(0);

  // ⌘K / Ctrl+K focuses the box
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.current?.focus(); setOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) { setData(null); return undefined; }
    const id = ++reqId.current;
    const t = setTimeout(() => {
      api.get('/stats/search', { q: q.trim() }).then((r) => { if (id === reqId.current) { setData(r); setHi(0); } }).catch(() => {});
    }, 220);
    return () => clearTimeout(t);
  }, [q]);

  const flat = useMemo(() => {
    if (!data) return [];
    return GROUPS.flatMap((g) => (data[g.key] || []).map((row) => ({ g, row })));
  }, [data]);

  const go = (item) => {
    setOpen(false);
    setQ('');
    setData(null);
    input.current?.blur();
    navigate(`${item.g.path}?open=${item.row.id}`);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter' && flat[hi]) { e.preventDefault(); go(flat[hi]); }
    else if (e.key === 'Escape') { setOpen(false); input.current?.blur(); }
  };

  let index = -1;
  return (
    <div className="gsearch" ref={wrap}>
      <label className="box">
        <Search size={18} />
        <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
          placeholder="Search bookings, customers, plates, invoices…" aria-label="Search the CRM" />
        <kbd>⌘K</kbd>
      </label>
      {open && q.trim().length >= 2 ? (
        <div className="pop" role="listbox">
          {!data ? <div className="empty" style={{ padding: 22 }}>Searching…</div> : null}
          {data && flat.length === 0 ? <div className="empty" style={{ padding: 22 }}>No results for “{q}”</div> : null}
          {data ? GROUPS.map((g) => {
            const list = data[g.key] || [];
            if (!list.length) return null;
            return (
              <div key={g.key}>
                <div className="group">{g.label}</div>
                {list.map((row) => {
                  index += 1;
                  const mine = index;
                  return (
                    <button type="button" key={`${g.key}-${row.id}`} className={`item${mine === hi ? ' active' : ''}`} onMouseEnter={() => setHi(mine)} onClick={() => go({ g, row })}>
                      <span className="ico"><g.icon size={17} strokeWidth={1.9} /></span>
                      <span className="grow" style={{ minWidth: 0 }}>
                        <div className="strong ellipsis">{g.title(row)}</div>
                        <div className="muted small ellipsis">{g.sub(row)}</div>
                      </span>
                      {g.pill ? g.pill(row) : null}
                    </button>
                  );
                })}
              </div>
            );
          }) : null}
        </div>
      ) : null}
    </div>
  );
}
