import bcrypt from 'bcryptjs';
import { db, migrate } from './db.js';
import { resetHelpdesk, seedHelpdesk } from './helpdesk/seed.js';

// The seed deletes every table first. It must never run by accident on a live database.
if (process.env.NODE_ENV === 'production' && !process.argv.includes('--force')) {
  console.error('Refusing to seed: this wipes every table. Run it with --force only if you really mean it.');
  process.exit(1);
}

migrate();

console.log('Seeding Autostrad CRM…');
resetHelpdesk();
db.exec(`DELETE FROM activities; DELETE FROM fines; DELETE FROM maintenance; DELETE FROM leads;
         DELETE FROM invoices; DELETE FROM trips; DELETE FROM bookings; DELETE FROM customers;
         DELETE FROM vehicles; DELETE FROM users; DELETE FROM branches; DELETE FROM settings;
         DELETE FROM sqlite_sequence;`);

/* --------------------------- deterministic rng -------------------------- */
let s = 20251027;
const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const money = (a, b) => Math.round((a + rnd() * (b - a)) * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const day = (d) => d.toISOString().slice(0, 10);
const shift = (days, hours = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(d.getHours() + hours);
  return d;
};

/* ------------------------------- branches ------------------------------- */
const branches = [
  ['Al Quoz Head Office', 'المقر الرئيسي - القوز', 'Dubai', 'Al Quoz Industrial 3, Dubai', '+971 4 339 8800', 'Khalid Al Mansoori', '08:00 – 20:00'],
  ['Dubai Airport T3', 'مطار دبي – المبنى 3', 'Dubai', 'Arrivals Hall, Terminal 3, DXB', '+971 4 220 4411', 'Rania Haddad', '24 hours'],
  ['Deira – Al Rigga', 'ديرة – الرقة', 'Dubai', 'Al Rigga Road, Deira, Dubai', '+971 4 295 6677', 'Samir Qureshi', '08:00 – 22:00'],
  ['Business Bay', 'الخليج التجاري', 'Dubai', 'Bay Square Building 6, Business Bay', '+971 4 551 2290', 'Leena Fahed', '08:00 – 20:00'],
  ['Abu Dhabi – Musaffah', 'أبوظبي – مصفح', 'Abu Dhabi', 'M-9 Musaffah Industrial, Abu Dhabi', '+971 2 555 1200', 'Omar Al Dhaheri', '07:30 – 20:00'],
  ['Yas Island Hub', 'جزيرة ياس', 'Abu Dhabi', 'Yas Mall, Level P1, Yas Island', '+971 2 565 0099', 'Dana Kuzbari', '09:00 – 23:00'],
  ['Al Zahiyah', 'الزاهية', 'Abu Dhabi', 'Al Zahiyah, Abu Dhabi Corniche', '+971 2 644 7733', 'Yousef Barakat', '08:00 – 21:00'],
  ['Sharjah – Al Nahda', 'الشارقة – النهدة', 'Sharjah', 'Al Nahda Street, Sharjah', '+971 6 530 4455', 'Hassan Nouri', '08:00 – 21:00'],
];
const insBranch = db.prepare(`INSERT INTO branches (name,name_ar,emirate,address,phone,manager,opening_hours,status)
  VALUES (?,?,?,?,?,?,?,'open')`);
branches.forEach((b) => insBranch.run(...b));
const branchIds = db.prepare('SELECT id FROM branches').all().map((r) => r.id);

/* --------------------------------- team --------------------------------- */
const hash = bcrypt.hashSync('autostrad123', 10);
const team = [
  ['Sami Al Rashid', 'it@autostrad.ae', 'it', 'IT Administrator', '+971 50 100 2030', 1],
  ['Mujtaba', 'admin@autostrad.ae', 'admin', 'Admin and customer support', null, 1],
  ['Khalid Al Mansoori', 'khalid@autostrad.ae', 'operations', 'Fleet Director', '+971 50 222 3344', 1],
  ['Rania Haddad', 'rania@autostrad.ae', 'operations', 'Airport Branch Manager', '+971 50 333 4455', 2],
  ['Samir Qureshi', 'samir@autostrad.ae', 'operations', 'Senior Rental Agent', '+971 52 444 5566', 3],
  ['Leena Fahed', 'leena@autostrad.ae', 'customer_service', 'Corporate Account Executive', '+971 55 555 6677', 4],
  ['Omar Al Dhaheri', 'omar.d@autostrad.ae', 'operations', 'Abu Dhabi Operations', '+971 50 666 7788', 5],
  ['Dana Kuzbari', 'dana@autostrad.ae', 'customer_service', 'Car Share Specialist', '+971 56 777 8899', 6],
  ['Yousef Barakat', 'yousef@autostrad.ae', 'operations', 'Rental Agent', '+971 54 888 9900', 7],
  ['Hassan Nouri', 'hassan@autostrad.ae', 'operations', 'Rental Agent', '+971 52 999 0011', 8],
  ['Mariam Saeed', 'mariam@autostrad.ae', 'finance', 'Finance & Collections', '+971 50 123 4567', 1],
  ['Noor Al Hashimi', 'noor@autostrad.ae', 'customer_service', 'Customer Happiness Agent', '+971 50 410 2201', 1],
  ['Fatima Al Ketbi', 'fatima@autostrad.ae', 'customer_service', 'Customer Happiness Agent', '+971 55 410 2202', 1],
  ['Ahmed Mansour', 'ahmed@autostrad.ae', 'finance', 'Accounts Executive', '+971 52 410 2203', 1],
  ['Zainab Ali', 'zainab@autostrad.ae', 'finance', 'Accounts Associate', '+971 56 410 2204', 1],
];
// which helpdesk team each person works in (cases are routed to a department, then to its least busy person)
const DEPARTMENT = {
  'admin@autostrad.ae': 'Customer Happiness', 'khalid@autostrad.ae': 'Operations', 'rania@autostrad.ae': 'Branch', 'samir@autostrad.ae': 'Branch',
  'leena@autostrad.ae': 'Customer Happiness', 'omar.d@autostrad.ae': 'Branch', 'dana@autostrad.ae': 'Customer Happiness', 'yousef@autostrad.ae': 'Branch',
  'hassan@autostrad.ae': 'Branch', 'mariam@autostrad.ae': 'Accounts', 'noor@autostrad.ae': 'Customer Happiness', 'fatima@autostrad.ae': 'Customer Happiness',
  'ahmed@autostrad.ae': 'Accounts', 'zainab@autostrad.ae': 'Accounts',
  // IT (it@autostrad.ae) works in no support team, so no case is ever routed to it
};
const insUser = db.prepare(`INSERT INTO users (name,email,password_hash,role,job_title,phone,branch_id,department,status)
  VALUES (?,?,?,?,?,?,?,?,'active')`);
team.forEach((t) => insUser.run(t[0], t[1], hash, t[2], t[3], t[4], t[5], DEPARTMENT[t[1]] || null));
const userIds = db.prepare('SELECT id FROM users').all().map((r) => r.id);

/* ------------------------------- vehicles -------------------------------- */
const models = [
  ['Mitsubishi', 'Attrage', 'Economy', 'Petrol', 95, 1750, 0.65],
  ['Nissan', 'Sunny', 'Economy', 'Petrol', 99, 1800, 0.68],
  ['Toyota', 'Yaris', 'Economy', 'Petrol', 110, 1950, 0.72],
  ['Kia', 'Pegas', 'Economy', 'Petrol', 92, 1700, 0.62],
  ['Hyundai', 'Accent', 'Compact', 'Petrol', 120, 2100, 0.78],
  ['Toyota', 'Corolla', 'Compact', 'Petrol', 145, 2600, 0.88],
  ['MG', '5', 'Compact', 'Petrol', 130, 2300, 0.82],
  ['Nissan', 'Kicks', 'SUV', 'Petrol', 165, 2950, 1.05],
  ['Chevrolet', 'Captiva', 'SUV', 'Petrol', 190, 3400, 1.2],
  ['Mitsubishi', 'Pajero', 'SUV', 'Petrol', 260, 4600, 1.55],
  ['Nissan', 'Patrol', 'Luxury SUV', 'Petrol', 520, 9200, 2.9],
  ['Tesla', 'Model 3', 'Electric', 'Electric', 340, 6200, 1.95],
  ['BYD', 'Dolphin', 'Electric', 'Electric', 185, 3300, 1.15],
  ['Toyota', 'Hiace', 'Van', 'Diesel', 230, 4100, 1.4],
];
const colors = ['White', 'Silver', 'Grey', 'Black', 'Blue', 'Pearl White'];
const plateCodes = ['A', 'B', 'C', 'F', 'G', 'J', 'K', 'L', 'M', 'N'];
const emirateCode = { Dubai: 'Dubai', 'Abu Dhabi': 'AUH', Sharjah: 'SHJ' };
const vStatus = ['available', 'available', 'available', 'on_trip', 'on_trip', 'reserved', 'maintenance'];

const insVeh = db.prepare(`INSERT INTO vehicles
  (plate,make,model,year,category,transmission,fuel_type,color,branch_id,status,odometer,fuel_level,
   daily_rate,monthly_rate,carshare_rate,next_service_km,insurance_expiry,registration_expiry,vin)
  VALUES (@plate,@make,@model,@year,@category,@transmission,@fuel_type,@color,@branch_id,@status,@odometer,
   @fuel_level,@daily_rate,@monthly_rate,@carshare_rate,@next_service_km,@insurance_expiry,@registration_expiry,@vin)`);

const usedPlates = new Set();
for (let i = 0; i < 54; i++) {
  const m = pick(models);
  let plate;
  do { plate = `${pick(plateCodes)} ${int(10000, 99999)}`; } while (usedPlates.has(plate));
  usedPlates.add(plate);
  const odo = int(4000, 128000);
  insVeh.run({
    plate, make: m[0], model: m[1], year: int(2022, 2026), category: m[2],
    transmission: 'Automatic', fuel_type: m[3], color: pick(colors),
    branch_id: pick(branchIds), status: pick(vStatus),
    odometer: odo, fuel_level: int(18, 100),
    daily_rate: m[4], monthly_rate: m[5], carshare_rate: m[6],
    next_service_km: odo + int(500, 9000),
    insurance_expiry: day(shift(int(-10, 300))),
    registration_expiry: day(shift(int(-5, 330))),
    vin: `JN${int(100000, 999999)}${int(1000, 9999)}`,
  });
}
const vehicles = db.prepare('SELECT * FROM vehicles').all();

/* ------------------------------- customers ------------------------------- */
const first = ['Ahmed', 'Omar', 'Fatima', 'Sara', 'Mohammed', 'Layla', 'Yousef', 'Hind', 'Rashid', 'Noura',
  'Tariq', 'Mariam', 'Hassan', 'Aisha', 'Karim', 'Dana', 'Saeed', 'Reem', 'Bilal', 'Huda',
  'James', 'Priya', 'Anil', 'Elena', 'Marcus', 'Sofia', 'Daniel', 'Olga', 'Ravi', 'Chen'];
const last = ['Al Mansoori', 'Al Dhaheri', 'Haddad', 'Qureshi', 'Fahed', 'Barakat', 'Nouri', 'Kuzbari',
  'Al Suwaidi', 'Al Hashimi', 'Khan', 'Sharma', 'Patel', 'Ivanova', 'Williams', 'Rossi', 'Okafor', 'Nguyen'];
const nats = ['UAE', 'Egypt', 'India', 'Pakistan', 'UK', 'Philippines', 'Lebanon', 'Jordan', 'Syria', 'Russia', 'Germany', 'Nigeria'];
const tiers = ['Standard', 'Standard', 'Standard', 'Silver', 'Silver', 'Gold', 'Platinum'];
const verif = ['verified', 'verified', 'verified', 'verified', 'pending', 'rejected'];

const insCus = db.prepare(`INSERT INTO customers
  (name,phone,email,nationality,emirates_id,license_no,license_expiry,verification_status,tier,segment,
   wallet_balance,trips_count,lifetime_value,join_date,notes,status)
  VALUES (@name,@phone,@email,@nationality,@emirates_id,@license_no,@license_expiry,@verification_status,
   @tier,@segment,@wallet_balance,@trips_count,@lifetime_value,@join_date,@notes,'active')`);

const corporates = ['Emaar Properties', 'ADNOC Distribution', 'Majid Al Futtaim', 'Etisalat e&', 'Aldar Properties',
  'Talabat Middle East', 'Careem Networks', 'DP World'];

for (let i = 0; i < 68; i++) {
  const isCorp = i < 8;
  const name = isCorp ? corporates[i] : `${pick(first)} ${pick(last)}`;
  const trips = int(0, 64);
  insCus.run({
    name,
    phone: `+971 5${int(0, 6)} ${int(100, 999)} ${int(1000, 9999)}`,
    email: isCorp
      ? `fleet@${name.toLowerCase().replace(/[^a-z]/g, '')}.ae`
      : `${name.split(' ')[0].toLowerCase()}.${int(10, 99)}@gmail.com`,
    nationality: isCorp ? 'UAE' : pick(nats),
    emirates_id: `784-${int(1975, 2005)}-${int(1000000, 9999999)}-${int(1, 9)}`,
    license_no: `DXB-${int(100000, 999999)}`,
    license_expiry: day(shift(int(-20, 900))),
    verification_status: isCorp ? 'verified' : pick(verif),
    tier: isCorp ? 'Platinum' : pick(tiers),
    segment: isCorp ? 'Corporate' : 'Individual',
    wallet_balance: money(0, 950),
    trips_count: trips,
    lifetime_value: Math.round(trips * money(140, 420)),
    join_date: day(shift(-int(0, 700))),
    notes: isCorp ? 'Corporate leasing account — monthly consolidated invoicing.' : null,
  });
}
const customers = db.prepare('SELECT * FROM customers').all();

/* ------------------------- bookings / trips / invoices ------------------- */
const lines = ['Daily', 'Daily', 'Daily', 'Flexi Monthly', 'Car Share', 'Car Share', 'Corporate Lease'];
const payMethods = ['Visa ••42', 'Mastercard ••71', 'Apple Pay', 'Cash', 'Corporate Account'];

const insBook = db.prepare(`INSERT INTO bookings
  (ref,customer_id,vehicle_id,product_line,pickup_branch_id,dropoff_branch_id,start_at,end_at,status,
   base_amount,extras_amount,vat_amount,total_amount,payment_status,payment_method,source,notes,created_at)
  VALUES (@ref,@customer_id,@vehicle_id,@product_line,@pickup_branch_id,@dropoff_branch_id,@start_at,@end_at,
   @status,@base_amount,@extras_amount,@vat_amount,@total_amount,@payment_status,@payment_method,@source,@notes,@created_at)`);
const insTrip = db.prepare(`INSERT INTO trips
  (booking_id,customer_id,vehicle_id,started_at,ended_at,distance_km,duration_min,start_fuel,end_fuel,fare,rating,status)
  VALUES (@booking_id,@customer_id,@vehicle_id,@started_at,@ended_at,@distance_km,@duration_min,@start_fuel,@end_fuel,@fare,@rating,@status)`);
const insInv = db.prepare(`INSERT INTO invoices
  (number,customer_id,booking_id,issue_date,due_date,subtotal,vat,total,status,method,paid_at)
  VALUES (@number,@customer_id,@booking_id,@issue_date,@due_date,@subtotal,@vat,@total,@status,@method,@paid_at)`);

let invNo = 1;
for (let i = 0; i < 180; i++) {
  const c = pick(customers);
  const v = pick(vehicles);
  const line = c.segment === 'Corporate' ? pick(['Corporate Lease', 'Flexi Monthly']) : pick(lines);
  const startOffset = int(-200, 12);
  const start = shift(startOffset, int(-6, 10));
  const durDays = line === 'Car Share' ? 0 : line === 'Daily' ? int(1, 9) : int(28, 120);
  const end = line === 'Car Share'
    ? new Date(start.getTime() + int(25, 320) * 60000)
    : shift(startOffset + durDays, int(-6, 10));

  let status;
  if (startOffset > 1) status = 'upcoming';
  else if (end > new Date()) status = 'active';
  else status = rnd() > 0.06 ? 'completed' : 'cancelled';

  const base = line === 'Car Share'
    ? Math.round(((end - start) / 60000) * v.carshare_rate * 100) / 100
    : line === 'Daily' ? v.daily_rate * durDays
      : Math.round((v.monthly_rate * (durDays / 30)) * 100) / 100;
  const extras = rnd() > 0.6 ? money(25, 320) : 0;
  const sub = Math.round((base + extras) * 100) / 100;
  const vat = Math.round(sub * 0.05 * 100) / 100;
  const total = Math.round((sub + vat) * 100) / 100;

  const paid = status === 'completed' ? (rnd() > 0.12) : status === 'active' ? rnd() > 0.35 : false;

  const info = insBook.run({
    ref: `AST-${String(100000 + i)}`,
    customer_id: c.id, vehicle_id: v.id, product_line: line,
    pickup_branch_id: v.branch_id, dropoff_branch_id: rnd() > 0.78 ? pick(branchIds) : v.branch_id,
    start_at: iso(start), end_at: iso(end), status,
    base_amount: base, extras_amount: extras, vat_amount: vat, total_amount: total,
    payment_status: status === 'cancelled' ? 'refunded' : paid ? 'paid' : 'unpaid',
    payment_method: c.segment === 'Corporate' ? 'Corporate Account' : pick(payMethods),
    source: pick(['App', 'App', 'App', 'Website', 'Walk-in', 'Call Centre', 'Partner']),
    notes: null,
    created_at: iso(shift(startOffset - int(0, 6))),
  });
  const bookingId = Number(info.lastInsertRowid);

  if (status === 'completed' || status === 'active') {
    const live = status === 'active' && line === 'Car Share';
    const mins = Math.max(10, Math.round((Math.min(end, new Date()) - start) / 60000));
    insTrip.run({
      booking_id: bookingId, customer_id: c.id, vehicle_id: v.id,
      started_at: iso(start),
      ended_at: live ? null : iso(end),
      distance_km: Math.round(mins * money(0.35, 0.95) * 10) / 10,
      duration_min: mins,
      start_fuel: int(55, 100), end_fuel: live ? null : int(15, 70),
      fare: live ? Math.round(mins * v.carshare_rate * 100) / 100 : total,
      rating: live ? null : pick([5, 5, 5, 4, 4, 3]),
      status: live ? 'live' : 'completed',
    });
  }

  if (status !== 'cancelled' && status !== 'upcoming') {
    const issue = day(start);
    const overdue = !paid && new Date(issue) < shift(-30);
    insInv.run({
      number: `INV-2026-${String(invNo++).padStart(4, '0')}`,
      customer_id: c.id, booking_id: bookingId,
      issue_date: issue, due_date: day(shift(startOffset + 14)),
      subtotal: sub, vat, total,
      status: paid ? 'paid' : overdue ? 'overdue' : 'sent',
      method: paid ? pick(payMethods) : null,
      paid_at: paid ? day(shift(startOffset + int(0, 10))) : null,
    });
  }
}

/* --------------------------------- leads --------------------------------- */
const stages = ['New', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'];
const leadCos = ['Gulf Logistics LLC', 'Noon Delivery Services', 'Al Futtaim Engineering', 'Dubizzle Group',
  'Mubadala Facilities', 'Spinneys UAE', 'Union Coop', 'Jumeirah Hospitality', 'Serco Middle East',
  'Khalifa Industrial Zone', 'Sobha Realty', 'Arabian Automobiles', 'Emirates Post Group', 'Agility Logistics',
  'RAK Ceramics', 'Transguard Group', 'Bayut Properties', 'Deliveroo MENA', 'ENOC Retail', 'Dulsco Group'];
const insLead = db.prepare(`INSERT INTO leads
  (company,contact_name,email,phone,source,stage,fleet_size,est_value,owner_id,next_action,next_action_date,notes,created_at)
  VALUES (@company,@contact_name,@email,@phone,@source,@stage,@fleet_size,@est_value,@owner_id,@next_action,@next_action_date,@notes,@created_at)`);
const actions = ['Send revised quotation', 'Schedule fleet demo', 'Follow-up call', 'Site visit at depot',
  'Share lease agreement', 'Negotiate monthly rate', 'Credit check approval'];
leadCos.forEach((co, i) => {
  const size = int(3, 90);
  insLead.run({
    company: co,
    contact_name: `${pick(first)} ${pick(last)}`,
    email: `procurement@${co.toLowerCase().replace(/[^a-z]/g, '').slice(0, 14)}.ae`,
    phone: `+971 4 ${int(200, 899)} ${int(1000, 9999)}`,
    source: pick(['Website', 'Referral', 'Cold Call', 'Exhibition', 'Partner', 'LinkedIn']),
    stage: stages[Math.min(5, Math.floor(rnd() * 6))],
    fleet_size: size,
    est_value: size * int(1600, 3200),
    owner_id: pick(userIds),
    next_action: pick(actions),
    next_action_date: day(shift(int(-6, 34))),
    notes: `${size}-vehicle requirement, ${pick(['12', '24', '36'])}-month term.`,
    created_at: iso(shift(-int(5, 180))),
  });
});

/* ------------------------------ maintenance ------------------------------ */
const mTypes = ['Service', 'Tyre Replacement', 'Accident Repair', 'Battery', 'AC Service', 'Body Work', 'Detailing'];
const vendors = ['Al Quoz Auto Centre', 'Fast Fit Dubai', 'ADNOC Oasis Service', 'Zdegree Garage', 'In-house Workshop'];
const insMaint = db.prepare(`INSERT INTO maintenance
  (vehicle_id,type,description,scheduled_date,completed_date,odometer,cost,vendor,status)
  VALUES (@vehicle_id,@type,@description,@scheduled_date,@completed_date,@odometer,@cost,@vendor,@status)`);
for (let i = 0; i < 34; i++) {
  const v = pick(vehicles);
  const off = int(-120, 30);
  const done = off < -2 && rnd() > 0.25;
  insMaint.run({
    vehicle_id: v.id, type: pick(mTypes),
    description: `${pick(mTypes)} — ${v.make} ${v.model} (${v.plate})`,
    scheduled_date: day(shift(off)),
    completed_date: done ? day(shift(off + int(0, 3))) : null,
    odometer: v.odometer - int(0, 6000),
    cost: money(180, 3400), vendor: pick(vendors),
    status: done ? 'completed' : off < 0 ? 'in_progress' : 'scheduled',
  });
}

/* --------------------------------- fines --------------------------------- */
const locations = ['Sheikh Zayed Road', 'Al Khail Road', 'Emirates Road', 'Yas Island', 'Corniche Abu Dhabi',
  'Al Ittihad Road', 'Jumeirah Beach Road', 'Mohammed Bin Zayed Road', 'Dubai Marina', 'Airport Road'];
const insFine = db.prepare(`INSERT INTO fines
  (type,reference,vehicle_id,customer_id,booking_id,issued_at,location,amount,admin_fee,status,authority)
  VALUES (@type,@reference,@vehicle_id,@customer_id,@booking_id,@issued_at,@location,@amount,@admin_fee,@status,@authority)`);
const bookingRows = db.prepare("SELECT id, customer_id, vehicle_id, start_at FROM bookings WHERE status IN ('completed','active')").all();
for (let i = 0; i < 46; i++) {
  const b = pick(bookingRows);
  const salik = rnd() > 0.45;
  insFine.run({
    type: salik ? 'Salik Toll' : 'Traffic Fine',
    reference: salik ? `SLK-${int(100000, 999999)}` : `TF-${int(1000000, 9999999)}`,
    vehicle_id: b.vehicle_id, customer_id: b.customer_id, booking_id: b.id,
    issued_at: b.start_at,
    location: salik ? pick(['Al Barsha Gate', 'Al Garhoud Bridge', 'Al Safa Gate', 'Airport Tunnel', 'Jebel Ali Gate']) : pick(locations),
    amount: salik ? 4 : pick([300, 400, 500, 600, 800, 1000]),
    admin_fee: salik ? 0 : 50,
    status: pick(['recovered', 'recovered', 'unrecovered', 'unrecovered', 'disputed']),
    authority: salik ? 'Salik (RTA)' : pick(['Dubai Police', 'Abu Dhabi Police', 'Sharjah Police']),
  });
}

/* ------------------------------ activities ------------------------------- */
const insAct = db.prepare(`INSERT INTO activities (type,subject,related_type,related_id,user_id,due_at,done)
  VALUES (@type,@subject,@related_type,@related_id,@user_id,@due_at,@done)`);
const leadRows = db.prepare('SELECT id, company FROM leads').all();
for (let i = 0; i < 24; i++) {
  const l = pick(leadRows);
  insAct.run({
    type: pick(['Call', 'Email', 'Meeting', 'Task', 'Site Visit']),
    subject: `${pick(actions)} — ${l.company}`,
    related_type: 'lead', related_id: l.id,
    user_id: pick(userIds),
    due_at: iso(shift(int(-10, 21), int(0, 9))),
    done: rnd() > 0.6 ? 1 : 0,
  });
}

/* -------------------------------- settings ------------------------------- */
const settings = {
  company_name: 'Autostrad Rent a Car',
  company_name_ar: 'أوتوستراد لتأجير السيارات',
  tagline: 'The heart of every journey',
  trn: '100123456700003',
  vat_rate: '5',
  currency: 'AED',
  default_branch: '1',
  salik_admin_fee: '0',
  fine_admin_fee: '50',
  support_email: 'care@autostrad.ae',
  support_phone: '800 288 444',
};
const insSet = db.prepare('INSERT INTO settings (key,value) VALUES (?,?)');
Object.entries(settings).forEach(([k, v]) => insSet.run(k, v));

/* ------------------------------ live trips ------------------------------- */
// A handful of car-share drives that are on the road right now, so the dashboard and the
// Trips page have something live to show (started 8-70 minutes ago, ending soon).
{
  const free = db.prepare("SELECT * FROM vehicles WHERE status='available' ORDER BY id").all();
  const riders = customers.filter((c) => c.segment === 'Individual' && c.verification_status === 'verified');
  const nowMs = Date.now();
  for (let i = 0; i < 5 && i < free.length; i++) {
    const v = free[i * 3 % free.length];
    const c = pick(riders);
    const started = new Date(nowMs - int(8, 70) * 60000);
    const ends = new Date(nowMs + int(20, 120) * 60000);
    const mins = Math.max(8, Math.round((nowMs - started.getTime()) / 60000));
    const est = Math.round(((ends - started) / 60000) * v.carshare_rate * 100) / 100;
    const vat = Math.round(est * 0.05 * 100) / 100;
    const b = insBook.run({
      ref: `AST-${100000 + 180 + i}`, customer_id: c.id, vehicle_id: v.id, product_line: 'Car Share',
      pickup_branch_id: v.branch_id, dropoff_branch_id: v.branch_id, start_at: iso(started), end_at: iso(ends), status: 'active',
      base_amount: est, extras_amount: 0, vat_amount: vat, total_amount: Math.round((est + vat) * 100) / 100,
      payment_status: 'paid', payment_method: pick(payMethods), source: 'App', notes: null, created_at: iso(started),
    });
    insTrip.run({
      booking_id: Number(b.lastInsertRowid), customer_id: c.id, vehicle_id: v.id, started_at: iso(started), ended_at: null,
      distance_km: Math.round(mins * money(0.35, 0.95) * 10) / 10, duration_min: mins,
      start_fuel: int(55, 100), end_fuel: null, fare: Math.round(mins * v.carshare_rate * 100) / 100, rating: null, status: 'live',
    });
    db.prepare("UPDATE vehicles SET status='on_trip' WHERE id=?").run(v.id);
  }
}

/* vehicle status follows trips: on_trip only while a trip is live */
db.exec(`UPDATE vehicles SET status='on_trip' WHERE id IN (SELECT vehicle_id FROM trips WHERE status='live')`);
db.exec(`UPDATE vehicles SET status='available' WHERE status='on_trip' AND id NOT IN (SELECT vehicle_id FROM trips WHERE status='live')`);

const hd = await seedHelpdesk();
const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
console.log(`  branches ${count('branches')}  ·  team ${count('users')}  ·  vehicles ${count('vehicles')}`);
console.log(`  customers ${count('customers')}  ·  bookings ${count('bookings')}  ·  trips ${count('trips')}`);
console.log(`  invoices ${count('invoices')}  ·  leads ${count('leads')}  ·  maintenance ${count('maintenance')}  ·  fines ${count('fines')}`);
console.log(`  helpdesk cases ${hd.cases}  ·  closed ${hd.closed}  ·  not answered yet ${hd.unanswered}  ·  waiting for details ${hd.waiting_for_details}${hd.errors ? `  ·  skipped ${hd.errors}` : ''}`);
console.log('\n  Login:  admin@autostrad.ae  /  autostrad123\n');
