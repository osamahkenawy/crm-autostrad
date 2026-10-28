// Lookup lists for select boxes (branches, vehicles, customers…), cached briefly.
import { useEffect, useState } from 'react';
import { api } from '../api';

let cache = null;
let stamp = 0;
let inflight = null;

export function loadOptions(force = false) {
  if (!force && cache && Date.now() - stamp < 20000) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = api.get('/stats/options')
    .then((o) => { cache = o; stamp = Date.now(); return o; })
    .finally(() => { inflight = null; });
  return inflight;
}
export const invalidateOptions = () => { stamp = 0; };

export function useOptions() {
  const [options, setOptions] = useState(cache);
  useEffect(() => {
    let alive = true;
    loadOptions().then((o) => { if (alive) setOptions(o); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return options;
}

/** relation name → how an option is shown in a select */
export const RELATIONS = {
  branches: (o) => ({ value: o.id, label: o.name, hint: o.emirate }),
  vehicles: (o) => ({ value: o.id, label: `${o.plate} · ${o.name}`, hint: `${o.category} · ${String(o.status || '').replace('_', ' ')}` }),
  customers: (o) => ({ value: o.id, label: o.name, hint: o.phone }),
  users: (o) => ({ value: o.id, label: o.name, hint: ({ it: 'IT', admin: 'Admin', operations: 'Operations', customer_service: 'Customer service', finance: 'Finance' })[o.role] || o.role }),
  bookings: (o) => ({ value: o.id, label: o.ref }),
  leads: (o) => ({ value: o.id, label: o.name }),
};
