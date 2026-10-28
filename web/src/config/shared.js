// Option lists and small helpers shared by the resource configs.
import { round2 } from '../lib/format';

export const VAT = 0.05; // UAE VAT

export const VEHICLE_STATUS = [
  { value: 'available', label: 'Available' }, { value: 'on_trip', label: 'On trip' },
  { value: 'reserved', label: 'Reserved' }, { value: 'maintenance', label: 'Maintenance' },
];
export const CATEGORIES = ['Economy', 'Compact', 'SUV', 'Luxury SUV', 'Electric', 'Van'];
export const PRODUCT_LINES = ['Daily', 'Flexi Monthly', 'Car Share', 'Corporate Lease'];
export const BOOKING_STATUS = [
  { value: 'upcoming', label: 'Upcoming' }, { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' }, { value: 'cancelled', label: 'Cancelled' },
];
export const PAYMENT_STATUS = [{ value: 'paid', label: 'Paid' }, { value: 'unpaid', label: 'Unpaid' }, { value: 'refunded', label: 'Refunded' }];
export const PAYMENT_METHODS = ['Visa ••42', 'Mastercard ••71', 'Apple Pay', 'Cash', 'Corporate Account', 'Bank Transfer'];
export const BOOKING_SOURCES = ['App', 'Website', 'Walk-in', 'Call Centre', 'Partner'];
export const EMIRATES = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain'];

/** UTC "YYYY-MM-DD HH:MM:SS", `h` hours from now, on the hour. */
export function inHours(h) {
  const d = new Date(Date.now() + h * 3600000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
export function inDays(n) {
  return new Date(Date.now() + 4 * 3600000 + n * 86400000).toISOString().slice(0, 10);
}

/** Price a booking from the vehicle's rates and the rental period (form values are Gulf-time inputs). */
export function estimateBase(values, options) {
  const v = options && options.vehicles.find((x) => String(x.id) === String(values.vehicle_id));
  if (!v || !values.start_at || !values.end_at) return null;
  const mins = (new Date(`${values.end_at}:00Z`) - new Date(`${values.start_at}:00Z`)) / 60000;
  if (!(mins > 0)) return null;
  switch (values.product_line) {
    case 'Car Share': return round2(mins * (v.carshare_rate || 0));
    case 'Daily': return round2(Math.max(1, Math.ceil(mins / 1440)) * (v.daily_rate || 0));
    case 'Flexi Monthly':
    case 'Corporate Lease': return round2((mins / 1440 / 30) * (v.monthly_rate || 0));
    default: return null;
  }
}

export const findBooking = (options, id) => (options && id ? options.bookings.find((b) => String(b.id) === String(id)) : null);
