import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, Bell, BadgeCheck, Building2, CalendarCheck, Car, ChevronRight, FileBarChart, FileWarning, FlaskConical, Headset, Inbox, LayoutDashboard, ListChecks, LogOut, Menu,
  PanelLeftClose, PanelLeftOpen, Receipt, Route, Settings, ShieldAlert, SlidersHorizontal, Target, UserCog, Users, Wrench, Clock, MessageSquareReply,
} from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Avatar, StatusPill } from './ui';
import GlobalSearch from './GlobalSearch';
import { moneyShort } from '../lib/format';

// `cap` is the ability that shows the link (the server decides who has it, see server/src/roles.js)
const NAV = [
  { label: 'Overview', items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true, cap: 'dashboard.view' }] },
  {
    label: 'Operations',
    items: [
      { to: '/bookings', label: 'Bookings', icon: CalendarCheck, cap: 'bookings.view' },
      { to: '/trips', label: 'Trips', icon: Route, badge: (s) => s.kpis.liveTrips, cap: 'trips.view' },
      { to: '/fleet', label: 'Fleet', icon: Car, cap: 'vehicles.view' },
      { to: '/maintenance', label: 'Maintenance', icon: Wrench, cap: 'maintenance.view' },
      { to: '/fines', label: 'Fines & Salik', icon: ShieldAlert, badge: (s) => s.kpis.finesOpenCount, cap: 'fines.view' },
    ],
  },
  {
    label: 'Customers',
    items: [
      { to: '/customers', label: 'Customers', icon: Users, badge: (s) => s.kpis.pendingKyc, cap: 'customers.view' },
      { to: '/leads', label: 'Corporate leads', icon: Target, cap: 'leads.view' },
      { to: '/tasks', label: 'Tasks', icon: ListChecks, cap: 'activities.view' },
    ],
  },
  {
    label: 'Customer service',
    items: [
      { to: '/helpdesk', label: 'Helpdesk', icon: Headset, end: true, cap: 'helpdesk.view' },
      { to: '/helpdesk/cases', label: 'Cases', icon: Inbox, hdBadge: (h) => h.open, cap: 'helpdesk.view' },
      { to: '/helpdesk/reports', label: 'Reports', icon: FileBarChart, cap: 'helpdesk.view' },
      { to: '/helpdesk/lab', label: 'AI lab', icon: FlaskConical, cap: 'helpdesk.lab' },
      { to: '/helpdesk/setup', label: 'Helpdesk setup', icon: SlidersHorizontal, cap: 'helpdesk.setup' },
    ],
  },
  { label: 'Finance', items: [{ to: '/invoices', label: 'Invoices', icon: Receipt, cap: 'invoices.view' }] },
  {
    label: 'Admin',
    items: [
      { to: '/branches', label: 'Branches', icon: Building2, cap: 'branches.view' },
      { to: '/team', label: 'Team and roles', icon: UserCog, cap: 'team.view' },
      { to: '/settings', label: 'Settings', icon: Settings, cap: 'settings.view' },
    ],
  },
];

/** Dashboard numbers are shared by the sidebar badges, the bell and the dashboard itself. */
const StatsContext = createContext({ stats: null, hd: null, reload: () => {} });
export const useStats = () => useContext(StatsContext);

function Notifications({ stats, hd }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const navigate = useNavigate();
  useEffect(() => {
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const k = stats && stats.kpis;
  const crm = stats ? [
    k.overdueReturns > 0 && { icon: Clock, tone: 'danger', title: `${k.overdueReturns} vehicle${k.overdueReturns > 1 ? 's' : ''} not returned on time`, sub: 'Active bookings past their end time', to: '/bookings?status=active', cap: 'bookings.view' },
    k.pendingKyc > 0 && { icon: BadgeCheck, tone: 'warn', title: `${k.pendingKyc} customer${k.pendingKyc > 1 ? 's' : ''} waiting for verification`, sub: 'Licence and Emirates ID checks', to: '/customers?verification_status=pending', cap: 'customers.view' },
    k.finesOpenCount > 0 && { icon: FileWarning, tone: 'danger', title: `${k.finesOpenCount} unrecovered fines`, sub: `${moneyShort(k.finesOpen)} still to charge`, to: '/fines?status=unrecovered', cap: 'fines.view' },
    k.outstandingCount > 0 && { icon: Receipt, tone: 'warn', title: `${k.outstandingCount} unpaid invoices`, sub: `${moneyShort(k.outstanding)} outstanding`, to: '/invoices?status=overdue', cap: 'invoices.view' },
    stats.expiring.length > 0 && { icon: AlertTriangle, tone: 'warn', title: `${stats.expiring.length} documents expiring soon`, sub: 'Insurance, registration and licences', to: '/fleet', cap: 'vehicles.view' },
  ] : [];
  const desk = hd ? [
    hd.overdue > 0 && { icon: Clock, tone: 'danger', title: `${hd.overdue} customer case${hd.overdue > 1 ? 's' : ''} overdue`, sub: 'Past the service-level time', to: '/helpdesk/cases?tab=overdue', cap: 'helpdesk.view' },
    hd.drafts_pending > 0 && { icon: MessageSquareReply, tone: 'warn', title: `${hd.drafts_pending} repl${hd.drafts_pending > 1 ? 'ies' : 'y'} waiting for approval`, sub: 'Drafted by the AI, nothing is sent until you approve', to: '/helpdesk/cases?tab=drafts', cap: 'helpdesk.view' },
    hd.needs_triage > 0 && { icon: Inbox, tone: 'warn', title: `${hd.needs_triage} case${hd.needs_triage > 1 ? 's' : ''} to check`, sub: 'The AI was not sure how to classify them', to: '/helpdesk/cases?tab=triage', cap: 'helpdesk.view' },
  ] : [];
  const items = [...crm, ...desk].filter(Boolean).filter((it) => can(it.cap));

  return (
    <div className="rel" ref={wrap}>
      <button type="button" className="icon-btn" aria-label="Notifications" onClick={() => setOpen((o) => !o)}>
        <Bell size={19} strokeWidth={1.9} />
        {items.length ? <span className="dot">{items.length}</span> : null}
      </button>
      {open ? (
        <div className="pop notif-pop">
          <div className="group">Needs your attention</div>
          {items.length === 0 ? <div className="empty" style={{ padding: 22 }}>You are all caught up.</div> : null}
          {items.map((it) => (
            <button type="button" key={it.title} className="item" onClick={() => { setOpen(false); navigate(it.to); }}>
              <span className={`ico`} style={{ background: `var(--${it.tone}-bg)`, color: `var(--${it.tone}-fg)` }}><it.icon size={17} strokeWidth={1.9} /></span>
              <span className="grow"><div className="strong">{it.title}</div><div className="muted small">{it.sub}</div></span>
              <ChevronRight size={16} className="faint" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  useEffect(() => {
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);
  return (
    <div className="rel" ref={wrap}>
      <button type="button" className="user-chip" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <Avatar name={user.name} size={34} />
        <span className="who"><b>{user.name}</b><span>{user.role_label}</span></span>
      </button>
      {open ? (
        <div className="pop menu-pop" role="menu">
          <div className="me">
            <div className="strong">{user.name}</div>
            <div className="muted small">{user.email}</div>
            <div className="row" style={{ marginTop: 8, gap: 8 }}><StatusPill kind="role" value={user.role} />{user.branch_name ? <span className="muted small">{user.branch_name}</span> : null}</div>
          </div>
          <button type="button" className="item" onClick={logout} role="menuitem"><span className="ico"><LogOut size={17} strokeWidth={1.9} /></span><span className="strong">Sign out</span></button>
        </div>
      ) : null}
    </div>
  );
}

export default function Layout() {
  const { user, can } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('autostrad.nav.collapsed') === '1'; } catch { return false; } });
  const [navOpen, setNavOpen] = useState(false);
  const [stats, setStats] = useState(null);
  const [hd, setHd] = useState(null);

  const reload = useCallback(() => {
    if (can('dashboard.view')) api.get('/stats/dashboard').then(setStats).catch(() => {});
    if (can('helpdesk.view')) api.get('/helpdesk/summary').then(setHd).catch(() => {});
  }, [can]);
  useEffect(() => { reload(); }, [reload, location.pathname]);
  useEffect(() => { const t = setInterval(reload, 60000); return () => clearInterval(t); }, [reload]);
  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  const toggleCollapsed = () => {
    setCollapsed((c) => { try { localStorage.setItem('autostrad.nav.collapsed', c ? '0' : '1'); } catch { /* ignore */ } return !c; });
  };

  return (
    <StatsContext.Provider value={{ stats, hd, reload }}>
      <div className={`app${collapsed ? ' collapsed' : ''}${navOpen ? ' nav-open' : ''}`}>
        {navOpen ? <div className="nav-scrim" onClick={() => setNavOpen(false)} /> : null}
        <aside className="sidebar">
          <Link to="/" className="sidebar-brand" aria-label="Autostrad dashboard">
            <img className="wordmark" src="/brand/logo-light.svg" alt="Autostrad Rent a Car" />
            <img className="pin" src="/brand/mark.png" alt="Autostrad" />
          </Link>
          <nav className="sidebar-scroll" aria-label="Main">
            {NAV.map((group) => {
              const items = group.items.filter((it) => !it.cap || can(it.cap));
              if (!items.length) return null;
              return (
                <div key={group.label}>
                  <div className="nav-label">{group.label}</div>
                  {items.map((it) => {
                    const n = it.hdBadge ? (hd ? it.hdBadge(hd) : 0) : (stats && it.badge ? it.badge(stats) : 0);
                    return (
                      <NavLink key={it.to} to={it.to} end={it.end} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} title={collapsed ? it.label : undefined}>
                        <it.icon size={20} strokeWidth={1.9} />
                        <span>{it.label}</span>
                        {n > 0 ? <span className="badge">{n}</span> : null}
                      </NavLink>
                    );
                  })}
                </div>
              );
            })}
          </nav>
          <div className="sidebar-foot">
            <div className="support"><strong>800 288 444</strong>24/7 customer care<br />The heart of every journey</div>
            <button type="button" className="collapse-btn" onClick={toggleCollapsed}>
              {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}<span>Collapse</span>
            </button>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <button type="button" className="icon-btn menu-btn" onClick={() => setNavOpen(true)} aria-label="Open menu"><Menu size={20} /></button>
            <GlobalSearch />
            <div className="spacer" style={{ flex: 1 }} />
            <Notifications stats={stats} hd={hd} />
            <UserMenu />
          </header>
          <main className="page">
            <Outlet />
          </main>
        </div>
      </div>
    </StatsContext.Provider>
  );
}
