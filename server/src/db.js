import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { migrateHelpdesk } from './helpdesk/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.ARC_DB_PATH || path.join(__dirname, '..', 'data', 'autostrad.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
// WAL is faster but is unavailable on some network/virtual filesystems — fall back quietly.
try { db.pragma('journal_mode = WAL'); } catch { /* keep default rollback journal */ }
db.pragma('foreign_keys = ON');

export function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer_service',
    job_title TEXT,
    phone TEXT,
    branch_id INTEGER REFERENCES branches(id),
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_ar TEXT,
    emirate TEXT NOT NULL,
    address TEXT,
    phone TEXT,
    manager TEXT,
    opening_hours TEXT,
    status TEXT NOT NULL DEFAULT 'open'
  );

  CREATE TABLE IF NOT EXISTS vehicles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plate TEXT NOT NULL UNIQUE,
    make TEXT NOT NULL,
    model TEXT NOT NULL,
    year INTEGER,
    category TEXT NOT NULL DEFAULT 'Economy',
    transmission TEXT DEFAULT 'Automatic',
    fuel_type TEXT DEFAULT 'Petrol',
    color TEXT,
    branch_id INTEGER REFERENCES branches(id),
    status TEXT NOT NULL DEFAULT 'available',
    odometer INTEGER DEFAULT 0,
    fuel_level INTEGER DEFAULT 100,
    daily_rate REAL DEFAULT 0,
    monthly_rate REAL DEFAULT 0,
    carshare_rate REAL DEFAULT 0,
    next_service_km INTEGER,
    insurance_expiry TEXT,
    registration_expiry TEXT,
    vin TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    nationality TEXT,
    emirates_id TEXT,
    license_no TEXT,
    license_expiry TEXT,
    verification_status TEXT NOT NULL DEFAULT 'pending',
    tier TEXT NOT NULL DEFAULT 'Standard',
    segment TEXT NOT NULL DEFAULT 'Individual',
    wallet_balance REAL DEFAULT 0,
    trips_count INTEGER DEFAULT 0,
    lifetime_value REAL DEFAULT 0,
    join_date TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL UNIQUE,
    customer_id INTEGER REFERENCES customers(id),
    vehicle_id INTEGER REFERENCES vehicles(id),
    product_line TEXT NOT NULL DEFAULT 'Daily',
    pickup_branch_id INTEGER REFERENCES branches(id),
    dropoff_branch_id INTEGER REFERENCES branches(id),
    start_at TEXT,
    end_at TEXT,
    status TEXT NOT NULL DEFAULT 'upcoming',
    base_amount REAL DEFAULT 0,
    extras_amount REAL DEFAULT 0,
    vat_amount REAL DEFAULT 0,
    total_amount REAL DEFAULT 0,
    payment_status TEXT NOT NULL DEFAULT 'unpaid',
    payment_method TEXT,
    source TEXT DEFAULT 'App',
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER REFERENCES bookings(id),
    customer_id INTEGER REFERENCES customers(id),
    vehicle_id INTEGER REFERENCES vehicles(id),
    started_at TEXT,
    ended_at TEXT,
    distance_km REAL DEFAULT 0,
    duration_min INTEGER DEFAULT 0,
    start_fuel INTEGER,
    end_fuel INTEGER,
    fare REAL DEFAULT 0,
    rating INTEGER,
    status TEXT NOT NULL DEFAULT 'live'
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT NOT NULL UNIQUE,
    customer_id INTEGER REFERENCES customers(id),
    booking_id INTEGER REFERENCES bookings(id),
    issue_date TEXT,
    due_date TEXT,
    subtotal REAL DEFAULT 0,
    vat REAL DEFAULT 0,
    total REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    method TEXT,
    paid_at TEXT
  );

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL,
    contact_name TEXT,
    email TEXT,
    phone TEXT,
    source TEXT DEFAULT 'Website',
    stage TEXT NOT NULL DEFAULT 'New',
    fleet_size INTEGER DEFAULT 1,
    est_value REAL DEFAULT 0,
    owner_id INTEGER REFERENCES users(id),
    next_action TEXT,
    next_action_date TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS maintenance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id INTEGER REFERENCES vehicles(id),
    type TEXT NOT NULL DEFAULT 'Service',
    description TEXT,
    scheduled_date TEXT,
    completed_date TEXT,
    odometer INTEGER,
    cost REAL DEFAULT 0,
    vendor TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled'
  );

  CREATE TABLE IF NOT EXISTS fines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'Traffic Fine',
    reference TEXT,
    vehicle_id INTEGER REFERENCES vehicles(id),
    customer_id INTEGER REFERENCES customers(id),
    booking_id INTEGER REFERENCES bookings(id),
    issued_at TEXT,
    location TEXT,
    amount REAL DEFAULT 0,
    admin_fee REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'unrecovered',
    authority TEXT
  );

  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'Call',
    subject TEXT NOT NULL,
    related_type TEXT,
    related_id INTEGER,
    user_id INTEGER REFERENCES users(id),
    due_at TEXT,
    done INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  `);

  // Added after the first release: the team's department drives helpdesk routing.
  const userCols = db.prepare('PRAGMA table_info(users)').all();
  if (!userCols.some((c) => c.name === 'department')) db.exec('ALTER TABLE users ADD COLUMN department TEXT');

  // Databases from before the five roles: admin became IT (it already ran the system), manager became admin, agent became customer service.
  // Only when an old role is still there, so it never touches a database that already uses the new ones.
  if (db.prepare("SELECT 1 FROM users WHERE role IN ('manager', 'agent') LIMIT 1").get()) {
    db.exec("UPDATE users SET role = CASE role WHEN 'admin' THEN 'it' WHEN 'manager' THEN 'admin' WHEN 'agent' THEN 'customer_service' ELSE role END");
  }

  migrateHelpdesk(db);
}
