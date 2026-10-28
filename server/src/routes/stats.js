import { Router } from 'express';
import { db } from '../db.js';
import { can } from '../roles.js';

export const statsRouter = Router();

const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);

statsRouter.get('/dashboard', (req, res) => {
  if (!can(req.user.role, 'dashboard.view')) return res.status(403).json({ error: 'Your role has no access to this area.' });
  const fleet = one(`SELECT
      COUNT(*) total,
      SUM(status='available') available,
      SUM(status='on_trip') on_trip,
      SUM(status='maintenance') maintenance,
      SUM(status='reserved') reserved
    FROM vehicles`);

  const utilisation = fleet.total ? Math.round(((fleet.on_trip + fleet.reserved) / fleet.total) * 100) : 0;

  const liveTrips = one(`SELECT COUNT(*) n FROM trips WHERE status='live'`).n;

  const bookingsToday = one(
    `SELECT COUNT(*) n FROM bookings WHERE date(start_at) = date('now')`
  ).n;

  const revenueMtd = one(
    `SELECT IFNULL(SUM(total),0) v FROM invoices
      WHERE status='paid' AND strftime('%Y-%m', issue_date) = strftime('%Y-%m','now')`
  ).v;

  const revenuePrevMtd = one(
    `SELECT IFNULL(SUM(total),0) v FROM invoices
      WHERE status='paid' AND strftime('%Y-%m', issue_date) = strftime('%Y-%m','now','-1 month')`
  ).v;

  const outstanding = one(
    `SELECT IFNULL(SUM(total),0) v, COUNT(*) n FROM invoices WHERE status IN ('sent','overdue')`
  );

  const overdueReturns = one(
    `SELECT COUNT(*) n FROM bookings WHERE status='active' AND datetime(end_at) < datetime('now')`
  ).n;

  const newCustomers = one(
    `SELECT COUNT(*) n FROM customers WHERE strftime('%Y-%m', join_date) = strftime('%Y-%m','now')`
  ).n;

  const pendingKyc = one(
    `SELECT COUNT(*) n FROM customers WHERE verification_status='pending'`
  ).n;

  const finesOpen = one(
    `SELECT IFNULL(SUM(amount+admin_fee),0) v, COUNT(*) n FROM fines WHERE status='unrecovered'`
  );

  const revenueTrend = all(
    `SELECT strftime('%Y-%m', issue_date) month, IFNULL(SUM(total),0) revenue, COUNT(*) invoices
       FROM invoices WHERE status='paid' AND issue_date >= date('now','-7 months','start of month')
      GROUP BY month ORDER BY month`
  );

  const byProductLine = all(
    `SELECT product_line label, COUNT(*) bookings, IFNULL(SUM(total_amount),0) revenue
       FROM bookings GROUP BY product_line ORDER BY revenue DESC`
  );

  const byCategory = all(
    `SELECT v.category label, COUNT(b.id) bookings, IFNULL(SUM(b.total_amount),0) revenue
       FROM bookings b JOIN vehicles v ON v.id=b.vehicle_id GROUP BY v.category ORDER BY revenue DESC`
  );

  const branchPerformance = all(
    `SELECT br.name label, COUNT(b.id) bookings, IFNULL(SUM(b.total_amount),0) revenue,
            (SELECT COUNT(*) FROM vehicles v WHERE v.branch_id=br.id) fleet
       FROM branches br LEFT JOIN bookings b ON b.pickup_branch_id = br.id
      GROUP BY br.id ORDER BY revenue DESC`
  );

  const recentBookings = all(
    `SELECT b.id, b.ref, b.product_line, b.status, b.total_amount, b.start_at,
            c.name customer_name, v.plate, (v.make||' '||v.model) vehicle_name
       FROM bookings b LEFT JOIN customers c ON c.id=b.customer_id
       LEFT JOIN vehicles v ON v.id=b.vehicle_id
      ORDER BY b.created_at DESC LIMIT 8`
  );

  const liveTripList = all(
    `SELECT t.id, t.started_at, t.distance_km, t.duration_min, t.fare,
            c.name customer_name, v.plate, (v.make||' '||v.model) vehicle_name, v.fuel_level
       FROM trips t LEFT JOIN customers c ON c.id=t.customer_id
       LEFT JOIN vehicles v ON v.id=t.vehicle_id
      WHERE t.status='live' ORDER BY t.started_at DESC LIMIT 6`
  );

  const expiring = all(
    `SELECT 'Insurance' kind, plate ref, insurance_expiry expiry FROM vehicles
      WHERE insurance_expiry IS NOT NULL AND date(insurance_expiry) <= date('now','+45 days')
     UNION ALL
     SELECT 'Registration', plate, registration_expiry FROM vehicles
      WHERE registration_expiry IS NOT NULL AND date(registration_expiry) <= date('now','+45 days')
     UNION ALL
     SELECT 'Driving licence', name, license_expiry FROM customers
      WHERE license_expiry IS NOT NULL AND date(license_expiry) <= date('now','+45 days')
     ORDER BY expiry ASC LIMIT 10`
  );

  const pipeline = all(
    `SELECT stage label, COUNT(*) n, IFNULL(SUM(est_value),0) value FROM leads GROUP BY stage`
  );

  res.json({
    fleet: { ...fleet, utilisation },
    kpis: {
      liveTrips, bookingsToday, revenueMtd, revenuePrevMtd,
      outstanding: outstanding.v, outstandingCount: outstanding.n,
      overdueReturns, newCustomers, pendingKyc,
      finesOpen: finesOpen.v, finesOpenCount: finesOpen.n,
    },
    revenueTrend, byProductLine, byCategory, branchPerformance,
    recentBookings, liveTripList, expiring, pipeline,
  });
});

/** Lists for the pickers. A role only gets the lists of areas it may see; staff names are for everyone. */
statsRouter.get('/options', (req, res) => {
  const see = (area) => can(req.user.role, `${area}.view`);
  res.json({
    branches: see('branches') ? all('SELECT id, name, emirate FROM branches ORDER BY name') : [],
    vehicles: see('vehicles') ? all(`SELECT id, plate, (make||' '||model) name, category, status, branch_id, daily_rate, monthly_rate, carshare_rate, fuel_level
                     FROM vehicles ORDER BY plate`) : [],
    customers: see('customers') ? all('SELECT id, name, phone, tier FROM customers ORDER BY name') : [],
    users: all("SELECT id, name, role FROM users WHERE status='active' ORDER BY name"),
    leads: see('leads') ? all('SELECT id, company name FROM leads ORDER BY company') : [],
    bookings: see('bookings') ? all(`SELECT b.id, b.ref, b.customer_id, b.vehicle_id, b.total_amount FROM bookings b ORDER BY b.id DESC LIMIT 400`) : [],
  });
});

/** Top matches across the whole CRM for the header search box. */
statsRouter.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const empty = { vehicles: [], customers: [], bookings: [], leads: [], invoices: [] };
  if (q.length < 2) return res.json(empty);
  const like = `%${q}%`;
  const see = (area) => can(req.user.role, `${area}.view`);
  res.json({
    vehicles: !see('vehicles') ? [] : all(`SELECT id, plate, (make||' '||model) name, status FROM vehicles
                    WHERE plate LIKE ? OR make LIKE ? OR model LIKE ? OR vin LIKE ? ORDER BY plate LIMIT 5`, like, like, like, like),
    customers: !see('customers') ? [] : all(`SELECT id, name, phone, tier FROM customers
                     WHERE name LIKE ? OR phone LIKE ? OR email LIKE ? OR emirates_id LIKE ? OR license_no LIKE ? ORDER BY name LIMIT 5`,
      like, like, like, like, like),
    bookings: !see('bookings') ? [] : all(`SELECT b.id, b.ref, b.status, c.name customer_name FROM bookings b LEFT JOIN customers c ON c.id=b.customer_id
                    WHERE b.ref LIKE ? OR c.name LIKE ? ORDER BY b.start_at DESC LIMIT 5`, like, like),
    leads: !see('leads') ? [] : all(`SELECT id, company, contact_name, stage FROM leads WHERE company LIKE ? OR contact_name LIKE ? ORDER BY company LIMIT 5`, like, like),
    invoices: !see('invoices') ? [] : all(`SELECT i.id, i.number, i.status, c.name customer_name FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id
                    WHERE i.number LIKE ? OR c.name LIKE ? ORDER BY i.issue_date DESC LIMIT 5`, like, like),
  });
});
