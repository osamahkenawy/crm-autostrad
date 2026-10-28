import './env.js';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db, migrate } from './db.js';
import { crudRouter } from './crud.js';
import { ROLE_KEYS, can, capsFor, guide, roleLabel } from './roles.js';
import { statsRouter } from './routes/stats.js';
import { helpdeskRouter } from './helpdesk/routes.js';
import { seedTestSet } from './helpdesk/lab.js';
import { getSettings } from './helpdesk/settings.js';
import { seedDefaultRouting } from './helpdesk/routing.js';
import { startScheduler } from './helpdesk/scheduler.js';
import { seedDefaultKeywords, seedDefaultTemplates } from './helpdesk/templates.js';

// Its own variable, so a generic PORT (set by hosts and dev runners for the web app) can never move the API.
const PORT = Number(process.env.API_PORT) || 4000;
const DEV_SECRET = 'autostrad-dev-secret-change-me';
const JWT_SECRET = process.env.JWT_SECRET || DEV_SECRET;
if (process.env.NODE_ENV === 'production' && (JWT_SECRET === DEV_SECRET || JWT_SECRET.length < 32)) {
  console.error('Refusing to start in production: set JWT_SECRET to a random value of at least 32 characters (it signs every sign-in).');
  process.exit(1);
}

migrate();
// first start: the keyword dictionary, the sample reply templates and the lab's sample emails
seedDefaultKeywords();
seedDefaultTemplates();
seedDefaultRouting();
if (getSettings().provider === 'demo') seedTestSet(); // sample emails are made up: a real mailbox starts without them (AI lab, Restore samples, adds them when wanted)

/* ------------------- vehicle status follows contracts & workshop -------------------
 * A vehicle goes on_trip (shown as "On rent") while a contract is open and back to available when the last
 * open contract is closed; likewise maintenance while a job is in progress. Other statuses
 * (available / reserved) are left to the team. (The table is still called trips: only the names people see changed.) */
const vehicleStatus = (id) => (db.prepare('SELECT status FROM vehicles WHERE id = ?').get(id) || {}).status;
const setVehicleStatus = (id, status) => db.prepare('UPDATE vehicles SET status = ? WHERE id = ?').run(status, id);

function syncAfterContract(vehicleId) {
  if (!vehicleId) return;
  const live = db.prepare("SELECT 1 FROM trips WHERE vehicle_id = ? AND status = 'live' LIMIT 1").get(vehicleId);
  if (live) setVehicleStatus(vehicleId, 'on_trip');
  else if (vehicleStatus(vehicleId) === 'on_trip') setVehicleStatus(vehicleId, 'available');
}

function syncAfterMaintenance(vehicleId) {
  if (!vehicleId) return;
  const inShop = db.prepare("SELECT 1 FROM maintenance WHERE vehicle_id = ? AND status = 'in_progress' LIMIT 1").get(vehicleId);
  if (inShop) setVehicleStatus(vehicleId, 'maintenance');
  else if (vehicleStatus(vehicleId) === 'maintenance') setVehicleStatus(vehicleId, 'available');
}

/** Next reference such as AST-100181 / INV-2026-0161 when the form leaves it empty. */
function nextRef(table, column, prefix, width) {
  const row = db.prepare(`SELECT MAX(CAST(SUBSTR(${column}, ${prefix.length + 1}) AS INTEGER)) AS m FROM ${table} WHERE ${column} LIKE ?`).get(`${prefix}%`);
  return `${prefix}${String((row && row.m) || 0 ? row.m + 1 : 1).padStart(width, '0')}`;
}

const app = express();
// Behind a reverse proxy the web app and the API share one origin, so production allows no cross-origin calls unless CORS_ORIGIN lists some.
const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigins.length ? corsOrigins : process.env.NODE_ENV !== 'production' }));
app.use(express.json({ limit: '2mb' }));

/* ------------------------------- auth ---------------------------------- */
/** The person as the web app sees them: no password hash, plus what their role allows. */
const publicUser = (u) => {
  const { password_hash, ...safe } = u;
  return { ...safe, role_label: roleLabel(u.role), caps: capsFor(u.role) };
};

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND status = ?').get(String(email || '').toLowerCase(), 'active');
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: publicUser(user) });
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let id;
  try { id = jwt.verify(token, JWT_SECRET).id; } catch { return res.status(401).json({ error: 'Session expired' }); }
  // the role is read from the database on every request, so a changed role or a disabled account takes effect at once
  const u = db.prepare('SELECT id, name, role, department, status FROM users WHERE id = ?').get(id);
  if (!u || u.status !== 'active') return res.status(401).json({ error: 'Session expired' });
  req.user = u;
  next();
}

/** Gate a CRM area: reading needs "view", anything that changes data needs "edit" (see roles.js). */
const guard = (area) => (req, res, next) => {
  const reading = req.method === 'GET' || req.method === 'HEAD';
  if (can(req.user.role, `${area}.${reading ? 'view' : 'edit'}`)) return next();
  res.status(403).json({ error: can(req.user.role, `${area}.view`) ? 'Your role can look at this but not change it.' : 'Your role has no access to this area.' });
};

app.get('/api/auth/me', requireAuth, (req, res) => {
  const u = db.prepare(`SELECT u.id,u.name,u.email,u.role,u.job_title,u.phone,u.branch_id,u.department,u.status,
    b.name AS branch_name FROM users u LEFT JOIN branches b ON b.id=u.branch_id WHERE u.id=?`).get(req.user.id);
  res.json(publicUser(u));
});

/** "Who can do what", for the Team page. */
app.get('/api/auth/roles', requireAuth, (_req, res) => res.json(guide()));

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'autostrad-crm' }));

/* ----------------------------- resources -------------------------------- */
const api = express.Router();
api.use(requireAuth);

api.use('/stats', statsRouter);
api.use('/helpdesk', helpdeskRouter);

api.use('/branches', guard('branches'), crudRouter({
  table: 'branches',
  columns: ['name', 'name_ar', 'emirate', 'address', 'phone', 'manager', 'opening_hours', 'status'],
  searchable: ['t.name', 't.emirate', 't.manager'],
  selectSql: `SELECT t.*,
      (SELECT COUNT(*) FROM vehicles v WHERE v.branch_id=t.id) AS fleet_count,
      (SELECT COUNT(*) FROM vehicles v WHERE v.branch_id=t.id AND v.status='available') AS available_count
    FROM branches t`,
  orderBy: 't.name ASC',
}));

api.use('/vehicles', guard('vehicles'), crudRouter({
  table: 'vehicles',
  columns: ['plate', 'make', 'model', 'year', 'category', 'transmission', 'fuel_type', 'color', 'branch_id',
    'status', 'odometer', 'fuel_level', 'daily_rate', 'monthly_rate', 'carshare_rate', 'next_service_km',
    'insurance_expiry', 'registration_expiry', 'vin'],
  searchable: ['t.plate', 't.make', 't.model', 't.vin'],
  selectSql: `SELECT t.*, b.name AS branch_name, (t.make || ' ' || t.model) AS name FROM vehicles t
    LEFT JOIN branches b ON b.id = t.branch_id`,
}));

api.use('/customers', guard('customers'), crudRouter({
  table: 'customers',
  columns: ['name', 'phone', 'email', 'nationality', 'emirates_id', 'license_no', 'license_expiry',
    'verification_status', 'tier', 'segment', 'wallet_balance', 'trips_count', 'lifetime_value', 'join_date', 'notes', 'status'],
  searchable: ['t.name', 't.phone', 't.email', 't.emirates_id', 't.license_no'],
}));

api.use('/bookings', guard('bookings'), crudRouter({
  table: 'bookings',
  columns: ['ref', 'customer_id', 'vehicle_id', 'product_line', 'pickup_branch_id', 'dropoff_branch_id',
    'start_at', 'end_at', 'status', 'base_amount', 'extras_amount', 'vat_amount', 'total_amount',
    'payment_status', 'payment_method', 'source', 'notes'],
  searchable: ['t.ref', 'c.name', 'v.plate'],
  selectSql: `SELECT t.*, c.name AS customer_name, c.phone AS customer_phone,
      v.plate, (v.make || ' ' || v.model) AS vehicle_name, v.category,
      pb.name AS pickup_branch, db2.name AS dropoff_branch
    FROM bookings t
    LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN vehicles v ON v.id = t.vehicle_id
    LEFT JOIN branches pb ON pb.id = t.pickup_branch_id
    LEFT JOIN branches db2 ON db2.id = t.dropoff_branch_id`,
  orderBy: 't.start_at DESC',
  beforeWrite: (body, op) => {
    if (op === 'create' && !body.ref) body.ref = nextRef('bookings', 'ref', 'AST-', 6);
    return body;
  },
}));

api.use('/contracts', guard('contracts'), crudRouter({
  table: 'trips',
  columns: ['booking_id', 'customer_id', 'vehicle_id', 'started_at', 'ended_at', 'distance_km',
    'duration_min', 'start_fuel', 'end_fuel', 'fare', 'rating', 'status'],
  searchable: ['c.name', 'v.plate'],
  selectSql: `SELECT t.*, c.name AS customer_name, v.plate, (v.make || ' ' || v.model) AS vehicle_name,
      v.fuel_level, b.ref AS booking_ref
    FROM trips t
    LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN vehicles v ON v.id = t.vehicle_id
    LEFT JOIN bookings b ON b.id = t.booking_id`,
  orderBy: 't.started_at DESC',
  afterWrite: (row, _op, prev) => {
    syncAfterContract(row.vehicle_id);
    if (prev && prev.vehicle_id !== row.vehicle_id) syncAfterContract(prev.vehicle_id);
  },
  afterDelete: (prev) => syncAfterContract(prev.vehicle_id),
}));

api.use('/invoices', guard('invoices'), crudRouter({
  table: 'invoices',
  columns: ['number', 'customer_id', 'booking_id', 'issue_date', 'due_date', 'subtotal', 'vat', 'total', 'status', 'method', 'paid_at'],
  searchable: ['t.number', 'c.name'],
  selectSql: `SELECT t.*, c.name AS customer_name, b.ref AS booking_ref FROM invoices t
    LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN bookings b ON b.id = t.booking_id`,
  orderBy: 't.issue_date DESC',
  beforeWrite: (body, op) => {
    if (op === 'create' && !body.number) body.number = nextRef('invoices', 'number', `INV-${new Date().getUTCFullYear()}-`, 4);
    return body;
  },
}));

api.use('/leads', guard('leads'), crudRouter({
  table: 'leads',
  columns: ['company', 'contact_name', 'email', 'phone', 'source', 'stage', 'fleet_size', 'est_value',
    'owner_id', 'next_action', 'next_action_date', 'notes'],
  searchable: ['t.company', 't.contact_name', 't.email'],
  selectSql: `SELECT t.*, u.name AS owner_name FROM leads t LEFT JOIN users u ON u.id = t.owner_id`,
}));

api.use('/maintenance', guard('maintenance'), crudRouter({
  table: 'maintenance',
  columns: ['vehicle_id', 'type', 'description', 'scheduled_date', 'completed_date', 'odometer', 'cost', 'vendor', 'status'],
  searchable: ['v.plate', 't.description', 't.vendor'],
  selectSql: `SELECT t.*, v.plate, (v.make || ' ' || v.model) AS vehicle_name FROM maintenance t
    LEFT JOIN vehicles v ON v.id = t.vehicle_id`,
  orderBy: 't.scheduled_date DESC',
  afterWrite: (row, _op, prev) => {
    syncAfterMaintenance(row.vehicle_id);
    if (prev && prev.vehicle_id !== row.vehicle_id) syncAfterMaintenance(prev.vehicle_id);
  },
  afterDelete: (prev) => syncAfterMaintenance(prev.vehicle_id),
}));

api.use('/fines', guard('fines'), crudRouter({
  table: 'fines',
  columns: ['type', 'reference', 'vehicle_id', 'customer_id', 'booking_id', 'issued_at', 'location',
    'amount', 'admin_fee', 'status', 'authority'],
  searchable: ['t.reference', 'v.plate', 'c.name', 't.location'],
  selectSql: `SELECT t.*, v.plate, c.name AS customer_name, b.ref AS booking_ref FROM fines t
    LEFT JOIN vehicles v ON v.id = t.vehicle_id
    LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN bookings b ON b.id = t.booking_id`,
  orderBy: 't.issued_at DESC',
}));

/** The system always needs somebody who can run it: the last active IT account cannot be demoted, disabled or deleted. */
function keepOneIt(id, patch) {
  const cur = db.prepare('SELECT role, status FROM users WHERE id = ?').get(id);
  if (!cur || cur.role !== 'it' || cur.status !== 'active') return;
  const role = 'role' in patch ? patch.role : cur.role;
  const status = 'status' in patch ? patch.status : cur.status;
  if (role === 'it' && status === 'active') return;
  const others = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'it' AND status = 'active' AND id <> ?").get(id).n;
  if (!others) throw new Error('At least one active IT (super admin) account must remain.');
}

api.use('/team', guard('team'), crudRouter({
  table: 'users',
  columns: ['name', 'email', 'role', 'job_title', 'phone', 'branch_id', 'department', 'status'],
  searchable: ['t.name', 't.email', 't.job_title'],
  selectSql: `SELECT t.id,t.name,t.email,t.role,t.job_title,t.phone,t.branch_id,t.department,t.status,t.created_at,
      b.name AS branch_name FROM users t LEFT JOIN branches b ON b.id = t.branch_id`,
  orderBy: 't.name ASC',
  beforeWrite: (body, op, raw, req) => {
    if (body.email) body.email = String(body.email).toLowerCase();
    if (op === 'create' && !body.role) throw new Error('Choose a role.');
    if ('role' in body && !ROLE_KEYS.includes(body.role)) throw new Error('Choose one of the five roles.');
    if (op === 'update') keepOneIt(Number(req.params.id), body);
    if (raw.password) {
      if (String(raw.password).length < 8) throw new Error('Password must be at least 8 characters.');
      body.password_hash = bcrypt.hashSync(String(raw.password), 10);
    } else if (op === 'create') {
      throw new Error('A password is required for a new team member.');
    }
    return body;
  },
  beforeDelete: (prev, req) => {
    if (prev.id === req.user.id) throw new Error('You cannot delete your own account.');
    keepOneIt(prev.id, { status: 'deleted' });
  },
}));

api.use('/activities', guard('activities'), crudRouter({
  table: 'activities',
  columns: ['type', 'subject', 'related_type', 'related_id', 'user_id', 'due_at', 'done'],
  searchable: ['t.subject'],
  selectSql: `SELECT t.*, u.name AS user_name, l.company AS related_name FROM activities t
    LEFT JOIN users u ON u.id = t.user_id
    LEFT JOIN leads l ON t.related_type = 'lead' AND l.id = t.related_id`,
  orderBy: 't.due_at ASC',
}));

/* ---------------------------- settings ---------------------------------- */
api.get('/settings', guard('settings'), (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});
api.put('/settings', guard('settings'), (req, res) => {
  const stmt = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(req.body || {})) stmt.run(k, String(v));
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

app.use('/api', api);

app.use((err, _req, res, _next) => {
  // a client's mistake (malformed JSON, a body over the limit, an address that cannot be decoded) is a 4xx, not a server fault
  const status = Number(err.status || err.statusCode) || (err instanceof URIError ? 400 : 500);
  if (status >= 400 && status < 500) {
    const message = err.type === 'entity.parse.failed' ? 'The request body is not valid JSON.' : err.type === 'entity.too.large' ? 'That request is too large (limit 2 MB).' : err instanceof URIError ? 'That address cannot be read.' : (err.expose && err.message) || 'Bad request';
    return res.status(status).json({ error: message });
  }
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

const HOST = process.env.API_HOST || undefined; // 127.0.0.1 when a reverse proxy on the same machine is the only way in
const onListening = () => {
  console.log(`\n  Autostrad CRM API  →  http://${HOST || 'localhost'}:${PORT}`);
  startScheduler();
  console.log('');
};
if (HOST) app.listen(PORT, HOST, onListening); else app.listen(PORT, onListening);
