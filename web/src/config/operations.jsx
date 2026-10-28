import { Banknote, Ban, CheckCircle2, CircleDollarSign, Flag, Play, Receipt, Send, ShieldAlert, Square } from 'lucide-react';
import { Pill, Plate, Stars, StatusPill } from '../components/ui';
import { MiniStats } from '../components/cells';
import { daysUntil, duration, fmtDate, fmtDateTime, money, moneyShort, nowUtc, num, round2, todayStr, toDate, pctChange } from '../lib/format';
import {
  BOOKING_SOURCES, BOOKING_STATUS, PAYMENT_METHODS, PAYMENT_STATUS, PRODUCT_LINES, VAT, estimateBase, findBooking, inDays, inHours,
} from './shared';

/* --------------------------------------------------------------- bookings */
export const bookings = {
  resource: 'bookings',
  title: 'Bookings',
  subtitle: 'Daily, flexi-monthly, car share and corporate lease rentals.',
  singular: 'booking',
  plural: 'bookings',
  searchPlaceholder: 'Search reference, customer or plate…',
  defaultSort: { key: 'start_at', dir: 'desc' },
  tabs: { field: 'status', all: 'All bookings', options: BOOKING_STATUS },
  filters: [
    { key: 'product_line', label: 'Product', options: PRODUCT_LINES },
    { key: 'payment_status', label: 'Payment', options: PAYMENT_STATUS },
    { key: 'source', label: 'Source', options: BOOKING_SOURCES },
  ],
  columns: [
    { key: 'ref', label: 'Booking', sortable: true, render: (r) => <div><div className="cell-main">{r.ref}</div><div className="cell-sub">{r.product_line}</div></div>, export: (r) => r.ref },
    { key: 'customer_name', label: 'Customer', render: (r) => <div><div className="cell-main">{r.customer_name}</div><div className="cell-sub">{r.customer_phone}</div></div>, export: (r) => r.customer_name },
    { key: 'vehicle_name', label: 'Vehicle', render: (r) => <div><div className="cell-main">{r.vehicle_name}</div><Plate value={r.plate} /></div>, export: (r) => `${r.vehicle_name} ${r.plate}` },
    {
      key: 'start_at', label: 'Period', sortable: true, export: (r) => `${r.start_at} → ${r.end_at}`,
      render: (r) => <div><div>{fmtDateTime(r.start_at)}</div><div className="cell-sub">→ {fmtDateTime(r.end_at)}</div></div>,
    },
    { key: 'pickup_branch', label: 'Pick-up', render: (r) => <div><div>{r.pickup_branch}</div>{r.dropoff_branch && r.dropoff_branch !== r.pickup_branch ? <div className="cell-sub">drop: {r.dropoff_branch}</div> : null}</div>, export: (r) => r.pickup_branch },
    {
      key: 'status', label: 'Status', sortable: true, export: (r) => `${r.status} / ${r.payment_status}`,
      render: (r) => <div className="col" style={{ gap: 6, alignItems: 'flex-start' }}><StatusPill kind="booking" value={r.status} /><StatusPill kind="payment" value={r.payment_status} /></div>,
    },
    { key: 'total_amount', label: 'Total', align: 'right', sortable: true, render: (r) => <b>{money(r.total_amount)}</b>, export: (r) => r.total_amount },
  ],
  recordTitle: (r) => r.ref,
  recordSubtitle: (r) => `${r.customer_name} · ${r.vehicle_name} (${r.plate})`,
  badges: (r) => (<><StatusPill kind="booking" value={r.status} /><StatusPill kind="payment" value={r.payment_status} /><Pill tone="neutral" dot={false}>{r.product_line}</Pill></>),
  highlights: (r) => (
    <MiniStats items={[
      { label: 'Total', value: money(r.total_amount) },
      { label: 'Length', value: duration((toDate(r.end_at) - toDate(r.start_at)) / 60000) },
      { label: 'VAT 5%', value: money(r.vat_amount) },
    ]} />
  ),
  actions: () => [
    { key: 'paid', label: 'Mark as paid', short: 'Mark paid', icon: Banknote, tone: 'soft', when: (r) => r.payment_status === 'unpaid' && r.status !== 'cancelled', patch: () => ({ payment_status: 'paid' }), success: 'Booking marked as paid' },
    { key: 'cancel', label: 'Cancel booking', short: 'Cancel', icon: Ban, tone: 'danger', when: (r) => r.status === 'upcoming' || r.status === 'active', patch: (r) => ({ status: 'cancelled', payment_status: r.payment_status === 'paid' ? 'refunded' : r.payment_status }), confirm: 'The booking is cancelled and a paid amount is marked as refunded.', success: 'Booking cancelled' },
  ],
  related: [
    { title: 'Trips', resource: 'trips', by: 'booking_id', page: '/trips', empty: 'No trip started yet.',
      row: (t) => ({ title: `Started ${fmtDateTime(t.started_at)}`, sub: `${num(t.distance_km)} km · ${duration(t.duration_min)}`, right: <StatusPill kind="trip" value={t.status} /> }) },
    { title: 'Invoices', resource: 'invoices', by: 'booking_id', page: '/invoices', empty: 'Not invoiced yet.',
      row: (i) => ({ title: i.number, sub: `Due ${fmtDate(i.due_date)}`, right: <span className="row" style={{ gap: 8 }}><b>{money(i.total)}</b><StatusPill kind="invoice" value={i.status} /></span> }) },
    { title: 'Fines & Salik', resource: 'fines', by: 'booking_id', page: '/fines', empty: 'No fines during this booking.',
      row: (f) => ({ title: f.reference || f.type, sub: `${fmtDate(f.issued_at)} · ${f.location || ''}`, right: <StatusPill kind="fine" value={f.status} /> }) },
  ],
  form: {
    defaults: () => ({ product_line: 'Daily', status: 'upcoming', payment_status: 'unpaid', source: 'Call Centre', start_at: inHours(1), end_at: inHours(25), extras_amount: 0, base_amount: 0, vat_amount: 0, total_amount: 0 }),
    compute: (v, key, { options, mode }) => {
      const patch = {};
      if (mode === 'create' && key === 'vehicle_id' && v.vehicle_id && options) {
        const car = options.vehicles.find((x) => String(x.id) === String(v.vehicle_id));
        if (car && car.branch_id) {
          if (!v.pickup_branch_id) patch.pickup_branch_id = car.branch_id;
          if (!v.dropoff_branch_id) patch.dropoff_branch_id = car.branch_id;
        }
      }
      let base = v.base_amount;
      if (mode === 'create' && ['vehicle_id', 'product_line', 'start_at', 'end_at'].includes(key)) {
        const est = estimateBase(v, options);
        if (est !== null) { patch.base_amount = est; base = est; }
      }
      if (patch.base_amount !== undefined || key === 'base_amount' || key === 'extras_amount') {
        const b = Number(base) || 0;
        const x = Number(v.extras_amount) || 0;
        patch.vat_amount = round2((b + x) * VAT);
        patch.total_amount = round2(b + x + patch.vat_amount);
      }
      return patch;
    },
    fields: [
      { key: 'ref', label: 'Reference', type: 'text', readOnly: true, hidden: (mode) => mode === 'create' },
      { type: 'section', label: 'Who and what' },
      { key: 'customer_id', label: 'Customer', type: 'relation', relation: 'customers', labelKey: 'customer_name', required: true },
      {
        key: 'vehicle_id', label: 'Vehicle', type: 'relation', relation: 'vehicles', labelKey: 'vehicle_name', required: true, view: (r) => <span>{r.vehicle_name} <Plate value={r.plate} /></span>,
        warn: (v, options, mode) => {
          const car = mode === 'create' && options && v.vehicle_id ? options.vehicles.find((x) => String(x.id) === String(v.vehicle_id)) : null;
          return car && car.status !== 'available' ? `This vehicle is ${String(car.status).replace('_', ' ')} right now. Check the dates before you confirm.` : null;
        },
      },
      { key: 'product_line', label: 'Product', type: 'select', options: PRODUCT_LINES, required: true },
      { key: 'source', label: 'Booked via', type: 'select', options: BOOKING_SOURCES },
      { type: 'section', label: 'Schedule (Gulf time)' },
      { key: 'start_at', label: 'Starts', type: 'datetime', required: true },
      { key: 'end_at', label: 'Ends', type: 'datetime', required: true },
      { key: 'pickup_branch_id', label: 'Pick-up branch', type: 'relation', relation: 'branches', labelKey: 'pickup_branch' },
      { key: 'dropoff_branch_id', label: 'Drop-off branch', type: 'relation', relation: 'branches', labelKey: 'dropoff_branch' },
      { type: 'section', label: 'Price (AED, VAT 5%)' },
      { key: 'base_amount', label: 'Rental', type: 'number', suffix: 'AED', min: 0, step: 0.01, format: 'money', hint: (mode) => (mode === 'create' ? 'Calculated from the vehicle rate and period. Edit if you agreed a different price.' : '') },
      { key: 'extras_amount', label: 'Extras', type: 'number', suffix: 'AED', min: 0, step: 0.01, format: 'money' },
      { key: 'vat_amount', label: 'VAT', type: 'number', suffix: 'AED', min: 0, step: 0.01, format: 'money' },
      { key: 'total_amount', label: 'Total', type: 'number', suffix: 'AED', min: 0, step: 0.01, format: 'money' },
      { type: 'section', label: 'Status' },
      { key: 'status', label: 'Booking status', type: 'select', options: BOOKING_STATUS, required: true },
      { key: 'payment_status', label: 'Payment', type: 'select', options: PAYMENT_STATUS, required: true },
      { key: 'payment_method', label: 'Payment method', type: 'select', options: PAYMENT_METHODS },
      { key: 'notes', label: 'Notes', type: 'textarea', span: 2 },
    ],
  },
};

/* ------------------------------------------------------------------ trips */
const elapsed = (r) => (r.status === 'live' ? (Date.now() - toDate(r.started_at).getTime()) / 60000 : r.duration_min);

export const trips = {
  resource: 'trips',
  title: 'Trips',
  subtitle: 'Live and completed drives, from unlock to return.',
  singular: 'trip',
  plural: 'trips',
  searchPlaceholder: 'Search customer or plate…',
  defaultSort: { key: 'started_at', dir: 'desc' },
  tabs: { field: 'status', all: 'All trips', default: '', options: [{ value: 'live', label: 'Live now' }, { value: 'completed', label: 'Completed' }] },
  filters: [{ key: 'rating', label: 'Rating', options: [5, 4, 3, 2, 1].map((n) => ({ value: n, label: `${n} star${n > 1 ? 's' : ''}` })) }],
  columns: [
    { key: 'booking_ref', label: 'Trip', render: (r) => <div><div className="cell-main">{r.booking_ref || `Trip #${r.id}`}</div><div className="cell-sub">{r.customer_name}</div></div>, export: (r) => r.booking_ref },
    { key: 'vehicle_name', label: 'Vehicle', render: (r) => <div><div className="cell-main">{r.vehicle_name}</div><Plate value={r.plate} /></div>, export: (r) => `${r.vehicle_name} ${r.plate}` },
    { key: 'started_at', label: 'Started', sortable: true, render: (r) => fmtDateTime(r.started_at), export: (r) => r.started_at },
    {
      key: 'distance_km', label: 'Distance', align: 'right', sortable: true, export: (r) => r.distance_km,
      render: (r) => <div><div>{num(r.distance_km)} km</div><div className="cell-sub">{duration(elapsed(r))}{r.start_fuel != null ? ` · fuel ${r.start_fuel}% → ${r.end_fuel != null ? `${r.end_fuel}%` : '…'}` : ''}</div></div>,
    },
    { key: 'fare', label: 'Fare', align: 'right', sortable: true, render: (r) => <b>{money(r.fare)}</b>, export: (r) => r.fare },
    { key: 'rating', label: 'Rating', sortable: true, render: (r) => <Stars value={r.rating} />, export: (r) => r.rating },
    { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusPill kind="trip" value={r.status} />, export: (r) => r.status },
  ],
  recordTitle: (r) => r.booking_ref || `Trip #${r.id}`,
  recordSubtitle: (r) => `${r.customer_name} · ${r.vehicle_name} (${r.plate})`,
  badges: (r) => <StatusPill kind="trip" value={r.status} />,
  highlights: (r) => (
    <MiniStats items={[
      { label: 'Fare', value: money(r.fare) },
      { label: r.status === 'live' ? 'Elapsed' : 'Duration', value: duration(elapsed(r)) },
      { label: 'Distance', value: `${num(r.distance_km)} km` },
    ]} />
  ),
  actions: () => [
    {
      key: 'end', label: 'End trip', icon: Square, tone: 'danger', when: (r) => r.status === 'live',
      confirm: 'The trip is closed now and the vehicle becomes available again.',
      patch: (r) => ({ status: 'completed', ended_at: nowUtc(), duration_min: Math.max(1, Math.round((Date.now() - toDate(r.started_at).getTime()) / 60000)), end_fuel: r.fuel_level ?? r.start_fuel }),
      success: 'Trip ended',
    },
  ],
  form: {
    defaults: () => ({ status: 'live', started_at: inHours(0) }),
    compute: (v, key, { options, mode }) => {
      if (key !== 'booking_id' || !v.booking_id) return null;
      const b = findBooking(options, v.booking_id);
      return b ? { customer_id: b.customer_id, vehicle_id: b.vehicle_id, ...(mode === 'create' ? { fare: b.total_amount } : {}) } : null;
    },
    fields: [
      { key: 'booking_id', label: 'Booking', type: 'relation', relation: 'bookings', labelKey: 'booking_ref', required: true },
      { key: 'status', label: 'Status', type: 'select', required: true, options: [{ value: 'live', label: 'Live now' }, { value: 'completed', label: 'Completed' }] },
      { key: 'customer_id', label: 'Customer', type: 'relation', relation: 'customers', labelKey: 'customer_name', required: true },
      { key: 'vehicle_id', label: 'Vehicle', type: 'relation', relation: 'vehicles', labelKey: 'vehicle_name', required: true },
      { key: 'started_at', label: 'Started', type: 'datetime', required: true },
      { key: 'ended_at', label: 'Ended', type: 'datetime' },
      { key: 'distance_km', label: 'Distance', type: 'number', suffix: 'km', min: 0 },
      { key: 'duration_min', label: 'Duration', type: 'number', suffix: 'min', min: 0, step: 1 },
      { key: 'start_fuel', label: 'Fuel at start', type: 'number', suffix: '%', min: 0, max: 100, step: 1 },
      { key: 'end_fuel', label: 'Fuel at end', type: 'number', suffix: '%', min: 0, max: 100, step: 1 },
      { key: 'fare', label: 'Fare', type: 'number', suffix: 'AED', min: 0, step: 0.01, format: 'money' },
      { key: 'rating', label: 'Customer rating', type: 'select', options: [1, 2, 3, 4, 5].map((n) => ({ value: n, label: `${n} star${n > 1 ? 's' : ''}` })), view: (r) => <Stars value={r.rating} /> },
    ],
  },
};

/* ------------------------------------------------------------ maintenance */
const MAINT_TYPES = ['Service', 'Tyre Replacement', 'Accident Repair', 'Battery', 'AC Service', 'Body Work', 'Detailing'];
const MAINT_STATUS = [{ value: 'scheduled', label: 'Scheduled' }, { value: 'in_progress', label: 'In progress' }, { value: 'completed', label: 'Completed' }];

export const maintenance = {
  resource: 'maintenance',
  title: 'Maintenance',
  subtitle: 'Workshop jobs. A vehicle goes to the workshop while a job is in progress.',
  singular: 'job',
  plural: 'jobs',
  addLabel: 'Schedule job',
  searchPlaceholder: 'Search plate, description or vendor…',
  defaultSort: { key: 'scheduled_date', dir: 'desc' },
  tabs: { field: 'status', all: 'All jobs', options: MAINT_STATUS },
  filters: [{ key: 'type', label: 'Type', options: MAINT_TYPES }],
  columns: [
    { key: 'vehicle_name', label: 'Vehicle', render: (r) => <div><div className="cell-main">{r.vehicle_name}</div><Plate value={r.plate} /></div>, export: (r) => `${r.vehicle_name} ${r.plate}` },
    { key: 'type', label: 'Type', sortable: true, render: (r) => <span className="tag">{r.type}</span> },
    { key: 'scheduled_date', label: 'Scheduled', sortable: true, render: (r) => fmtDate(r.scheduled_date), export: (r) => r.scheduled_date },
    { key: 'completed_date', label: 'Completed', sortable: true, render: (r) => fmtDate(r.completed_date), export: (r) => r.completed_date },
    { key: 'vendor', label: 'Vendor' },
    { key: 'cost', label: 'Cost', align: 'right', sortable: true, render: (r) => money(r.cost), export: (r) => r.cost },
    { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusPill kind="maintenance" value={r.status} />, export: (r) => r.status },
  ],
  recordTitle: (r) => `${r.type} · ${r.vehicle_name}`,
  recordSubtitle: (r) => `${r.plate} · ${r.vendor || 'No vendor'}`,
  badges: (r) => <StatusPill kind="maintenance" value={r.status} />,
  highlights: (r) => (
    <MiniStats items={[
      { label: 'Cost', value: money(r.cost) },
      { label: 'Scheduled', value: fmtDate(r.scheduled_date) },
      { label: 'Odometer', value: r.odometer ? `${num(r.odometer)} km` : '—' },
    ]} />
  ),
  actions: () => [
    { key: 'start', label: 'Start job', short: 'Start', icon: Play, tone: 'soft', when: (r) => r.status === 'scheduled', patch: () => ({ status: 'in_progress' }), success: 'Job started. Vehicle is in the workshop.' },
    { key: 'complete', label: 'Complete job', short: 'Complete', icon: CheckCircle2, tone: 'soft', when: (r) => r.status !== 'completed', patch: () => ({ status: 'completed', completed_date: todayStr() }), success: 'Job completed. Vehicle released.' },
  ],
  form: {
    defaults: () => ({ type: 'Service', status: 'scheduled', scheduled_date: inDays(0) }),
    fields: [
      { key: 'vehicle_id', label: 'Vehicle', type: 'relation', relation: 'vehicles', labelKey: 'vehicle_name', required: true, span: 2, view: (r) => <span>{r.vehicle_name} <Plate value={r.plate} /></span> },
      { key: 'type', label: 'Type', type: 'select', options: MAINT_TYPES, required: true },
      { key: 'status', label: 'Status', type: 'select', options: MAINT_STATUS, required: true },
      { key: 'description', label: 'Description', type: 'textarea', span: 2 },
      { key: 'scheduled_date', label: 'Scheduled for', type: 'date', required: true },
      { key: 'completed_date', label: 'Completed on', type: 'date' },
      { key: 'vendor', label: 'Vendor', type: 'text' },
      { key: 'cost', label: 'Cost', type: 'number', suffix: 'AED', min: 0, step: 0.01, format: 'money' },
      { key: 'odometer', label: 'Odometer', type: 'number', suffix: 'km', min: 0, step: 1 },
    ],
  },
};

/* ------------------------------------------------------------------ fines */
const FINE_STATUS = [{ value: 'unrecovered', label: 'Unrecovered' }, { value: 'recovered', label: 'Recovered' }, { value: 'disputed', label: 'Disputed' }];

export const fines = {
  resource: 'fines',
  title: 'Fines & Salik',
  subtitle: 'Traffic fines and Salik tolls, matched to the customer who was driving.',
  singular: 'fine',
  plural: 'fines',
  searchPlaceholder: 'Search reference, plate, customer or location…',
  defaultSort: { key: 'issued_at', dir: 'desc' },
  tabs: { field: 'status', all: 'All', options: FINE_STATUS },
  filters: [{ key: 'type', label: 'Type', options: ['Traffic Fine', 'Salik Toll'] }],
  stats: [
    { label: 'Unrecovered', icon: ShieldAlert, tone: 'danger', value: (d) => moneyShort(d.kpis.finesOpen), foot: (d) => `${d.kpis.finesOpenCount} fines waiting to be charged` },
    { label: 'Admin fee per fine', icon: CircleDollarSign, value: () => moneyShort(50), foot: () => 'added to traffic fines' },
  ],
  columns: [
    { key: 'reference', label: 'Reference', sortable: true, render: (r) => <div><div className="cell-main">{r.reference}</div><div className="cell-sub">{r.type === 'Salik Toll' ? 'Salik toll' : 'Traffic fine'} · {r.authority}</div></div>, export: (r) => r.reference },
    { key: 'plate', label: 'Vehicle', render: (r) => <Plate value={r.plate} /> },
    { key: 'customer_name', label: 'Customer', render: (r) => <div><div className="cell-main">{r.customer_name}</div><div className="cell-sub">{r.booking_ref}</div></div>, export: (r) => r.customer_name },
    { key: 'issued_at', label: 'Issued', sortable: true, render: (r) => <div><div>{fmtDateTime(r.issued_at)}</div><div className="cell-sub">{r.location}</div></div>, export: (r) => `${r.issued_at} ${r.location || ''}`.trim() },
    { key: 'amount', label: 'Amount', align: 'right', sortable: true, render: (r) => <div><b>{money(Number(r.amount) + Number(r.admin_fee))}</b>{Number(r.admin_fee) ? <div className="cell-sub">incl. {moneyShort(r.admin_fee)} admin fee</div> : null}</div>, export: (r) => Number(r.amount) + Number(r.admin_fee) },
    { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusPill kind="fine" value={r.status} />, export: (r) => r.status },
  ],
  recordTitle: (r) => r.reference || r.type,
  recordSubtitle: (r) => `${r.customer_name || 'No customer'} · ${r.plate || ''}`,
  badges: (r) => (<><StatusPill kind="fine" value={r.status} /><StatusPill kind="fineType" value={r.type} /></>),
  highlights: (r) => (
    <MiniStats items={[
      { label: 'Fine', value: money(r.amount) },
      { label: 'Admin fee', value: money(r.admin_fee) },
      { label: 'To charge', value: money(Number(r.amount) + Number(r.admin_fee)) },
    ]} />
  ),
  actions: () => [
    { key: 'recovered', label: 'Mark recovered', short: 'Recovered', icon: CheckCircle2, tone: 'soft', when: (r) => r.status !== 'recovered', patch: () => ({ status: 'recovered' }), success: 'Fine marked as recovered' },
    { key: 'dispute', label: 'Dispute', short: 'Dispute', icon: Flag, tone: 'soft', when: (r) => r.status === 'unrecovered', patch: () => ({ status: 'disputed' }), success: 'Fine marked as disputed' },
  ],
  form: {
    defaults: () => ({ type: 'Traffic Fine', status: 'unrecovered', admin_fee: 50, authority: 'Dubai Police', issued_at: inHours(0) }),
    compute: (v, key, { options, mode }) => {
      const patch = {};
      if (key === 'booking_id' && v.booking_id) {
        const b = findBooking(options, v.booking_id);
        if (b) { patch.vehicle_id = b.vehicle_id; patch.customer_id = b.customer_id; }
      }
      if (key === 'type' && mode === 'create') {
        patch.admin_fee = v.type === 'Salik Toll' ? 0 : 50;
        patch.authority = v.type === 'Salik Toll' ? 'Salik (RTA)' : (v.authority === 'Salik (RTA)' ? 'Dubai Police' : v.authority);
      }
      return patch;
    },
    fields: [
      { key: 'type', label: 'Type', type: 'select', options: ['Traffic Fine', 'Salik Toll'], required: true },
      { key: 'reference', label: 'Reference', type: 'text', placeholder: 'TF-1234567' },
      { key: 'booking_id', label: 'Booking', type: 'relation', relation: 'bookings', labelKey: 'booking_ref', hint: 'Pick the booking and the vehicle and customer fill in.' },
      { key: 'vehicle_id', label: 'Vehicle', type: 'relation', relation: 'vehicles', labelKey: 'plate', required: true },
      { key: 'customer_id', label: 'Customer', type: 'relation', relation: 'customers', labelKey: 'customer_name' },
      { key: 'issued_at', label: 'Issued', type: 'datetime' },
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'authority', label: 'Authority', type: 'select', options: ['Dubai Police', 'Abu Dhabi Police', 'Sharjah Police', 'Salik (RTA)'] },
      { key: 'amount', label: 'Amount', type: 'number', suffix: 'AED', min: 0, step: 0.01, required: true, format: 'money' },
      { key: 'admin_fee', label: 'Admin fee', type: 'number', suffix: 'AED', min: 0, step: 0.01, format: 'money' },
      { key: 'status', label: 'Status', type: 'select', options: FINE_STATUS, required: true },
    ],
  },
};

/* --------------------------------------------------------------- invoices */
const INVOICE_STATUS = [{ value: 'paid', label: 'Paid' }, { value: 'sent', label: 'Sent' }, { value: 'overdue', label: 'Overdue' }, { value: 'draft', label: 'Draft' }];
const isUnpaid = (r) => r.status !== 'paid';

export const invoices = {
  resource: 'invoices',
  title: 'Invoices',
  subtitle: 'Tax invoices with 5% VAT, from draft to paid.',
  singular: 'invoice',
  plural: 'invoices',
  searchPlaceholder: 'Search invoice number or customer…',
  defaultSort: { key: 'issue_date', dir: 'desc' },
  tabs: { field: 'status', all: 'All invoices', options: INVOICE_STATUS },
  stats: [
    {
      label: 'Paid this month', icon: Banknote, tone: 'ok', value: (d) => moneyShort(d.kpis.revenueMtd),
      foot: (d) => { const c = pctChange(d.kpis.revenueMtd, d.kpis.revenuePrevMtd); return c === null ? 'no data for last month' : `${c >= 0 ? '+' : ''}${c.toFixed(0)}% vs last month`; },
    },
    { label: 'Outstanding', icon: Receipt, tone: 'warn', value: (d) => moneyShort(d.kpis.outstanding), foot: (d) => `${d.kpis.outstandingCount} invoices not yet paid` },
  ],
  columns: [
    { key: 'number', label: 'Invoice', sortable: true, render: (r) => <div><div className="cell-main">{r.number}</div><div className="cell-sub">{r.booking_ref}</div></div>, export: (r) => r.number },
    { key: 'customer_name', label: 'Customer', export: (r) => r.customer_name },
    { key: 'issue_date', label: 'Issued', sortable: true, render: (r) => fmtDate(r.issue_date), export: (r) => r.issue_date },
    {
      key: 'due_date', label: 'Due', sortable: true, export: (r) => r.due_date,
      render: (r) => { const late = isUnpaid(r) && daysUntil(r.due_date) < 0; return <span style={late ? { color: 'var(--danger-fg)', fontWeight: 700 } : undefined}>{fmtDate(r.due_date)}</span>; },
    },
    { key: 'total', label: 'Total', align: 'right', sortable: true, render: (r) => <div><b>{money(r.total)}</b><div className="cell-sub">VAT {money(r.vat)}</div></div>, export: (r) => r.total },
    { key: 'method', label: 'Method' },
    { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusPill kind="invoice" value={r.status} />, export: (r) => r.status },
  ],
  recordTitle: (r) => r.number,
  recordSubtitle: (r) => `${r.customer_name}${r.booking_ref ? ` · ${r.booking_ref}` : ''}`,
  badges: (r) => <StatusPill kind="invoice" value={r.status} />,
  highlights: (r) => (
    <MiniStats items={[
      { label: 'Total', value: money(r.total) },
      { label: 'VAT', value: money(r.vat) },
      { label: 'Due', value: fmtDate(r.due_date) },
    ]} />
  ),
  actions: () => [
    { key: 'send', label: 'Send to customer', short: 'Send', icon: Send, tone: 'soft', when: (r) => r.status === 'draft', patch: () => ({ status: 'sent' }), success: 'Invoice sent' },
    { key: 'paid', label: 'Mark as paid', short: 'Mark paid', icon: CheckCircle2, tone: 'soft', when: isUnpaid, patch: (r) => ({ status: 'paid', paid_at: todayStr(), method: r.method || 'Bank Transfer' }), success: 'Invoice marked as paid' },
  ],
  form: {
    defaults: () => ({ status: 'draft', issue_date: inDays(0), due_date: inDays(14), subtotal: 0, vat: 0, total: 0 }),
    compute: (v, key, { options }) => {
      if (key === 'booking_id' && v.booking_id) {
        const b = findBooking(options, v.booking_id);
        if (b) {
          const total = Number(b.total_amount) || 0;
          const sub = round2(total / (1 + VAT));
          return { customer_id: b.customer_id, subtotal: sub, vat: round2(total - sub), total };
        }
      }
      if (key === 'subtotal') {
        const s = Number(v.subtotal) || 0;
        const vat = round2(s * VAT);
        return { vat, total: round2(s + vat) };
      }
      return null;
    },
    fields: [
      { key: 'number', label: 'Invoice number', type: 'text', readOnly: true, hidden: (mode) => mode === 'create' },
      { key: 'booking_id', label: 'Booking', type: 'relation', relation: 'bookings', labelKey: 'booking_ref', hint: 'Pick a booking to fill in the customer and amounts.' },
      { key: 'customer_id', label: 'Customer', type: 'relation', relation: 'customers', labelKey: 'customer_name', required: true },
      { key: 'status', label: 'Status', type: 'select', options: INVOICE_STATUS, required: true },
      { key: 'issue_date', label: 'Issue date', type: 'date', required: true },
      { key: 'due_date', label: 'Due date', type: 'date' },
      { key: 'subtotal', label: 'Subtotal', type: 'number', suffix: 'AED', min: 0, step: 0.01, format: 'money' },
      { key: 'vat', label: 'VAT (5%)', type: 'number', suffix: 'AED', min: 0, step: 0.01, format: 'money' },
      { key: 'total', label: 'Total', type: 'number', suffix: 'AED', min: 0, step: 0.01, format: 'money' },
      { key: 'method', label: 'Payment method', type: 'select', options: PAYMENT_METHODS },
      { key: 'paid_at', label: 'Paid on', type: 'date' },
    ],
  },
};
