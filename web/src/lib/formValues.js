// Form values ⇄ API payload, and validation. Kept apart from the form component so hot reload stays happy.
import { fromInputDT, toInputDT } from './format';

/** Row from the API → values the inputs can show. */
export function toFormValues(fields, row = {}) {
  const v = {};
  for (const f of fields) {
    if (f.type === 'section') continue;
    const raw = row[f.key];
    if (f.type === 'datetime') v[f.key] = toInputDT(raw);
    else v[f.key] = raw === null || raw === undefined ? '' : raw;
  }
  return v;
}

/** Input values → body for POST/PUT. */
export function toPayload(fields, values) {
  const out = {};
  for (const f of fields) {
    if (f.type === 'section' || f.readOnly) continue;
    let val = values[f.key];
    if (f.type === 'datetime') val = fromInputDT(val);
    else if (f.type === 'number' || f.type === 'relation') val = val === '' || val === null || val === undefined ? null : Number(val);
    else if (val === '' || val === undefined) val = null;
    out[f.key] = val;
  }
  return out;
}

export const isRequired = (f, mode) => (typeof f.required === 'function' ? f.required(mode) : Boolean(f.required));

export function validate(fields, values, mode) {
  const errors = {};
  for (const f of fields) {
    if (f.type === 'section' || f.readOnly || (f.hidden && f.hidden(mode, values))) continue;
    const val = values[f.key];
    const blank = val === '' || val === null || val === undefined;
    if (isRequired(f, mode) && blank) { errors[f.key] = `${f.label} is required`; continue; }
    if (blank) continue;
    if (f.type === 'email' && !/^\S+@\S+\.\S+$/.test(String(val))) errors[f.key] = 'Enter a valid email address';
    if (f.type === 'number') {
      const n = Number(val);
      if (Number.isNaN(n)) errors[f.key] = 'Enter a number';
      else if (f.min !== undefined && n < f.min) errors[f.key] = `Must be at least ${f.min}`;
      else if (f.max !== undefined && n > f.max) errors[f.key] = `Must be at most ${f.max}`;
    }
    if (f.type === 'password' && String(val).length < 8) errors[f.key] = 'Use at least 8 characters';
  }
  return errors;
}

