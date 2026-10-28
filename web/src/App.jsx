import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { useAuth } from './auth';
import Layout from './components/Layout';
import { EmptyState } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import HelpdeskDashboard from './helpdesk/Dashboard';
import Cases from './helpdesk/Cases';
import Reports from './helpdesk/Reports';
import Lab from './helpdesk/Lab';
import HelpdeskSetup from './helpdesk/Setup';
import { Bookings, Branches, Contracts, Customers, Fines, Fleet, Invoices, Leads, Maintenance, Tasks, Team } from './pages/resources';

// the old address /trips (a bookmark, a link) leads to /contracts, filters included
function TripsRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/contracts${search}`} replace />;
}

function Splash() {
  return <div className="spinner-page"><img src="/brand/mark.png" alt="Loading" /></div>;
}

function RequireAuth({ children }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <Splash />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return children;
}

/** Hides a page from roles that may not use it (the menu hides the link too, and the server refuses the data anyway). */
function Gate({ cap, children }) {
  const { can } = useAuth();
  if (cap && !can(cap)) {
    return <div className="card"><EmptyState icon={Compass} title="This area is not available for your role" text="Ask IT if you need access." action={<Link to="/" className="btn btn-soft">Back to the start</Link>} /></div>;
  }
  return children;
}

/** The first screen: the CRM dashboard, or the helpdesk for roles that do not see revenue and fleet figures. */
function Landing() {
  const { can } = useAuth();
  return can('dashboard.view') ? <Dashboard /> : <Navigate to="/helpdesk" replace />;
}

const NotFound = () => (
  <div className="card"><EmptyState icon={Compass} title="We could not find that page" text="The link may be old or the page may have moved." action={<Link to="/" className="btn btn-soft">Back to the dashboard</Link>} /></div>
);

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<Landing />} />
        <Route path="bookings" element={<Gate cap="bookings.view"><Bookings /></Gate>} />
        <Route path="contracts" element={<Gate cap="contracts.view"><Contracts /></Gate>} />
        <Route path="trips" element={<TripsRedirect />} />
        <Route path="fleet" element={<Gate cap="vehicles.view"><Fleet /></Gate>} />
        <Route path="maintenance" element={<Gate cap="maintenance.view"><Maintenance /></Gate>} />
        <Route path="fines" element={<Gate cap="fines.view"><Fines /></Gate>} />
        <Route path="customers" element={<Gate cap="customers.view"><Customers /></Gate>} />
        <Route path="leads" element={<Gate cap="leads.view"><Leads /></Gate>} />
        <Route path="tasks" element={<Gate cap="activities.view"><Tasks /></Gate>} />
        <Route path="invoices" element={<Gate cap="invoices.view"><Invoices /></Gate>} />
        <Route path="helpdesk" element={<Gate cap="helpdesk.view"><HelpdeskDashboard /></Gate>} />
        <Route path="helpdesk/cases" element={<Gate cap="helpdesk.view"><Cases /></Gate>} />
        <Route path="helpdesk/reports" element={<Gate cap="helpdesk.view"><Reports /></Gate>} />
        <Route path="helpdesk/lab" element={<Gate cap="helpdesk.lab"><Lab /></Gate>} />
        <Route path="helpdesk/setup" element={<Gate cap="helpdesk.setup"><HelpdeskSetup /></Gate>} />
        <Route path="branches" element={<Gate cap="branches.view"><Branches /></Gate>} />
        <Route path="team" element={<Gate cap="team.view"><Team /></Gate>} />
        <Route path="settings" element={<Gate cap="settings.view"><Settings /></Gate>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
