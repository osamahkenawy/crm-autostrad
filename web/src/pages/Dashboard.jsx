import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, BadgeCheck, Banknote, CalendarCheck, Car, ChevronRight, Clock, FileSignature, FileWarning, Gauge, Receipt, ShieldAlert, Users,
} from 'lucide-react';
import { useAuth } from '../auth';
import { useStats } from '../components/Layout';
import { Avatar, Card, Plate, ProgressBar, StatusPill, fuelTone } from '../components/ui';
import {
  daysUntil, duration, fmtDate, fmtLongDate, hourInDubai, money, moneyCompact, moneyShort, monthLabel, num, pctChange, toDate, todayStr,
} from '../lib/format';

const FLEET = [
  { key: 'available', label: 'Available', color: '#1fa971' },
  { key: 'on_trip', label: 'On rent', color: '#2e86ce' },
  { key: 'reserved', label: 'Reserved', color: '#e8a23a' },
  { key: 'maintenance', label: 'Maintenance', color: '#e5484d' },
];
const STAGES = ['New', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'];
const STAGE_COLOR = { New: '#3db2e2', Qualified: '#2e86ce', Proposal: '#174371', Negotiation: '#e8a23a', Won: '#1fa971', Lost: '#e5484d' };

/** KPI tile: a link when the user may open the target page, a plain tile otherwise. */
function Tile({ to, cap, children }) {
  const { can } = useAuth();
  const allowed = !cap || can(cap);
  return allowed ? <Link to={to} className="tile">{children}</Link> : <div className="tile">{children}</div>;
}

function lastMonths(n) {
  const base = new Date(`${todayStr()}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - (n - 1 - i), 1)).toISOString().slice(0, 7));
}

function MoneyTooltip({ active, payload, label, suffix }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  return (
    <div className="card" style={{ padding: '10px 14px', boxShadow: 'var(--shadow-pop)' }}>
      <div className="muted small" style={{ fontWeight: 700 }}>{p.fullLabel || label}</div>
      <div className="strong" style={{ fontSize: 16, color: 'var(--navy)' }}>{money(payload[0].value)}</div>
      {suffix ? <div className="muted small">{suffix(p)}</div> : null}
    </div>
  );
}

const axisTick = { fill: '#667b96', fontSize: 12, fontWeight: 600 };

function Delta({ cur, prev }) {
  const c = pctChange(cur, prev);
  if (c === null) return <span>no data last month</span>;
  const up = c >= 0;
  return (
    <>
      <span className={`delta ${up ? 'up' : 'down'}`}>{up ? <ArrowUpRight size={14} strokeWidth={2.6} /> : <ArrowDownRight size={14} strokeWidth={2.6} />}{Math.abs(c).toFixed(0)}%</span>
      <span>vs last month</span>
    </>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const { stats } = useStats();

  const trend = useMemo(() => {
    if (!stats) return [];
    const by = Object.fromEntries(stats.revenueTrend.map((r) => [r.month, r]));
    return lastMonths(8).map((m) => ({ month: m, label: monthLabel(m), fullLabel: new Date(`${m}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }), revenue: (by[m] && by[m].revenue) || 0, invoices: (by[m] && by[m].invoices) || 0 }));
  }, [stats]);

  const hour = hourInDubai();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = (user.name || '').split(' ')[0];

  const f = stats && stats.fleet;
  const k = stats && stats.kpis;
  const maxBranch = stats ? Math.max(1, ...stats.branchPerformance.map((b) => b.revenue)) : 1;
  const maxProduct = stats ? Math.max(1, ...stats.byProductLine.map((b) => b.revenue)) : 1;
  const pipeline = stats ? STAGES.map((s) => stats.pipeline.find((p) => p.label === s) || { label: s, n: 0, value: 0 }) : [];
  const maxStage = Math.max(1, ...pipeline.map((p) => p.n));

  return (
    <>
      <section className="hero">
        <div className="row between wrap" style={{ alignItems: 'flex-end', gap: 20 }}>
          <div>
            <h1>{greeting}, {first}</h1>
            <p>{fmtLongDate()}. Here is what is happening across Autostrad today.</p>
            <div className="chips">
              {stats ? (
                <>
                  <span className="chip"><Car size={16} /> {f.on_trip} on the road</span>
                  <span className="chip"><CalendarCheck size={16} /> {k.bookingsToday} bookings today</span>
                  <span className="chip"><BadgeCheck size={16} /> {k.pendingKyc} to verify</span>
                </>
              ) : <span className="chip">Loading the latest numbers…</span>}
            </div>
          </div>
          <div className="row wrap" style={{ gap: 10 }}>
            <Link to="/bookings?new=1" className="btn btn-hero">New booking</Link>
            <Link to="/fleet?new=1" className="btn btn-hero-ghost">Add vehicle</Link>
            <Link to="/leads?new=1" className="btn btn-hero-ghost">New lead</Link>
          </div>
        </div>
      </section>

      {/* KPI tiles */}
      <div className="kpis">
        {stats ? (
          <>
            <Tile to="/invoices?status=paid" cap="invoices.view">
              <div className="top"><span className="label">Revenue this month</span><span className="ico ok"><Banknote size={19} strokeWidth={1.9} /></span></div>
              <div className="value">{moneyShort(k.revenueMtd)}</div>
              <div className="foot"><Delta cur={k.revenueMtd} prev={k.revenuePrevMtd} /></div>
            </Tile>
            <Tile to="/contracts?status=live">
              <div className="top"><span className="label">Open contracts</span><span className="ico"><FileSignature size={19} strokeWidth={1.9} /></span></div>
              <div className="value">{k.openContracts}</div>
              <div className="foot">{f.on_trip} vehicles on the road</div>
            </Tile>
            <Tile to="/bookings">
              <div className="top"><span className="label">Bookings today</span><span className="ico"><CalendarCheck size={19} strokeWidth={1.9} /></span></div>
              <div className="value">{k.bookingsToday}</div>
              <div className="foot">starting today</div>
            </Tile>
            <Tile to="/fleet">
              <div className="top"><span className="label">Fleet utilisation</span><span className="ico navy"><Gauge size={19} strokeWidth={1.9} /></span></div>
              <div className="value">{f.utilisation}%</div>
              <div className="foot" style={{ display: 'block' }}><ProgressBar value={f.utilisation} /><div style={{ marginTop: 8 }}>{f.available} of {f.total} vehicles available</div></div>
            </Tile>
            <Tile to="/invoices?status=overdue" cap="invoices.view">
              <div className="top"><span className="label">Outstanding</span><span className="ico warn"><Receipt size={19} strokeWidth={1.9} /></span></div>
              <div className="value">{moneyShort(k.outstanding)}</div>
              <div className="foot">{k.outstandingCount} invoices not yet paid</div>
            </Tile>
            <Tile to="/bookings?status=active">
              <div className="top"><span className="label">Late returns</span><span className={`ico ${k.overdueReturns ? 'danger' : 'ok'}`}><Clock size={19} strokeWidth={1.9} /></span></div>
              <div className="value">{k.overdueReturns}</div>
              <div className="foot">{k.overdueReturns ? 'active bookings past their end time' : 'everything is back on time'}</div>
            </Tile>
            <Tile to="/customers?verification_status=pending">
              <div className="top"><span className="label">Pending verification</span><span className="ico warn"><Users size={19} strokeWidth={1.9} /></span></div>
              <div className="value">{k.pendingKyc}</div>
              <div className="foot">{k.newCustomers} new customers this month</div>
            </Tile>
            <Tile to="/fines?status=unrecovered" cap="fines.view">
              <div className="top"><span className="label">Unrecovered fines</span><span className="ico danger"><ShieldAlert size={19} strokeWidth={1.9} /></span></div>
              <div className="value">{moneyShort(k.finesOpen)}</div>
              <div className="foot">{k.finesOpenCount} fines and Salik tolls</div>
            </Tile>
          </>
        ) : Array.from({ length: 8 }, (_, i) => (
          <div className="tile" key={i}><span className="skel" style={{ width: '50%', marginBottom: 18 }} /><span className="skel" style={{ width: '65%', height: 28, marginBottom: 12 }} /><span className="skel" style={{ width: '40%' }} /></div>
        ))}
      </div>

      {stats ? (
        <>
          <div className="dash-grid">
            <Card className="span8" title="Revenue" sub="Paid invoices per month, last 8 months">
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trend} margin={{ top: 14, right: 12, left: -6, bottom: 0 }}>
                    <defs>
                      <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2e86ce" stopOpacity={0.38} />
                        <stop offset="100%" stopColor="#2e86ce" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#e3ecf7" strokeDasharray="4 6" vertical={false} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} tick={axisTick} />
                    <YAxis tickLine={false} axisLine={false} width={58} tick={axisTick} tickFormatter={(v) => moneyCompact(v).replace(/AED\s?/, '')} />
                    <Tooltip content={<MoneyTooltip suffix={(p) => `${p.invoices} paid invoices`} />} cursor={{ stroke: '#2e86ce', strokeDasharray: '4 4' }} />
                    <Area type="monotone" dataKey="revenue" stroke="#2e86ce" strokeWidth={3} fill="url(#rev)" dot={{ r: 4, fill: '#fff', stroke: '#2e86ce', strokeWidth: 2 }} activeDot={{ r: 6 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="span4" title="Fleet status" sub={`${f.total} vehicles`}>
              <div className="fleet-ring" style={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={FLEET.map((s) => ({ name: s.label, value: f[s.key], color: s.color }))} dataKey="value" innerRadius={64} outerRadius={90} paddingAngle={3} cornerRadius={6} stroke="none">
                      {FLEET.map((s) => <Cell key={s.key} fill={s.color} />)}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="center"><div><b>{f.utilisation}%</b><span>utilised</span></div></div>
              </div>
              <div className="legend" style={{ marginTop: 10 }}>
                {FLEET.map((s) => (
                  <Link to={`/fleet?status=${s.key}`} className="li" key={s.key} style={{ color: 'inherit' }}>
                    <span className="sw" style={{ background: s.color }} />{s.label}<b>{f[s.key]}</b>
                  </Link>
                ))}
              </div>
            </Card>
          </div>

          <div className="dash-grid">
            <Card className="span4" title="By product" sub="Revenue per rental type">
              <div className="hbar">
                {stats.byProductLine.map((p) => (
                  <div className="hrow" key={p.label}>
                    <div className="top"><span>{p.label}</span><span>{moneyCompact(p.revenue)}</span></div>
                    <ProgressBar value={(p.revenue / maxProduct) * 100} />
                    <div className="muted small" style={{ marginTop: 5 }}>{num(p.bookings)} bookings</div>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="span4" title="By vehicle category" sub="Booked revenue">
              <div style={{ height: 250 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.byCategory} layout="vertical" margin={{ top: 4, right: 18, left: 4, bottom: 0 }}>
                    <defs>
                      <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="#174371" /><stop offset="100%" stopColor="#3db2e2" /></linearGradient>
                    </defs>
                    <CartesianGrid stroke="#e3ecf7" strokeDasharray="4 6" horizontal={false} />
                    <XAxis type="number" tickLine={false} axisLine={false} tick={axisTick} tickFormatter={(v) => moneyCompact(v).replace(/AED\s?/, '')} />
                    <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={84} tick={{ ...axisTick, fill: '#14324f' }} />
                    <Tooltip content={<MoneyTooltip suffix={(p) => `${p.bookings} bookings`} />} cursor={{ fill: 'rgba(46,134,206,0.08)' }} />
                    <Bar dataKey="revenue" fill="url(#bar)" radius={[0, 8, 8, 0]} barSize={18} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="span4" title="Branch performance" sub="Revenue by pick-up branch">
              <div className="hbar">
                {stats.branchPerformance.slice(0, 6).map((b) => (
                  <div className="hrow" key={b.label}>
                    <div className="top"><span className="ellipsis" style={{ maxWidth: '62%' }}>{b.label}</span><span>{moneyCompact(b.revenue)}</span></div>
                    <ProgressBar value={(b.revenue / maxBranch) * 100} />
                    <div className="muted small" style={{ marginTop: 5 }}>{b.bookings} bookings · {b.fleet} vehicles</div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <div className="dash-grid">
            <Card className="span5" title="On the road now" sub={`${stats.openContractList.length} open contracts`}
              action={<Link to="/contracts?status=live" className="btn btn-soft btn-xs">All contracts <ChevronRight size={14} /></Link>}>
              {stats.openContractList.length === 0 ? <div className="empty" style={{ padding: '26px 8px' }}><div className="ico"><FileSignature size={26} strokeWidth={1.7} /></div><h4>No open contracts</h4><p>Open contracts show up here while a car is with a customer.</p></div> : null}
              {stats.openContractList.map((t) => {
                const mins = (Date.now() - toDate(t.started_at).getTime()) / 60000;
                return (
                  <div className="mini-row" key={t.id}>
                    <Avatar name={t.customer_name} size={38} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="strong ellipsis">{t.vehicle_name}</div>
                      <div className="muted small ellipsis">{t.customer_name} · {t.plate}</div>
                    </div>
                    <div style={{ width: 96 }}>
                      <div className="row between small"><b>{duration(mins)}</b><span className="muted">{t.fuel_level}%</span></div>
                      <div style={{ marginTop: 5 }}><ProgressBar value={t.fuel_level} tone={fuelTone(t.fuel_level)} label="Fuel" /></div>
                    </div>
                  </div>
                );
              })}
            </Card>

            <Card className="span7" title="Latest bookings" sub="Most recently created"
              action={<Link to="/bookings" className="btn btn-soft btn-xs">All bookings <ChevronRight size={14} /></Link>}>
              {stats.recentBookings.map((b) => (
                <Link to={`/bookings?open=${b.id}`} className="mini-row" key={b.id} style={{ color: 'inherit' }}>
                  <Avatar name={b.customer_name} size={38} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="strong ellipsis">{b.customer_name}</div>
                    <div className="muted small ellipsis">{b.ref} · {b.vehicle_name} · {b.product_line}</div>
                  </div>
                  <StatusPill kind="booking" value={b.status} />
                  <b style={{ minWidth: 92, textAlign: 'right' }}>{money(b.total_amount)}</b>
                </Link>
              ))}
            </Card>
          </div>

          <div className="dash-grid">
            <Card className="span6" title="Needs attention" sub="Documents expiring in the next 45 days">
              {stats.expiring.length === 0 ? <div className="muted" style={{ padding: '18px 0' }}>Nothing is about to expire.</div> : null}
              {stats.expiring.map((e, i) => {
                const d = daysUntil(e.expiry);
                const late = d < 0;
                return (
                  <Link to={e.kind === 'Driving licence' ? '/customers' : '/fleet'} className="attn" key={`${e.kind}-${e.ref}-${i}`}>
                    <span className="ico" style={{ background: late ? 'var(--danger-bg)' : 'var(--warn-bg)', color: late ? 'var(--danger-fg)' : 'var(--warn-fg)' }}>
                      {e.kind === 'Driving licence' ? <FileWarning size={18} strokeWidth={1.9} /> : <AlertTriangle size={18} strokeWidth={1.9} />}
                    </span>
                    <div className="grow">
                      <div className="strong">{e.kind}</div>
                      <div className="muted small">{e.kind === 'Driving licence' ? e.ref : <Plate value={e.ref} />}</div>
                    </div>
                    <div className="right">
                      <div className="strong" style={{ color: late ? 'var(--danger-fg)' : 'var(--warn-fg)' }}>{late ? `Expired ${-d}d ago` : d === 0 ? 'Today' : `in ${d} days`}</div>
                      <div className="muted small">{fmtDate(e.expiry)}</div>
                    </div>
                    <ChevronRight size={16} className="chev" />
                  </Link>
                );
              })}
            </Card>

            <Card className="span6" title="Corporate lease pipeline" sub="Leads by stage"
              action={<Link to="/leads" className="btn btn-soft btn-xs">Open board <ChevronRight size={14} /></Link>}>
              <div className="hbar">
                {pipeline.map((p) => (
                  <div className="hrow" key={p.label}>
                    <div className="top"><span className="row" style={{ gap: 8 }}><span className="dot-stage" style={{ background: STAGE_COLOR[p.label] }} />{p.label}<span className="tag">{p.n}</span></span><span>{moneyCompact(p.value)}</span></div>
                    <div className="bar"><i style={{ width: `${(p.n / maxStage) * 100}%`, background: STAGE_COLOR[p.label] }} /></div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </>
      ) : (
        <div className="dash-grid">
          <div className="card span8 card-pad" style={{ gridColumn: 'span 8', height: 320 }}><span className="skel" style={{ width: '30%' }} /></div>
          <div className="card span4 card-pad" style={{ gridColumn: 'span 4', height: 320 }}><span className="skel" style={{ width: '40%' }} /></div>
        </div>
      )}
    </>
  );
}
