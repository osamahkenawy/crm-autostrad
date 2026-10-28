import { Wrench, CheckCircle2, Car, Gauge } from 'lucide-react';
import { Pill, Plate, ProgressBar, StatusPill, fuelTone } from '../components/ui';
import { CategoryIcon, ExpiryCell, MiniStats } from '../components/cells';
import { fmtDate, moneyShort, money, num } from '../lib/format';
import { CATEGORIES, EMIRATES, VEHICLE_STATUS } from './shared';

/* ------------------------------------------------------------------ fleet */
export const vehicles = {
  resource: 'vehicles',
  title: 'Fleet',
  subtitle: 'Every vehicle with its status, rates and compliance dates.',
  singular: 'vehicle',
  plural: 'vehicles',
  searchPlaceholder: 'Search plate, make, model or VIN…',
  defaultSort: { key: 'plate', dir: 'asc' },
  layouts: ['table', 'cards'],
  tabs: { field: 'status', all: 'All vehicles', options: VEHICLE_STATUS },
  filters: [
    { key: 'category', label: 'Category', options: CATEGORIES },
    { key: 'branch_id', label: 'Branch', relation: 'branches' },
  ],
  stats: [
    { label: 'Available now', icon: CheckCircle2, tone: 'ok', value: (d) => d.fleet.available, foot: (d) => `of ${d.fleet.total} vehicles` },
    { label: 'On the road', icon: Car, value: (d) => d.fleet.on_trip, foot: (d) => `${d.kpis.openContracts} open contracts` },
    { label: 'In workshop', icon: Wrench, tone: 'danger', value: (d) => d.fleet.maintenance, foot: (d) => `${d.fleet.reserved} reserved` },
    { label: 'Utilisation', icon: Gauge, tone: 'navy', value: (d) => `${d.fleet.utilisation}%`, foot: () => 'on rent or reserved' },
  ],
  columns: [
    {
      key: 'name', label: 'Vehicle', export: (r) => r.name,
      render: (r) => (
        <div className="row" style={{ gap: 12 }}>
          <CategoryIcon category={r.category} />
          <div><div className="cell-main">{r.name}</div><div className="cell-sub">{r.category} · {r.year} · {r.color}</div></div>
        </div>
      ),
    },
    { key: 'plate', label: 'Plate', sortable: true, render: (r) => <Plate value={r.plate} /> },
    { key: 'branch_name', label: 'Branch' },
    { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusPill kind="vehicle" value={r.status} />, export: (r) => r.status },
    {
      key: 'fuel_level', label: 'Fuel / charge', sortable: true, export: (r) => `${r.fuel_level}%`,
      render: (r) => (
        <div style={{ minWidth: 110 }}>
          <div className="row between small" style={{ marginBottom: 5 }}><span className="muted">{r.fuel_type === 'Electric' ? 'Charge' : 'Fuel'}</span><b>{r.fuel_level}%</b></div>
          <ProgressBar value={r.fuel_level} tone={fuelTone(r.fuel_level)} label="Fuel level" />
        </div>
      ),
    },
    { key: 'odometer', label: 'Odometer', align: 'right', sortable: true, render: (r) => `${num(r.odometer)} km`, export: (r) => r.odometer },
    { key: 'daily_rate', label: 'Daily rate', align: 'right', sortable: true, render: (r) => moneyShort(r.daily_rate), export: (r) => r.daily_rate },
    { key: 'insurance_expiry', label: 'Insurance', sortable: true, render: (r) => <ExpiryCell date={r.insurance_expiry} />, export: (r) => r.insurance_expiry },
  ],
  card: (r) => (
    <>
      <div className="row between"><CategoryIcon category={r.category} /><StatusPill kind="vehicle" value={r.status} /></div>
      <div style={{ marginTop: 14 }}>
        <div className="strong" style={{ fontSize: 17 }}>{r.name}</div>
        <div className="muted">{r.year} · {r.color} · {r.transmission}</div>
      </div>
      <div className="row between" style={{ marginTop: 12 }}><Plate value={r.plate} /><span className="muted small">{r.branch_name}</span></div>
      <div style={{ marginTop: 14 }}>
        <div className="row between small" style={{ marginBottom: 5 }}><span className="muted">{r.fuel_type === 'Electric' ? 'Charge' : 'Fuel'}</span><b>{r.fuel_level}%</b></div>
        <ProgressBar value={r.fuel_level} tone={fuelTone(r.fuel_level)} />
      </div>
      <div className="row between" style={{ marginTop: 14 }}>
        <span><b>{moneyShort(r.daily_rate)}</b><span className="muted small"> / day</span></span>
        <span className="muted small">{num(r.odometer)} km</span>
      </div>
    </>
  ),
  avatar: (r) => <CategoryIcon category={r.category} size={48} />,
  recordTitle: (r) => r.name,
  recordSubtitle: (r) => `${r.year} · ${r.color} · ${r.branch_name || 'No branch'}`,
  badges: (r) => (
    <>
      <Plate value={r.plate} />
      <StatusPill kind="vehicle" value={r.status} />
      <Pill tone="neutral" dot={false}>{r.category}</Pill>
    </>
  ),
  highlights: (r) => (
    <MiniStats items={[
      { label: r.fuel_type === 'Electric' ? 'Charge' : 'Fuel', value: `${r.fuel_level}%` },
      { label: 'Odometer', value: `${num(r.odometer)} km` },
      { label: 'Daily rate', value: moneyShort(r.daily_rate) },
    ]} />
  ),
  actions: (r) => [
    { key: 'free', label: 'Mark available', short: 'Available', icon: CheckCircle2, when: (x) => x.status !== 'available', patch: () => ({ status: 'available' }), success: 'Vehicle is available' },
    { key: 'shop', label: 'Send to workshop', short: 'Workshop', icon: Wrench, tone: 'soft', when: (x) => x.status === 'available' || x.status === 'reserved', patch: () => ({ status: 'maintenance' }), success: 'Vehicle sent to workshop' },
  ],
  related: [
    { title: 'Recent bookings', resource: 'bookings', by: 'vehicle_id', page: '/bookings', empty: 'No bookings for this vehicle yet.',
      row: (b) => ({ title: `${b.ref} · ${b.customer_name}`, sub: `${fmtDate(b.start_at)} · ${b.product_line}`, right: <StatusPill kind="booking" value={b.status} /> }) },
    { title: 'Maintenance history', resource: 'maintenance', by: 'vehicle_id', page: '/maintenance', empty: 'No maintenance recorded.',
      row: (m) => ({ title: m.type, sub: `${fmtDate(m.scheduled_date)} · ${m.vendor || 'No vendor'}`, right: <StatusPill kind="maintenance" value={m.status} /> }) },
    { title: 'Fines & Salik', resource: 'fines', by: 'vehicle_id', page: '/fines', empty: 'No fines for this vehicle.',
      row: (f) => ({ title: f.reference || f.type, sub: `${fmtDate(f.issued_at)} · ${f.location || ''}`, right: <b>{money(Number(f.amount) + Number(f.admin_fee))}</b> }) },
  ],
  form: {
    defaults: () => ({ category: 'Economy', transmission: 'Automatic', fuel_type: 'Petrol', status: 'available', year: new Date().getFullYear(), fuel_level: 100, odometer: 0 }),
    fields: [
      { type: 'section', label: 'Vehicle' },
      { key: 'plate', label: 'Plate number', type: 'text', required: true, placeholder: 'A 12345', hideInView: true },
      { key: 'make', label: 'Make', type: 'text', required: true },
      { key: 'model', label: 'Model', type: 'text', required: true },
      { key: 'year', label: 'Year', type: 'number', min: 2000, max: 2100, step: 1 },
      { key: 'color', label: 'Colour', type: 'text' },
      { key: 'category', label: 'Category', type: 'select', options: CATEGORIES, required: true },
      { key: 'transmission', label: 'Transmission', type: 'select', options: ['Automatic', 'Manual'] },
      { key: 'fuel_type', label: 'Fuel type', type: 'select', options: ['Petrol', 'Diesel', 'Hybrid', 'Electric'] },
      { key: 'vin', label: 'VIN', type: 'text' },
      { type: 'section', label: 'Status and location' },
      { key: 'branch_id', label: 'Home branch', type: 'relation', relation: 'branches', labelKey: 'branch_name' },
      { key: 'status', label: 'Status', type: 'select', options: VEHICLE_STATUS, required: true },
      { key: 'odometer', label: 'Odometer', type: 'number', suffix: 'km', min: 0, step: 1 },
      { key: 'fuel_level', label: 'Fuel / charge', type: 'number', suffix: '%', min: 0, max: 100, step: 1 },
      { key: 'next_service_km', label: 'Next service at', type: 'number', suffix: 'km', min: 0, step: 1 },
      { type: 'section', label: 'Pricing (AED)' },
      { key: 'daily_rate', label: 'Daily rate', type: 'number', suffix: 'AED', min: 0 },
      { key: 'monthly_rate', label: 'Monthly rate', type: 'number', suffix: 'AED', min: 0 },
      { key: 'carshare_rate', label: 'Car share rate', type: 'number', suffix: 'AED/min', min: 0, step: 0.01 },
      { type: 'section', label: 'Compliance' },
      { key: 'insurance_expiry', label: 'Insurance expiry', type: 'date', view: (r) => <ExpiryCell date={r.insurance_expiry} /> },
      { key: 'registration_expiry', label: 'Registration expiry', type: 'date', view: (r) => <ExpiryCell date={r.registration_expiry} /> },
    ],
  },
};

/* --------------------------------------------------------------- branches */
export const branches = {
  resource: 'branches',
  title: 'Branches',
  subtitle: 'Pick-up and drop-off locations across the emirates.',
  singular: 'branch',
  plural: 'branches',
  searchPlaceholder: 'Search branch, emirate or manager…',
  defaultSort: { key: 'name', dir: 'asc' },
  layouts: ['cards', 'table'],
  filters: [{ key: 'emirate', label: 'Emirate', options: EMIRATES }],
  columns: [
    { key: 'name', label: 'Branch', sortable: true, render: (r) => <div><div className="cell-main">{r.name}</div><div className="cell-sub" dir="rtl" style={{ textAlign: 'left' }}>{r.name_ar}</div></div>, export: (r) => r.name },
    { key: 'emirate', label: 'Emirate', sortable: true },
    { key: 'address', label: 'Address', wrap: true },
    { key: 'manager', label: 'Manager' },
    { key: 'opening_hours', label: 'Hours' },
    { key: 'fleet_count', label: 'Fleet', align: 'right', render: (r) => <span><b>{r.available_count}</b><span className="muted"> / {r.fleet_count} free</span></span>, export: (r) => r.fleet_count },
    { key: 'phone', label: 'Phone', render: (r) => <span className="nowrap">{r.phone}</span> },
    { key: 'status', label: 'Status', render: (r) => <StatusPill kind="branch" value={r.status} /> },
  ],
  card: (r) => (
    <>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="strong" style={{ fontSize: 17 }}>{r.name}</div>
          <div className="muted" dir="rtl" style={{ textAlign: 'left' }}>{r.name_ar}</div>
        </div>
        <StatusPill kind="branch" value={r.status} />
      </div>
      <div className="row" style={{ marginTop: 12, gap: 8 }}><span className="tag">{r.emirate}</span><span className="muted small">{r.opening_hours}</span></div>
      <div className="muted" style={{ marginTop: 12 }}>{r.address}</div>
      <div className="row between small" style={{ marginTop: 16, marginBottom: 6 }}><span className="muted">Vehicles free</span><b>{r.available_count} of {r.fleet_count}</b></div>
      <ProgressBar value={r.fleet_count ? (r.available_count / r.fleet_count) * 100 : 0} tone="ok" />
      <div className="row between small" style={{ marginTop: 14 }}><span className="muted">Manager</span><b>{r.manager || '—'}</b></div>
    </>
  ),
  recordTitle: (r) => r.name,
  recordSubtitle: (r) => r.name_ar,
  badges: (r) => (<><StatusPill kind="branch" value={r.status} /><Pill tone="neutral" dot={false}>{r.emirate}</Pill></>),
  highlights: (r) => (
    <MiniStats items={[
      { label: 'Fleet', value: r.fleet_count },
      { label: 'Free now', value: r.available_count },
      { label: 'Hours', value: r.opening_hours || '—' },
    ]} />
  ),
  related: [
    { title: 'Vehicles based here', resource: 'vehicles', by: 'branch_id', page: '/fleet', limit: 6, empty: 'No vehicles based here.',
      row: (v) => ({ title: v.name, sub: v.plate, right: <StatusPill kind="vehicle" value={v.status} /> }) },
  ],
  form: {
    defaults: () => ({ emirate: 'Dubai', status: 'open' }),
    fields: [
      { key: 'name', label: 'Branch name', type: 'text', required: true },
      { key: 'name_ar', label: 'Arabic name', type: 'text' },
      { key: 'emirate', label: 'Emirate', type: 'select', options: EMIRATES, required: true },
      { key: 'status', label: 'Status', type: 'select', options: [{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }], required: true },
      { key: 'address', label: 'Address', type: 'text', span: 2 },
      { key: 'manager', label: 'Manager', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'tel' },
      { key: 'opening_hours', label: 'Opening hours', type: 'text', placeholder: '08:00 – 20:00' },
    ],
  },
};
